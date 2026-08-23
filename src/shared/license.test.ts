import { describe, it, expect } from 'vitest'
import {
  TRIAL_DAYS,
  b64urlEncode,
  decodeLicense,
  licenseState,
  splitLicense,
  type LicensePayload
} from './license'

const payload: LicensePayload = {
  v: 1,
  name: 'Sharma Traders',
  plan: 'annual',
  issued: '2026-04-01',
  expires: '2027-04-01',
  companies: 1
}

const token = (p: Partial<LicensePayload> = {}): string => `${b64urlEncode(JSON.stringify({ ...payload, ...p }))}.sig`

describe('token parsing', () => {
  it('splits a token into its signed part and signature', () => {
    expect(splitLicense('abc.def')).toEqual({ signed: 'abc', signature: 'def' })
    expect(splitLicense('  abc.def  ')).toEqual({ signed: 'abc', signature: 'def' })
  })

  it('rejects anything that is not two non-empty parts', () => {
    for (const bad of ['', 'abc', 'abc.', '.def', 'a.b.c']) {
      expect(splitLicense(bad), bad).toBeNull()
    }
  })

  it('decodes a well-formed payload', () => {
    expect(decodeLicense(token())).toEqual(payload)
  })

  it('refuses payloads it does not understand rather than guessing', () => {
    expect(decodeLicense(token({ v: 2 }))).toBeNull()
    expect(decodeLicense(token({ plan: 'monthly' as never }))).toBeNull()
    expect(decodeLicense(token({ expires: 'next year' as never }))).toBeNull()
    expect(decodeLicense(`${b64urlEncode('not json')}.sig`)).toBeNull()
    expect(decodeLicense('!!!.sig')).toBeNull()
  })
})

describe('trial', () => {
  const trial = (today: string) =>
    licenseState({ today, firstRun: '2026-04-01', payload: null, verified: false })

  it('runs for 30 days with everything working', () => {
    const s = trial('2026-04-01')
    expect(s.kind).toBe('trial')
    expect(s.readOnly).toBe(false)
    expect(s.daysLeft).toBe(TRIAL_DAYS)
  })

  it('counts down', () => {
    expect(trial('2026-04-21').daysLeft).toBe(10)
    expect(trial('2026-04-30').daysLeft).toBe(1)
  })

  it('degrades to read-only rather than locking the books', () => {
    const s = trial('2026-05-02')
    expect(s.kind).toBe('trial-expired')
    expect(s.readOnly).toBe(true)
    // The message has to say what still works, because that is the whole promise.
    expect(s.message).toMatch(/open, read, print, export and back up/)
  })
})

describe('a verified licence', () => {
  const state = (today: string, p: Partial<LicensePayload> = {}) =>
    licenseState({ today, firstRun: '2026-04-01', payload: { ...payload, ...p }, verified: true })

  it('unlocks writing and names the holder', () => {
    const s = state('2026-06-01')
    expect(s.kind).toBe('licensed')
    expect(s.readOnly).toBe(false)
    expect(s.message).toContain('Sharma Traders')
  })

  it('is still valid on its final day', () => {
    expect(state('2027-04-01').kind).toBe('licensed')
    expect(state('2027-04-01').daysLeft).toBe(0)
  })

  it('an expired annual licence goes read-only, never locked', () => {
    const s = state('2027-04-02')
    expect(s.kind).toBe('license-expired')
    expect(s.readOnly).toBe(true)
    expect(s.message).toMatch(/still here/)
    expect(s.message).toMatch(/export and back up/)
  })

  it('a perpetual licence keeps working after its update window closes', () => {
    const s = state('2030-01-01', { plan: 'perpetual' })
    expect(s.kind).toBe('licensed')
    expect(s.readOnly).toBe(false)
    expect(s.message).toMatch(/keeps working/)
  })

  it('outlives the trial it started in', () => {
    // Someone who buys on day 40 must not be read-only because the trial lapsed.
    expect(state('2026-06-01').readOnly).toBe(false)
  })
})

describe('a licence that does not verify', () => {
  it('says so without locking anything, and falls back to trial rules', () => {
    const s = licenseState({
      today: '2026-04-10',
      firstRun: '2026-04-01',
      payload: null,
      verified: false,
      tampered: true
    })
    expect(s.kind).toBe('invalid')
    expect(s.readOnly).toBe(false)
    expect(s.message).toMatch(/didn't verify/)
  })

  it('never trusts a payload main did not verify', () => {
    // The decoded payload alone must not grant anything: this is the forgery path.
    const s = licenseState({ today: '2026-04-10', firstRun: '2026-04-01', payload, verified: false })
    expect(s.kind).toBe('trial')
    expect(s.payload).toBeNull()
  })

  it('an unverified payload cannot outlast the trial either', () => {
    const s = licenseState({ today: '2026-09-01', firstRun: '2026-04-01', payload, verified: false })
    expect(s.kind).toBe('trial-expired')
    expect(s.readOnly).toBe(true)
  })
})
