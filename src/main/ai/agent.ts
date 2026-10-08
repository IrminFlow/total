// The agent loop (WP 5.1). One question = one "turn": the user's message is stored, then the
// model is called up to `maxSteps` times; each call may ask for tools (run locally through the
// registry, results stored and sent back) or give the final answer. Everything streams to the
// renderer as AiEvents. Per-thread cancellation (Stop) aborts the in-flight call.
//
// Privacy: what is SENT is the masked / pseudonymised form of the system prompt, the history and
// every tool result (privacy.ts) — always applied to parsed values, never to raw JSON text; what
// is STORED and SHOWN is real. A tool result's sent text is cached on its message (keyed by the
// privacy settings and budget), so later steps reuse exactly what the model saw instead of
// re-trimming the whole history. Each call writes one ai_outbound_log row (sizes, tools, privacy
// flags, SHA-256 of the exact payload) and one ai_usage row (tokens, estimated cost).
//
// The numbers rule is checked after the answer: money-looking figures are looked up in the tool
// results the model saw in this conversation (numbers.ts); the panel warns about the rest.
import { createHash, randomUUID } from 'crypto'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { AI_DATA_NOTICE_VERSION, AI_PRE_CALL_TOOLS, type AiContext, type AiPreCall, type AiEvent, type AiMessageDto, type AiSettings, type AiSource } from '@shared/ai'
import type { Role } from '../services/roles'
import { buildSystemPrompt } from './prompt'
import { mapStrings, outboundText, inboundText, type PrivacyOptions } from './privacy'
import { fitToBudget, DEFAULT_TOOL_RESULT_BUDGET } from './truncate'
import { checkFigures, type SeenResult } from './numbers'
import { estimateCostMicroUsd } from './cost'
import { AiAbortError, type AiProvider, type ChatItem, type ChatResult } from './types'
import type { ToolRegistry } from './tools/registry'
import { redactSecrets } from './provider'
import * as store from './store'
import { writeAudit } from '../services/audit'

// ---------- per-thread runs (keyed by company + thread) ----------

export class AgentRuns {
  private readonly runs = new Map<string, { runId: string; controller: AbortController; scope: string; threadId: number }>()

  private key(scope: string, threadId: number): string {
    return `${scope}\u0000${threadId}`
  }

  start(threadId: number, scope = ''): { runId: string; signal: AbortSignal } {
    const k = this.key(scope, threadId)
    if (this.runs.has(k)) throw new Error('The assistant is still answering in this conversation — wait or press Stop')
    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(k, { runId, controller, scope, threadId })
    return { runId, signal: controller.signal }
  }

  end(threadId: number, runId: string, scope = ''): void {
    const k = this.key(scope, threadId)
    if (this.runs.get(k)?.runId === runId) this.runs.delete(k)
  }

  cancel(threadId: number, scope = ''): boolean {
    const r = this.runs.get(this.key(scope, threadId))
    if (!r) return false
    r.controller.abort()
    return true
  }

  cancelAll(): void {
    for (const r of this.runs.values()) r.controller.abort()
  }

  /** Thread ids answering in one company. */
  running(scope = ''): Set<number> {
    return new Set([...this.runs.values()].filter((r) => r.scope === scope).map((r) => r.threadId))
  }

  get size(): number {
    return this.runs.size
  }
}

// ---------- the turn ----------

export interface AgentDeps {
  db: DB
  company: CompanyInfo
  provider: AiProvider
  registry: ToolRegistry
  settings: AiSettings
  user: { name: string | null; role: Role }
  /** The signed-in user's role NOW (re-checked before every tool call); null = signed out. */
  roleNow?: () => Role | null
  emit: (e: AiEvent) => void
  runs: AgentRuns
  /** The company the runs belong to (AgentRuns key). */
  scope?: string
  today?: string
  now?: () => number
  toolBudget?: number
  /** Override the default working period (FY of today) when the renderer sends none. */
  period?: { from: string; to: string }
}

export interface AskInput {
  threadId?: number
  /** Ignored with `regenerate` (the thread's last question is answered again). */
  text: string
  /** WP 5.2 Regenerate: drop the last answer and answer the last question again. */
  regenerate?: boolean
  context?: AiContext
  speed?: 'default' | 'fast'
  /** WP 5.5 "Run with AI": a read tool run before the first model call; its result is stored as
   *  an ordinary tool call of this turn, so the model starts from it. Ignored with regenerate. */
  preCall?: AiPreCall
}

