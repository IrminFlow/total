import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AI_CONFIG,
  aiConfigSchema,
  endpointHost,
  isInsecureEndpoint,
  isLocalEndpoint,
  mergeAiConfig
} from './config'
import { mapProviderError, NO_KEY_ERROR } from './errors'
import { capRows, RunBudget, DEFAULT_ROW_CAP } from './truncate'
import { Pseudonymiser, maskGstin, redact, REDACTED_KEYS } from './redact'
import { buildSystemPrompt } from './prompts'

describe('AI config', () => {
  it('is off-by-default shaped: no key, conservative caps', () => {
    expect(DEFAULT_AI_CONFIG.egress).toBe('full')
    expect(DEFAULT_AI_CONFIG.consentedHost).toBe('')
    expect(DEFAULT_AI_CONFIG.sessionCapPaise).toBeGreaterThan(0)
    expect(DEFAULT_AI_CONFIG.visionModel).toBe('')
  })

  it('merges older or corrupt persisted JSON without throwing', () => {
    expect(mergeAiConfig(undefined)).toEqual(DEFAULT_AI_CONFIG)
    expect(mergeAiConfig(null)).toEqual(DEFAULT_AI_CONFIG)
    expect(mergeAiConfig('nonsense')).toEqual(DEFAULT_AI_CONFIG)
    expect(mergeAiConfig({ model: 'llama3' }).model).toBe('llama3')
    // A value of the wrong type falls back to all-defaults rather than exploding at startup.
    expect(mergeAiConfig({ maxTokens: 'lots' })).toEqual(DEFAULT_AI_CONFIG)
  })

  it('rejects caps outside the allowed range', () => {
    expect(aiConfigSchema.safeParse({ ...DEFAULT_AI_CONFIG, maxTokens: 10 }).success).toBe(false)
    expect(aiConfigSchema.safeParse({ ...DEFAULT_AI_CONFIG, sessionCapPaise: -1 }).success).toBe(false)
  })

  it('recognises endpoints that run on this machine', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://ollama.local/v1']) {
      expect(isLocalEndpoint(url), url).toBe(true)
    }
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false)
    expect(isLocalEndpoint('not a url')).toBe(false)
  })

  it('treats plaintext http as insecure unless it is local', () => {
    expect(isInsecureEndpoint('http://api.example.com/v1')).toBe(true)
    expect(isInsecureEndpoint('http://localhost:11434/v1')).toBe(false)
    expect(isInsecureEndpoint('https://api.openai.com/v1')).toBe(false)
  })

  it('names the host only — a URL can carry a key in its query string', () => {
    expect(endpointHost('https://api.example.com/v1?key=sk-secret')).toBe('api.example.com')
  })
})

describe('provider error mapping', () => {
  const ctx = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 60000 }

  it('maps each failure to something the user can act on', () => {
    expect(mapProviderError({ status: 401 }, ctx).kind).toBe('auth')
    expect(mapProviderError({ status: 403 }, ctx).kind).toBe('forbidden')
    expect(mapProviderError({ status: 404 }, ctx).kind).toBe('model-not-found')
    expect(mapProviderError({ status: 429 }, ctx).kind).toBe('rate-limit')
    expect(mapProviderError({ status: 429, code: 'insufficient_quota' }, ctx).kind).toBe('quota')
    expect(mapProviderError({ status: 503 }, ctx).kind).toBe('server')
    expect(mapProviderError({ code: 'context_length_exceeded' }, ctx).kind).toBe('context-overflow')
  })

  it('distinguishes no-network from nothing-listening', () => {
    expect(mapProviderError({ cause: { code: 'ENOTFOUND' } }, ctx).kind).toBe('offline')
    expect(mapProviderError({ cause: { code: 'ECONNREFUSED' } }, ctx).kind).toBe('refused')
  })

  it('points a refused local endpoint at the thing that should be running', () => {
    const local = { baseUrl: 'http://localhost:11434/v1', model: 'llama3' }
    expect(mapProviderError({ cause: { code: 'ECONNREFUSED' } }, local).message).toMatch(/Ollama|LM Studio/)
  })

  it('says nothing on a user cancellation', () => {
    const m = mapProviderError({ name: 'AbortError' }, ctx)
    expect(m.kind).toBe('cancelled')
    expect(m.message).toBe('')
  })

  it('marks only the transient failures retryable', () => {
    expect(mapProviderError({ status: 429 }, ctx).retryable).toBe(true)
    expect(mapProviderError({ status: 503 }, ctx).retryable).toBe(true)
    expect(mapProviderError({ status: 401 }, ctx).retryable).toBe(false)
  })

  it('never leaks anything key-shaped into a message', () => {
    const cases = [
      mapProviderError({ status: 401, message: 'bad key sk-proj-abc123' }, ctx),
      mapProviderError({ status: 500, message: 'Authorization: Bearer sk-live-xyz' }, ctx),
      NO_KEY_ERROR
    ]
    for (const c of cases) expect(c.message).not.toMatch(/sk-/)
  })
})

