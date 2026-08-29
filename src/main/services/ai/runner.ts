/**
 * The assistant run: prompt, tool loop, streaming, cancellation and spend caps.
 *
 * A run is started by an ordinary `handle()` IPC call that returns a runId immediately; frames
 * then flow to the renderer on the one-way `ai:stream` channel. Nothing about the existing 203
 * request/response handlers changes.
 *
 * The loop is bounded three ways, because an unbounded tool loop against a paid endpoint is the
 * user's money: a per-run iteration cap, a character budget across all tool results, and a wall
 * clock. Whichever trips first ends the run with an explicit `finish` rather than silence.
 */

import { randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { DB } from '../../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { endpointHost, isLocalEndpoint } from '@shared/ai/config'
import { buildSystemPrompt } from '@shared/ai/prompts'
import { DeltaCoalescer, type AiFinish, type AiFrame, type AiFramePayload } from '@shared/ai/stream'
import { Pseudonymiser } from '@shared/ai/redact'
import { RunBudget } from '@shared/ai/truncate'
import { frameToolResult } from '@shared/ai/injection'
import { capVerdict, estimateCostPaise } from '@shared/ai/cost'
import { approxTokens, type PayloadPreview, type PreviewMessage } from '@shared/ai/preview'
import type { VoucherDraftProposal, DraftIssue } from '@shared/ai/draft'
import { fyOf } from '@shared/dates'
import { AiError, makeClient, type ChatClient, type ChatMessage, type ChatToolDef } from './provider'
import { readConfig } from './config'
import { recordSpend, spendSnapshot } from './spend'
import { recordRun } from '../assistantLog'
import { dispatch, TOOLS, type AiToolCtx } from './tools'
import { toJsonSchema } from '@shared/ai/jsonSchema'
import { log } from '../../log'

export const AI_STREAM_CHANNEL = 'ai:stream'

/** Wall clock for one run. Past this the user has been staring at a spinner too long anyway. */
const RUN_TIMEOUT_MS = 60_000
/** Consecutive tool errors before giving up, rather than letting the model loop on a bad call. */
const MAX_TOOL_ERRORS = 2
/** Concurrent runs across the whole app. */
const MAX_CONCURRENT = 3

interface Run {
  controller: AbortController
  wc: WebContents
  startedAt: number
}

const runs = new Map<string, Run>()

export interface StartOptions {
  db: DB
  slug: string
  info: CompanyInfo
  today: string
  question: string
  screen?: string
  history?: { role: 'user' | 'assistant'; content: string }[]
  wc: WebContents
  /** Signed-in user, for the audit trail. Null when nobody has signed in. */
  askedBy?: string | null
  /** Injectable for tests; production passes nothing and gets the real provider. */
  client?: ChatClient
}

function toolDefs(): ChatToolDef[] {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: toJsonSchema(t.params) }
  }))
}

export function abortRun(runId: string): boolean {
  const run = runs.get(runId)
  if (!run) return false
  run.controller.abort()
  runs.delete(runId)
  return true
}

/** Called on company close and window teardown — a run outliving its books is never wanted. */
export function abortAll(): void {
  for (const [id] of runs) abortRun(id)
}

export function activeRuns(): number {
  return runs.size
}

/**
 * Exactly what would be posted for the first request of a run — without posting it.
 *
 * Built by calling the same prompt builder and the same tool definitions the runner uses, so
 * there is no second implementation to drift out of agreement with the first. It contacts
 * nothing: a user with no key, no network and a misconfigured endpoint can still read their own
 * books going out, which is the whole point of offering the view before the decision.
 *
 * Tool results are not shown, because none exist yet — the note says so rather than inventing a
 * plausible one. What the user can check here is the disclosure that is unconditional: the system
 * prompt, the company context, their question, and the fact that no tool in the list writes.
 */
export function buildPreview(opts: {
  info: CompanyInfo
  today: string
  question: string
  screen?: string
  history?: { role: 'user' | 'assistant'; content: string }[]
}): PayloadPreview {
  const config = readConfig()
  const fy = fyOf(opts.today)
  const messages: PreviewMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        companyName: opts.info.name,
        stateCode: opts.info.stateCode,
        gstRegistrationType: opts.info.gstRegistrationType,
        financialYear: { from: fy.from, to: fy.to },
        today: opts.today,
        screen: opts.screen,
        namesRedacted: config.egress === 'names-redacted'
      })
    },
    ...(opts.history ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.question }
  ]
  const characters = messages.reduce((sum, m) => sum + m.content.length, 0)
  const local = isLocalEndpoint(config.baseUrl)
  return {
    host: endpointHost(config.baseUrl),
    model: config.model,
    local,
    messages,
    tools: TOOLS.map((t) => t.name),
    characters,
    estimatedCostPaise: estimateCostPaise(config.model, approxTokens(characters), 500, { local }).paise,
    egress: config.egress
  }
}

