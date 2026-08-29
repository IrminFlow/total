import { describe, it, expect } from 'vitest'
import { ENDPOINT_PRESETS, applyPreset, matchPreset, presetById } from './presets'
import { MCP_WRITE_LIMIT, TokenBucket } from './rateLimit'
import { AGENT_CHANGELOG, agentChangelogResource, changesSince } from './agentChangelog'
import { alwaysRedactedFields, approxTokens, redactionPreview } from './preview'
import { isLocalEndpoint, isInsecureEndpoint } from './config'

describe('endpoint presets', () => {
  it('offers a local option that needs no key and sends nothing anywhere', () => {
    for (const id of ['ollama', 'lmstudio']) {
      const preset = presetById(id)!
      expect(preset.local, id).toBe(true)
      expect(preset.needsKey, id).toBe(false)
      expect(isLocalEndpoint(preset.baseUrl), id).toBe(true)
      // Plain http is only ever acceptable because it terminates on this machine.
      expect(isInsecureEndpoint(preset.baseUrl), id).toBe(false)
    }
  })

  it('uses 127.0.0.1 rather than localhost for the local servers', () => {
    // On a machine that resolves localhost to ::1 first, an IPv4-only Ollama refuses the
    // connection and the error reads as "Ollama is not running" when it is.
    for (const preset of ENDPOINT_PRESETS.filter((p) => p.local)) {
      expect(preset.baseUrl, preset.id).toContain('127.0.0.1')
    }
  })

  it('pre-consents a local host and re-arms consent for a remote one', () => {
    expect(applyPreset(presetById('ollama')!).consentedHost).toBe('127.0.0.1:11434')
    expect(applyPreset(presetById('openai')!).consentedHost).toBe('')
  })

  it('recognises the preset a saved configuration is already on', () => {
    expect(matchPreset('http://127.0.0.1:11434/v1/')?.id).toBe('ollama')
    expect(matchPreset('https://api.example.com/v1')).toBeUndefined()
  })

  it('says what to do before each preset will work', () => {
    for (const preset of ENDPOINT_PRESETS) {
      expect(preset.hint.length, preset.id).toBeGreaterThan(20)
    }
  })
})

describe('MCP write rate limit', () => {
  it('lets a burst through and then governs', () => {
    let now = 0
    const bucket = new TokenBucket(MCP_WRITE_LIMIT, () => now)
    for (let i = 0; i < MCP_WRITE_LIMIT.capacity; i++) {
      expect(bucket.take().allowed, `write ${i}`).toBe(true)
    }
    expect(bucket.take().allowed).toBe(false)
  })

  it('refuses without consuming, so retrying does not push recovery further away', () => {
    let now = 0
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 }, () => now)
    bucket.take()
    const first = bucket.take()
    const second = bucket.take()
    expect(first.allowed).toBe(false)
    expect(second.retryAfterSeconds).toBe(first.retryAfterSeconds)
  })

  it('names the wait, and honours it', () => {
    let now = 0
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.5 }, () => now)
    bucket.take()
    const refused = bucket.take()
    expect(refused.retryAfterSeconds).toBe(2)
    now += 2000
    expect(bucket.take().allowed).toBe(true)
  })

  it('is generous enough for a human-paced agent', () => {
    // A backfill of a couple of dozen vouchers must not trip it.
    expect(MCP_WRITE_LIMIT.capacity).toBeGreaterThanOrEqual(20)
  })
})

describe('agent changelog', () => {
  it('is dated, append-only and in order', () => {
    const dates = AGENT_CHANGELOG.map((e) => e.date)
    expect([...dates].sort()).toEqual(dates)
    for (const entry of AGENT_CHANGELOG) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.note.length, entry.subject).toBeGreaterThan(30)
    }
  })

  it('answers "what changed since I last looked"', () => {
    expect(changesSince('2099-01-01')).toEqual([])
    expect(changesSince('2026-08-25').every((e) => e.date >= '2026-08-25')).toBe(true)
    expect(changesSince('2000-01-01')).toHaveLength(AGENT_CHANGELOG.length)
  })

  it('tells an agent when its picture of the tools is stale', () => {
    const resource = agentChangelogResource()
    expect(resource.latest).toBe(AGENT_CHANGELOG[AGENT_CHANGELOG.length - 1]!.date)
    expect(resource.note).toMatch(/re-read the tool list/)
  })

  it('warns that a proposed voucher is not a posted one', () => {
    const entry = AGENT_CHANGELOG.find((e) => e.subject.includes('propose_voucher'))!
    expect(entry.note).toMatch(/never writes/i)
  })
})

describe('redaction preview', () => {
  it('runs the real redactor, so it cannot describe rules the code does not have', () => {
    const preview = redactionPreview()
    const fields = preview.withheld.map((w) => w.field)
    expect(fields).toContain('pan')
    expect(fields).toContain('accountNo')
    expect(fields).toContain('ifsc')
    expect(fields).toContain('email')
    expect(fields).toContain('phone')
    expect(fields).toContain('gstin')
  })

  it('shows the GSTIN partially preserved rather than dropped', () => {
    const gstin = redactionPreview().withheld.find((w) => w.field === 'gstin')!
    expect(gstin.after).toBe('27••••••••••1ZV')
    expect(gstin.after).not.toContain('AAPFU0939F')
  })

  it('shows what IS sent, so the trade-off is legible', () => {
    const preview = redactionPreview()
    expect(preview.sent).toContain('name')
    expect(preview.sent).toContain('pending')
    expect(preview.sent).not.toContain('pan')
  })

  it('gives a reason for every withheld field', () => {
    for (const field of redactionPreview().withheld) {
      expect(field.why.length, field.field).toBeGreaterThan(20)
    }
  })

  it('lists the redacted key set for the settings panel', () => {
    const fields = alwaysRedactedFields()
    expect(fields).toEqual([...fields].sort())
    expect(fields).toContain('ifsc')
  })

  it('estimates size in the safe direction', () => {
    expect(approxTokens(4001)).toBe(1001)
  })
})