describe('tool result caps', () => {
  const rows = (n: number): { i: number }[] => Array.from({ length: n }, (_, i) => ({ i }))

  it('passes a small result through untouched', () => {
    const env = capRows(rows(3))
    expect(env.truncated).toBe(false)
    expect(env.rowCount).toBe(3)
    expect(env.totalRows).toBe(3)
    expect(env.note).toBeUndefined()
  })

  it('cuts to the row cap and says how much was dropped', () => {
    const env = capRows(rows(500))
    expect(env.rowCount).toBe(DEFAULT_ROW_CAP)
    expect(env.totalRows).toBe(500)
    expect(env.truncated).toBe(true)
    expect(env.note).toMatch(/450 more rows omitted/)
    expect(env.note).toMatch(/NOT seen all the data/)
  })

  it('keeps totals computed over every row, so a truncated list still answers correctly', () => {
    const env = capRows(rows(500), { totals: { grandTotal: '12,34,567.00' } })
    expect(env.truncated).toBe(true)
    expect(env.totals).toEqual({ grandTotal: '12,34,567.00' })
  })

  it('trims whole rows to fit the character budget, never half a row', () => {
    const fat = Array.from({ length: 40 }, (_, i) => ({ i, blob: 'x'.repeat(500) }))
    const env = capRows(fat, { charCap: 5000 })
    expect(env.truncated).toBe(true)
    expect(JSON.stringify(env.rows).length).toBeLessThanOrEqual(5000)
    // Every row that survived is intact.
    for (const row of env.rows) expect(row.blob.length).toBe(500)
  })

  it('echoes the period back so a figure cannot be misattributed to other dates', () => {
    const env = capRows(rows(2), { from: '2026-04-01', to: '2026-06-30' })
    expect(env.from).toBe('2026-04-01')
    expect(env.to).toBe('2026-06-30')
  })

  it('includes the narrowing hint in the note', () => {
    expect(capRows(rows(99), { hint: 'filter by ledger' }).note).toMatch(/filter by ledger/)
  })

  it('a run budget stops the tool loop once it is spent', () => {
    const budget = new RunBudget(100)
    expect(budget.spend('x'.repeat(40))).toBe(true)
    expect(budget.exhausted).toBe(false)
    expect(budget.spend('x'.repeat(80))).toBe(false)
    expect(budget.exhausted).toBe(true)
    expect(budget.remaining).toBe(0)
  })
})

describe('redaction', () => {
  it('masks a GSTIN but keeps the state code and check characters', () => {
    expect(maskGstin('27AAPFU0939F1ZV')).toBe('27••••••••••1ZV')
    expect(maskGstin('27AAPFU0939F1ZV')).toHaveLength(15)
    // The embedded PAN is what identifies the party, and none of it survives.
    expect(maskGstin('27AAPFU0939F1ZV')).not.toContain('AAPFU0939F')
  })

  it('removes every always-redacted field at any depth', () => {
    const input = {
      name: 'Sharma Traders',
      gstin: '27AAPFU0939F1ZV',
      pan: 'AAPFU0939F',
      contact: { email: 'a@b.com', phone: '9876543210', ifsc: 'HDFC0001' },
      lines: [{ accountNo: '1234567890', amount: 5000 }]
    }
    const out = redact(input)
    const json = JSON.stringify(out)
    expect(json).not.toContain('AAPFU0939F1ZV')
    expect(json).not.toContain('a@b.com')
    expect(json).not.toContain('9876543210')
    expect(json).not.toContain('1234567890')
    expect(json).not.toContain('HDFC0001')
    // Business data survives — redaction must not make the tools useless.
    expect(out.name).toBe('Sharma Traders')
    expect(out.lines[0]!.amount).toBe(5000)
  })

  it('leaves empty values alone rather than inventing a redaction marker', () => {
    expect(redact({ pan: '' }).pan).toBe('')
    expect(redact({ email: null }).email).toBeNull()
  })

  it('covers the documented key list', () => {
    for (const key of REDACTED_KEYS) {
      const out = redact({ [key]: 'sensitive' }) as Record<string, unknown>
      expect(out[key], key).toBe('[redacted]')
    }
  })

  it('pseudonymises and restores names, including mid-sentence', () => {
    const p = new Pseudonymiser()
    const a = p.code('Sharma Traders')
    const b = p.code('Sharma')
    expect(a).not.toBe(b)
    const sent = p.apply('Sharma Traders owes more than Sharma')
    expect(sent).not.toContain('Sharma Traders')
    expect(p.restore(sent)).toBe('Sharma Traders owes more than Sharma')
  })

  it('gives a stable code for the same name', () => {
    const p = new Pseudonymiser()
    expect(p.code('Acme')).toBe(p.code('Acme'))
    expect(p.size).toBe(1)
  })
})

describe('system prompt', () => {
  const ctx = {
    companyName: 'Demo Traders',
    stateCode: '27',
    gstRegistrationType: 'regular',
    financialYear: { from: '2026-04-01', to: '2027-03-31' },
    today: '2026-08-24'
  }

  it('states the grounding rules the tool layer actually enforces', () => {
    const p = buildSystemPrompt(ctx)
    expect(p).toMatch(/Never state a number you did not read/)
    expect(p).toMatch(/Never do arithmetic/)
    expect(p).toMatch(/truncated/)
    expect(p).toMatch(/no tool that writes/)
    expect(p).toMatch(/Q1 is Apr-Jun/)
  })

  it('carries the company context a question depends on', () => {
    const p = buildSystemPrompt(ctx)
    expect(p).toContain('Demo Traders')
    expect(p).toContain('2026-04-01')
    expect(p).toContain('2026-08-24')
  })

  it('names the screen so "why is this so high?" is answerable', () => {
    expect(buildSystemPrompt({ ...ctx, screen: 'Trial balance' })).toMatch(/looking at the "Trial balance" screen/)
    expect(buildSystemPrompt(ctx)).not.toMatch(/looking at/)
  })

  it('explains the codes when names are redacted', () => {
    expect(buildSystemPrompt({ ...ctx, namesRedacted: true })).toMatch(/replaced with codes/)
  })

  it('is stable — an accidental edit changes every answer', () => {
    expect(buildSystemPrompt(ctx)).toMatchSnapshot()
  })
})