export function startRun(opts: StartOptions): string {
  if (runs.size >= MAX_CONCURRENT) {
    for (const [id, run] of runs) {
      if (Date.now() - run.startedAt > RUN_TIMEOUT_MS) abortRun(id)
    }
    if (runs.size >= MAX_CONCURRENT) {
      throw new Error(`The assistant already has ${MAX_CONCURRENT} questions running. Wait for one to finish or cancel it.`)
    }
  }
  const runId = randomUUID()
  const controller = new AbortController()
  runs.set(runId, { controller, wc: opts.wc, startedAt: Date.now() })
  void execute(runId, opts, controller).finally(() => runs.delete(runId))
  return runId
}

async function execute(runId: string, opts: StartOptions, controller: AbortController): Promise<void> {
  const config = readConfig()
  let seq = 0

  const send = (frame: AiFramePayload): void => {
    if (opts.wc.isDestroyed()) {
      controller.abort()
      return
    }
    opts.wc.send(`total:${AI_STREAM_CHANNEL}`, { ...frame, runId, seq: seq++ } as AiFrame)
  }

  const coalescer = new DeltaCoalescer((text) => send({ t: 'delta', text }))
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)
  let finish: AiFinish = 'stop'

  // Collected as the run goes, and written to the audit trail in `finally` — so a run that
  // errors or is cancelled still leaves a record of what was asked and what it read.
  const local = isLocalEndpoint(config.baseUrl)
  const host = endpointHost(config.baseUrl)
  const toolsCalled: string[] = []
  let quarantined = 0
  let answer = ''
  let runCostPaise = 0
  let draft: VoucherDraftProposal | null = null

  try {
    // The cap is checked here, in main, before a single byte is sent. A renderer-side check is
    // an affordance; this is the boundary. A local endpoint is never capped — see shared/ai/cost.
    const before = spendSnapshot(opts.today)
    const verdict = capVerdict({
      sessionPaise: before.sessionPaise,
      todayPaise: before.todayPaise,
      sessionCapPaise: config.sessionCapPaise,
      dailyCapPaise: config.dailyCapPaise,
      local
    })
    if (verdict.blocked) {
      send({ t: 'error', kind: 'cap', message: verdict.message })
      finish = 'cap'
      return
    }

    const client = opts.client ?? makeClient()
    const fy = fyOf(opts.today)
    const pseudo = config.egress === 'names-redacted' ? new Pseudonymiser() : undefined

    send({
      t: 'start',
      model: config.model,
      host: endpointHost(config.baseUrl),
      local: isLocalEndpoint(config.baseUrl)
    })

    const toolCtx: AiToolCtx = {
      db: opts.db,
      slug: opts.slug,
      info: opts.info,
      today: opts.today,
      fyFrom: fy.from,
      fyTo: fy.to,
      pseudo
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          companyName: opts.info.name,
          stateCode: opts.info.stateCode,
          gstRegistrationType: opts.info.gstRegistrationType,
          financialYear: { from: fy.from, to: fy.to },
          today: opts.today,
          screen: opts.screen,
          namesRedacted: pseudo != null
        })
      },
      // Only the last few turns: older tool results are dropped rather than re-sent, which is
      // both cheaper and stops a long session slowly filling the context with stale figures.
      ...(opts.history ?? []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: opts.question }
    ]

    const budget = new RunBudget()
    const defs = toolDefs()
    let toolErrors = 0
    /** Set when a cap is crossed mid-run; the loop stops at the next turn boundary. */
    let capReached: string | null = null

    for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
      let assistantText = ''
      const calls: { id: string; name: string; arguments: string }[] = []
      let sawFinish: 'stop' | 'length' | 'tool_calls' | undefined

      for await (const chunk of client.stream({ messages, tools: defs, signal: controller.signal })) {
        if (chunk.text) {
          assistantText += chunk.text
          coalescer.push(pseudo ? pseudo.restore(chunk.text) : chunk.text)
        }
        if (chunk.toolCalls) calls.push(...chunk.toolCalls)
        if (chunk.usage) {
          send({
            t: 'usage',
            promptTokens: chunk.usage.promptTokens,
            completionTokens: chunk.usage.completionTokens
          })
          const cost = estimateCostPaise(config.model, chunk.usage.promptTokens, chunk.usage.completionTokens, { local })
          runCostPaise += cost.paise
          recordSpend(opts.today, cost.paise, cost.known)
          const after = spendSnapshot(opts.today)
          send({
            t: 'spend',
            runPaise: runCostPaise,
            sessionPaise: after.sessionPaise,
            todayPaise: after.todayPaise,
            priced: cost.known
          })
          // Mid-run, not only at the start: one question that turns into six tool iterations is
          // exactly the shape that runs past a cap, and stopping at the next turn boundary costs
          // the user one exchange rather than five.
          const stop = capVerdict({
            sessionPaise: after.sessionPaise,
            todayPaise: after.todayPaise,
            sessionCapPaise: config.sessionCapPaise,
            dailyCapPaise: config.dailyCapPaise,
            local
          })
          if (stop.blocked) capReached = stop.message
        }
        if (chunk.finish) sawFinish = chunk.finish
      }
      coalescer.flush()
      answer += pseudo ? pseudo.restore(assistantText) : assistantText

      if (capReached) {
        send({ t: 'error', kind: 'cap', message: capReached })
        finish = 'cap'
        break
      }

      if (calls.length === 0) {
        finish = sawFinish === 'length' ? 'length' : 'stop'
        break
      }

      messages.push({
        role: 'assistant',
        content: assistantText,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments }
        }))
      })

      for (const call of calls) {
        let args: unknown = {}
        try {
          args = call.arguments ? (JSON.parse(call.arguments) as unknown) : {}
        } catch {
          args = {}
        }
        send({ t: 'tool_call', name: call.name, args })

        const result = dispatch(toolCtx, call.name, args)
        toolsCalled.push(call.name)

        // The renderer gets the REAL rows; the model gets them quarantined and framed as data.
        // Two different audiences: the human is the one who can tell a hostile narration from an
        // ordinary one, so blanking it for them would remove the only evidence that it existed.
        send({ t: 'tool_result', name: call.name, result })
        const { framed, findings } = frameToolResult(call.name, result)
        quarantined += findings.length
        if (findings.length > 0) {
          log('warn', 'ai-tool-result-quarantined', { tool: call.name, findings: findings.length })
        }
        const serialized = JSON.stringify(framed)

        if ((result as { ok?: boolean }).ok === false) {
          toolErrors++
        } else {
          toolErrors = 0
        }

        // A draft is surfaced to the renderer as its own frame, so the drawer's "open this in the
        // voucher screen" button is wired to the object the validator checked rather than to
        // whatever the model wrote about it afterwards.
        const proposal = (result as { draft?: VoucherDraftProposal; openable?: boolean; summary?: string; issues?: DraftIssue[] })
        if (call.name === 'propose_voucher' && proposal.draft) {
          draft = proposal.draft
          send({
            t: 'draft',
            draft: proposal.draft,
            summary: proposal.summary ?? '',
            openable: proposal.openable === true,
            issues: proposal.issues ?? []
          })
        }

        messages.push({ role: 'tool', tool_call_id: call.id, content: serialized })

        if (!budget.spend(serialized)) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              ok: false,
              error: 'Data budget for this question is spent. Answer from what you already have, and say it is partial.'
            })
          })
          break
        }
      }

      if (toolErrors >= MAX_TOOL_ERRORS) {
        finish = 'error'
        send({ t: 'error', kind: 'tool', message: 'The assistant kept calling a tool that failed. Try rephrasing.' })
        break
      }
      if (budget.exhausted) {
        finish = 'cap'
        break
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      finish = 'cancelled'
    } else if (err instanceof AiError) {
      finish = 'error'
      send({ t: 'error', kind: err.mapped.kind, message: err.mapped.message })
    } else {
      finish = 'error'
      // The message, never the object: a provider error can carry headers.
      log('error', 'ai-run-failed', { message: (err as Error).message })
      send({ t: 'error', kind: 'unknown', message: 'The assistant failed. See Settings → AI.' })
    }
  } finally {
    clearTimeout(timeout)
    coalescer.flush()
    coalescer.dispose()
    try {
      recordRun(opts.db, {
        runId,
        question: opts.question,
        answer: answer || null,
        model: config.model,
        host,
        local,
        tools: toolsCalled,
        quarantined,
        draft,
        costPaise: runCostPaise,
        finish,
        askedBy: opts.askedBy ?? null
      })
    } catch (err) {
      // The trail is provenance, not books: failing to write it must never swallow an answer the
      // user is already reading.
      log('error', 'ai-audit-write-failed', { message: (err as Error).message })
    }
    send({ t: 'done', finish })
  }
}
