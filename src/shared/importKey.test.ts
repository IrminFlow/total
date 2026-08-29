import { describe, it, expect } from 'vitest'
import { voucherFingerprint, type FingerprintSource } from './importKey'

const voucher: FingerprintSource = {
  vchType: 'Sales',
  date: '2026-04-11',
  number: 'INV-104',
  party: 'Kumar Traders',
  lines: [
    { ledger: 'Kumar Traders', drCr: 'dr', amount: 118000 },
    { ledger: 'Sales', drCr: 'cr', amount: 100000 },
    { ledger: 'Output CGST', drCr: 'cr', amount: 9000 },
    { ledger: 'Output SGST', drCr: 'cr', amount: 9000 }
  ]
}

describe('voucherFingerprint', () => {
  it('is the same for the same voucher exported twice', () => {
    expect(voucherFingerprint(voucher)).toBe(voucherFingerprint({ ...voucher }))
  })

  it('ignores line order — Tally does not promise it between exports', () => {
    const reordered = { ...voucher, lines: [...voucher.lines].reverse() }
    expect(voucherFingerprint(reordered)).toBe(voucherFingerprint(voucher))
  })

  it('ignores case and stray spacing in names', () => {
    const messy = {
      ...voucher,
      vchType: ' SALES ',
      number: ' inv-104 ',
      party: 'kumar traders',
      lines: voucher.lines.map((l) => ({ ...l, ledger: ` ${l.ledger.toUpperCase()} ` }))
    }
    expect(voucherFingerprint(messy)).toBe(voucherFingerprint(voucher))
  })

  it('changes when a single paisa changes', () => {
    const nudged = {
      ...voucher,
      lines: voucher.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 1 } : l))
    }
    expect(voucherFingerprint(nudged)).not.toBe(voucherFingerprint(voucher))
  })

  it('changes with the date, the number, the type and the party', () => {
    expect(voucherFingerprint({ ...voucher, date: '2026-04-12' })).not.toBe(voucherFingerprint(voucher))
    expect(voucherFingerprint({ ...voucher, number: 'INV-105' })).not.toBe(voucherFingerprint(voucher))
    expect(voucherFingerprint({ ...voucher, vchType: 'Purchase' })).not.toBe(voucherFingerprint(voucher))
    expect(voucherFingerprint({ ...voucher, party: 'Someone Else' })).not.toBe(voucherFingerprint(voucher))
  })

  it('prefers Tally\'s own GUID when the export carries one', () => {
    const withGuid = { ...voucher, guid: 'abc-123' }
    expect(voucherFingerprint(withGuid)).toBe('guid:ABC-123')
    // …and then the contents no longer matter: it is the same voucher, edited in Tally.
    expect(voucherFingerprint({ ...withGuid, number: 'INV-999' })).toBe(voucherFingerprint(withGuid))
  })

  it('carries the shape of the voucher in plain sight, not only in the hash', () => {
    // A hash collision alone must never be able to merge two vouchers: the line count and the
    // debit total are part of the key itself.
    const key = voucherFingerprint(voucher)
    expect(key).toContain('|4|118000|')
  })

  it('tells two same-day same-total vouchers of one party apart by number', () => {
    const second = { ...voucher, number: 'INV-105' }
    expect(voucherFingerprint(second)).not.toBe(voucherFingerprint(voucher))
  })
})
