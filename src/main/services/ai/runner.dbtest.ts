import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb, TEST_INFO, postSimpleVoucher } from '../../db/testdb'
import { startFakeOpenAi } from '../../../../scripts/lib/fake-openai.mjs'
import type { AiFrame } from '@shared/ai/stream'

/**
 * The assistant run end to end, against a real OpenAI SDK talking to a local fake server.
 *
 * Deliberately not an injected fake client: this exercises the SDK's SSE parsing, tool-call
 * fragment reassembly and abort plumbing, which is where a streaming bug would actually live.
 */

let scratch: string
let fake: Awaited<ReturnType<typeof startFakeOpenAi>>

/** Collects frames the way the renderer would, standing in for a WebContents. */
function collector(): { wc: { send: (channel: string, payload: AiFrame) => void; isDestroyed: () => boolean }; frames: AiFrame[] } {
  const frames: AiFrame[] = []
  return {
    frames,
    wc: {
      send: (_channel, payload) => frames.push(payload),
      isDestroyed: () => false
    }
  }
}

async function settle(frames: AiFrame[], ms = 8000): Promise<AiFrame[]> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (frames.some((f) => f.t === 'done')) return frames
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`run did not finish; frames: ${frames.map((f) => f.t).join(', ')}`)
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'total-ai-'))
  process.env.TOTAL_DATA_DIR = scratch
  fake = await startFakeOpenAi()
})

afterEach(async () => {
  await fake.close()
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.TOTAL_DATA_DIR
})

async function configure(overrides: Record<string, unknown> = {}): Promise<void> {
  const { writeConfigFromSettings } = await import('./config')
  const { DEFAULT_AI_CONFIG } = await import('@shared/ai/config')
  writeConfigFromSettings({
    ...DEFAULT_AI_CONFIG,
    baseUrl: fake.url,
    model: 'fake-small',
    apiKey: 'sk-test-not-a-real-key',
    ...overrides
  } as never)
}

async function run(db: ReturnType<typeof seededDb>, question: string): Promise<AiFrame[]> {
  const { startRun } = await import('./runner')
  const { frames, wc } = collector()
  startRun({
    db,
    slug: 'test-co',
    info: TEST_INFO,
    today: '2025-06-15',
    question,
    wc: wc as never
  })
  return settle(frames)
}