export interface TurnHandle {
  threadId: number
  runId: string
  userMessage: AiMessageDto
  /** Resolves when the turn ends (answered, failed or stopped) — never rejects. */
  finished: Promise<{ status: 'done' | 'error' | 'cancelled'; error?: string }>
}

export const AI_OFF_MESSAGE = 'The assistant is off for this company — turn it on in Settings → AI'
export const AI_NOTICE_MESSAGE = 'Read and accept the data notice first'
export const AI_NOTICE_CHANGED = 'The data notice has changed — read and accept it again in Settings → AI'

/** Why the assistant may not run for these settings (key / mock checks are the caller's). */
export function settingsBlocker(s: AiSettings): string | null {
  if (!s.noticeAcceptedAt) return AI_NOTICE_MESSAGE
  if (s.noticeVersion !== AI_DATA_NOTICE_VERSION) return AI_NOTICE_CHANGED
  if (!s.enabled) return AI_OFF_MESSAGE
  return null
}

function fyPeriod(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number]
  const start = m >= 4 ? y : y - 1
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` }
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Cache key for a tool result's sent text: privacy options, alias-map size and budget. */
export function privacySignature(privacy: PrivacyOptions, budget: number): string {
  return `m${privacy.maskIds ? 1 : 0}p${privacy.pseudonymiser ? privacy.pseudonymiser.size : 'x'}b${budget}`
}

/** The text a tool output is sent as: strings mapped (never the raw JSON), then budgeted. */
export function sentToolText(output: unknown, privacy: PrivacyOptions, budget: number): { text: string; truncated: boolean } {
  const fitted = fitToBudget(mapStrings(output, (s) => outboundText(s, privacy)), budget)
  return { text: fitted.text, truncated: fitted.truncated }
}

/** Rebuild the conversation for the model from stored messages (real text → outbound form).
 *  A tool call whose result was never stored (stopped mid-tool) is dropped with its call, since
 *  the API refuses a call without an output. Reasoning items are passed back only for the steps
 *  of the current question (after the last user message). */
export function historyItems(
  messages: readonly store.StoredMessage[],
  privacy: PrivacyOptions,
  budget: number
): { items: ChatItem[]; toolResults: string[]; seen: SeenResult[] } {
  const out = (s: string): string => outboundText(s, privacy)
  const sig = privacySignature(privacy, budget)
  const answered = new Set(messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId!))
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
  })
  const items: ChatItem[] = []
  const toolResults: string[] = []
  const seen: SeenResult[] = []
  messages.forEach((m, i) => {
    if (m.role === 'user') items.push({ type: 'message', role: 'user', content: out(m.content) })
    else if (m.role === 'assistant') {
      if (i > lastUser) for (const r of m.reasoning) items.push({ type: 'reasoning', item: r })
      if (m.content.trim() && m.status !== 'error') items.push({ type: 'message', role: 'assistant', content: out(m.content) })
      for (const c of m.toolCalls) {
        if (answered.has(c.callId)) {
          items.push({ type: 'tool_call', callId: c.callId, name: c.name, arguments: JSON.stringify(mapStrings(c.input ?? {}, out)) })
        }
      }
    } else if (m.toolCallId) {
      const text = m.sentText != null && m.sentPrivacy === sig ? m.sentText : sentToolText(m.toolOutput, privacy, budget).text
      items.push({ type: 'tool_result', callId: m.toolCallId, output: text })
      toolResults.push(m.toolName ?? '?')
      seen.push({ name: m.toolName ?? '?', text })
    }
  })
  return { items, toolResults, seen }
}

/** Model arguments → real values: parse, map aliases back in every string, re-serialise. A name
 *  containing quotes or backslashes can never break (or inject keys into) the JSON. */
export function inboundArguments(raw: string, privacy: PrivacyOptions): { args: string; input: unknown } {
  try {
    const input = mapStrings(JSON.parse(raw) as unknown, (s) => inboundText(s, privacy))
    return { args: JSON.stringify(input), input }
  } catch {
    return { args: raw, input: raw } // the registry reports the bad JSON to the model
  }
}

function dedupeSources(list: readonly AiSource[]): AiSource[] {
  const seen = new Set<string>()
  const out: AiSource[] = []
  for (const s of list) {
    const key = JSON.stringify(s)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

export function startTurn(deps: AgentDeps, askInput: AskInput): TurnHandle {
  let input = askInput
  const { db, settings } = deps
  const blocker = settingsBlocker(settings)
  if (blocker) throw new Error(blocker === AI_NOTICE_MESSAGE ? AI_OFF_MESSAGE : blocker)
  let threadId = input.threadId ?? null
  if (threadId !== null && !store.threadExists(db, threadId)) throw new Error('Conversation not found')
  const scope = deps.scope ?? ''
  let text: string
  let userMessage: AiMessageDto
  let runId: string
  let signal: AbortSignal
  if (input.regenerate) {
    if (threadId === null) throw new Error('Nothing to regenerate in a new conversation')
    const last = store.lastUserMessage(db, threadId)
    if (!last) throw new Error('Nothing to regenerate yet')
    ;({ runId, signal } = deps.runs.start(threadId, scope))
    text = last.content
    const asked = store.getMessage(db, last.id)!
    // Re-ask with the screen context the question was ASKED with (an explain figure included),
    // never whatever screen happens to be open now.
    input = { ...input, context: asked.context ?? undefined }
    const tid = threadId
    db.transaction(() => {
      const removed = store.deleteMessagesAfter(db, tid, last.id)
      for (const d of removed.supersededDrafts) writeAudit(db, 'ai_draft', d, 'update', { status: 'open' }, { status: 'superseded', note: 'its answer was regenerated' })
      writeAudit(db, 'ai_thread', tid, 'update', { messageIds: removed.messageIds }, { regenerated: last.id, supersededDrafts: removed.supersededDrafts })
    })()
    userMessage = store.toDto(asked)
  } else {
    text = input.text.trim()
    if (!text) throw new Error('Type a question first')
    if (threadId === null) threadId = store.createThread(db, text, deps.user.name)
    ;({ runId, signal } = deps.runs.start(threadId, scope))
    userMessage = store.toDto(store.addMessage(db, { threadId, role: 'user', content: text, context: input.context ?? null }))
  }
  deps.emit({ type: 'run-start', threadId, runId, userMessage })
  const tid = threadId
  const finished = runLoop(deps, input, tid, runId, signal, text)
    .catch((err: unknown) => {
      // Defensive: runLoop handles its own failures; this catches the rest (e.g. the company
      // closed mid-run and its database handle went away, or the thread was deleted between a
      // check and a write) — reported as stopped, never as a raw database error.
      let gone = true
      try {
        gone = !store.threadExists(db, tid)
      } catch {
        /* the handle is closed */
      }
      if (gone) {
        deps.emit({ type: 'cancelled', threadId: tid, runId })
        return { status: 'cancelled' as const }
      }
      const error = redactSecrets(err instanceof Error ? err.message : String(err))
      deps.emit({ type: 'error', threadId: tid, runId, error })
      return { status: 'error' as const, error }
    })
    .finally(() => deps.runs.end(tid, runId, scope))
  return { threadId: tid, runId, userMessage, finished }
}

async function runLoop(
  deps: AgentDeps,
  input: AskInput,
  threadId: number,
  runId: string,
  signal: AbortSignal,
  userRequest: string
): Promise<{ status: 'done' | 'error' | 'cancelled'; error?: string }> {
  const { db, settings, provider, registry, emit } = deps
  const now = deps.now ?? Date.now
  const today = deps.today ?? todayISO()
  const period = input.context?.from && input.context?.to ? { from: input.context.from, to: input.context.to } : (deps.period ?? fyPeriod(today))
  const budget = deps.toolBudget ?? DEFAULT_TOOL_RESULT_BUDGET
  const privacy: PrivacyOptions = {
    maskIds: settings.privacy.maskIds,
    pseudonymiser: settings.privacy.pseudonymiseParties ? store.companyPseudonymiser(db) : null
  }
  const sig = privacySignature(privacy, budget)
  const role = deps.user.role
  const tools = registry.available(role)
  const specs = registry.specs(role)
  const instructions = outboundText(
    buildSystemPrompt({
      company: {
        name: deps.company.name,
        gstin: deps.company.gstin,
        stateCode: deps.company.stateCode,
        registrationType: deps.company.gstRegistrationType,
        booksFromFy: deps.company.booksFrom
      },
      today,
      period,
      user: { name: deps.user.name, role },
      screen: input.context?.screen ?? null,
      context: input.context ?? null,
      tools: tools.map((t) => ({ name: t.name, kind: t.kind })),
      privacy: settings.privacy
    }),
    privacy
  )
  const model = input.speed === 'fast' ? settings.fastModel : settings.defaultModel
  const turnSources: AiSource[] = []
  const send = (m: store.StoredMessage): void => emit({ type: 'message', threadId, runId, message: store.toDto(m) })
  // A thread can be deleted (thread delete / Delete all AI data) while a call is in flight: its
  // usage is still recorded — unlinked — and nothing else is written for it.
  const threadGone = (): boolean => !store.threadExists(db, threadId)
  const usageThread = (): number | null => (threadGone() ? null : threadId)

  const stopped = (partial: string): { status: 'cancelled' } => {
    if (partial.trim()) send(store.addMessage(db, { threadId, role: 'assistant', content: partial, status: 'cancelled', model }))
    emit({ type: 'cancelled', threadId, runId })
    return { status: 'cancelled' }
  }
  const failed = (error: string, partial = ''): { status: 'error'; error: string } => {
    send(store.addMessage(db, { threadId, role: 'assistant', content: partial ? `${partial}\n\n${error}` : error, status: 'error', model }))
    emit({ type: 'error', threadId, runId, error })
    return { status: 'error', error }
  }

  // WP 5.5: the assistant screen's tool, run first (read tools only, the role still applies).
  if (input.preCall && !input.regenerate) {
    const pre = input.preCall
    if (!(AI_PRE_CALL_TOOLS as readonly string[]).includes(pre.tool) || registry.get(pre.tool)?.kind !== 'read') return failed(`${pre.tool} cannot be run ahead of the question.`)
    const callId = `pre_${runId.slice(0, 8)}`
    const holder = store.addMessage(db, { threadId, role: 'assistant', content: '', toolCalls: [{ callId, name: pre.tool, input: pre.input }], model })
    send(holder)
    emit({ type: 'tool-start', threadId, runId, callId, name: pre.tool, input: pre.input })
    const run = await registry.run(pre.tool, JSON.stringify(pre.input), {
      db, company: deps.company, role, userName: deps.user.name, threadId, messageId: holder.id, today, period, userRequest, screen: input.context ?? null
    })
    const output = run.ok ? { ok: true, result: run.data } : { ok: false, error: run.error }
    const sent = sentToolText(output, privacy, budget)
    const sources = run.ok ? run.sources : []
    send(
      store.addMessage(db, {
        threadId, role: 'tool', toolCallId: callId, toolName: pre.tool, toolInput: run.input, toolOutput: output, toolOk: run.ok,
        truncated: sent.truncated, sources, draftId: null, sentText: sent.text, sentPrivacy: sig
      })
    )
    turnSources.push(...sources)
  }

  for (let step = 1; step <= settings.maxSteps; step++) {
    if (signal.aborted) return stopped('')
    const history = store.listMessages(db, threadId)
    const { items, toolResults, seen } = historyItems(history, privacy, budget)
    const payload = JSON.stringify({ model, instructions, input: items, tools: specs })
    const outboundId = store.logOutbound(db, {
      threadId,
      provider: provider.name,
      model,
      requestBytes: Buffer.byteLength(payload, 'utf8'),
      instructionsBytes: Buffer.byteLength(instructions, 'utf8'),
      messageCount: items.length,
      toolsOffered: specs.map((s) => s.name),
      toolResultsSent: toolResults,
      masked: privacy.maskIds,
      pseudonymised: !!privacy.pseudonymiser,
      payloadSha256: sha256(payload),
      // What was SENT: the masked / pseudonymised context (never raw party names or identifiers).
      context: input.context ? mapStrings(input.context, (s) => outboundText(s, privacy)) : null
    })

    const reverser = privacy.pseudonymiser?.stream()
    let streamed = ''
    const push = (t: string): void => {
      if (!t) return
      streamed += t
      emit({ type: 'delta', threadId, runId, text: t })
    }
    const t0 = now()
    let res: ChatResult
    try {
      res = await provider.chat({ model, instructions, input: items, tools: specs, signal }, { onTextDelta: (d) => push(reverser ? reverser.push(d) : d) })
      if (reverser) push(reverser.flush())
    } catch (err) {
      const aborted = err instanceof AiAbortError || signal.aborted
      const error = redactSecrets(err instanceof Error ? err.message : String(err))
      const gone = threadGone()
      store.setOutboundStatus(db, outboundId, aborted ? 'cancelled' : 'error')
      // Failed and stopped calls are counted too (tokens unknown: the provider sends usage only
      // with a completed response).
      store.recordUsage(db, {
        threadId: gone ? null : threadId, messageId: null, provider: provider.name, model, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0,
        costMicroUsd: null, durationMs: now() - t0, ok: false, error: aborted ? 'stopped' : error, day: today
      })
      if (gone) {
        emit({ type: 'cancelled', threadId, runId })
        return { status: 'cancelled' }
      }
      if (aborted) return stopped(streamed)
      return failed(error, streamed)
    }
    store.setOutboundStatus(db, outboundId, 'ok')
    const cost = estimateCostMicroUsd(res.usage, settings.prices[res.model] ?? settings.prices[model])
    const usageThreadId = usageThread()
    const usageId = store.recordUsage(db, {
      threadId: usageThreadId, messageId: null, provider: provider.name, model: res.model, inputTokens: res.usage.inputTokens, cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens, reasoningTokens: res.usage.reasoningTokens, costMicroUsd: cost, durationMs: now() - t0, ok: true, day: today
    })
    if (usageThreadId === null) {
      emit({ type: 'cancelled', threadId, runId })
      return { status: 'cancelled' }
    }
    const text = inboundText(res.text, privacy)
    const usageFields = { model: res.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costMicroUsd: cost }

    if (res.toolCalls.length === 0) {
      // Figures are checked against what the model actually saw in this conversation, and each
      // sourced one is traced to the row (voucher / ledger / item) it came from — newest first.
      const origins = history
        .filter((m) => m.role === 'tool' && m.toolOk)
        .reverse()
        .map((m) => ({ tool: m.toolName ?? '?', output: m.toolOutput, sources: m.sources }))
      const figures = checkFigures(text, seen, origins)
      const final = store.addMessage(db, { threadId, role: 'assistant', content: text, figures, sources: dedupeSources(turnSources), ...usageFields })
      db.prepare('UPDATE ai_usage SET message_id = ? WHERE id = ?').run(final.id, usageId)
      send(final)
      emit({ type: 'done', threadId, runId })
      return { status: 'done' }
    }

    const calls = res.toolCalls.map((c) => ({ callId: c.callId, name: c.name, ...inboundArguments(c.arguments, privacy) }))
    const assistant = store.addMessage(db, {
      threadId,
      role: 'assistant',
      content: text,
      toolCalls: calls.map(({ callId, name, input: i }) => ({ callId, name, input: i })),
      reasoning: res.reasoning,
      ...usageFields
    })
    db.prepare('UPDATE ai_usage SET message_id = ? WHERE id = ?').run(assistant.id, usageId)
    send(assistant)

    for (const c of calls) {
      if (signal.aborted) return stopped('')
      // The session can change mid-run (sign-out, another user): re-check before every tool.
      const roleNow = deps.roleNow ? deps.roleNow() : role
      if (roleNow === null) return failed('Signed out — the assistant stopped.')
      emit({ type: 'tool-start', threadId, runId, callId: c.callId, name: c.name, input: c.input })
      const run = await registry.run(c.name, c.args, {
        db, company: deps.company, role: roleNow, userName: deps.user.name, threadId, messageId: assistant.id, today, period, userRequest,
        screen: input.context ?? null
      })
      const output = run.ok ? { ok: true, result: run.data } : { ok: false, error: run.error }
      const sent = sentToolText(output, privacy, budget)
      const sources = run.ok ? run.sources : []
      const toolMsg = store.addMessage(db, {
        threadId, role: 'tool', toolCallId: c.callId, toolName: c.name, toolInput: run.input, toolOutput: output, toolOk: run.ok,
        truncated: sent.truncated, sources, draftId: run.ok ? run.draftId : null, sentText: sent.text, sentPrivacy: sig
      })
      turnSources.push(...sources)
      send(toolMsg)
      if (run.ok && run.draftId) {
        const draft = store.getDraft(db, run.draftId)
        if (draft) emit({ type: 'draft', threadId, runId, draft })
      }
    }
  }

  send(
    store.addMessage(db, {
      threadId,
      role: 'assistant',
      content: `I stopped after ${settings.maxSteps} steps without a final answer. Try a narrower question.`,
      sources: dedupeSources(turnSources),
      model
    })
  )
  emit({ type: 'done', threadId, runId })
  return { status: 'done' }
}
