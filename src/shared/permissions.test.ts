import { describe, it, expect } from 'vitest'
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  capabilityOfChannel,
  denialMessage,
  parseDenials,
  permitsChannel
} from './permissions'

describe('per-user denials', () => {
  it('lets everything through when nothing is denied', () => {
    for (const channel of ['voucher:save', 'payroll:run', 'export:csv', 'report:trialBalance']) {
      expect(permitsChannel([], channel)).toBe(true)
    }
  })

  it('cuts one area out of a role without touching the rest', () => {
    const denials = parseDenials(['payroll'])
    expect(permitsChannel(denials, 'payroll:run')).toBe(false)
    expect(permitsChannel(denials, 'attendance:save')).toBe(false)
    expect(permitsChannel(denials, 'voucher:save')).toBe(true)
    expect(permitsChannel(denials, 'report:trialBalance')).toBe(true)
  })

  it('denies the reports of a denied area too, not just its writes', () => {
    // A payroll denial that still serves the payroll register is decoration.
    const denials = parseDenials(['payroll'])
    expect(permitsChannel(denials, 'payroll:trend')).toBe(false)
    expect(permitsChannel(denials, 'payroll:runs')).toBe(false)
  })

  it('never denies the way back out of the app', () => {
    // Locking someone out of the company picker or the auth flow leaves them stuck.
    const everything = parseDenials([...CAPABILITIES])
    for (const channel of ['company:list', 'company:open', 'company:close', 'auth:login', 'auth:logout', 'log:renderer']) {
      expect(capabilityOfChannel(channel)).toBeNull()
      expect(permitsChannel(everything, channel)).toBe(true)
    }
  })

  it('routes exports away from the area whose data they carry', () => {
    // export:csv of a payroll register is still an export; the denial that matters is "no files
    // leave with this user", and it has to be reachable without denying payroll itself.
    expect(capabilityOfChannel('export:csv')).toBe('exports')
    expect(capabilityOfChannel('backup:exportEncrypted')).toBe('exports')
    expect(capabilityOfChannel('invoice:pdfBatch')).toBe('exports')
  })

  it('reads back whatever the JSON column happens to hold', () => {
    expect(parseDenials(null)).toEqual([])
    expect(parseDenials('payroll')).toEqual([])
    expect(parseDenials(['payroll', 'nonsense', 'payroll', 'gst'])).toEqual(['gst', 'payroll'])
  })

  it('names the area it refused', () => {
    expect(denialMessage('payroll')).toContain('payroll')
    for (const capability of CAPABILITIES) expect(CAPABILITY_LABELS[capability]).toBeTruthy()
  })
})
