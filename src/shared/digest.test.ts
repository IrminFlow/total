import { describe, it, expect } from 'vitest'
import { buildDigest, digestHeadline, type DigestAuditRow } from './digest'
import { formatPaise } from './money'

const row = (over: Partial<DigestAuditRow>): DigestAuditRow => ({
  entity: 'voucher',
  entityId: 1,
  action: 'create',
  at: '2026-08-23 10:30:00',
  userName: 'Arun',
  beforeJson: null,
  afterJson: JSON.stringify({ number: 'INV-1', lines: [{ drCr: 'dr', amount: 100000 }] }),
  ...over
})

describe('buildDigest', () => {
  it('says plainly when nothing happened', () => {
    const digest = buildDigest('2026-08-23', [])
    expect(digest.quiet).toBe(true)
    expect(digest.sections).toEqual([])
    expect(digestHeadline(digest, formatPaise)).toMatch(/Nothing/)
  })

  it('separates entries, alterations and the bin', () => {
    const digest = buildDigest('2026-08-23', [
      row({}),
      row({ entityId: 2, action: 'update', beforeJson: JSON.stringify({ number: 'INV-2' }), afterJson: JSON.stringify({ number: 'INV-2' }) }),
      row({ entityId: 3, action: 'delete', afterJson: null, beforeJson: JSON.stringify({ number: 'INV-3' }) })
    ])
    expect(digest.sections.map((s) => s.key)).toEqual(['entered', 'altered', 'binned'])
    expect(digest.totalEvents).toBe(3)
  })

  it('reads a restore as coming back out of the bin, not as an edit', () => {
    const digest = buildDigest('2026-08-23', [
      row({
        action: 'update',
        beforeJson: JSON.stringify({ number: 'INV-9', deletedAt: '2026-08-22 09:00:00' }),
        afterJson: JSON.stringify({ number: 'INV-9', deletedAt: null })
      })
    ])
    expect(digest.sections.map((s) => s.key)).toEqual(['restored'])
  })

  it('totals the value entered, in paise', () => {
    const digest = buildDigest('2026-08-23', [
      row({ afterJson: JSON.stringify({ number: 'A', lines: [{ drCr: 'dr', amount: 150000 }, { drCr: 'cr', amount: 150000 }] }) }),
      row({ entityId: 2, afterJson: JSON.stringify({ number: 'B', lines: [{ drCr: 'dr', amount: 50000 }] }) })
    ])
    expect(digest.enteredValue).toBe(200000)
    expect(digestHeadline(digest, formatPaise)).toContain('2,000.00')
  })

  it('keeps masters apart from entries', () => {
    // "Three entries and a new supplier" is a normal morning; "no entries and four suppliers
    // edited" is worth a second look, and one merged line would hide the difference.
    const digest = buildDigest('2026-08-23', [
      row({ entity: 'ledger', action: 'update', afterJson: JSON.stringify({ name: 'Kumar Traders' }) })
    ])
    expect(digest.sections[0]!.key).toBe('masters')
    expect(digest.sections[0]!.items[0]!.label).toBe('ledger: Kumar Traders')
  })

  it('counts a wrong PIN as a sign-in event and says so', () => {
    const digest = buildDigest('2026-08-23', [
      row({ entity: 'user', action: 'login_failed', userName: 'Arun', afterJson: null })
    ])
    expect(digest.sections[0]!.key).toBe('signIns')
    expect(digest.sections[0]!.items[0]!.label).toContain('wrong PIN')
  })

  it('attributes events to people, busiest first', () => {
    const digest = buildDigest('2026-08-23', [
      row({ userName: 'Arun' }),
      row({ entityId: 2, userName: 'Meena' }),
      row({ entityId: 3, userName: 'Meena' })
    ])
    expect(digest.people).toEqual([
      { userName: 'Meena', events: 2 },
      { userName: 'Arun', events: 1 }
    ])
  })

  it('survives an audit row whose JSON cannot be read', () => {
    const digest = buildDigest('2026-08-23', [row({ afterJson: '{not json' })])
    expect(digest.totalEvents).toBe(1)
    expect(digest.sections[0]!.items[0]!.label).toBe('Voucher #1')
  })

  it('caps the items shown but never the count', () => {
    const many = Array.from({ length: 40 }, (_, i) => row({ entityId: i + 1 }))
    const digest = buildDigest('2026-08-23', many)
    expect(digest.sections[0]!.count).toBe(40)
    expect(digest.sections[0]!.items.length).toBe(12)
  })

  it('reads the time off the audit stamp', () => {
    expect(buildDigest('2026-08-23', [row({ at: '2026-08-23 18:05:41' })]).sections[0]!.items[0]!.time).toBe('18:05')
  })
})
