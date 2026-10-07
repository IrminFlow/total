// The agent loop (WP 5.1). One question = one "turn": the user's message is stored, then the
// model is called up to `maxSteps` times; each call may ask for tools (run locally through the
// registry, results stored and sent back) or give the final answer. Everything streams to the
// renderer as AiEvents. Per-thread cancellation (Stop) aborts the in-flight call.
//
// Privacy: what is SENT is the masked / pseudonymised form of the system prompt, the history and
// every tool result (privacy.ts); what is STORED and SHOWN is real. Each call writes one
// ai_outbound_log row (sizes, tools, privacy flags, SHA-256 of the exact payload) and one
// ai_usage row (tokens, estimated cost).
//
// The numbers rule is checked after the answer: money-looking figures are looked up in the
// turn's tool results (numbers.ts) and the panel marks any that are not there.
import { createHash, randomUUID } from 'crypto'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { todayISO } from '@shared/dates'
import type { AiContext, AiEvent, AiMessageDto, AiSettings, AiSource } from '@shared/ai'
import type { Role } from '../services/roles'
import { buildSystemPrompt } from './prompt'
import { mapStrings, outboundText, inboundText, type PrivacyOptions } from './privacy'
import { fitToBudget, DEFAULT_TOOL_RESULT_BUDGET } from './truncate'
import { checkFigures } from './numbers'
import { estimateCostMicroUsd } from './cost'
import { AiAbortError, type AiProvider, type ChatItem, type ChatResult } from './types'
import type { ToolRegistry } from './tools/registry'
import { redactSecrets } from './provider'
import * as store from './store'

// ---------- per-thread runs ----------

export class AgentRuns {
  private readonly runs = new Map<number, { runId: string; controller: AbortController }>()

  start(threadId: number): { runId: string; signal: AbortSignal } {
    if (this.runs.has(threadId)) throw new Error('The assistant is still answering in this conversation — wait or press Stop')
    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(threadId, { runId, controller })
    return { runId, signal: controller.signal }
  }

  end(threadId: number, runId: string): void {
    if (this.runs.get(threadId)?.runId === runId) this.runs.delete(threadId)
  }

  cancel(threadId: number): boolean {
    const r = this.runs.get(threadId)
    if (!r) return false
    r.controller.abort()
    return true
  }

  cancelAll(): void {
    for (const r of this.runs.values()) r.controller.abort()
  }

