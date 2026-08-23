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
import { fyOf } from '@shared/dates'
import { AiError, makeClient, type ChatClient, type ChatMessage, type ChatToolDef } from './provider'
import { readConfig } from './config'
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

export function startRun(opts: StartOptions): string {
  if (runs.size >= MAX_CONCURRENT) {
    for (const [id, run] of runs) {
      if (Date.now() - run.startedAt > RUN_TIMEOUT_MS) abortRun(id)
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

  try {
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
        }
        if (chunk.finish) sawFinish = chunk.finish
      }
      coalescer.flush()

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
        const serialized = JSON.stringify(result)
        send({ t: 'tool_result', name: call.name, result })

        if ((result as { ok?: boolean }).ok === false) {
          toolErrors++
        } else {
          toolErrors = 0
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
    send({ t: 'done', finish })
  }
}