describe('assistant run', () => {
  it('streams an answer and reports the endpoint it used', async () => {
    await configure()
    fake.push({ kind: 'text', text: 'Your cash balance is 50,000.00 [tb:1].' })
    const frames = await run(seededDb(), 'what is my cash balance?')

    const start = frames.find((f) => f.t === 'start')
    expect(start).toBeDefined()
    expect(start).toMatchObject({ model: 'fake-small', local: true })

    const text = frames.filter((f) => f.t === 'delta').map((f) => (f as { text: string }).text).join('')
    expect(text).toBe('Your cash balance is 50,000.00 [tb:1].')
    expect(frames.at(-1)).toMatchObject({ t: 'done', finish: 'stop' })
  })

  it('runs a tool, feeds the result back, and answers from it', async () => {
    await configure()
    const db = seededDb()
    postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })

    fake.push({ kind: 'tool', calls: [{ name: 'trial_balance', args: { asOn: '2025-06-15' } }] })
    fake.push({ kind: 'text', text: 'Cash stands at 50,000.00 [tb:1].' })

    const frames = await run(db, 'trial balance please')

    const call = frames.find((f) => f.t === 'tool_call')
    expect(call).toMatchObject({ name: 'trial_balance' })

    const result = frames.find((f) => f.t === 'tool_result') as { result: { rows: unknown[]; totals: unknown } }
    expect(result.result.rows.length).toBeGreaterThan(0)
    expect(result.result.totals).toBeDefined()

    // The tool result really went back to the model as a tool message.
    const second = fake.requests.at(-1)!.body as { messages: { role: string }[] }
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true)
    expect(frames.at(-1)).toMatchObject({ t: 'done', finish: 'stop' })
  })

  it('reports a bad key as something the user can act on', async () => {
    await configure()
    fake.push({ kind: 'error', status: 401, body: { error: { message: 'nope' } } })
    const frames = await run(seededDb(), 'anything')
    const error = frames.find((f) => f.t === 'error') as { message: string; kind: string }
    expect(error.kind).toBe('auth')
    expect(error.message).toMatch(/API key/)
    expect(frames.at(-1)).toMatchObject({ t: 'done', finish: 'error' })
  })

  it('stops after repeated tool failures instead of looping', async () => {
    await configure()
    for (let i = 0; i < 6; i++) fake.push({ kind: 'tool', calls: [{ name: 'no_such_tool', args: {} }] })
    const frames = await run(seededDb(), 'call a tool that does not exist')
    expect(frames.at(-1)).toMatchObject({ t: 'done' })
    // Bounded: it must not have burned every allowed iteration on a failing call.
    expect(frames.filter((f) => f.t === 'tool_call').length).toBeLessThanOrEqual(2)
  })

  it('a cancelled run stops and leaves nothing behind', async () => {
    await configure()
    fake.push({ kind: 'hang', ms: 4000 })
    const { startRun, abortRun, activeRuns } = await import('./runner')
    const { frames, wc } = collector()
    const runId = startRun({
      db: seededDb(),
      slug: 'test-co',
      info: TEST_INFO,
      today: '2025-06-15',
      question: 'slow one',
      wc: wc as never
    })
    expect(activeRuns()).toBe(1)
    expect(abortRun(runId)).toBe(true)
    await settle(frames)
    expect(frames.at(-1)).toMatchObject({ t: 'done', finish: 'cancelled' })
    expect(activeRuns()).toBe(0)
  })

  it('refuses a fourth live run instead of silently exceeding the concurrency cap', async () => {
    await configure()
    const { startRun, abortAll, activeRuns } = await import('./runner')
    const db = seededDb()
    const { wc } = collector()
    const hangingClient = {
      async *stream({ signal }: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      },
      async listModels() { return [] as string[] }
    }
    const options = {
      db,
      slug: 'test-co',
      info: TEST_INFO,
      today: '2025-06-15',
      question: 'keep this open',
      wc: wc as never,
      client: hangingClient as never
    }

    startRun(options)
    startRun(options)
    startRun(options)
    expect(activeRuns()).toBe(3)
    expect(() => startRun(options)).toThrow(/already has 3 questions running/)
    expect(activeRuns()).toBe(3)

    abortAll()
    const deadline = Date.now() + 2000
    while (activeRuns() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(activeRuns()).toBe(0)
    db.close()
  })

  it('never sends a GSTIN, whatever the tools return', async () => {
    await configure()
    const db = seededDb()
    const gstin = '27AAPFU0939F1ZV'
    db.prepare("UPDATE ledgers SET gstin = ? WHERE name = 'Cash'").run(gstin)
    postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })

    fake.push({ kind: 'tool', calls: [{ name: 'trial_balance', args: {} }] })
    fake.push({ kind: 'tool', calls: [{ name: 'search', args: { query: 'Cash' } }] })
    fake.push({ kind: 'text', text: 'Done.' })

    await run(db, 'tell me about Cash')

    // Guard against a vacuous pass: the tools must actually have run and shipped book data to
    // the endpoint. If nothing was sent, "the GSTIN wasn't sent" proves nothing.
    expect(fake.sentText()).toContain('Cash')
    expect(fake.requests.filter((r) => r.url?.includes('chat')).length).toBeGreaterThan(1)

    expect(fake.sentText()).not.toContain(gstin)
    expect(fake.sentText()).not.toContain('AAPFU0939F')
  })

  it('sends the grounding rules with every run', async () => {
    await configure()
    fake.push({ kind: 'text', text: 'ok' })
    await run(seededDb(), 'hello')
    const first = fake.requests.find((r) => r.url?.includes('chat'))!.body as {
      messages: { role: string; content: string }[]
    }
    const system = first.messages.find((m) => m.role === 'system')!.content
    expect(system).toMatch(/Never state a number you did not read/)
    expect(system).toMatch(/no tool that writes/)
    expect(system).toContain('Test Co')
  })
})