  running(): Set<number> {
    return new Set(this.runs.keys())
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
  emit: (e: AiEvent) => void
  runs: AgentRuns
  today?: string
  now?: () => number
  toolBudget?: number
  /** Override the default working period (FY of today) when the renderer sends none. */
  period?: { from: string; to: string }
}

export interface AskInput {
  threadId?: number
  text: string
  context?: AiContext
  speed?: 'default' | 'fast'
}

export interface TurnHandle {
  threadId: number
  runId: string
  userMessage: AiMessageDto
  /** Resolves when the turn ends (answered, failed or stopped) — never rejects. */
  finished: Promise<{ status: 'done' | 'error' | 'cancelled'; error?: string }>
}

export const AI_OFF_MESSAGE = 'The assistant is off for this company — turn it on in Settings → AI'

function fyPeriod(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number]
  const start = m >= 4 ? y : y - 1
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` }
}

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Rebuild the conversation for the model from stored messages (real text → outbound form).
 *  A tool call whose result was never stored (stopped mid-tool) is dropped with its call, since
 *  the API refuses a call without an output. */
export function historyItems(messages: readonly AiMessageDto[], privacy: PrivacyOptions, budget: number): { items: ChatItem[]; toolResults: string[] } {
  const out = (s: string): string => outboundText(s, privacy)
  const answered = new Set(messages.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId!))
  const items: ChatItem[] = []
  const toolResults: string[] = []
  for (const m of messages) {
    if (m.role === 'user') items.push({ type: 'message', role: 'user', content: out(m.content) })
    else if (m.role === 'assistant') {
      if (m.content.trim() && m.status !== 'error') items.push({ type: 'message', role: 'assistant', content: out(m.content) })
      for (const c of m.toolCalls) {
        if (answered.has(c.callId)) items.push({ type: 'tool_call', callId: c.callId, name: c.name, arguments: out(JSON.stringify(c.input ?? {})) })
      }
    } else if (m.toolCallId) {
      const fitted = fitToBudget(mapStrings(m.toolOutput, out), budget)
      items.push({ type: 'tool_result', callId: m.toolCallId, output: fitted.text })
      toolResults.push(m.toolName ?? '?')
    }
  }
  return { items, toolResults }
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

export function startTurn(deps: AgentDeps, input: AskInput): TurnHandle {
  const { db, settings } = deps
  if (!settings.enabled || !settings.noticeAcceptedAt) throw new Error(AI_OFF_MESSAGE)
  const text = input.text.trim()
  if (!text) throw new Error('Type a question first')
  let threadId = input.threadId ?? null
  if (threadId !== null && !store.threadExists(db, threadId)) throw new Error('Conversation not found')
  if (threadId === null) threadId = store.createThread(db, text, deps.user.name)
  const { runId, signal } = deps.runs.start(threadId)
  const userMessage = store.addMessage(db, { threadId, role: 'user', content: text })
  deps.emit({ type: 'run-start', threadId, runId, userMessage })
  const tid = threadId
  const finished = runLoop(deps, input, tid, runId, signal)
    .catch((err: unknown) => {
      // Defensive: runLoop handles its own failures; this only catches a bug in that handling.
      const error = redactSecrets(err instanceof Error ? err.message : String(err))
      deps.emit({ type: 'error', threadId: tid, runId, error })
      return { status: 'error' as const, error }
    })
    .finally(() => deps.runs.end(tid, runId))
  return { threadId: tid, runId, userMessage, finished }
}

async function runLoop(
  deps: AgentDeps,
  input: AskInput,
  threadId: number,
  runId: string,
  signal: AbortSignal
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
      tools: tools.map((t) => ({ name: t.name, kind: t.kind })),
      privacy: settings.privacy
    }),
    privacy
  )
  const model = input.speed === 'fast' ? settings.fastModel : settings.defaultModel
  const turnSources: AiSource[] = []
  const turnResults: { name: string; text: string }[] = []

  const stopped = (partial: string): { status: 'cancelled' } => {
    if (partial.trim()) {
      const m = store.addMessage(db, { threadId, role: 'assistant', content: partial, status: 'cancelled', model })
      emit({ type: 'message', threadId, runId, message: m })
    }
    emit({ type: 'cancelled', threadId, runId })
    return { status: 'cancelled' }
  }

  for (let step = 1; step <= settings.maxSteps; step++) {
    if (signal.aborted) return stopped('')
    const history = store.listMessages(db, threadId)
    const { items, toolResults } = historyItems(history, privacy, budget)
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
      payloadSha256: sha256(payload)
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
      store.setOutboundStatus(db, outboundId, aborted ? 'cancelled' : 'error')
      store.recordUsage(db, {
        threadId, messageId: null, provider: provider.name, model, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0,
        costMicroUsd: null, durationMs: now() - t0, ok: false, error: aborted ? 'stopped' : error, day: today
      })
      if (aborted) return stopped(streamed)
      const m = store.addMessage(db, { threadId, role: 'assistant', content: streamed ? `${streamed}\n\n${error}` : error, status: 'error', model })
      emit({ type: 'message', threadId, runId, message: m })
      emit({ type: 'error', threadId, runId, error })
      return { status: 'error', error }
    }
    store.setOutboundStatus(db, outboundId, 'ok')
    const cost = estimateCostMicroUsd(res.usage, settings.prices[res.model] ?? settings.prices[model])
    const usageId = store.recordUsage(db, {
      threadId, messageId: null, provider: provider.name, model: res.model, inputTokens: res.usage.inputTokens, cachedTokens: res.usage.cachedTokens,
      outputTokens: res.usage.outputTokens, reasoningTokens: res.usage.reasoningTokens, costMicroUsd: cost, durationMs: now() - t0, ok: true, day: today
    })
    const text = inboundText(res.text, privacy)
    const usageFields = { model: res.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costMicroUsd: cost }

    if (res.toolCalls.length === 0) {
      const figures = checkFigures(text, turnResults)
      const final = store.addMessage(db, { threadId, role: 'assistant', content: text, figures, sources: dedupeSources(turnSources), ...usageFields })
      db.prepare('UPDATE ai_usage SET message_id = ? WHERE id = ?').run(final.id, usageId)
      emit({ type: 'message', threadId, runId, message: final })
      emit({ type: 'done', threadId, runId })
      return { status: 'done' }
    }

    const calls = res.toolCalls.map((c) => {
      const args = inboundText(c.arguments, privacy)
      let parsed: unknown = args
      try {
        parsed = JSON.parse(args)
      } catch {
        /* the registry reports bad JSON */
      }
      return { callId: c.callId, name: c.name, args, input: parsed }
    })
    const assistant = store.addMessage(db, {
      threadId, role: 'assistant', content: text, toolCalls: calls.map(({ callId, name, input: i }) => ({ callId, name, input: i })), ...usageFields
    })
    db.prepare('UPDATE ai_usage SET message_id = ? WHERE id = ?').run(assistant.id, usageId)
    emit({ type: 'message', threadId, runId, message: assistant })

    for (const c of calls) {
      if (signal.aborted) return stopped('')
      emit({ type: 'tool-start', threadId, runId, callId: c.callId, name: c.name, input: c.input })
      const run = await registry.run(c.name, c.args, {
        db, company: deps.company, role, userName: deps.user.name, threadId, messageId: assistant.id, today, period
      })
      const output = run.ok ? { ok: true, result: run.data } : { ok: false, error: run.error }
      const sent = fitToBudget(mapStrings(output, (s) => outboundText(s, privacy)), budget)
      const sources = run.ok ? run.sources : []
      const toolMsg = store.addMessage(db, {
        threadId, role: 'tool', toolCallId: c.callId, toolName: c.name, toolInput: run.input, toolOutput: output, toolOk: run.ok,
        truncated: sent.truncated, sources, draftId: run.ok ? run.draftId : null
      })
      turnSources.push(...sources)
      turnResults.push({ name: c.name, text: JSON.stringify(output) })
      emit({ type: 'message', threadId, runId, message: toolMsg })
      if (run.ok && run.draftId) {
        const draft = store.getDraft(db, run.draftId)
        if (draft) emit({ type: 'draft', threadId, runId, draft })
      }
    }
  }

  const m = store.addMessage(db, {
    threadId, role: 'assistant',
    content: `I stopped after ${settings.maxSteps} steps without a final answer. Try a narrower question.`,
    sources: dedupeSources(turnSources), model
  })
  emit({ type: 'message', threadId, runId, message: m })
  emit({ type: 'done', threadId, runId })
  return { status: 'done' }
}
