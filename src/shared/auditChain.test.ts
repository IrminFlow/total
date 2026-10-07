import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import {
  GENESIS_HASH, auditRowHash, canonicalAuditPayload, clockSkewNote, localIsoWithOffset, mergeRanges, rangeCovered, rowStatuses,
  verificationSummary, verifyAuditChain, type AuditChainRow
} from './auditChain'
import { auditPruneCutoff, statutoryRetentionFloor } from './auditRetention'

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex')

function chain(n: number): AuditChainRow[] {
  const rows: AuditChainRow[] = []
  let prev = GENESIS_HASH
  for (let i = 1; i <= n; i++) {
    const base = {
      id: i, entity: 'voucher', entityId: i, action: 'create', at: '2026-10-07 10:00:00', atIso: '2026-10-07T15:30:00.000+05:30',
      beforeJson: null, afterJson: JSON.stringify({ n: i, name: 'ŚrīGaṇeśa “quoted”\n' }), userName: 'Priya', userId: 1, appVersion: '0.7.0',
      clockSkewNote: null, prevHash: prev
    }
    const rowHash = auditRowHash(base, sha)
    rows.push({ ...base, rowHash })
    prev = rowHash
  }
  return rows
}

describe('audit hash chain', () => {
  it('canonical payload is a fixed-order JSON array covering every column', () => {
    const r = chain(1)[0]!
    const parsed = JSON.parse(canonicalAuditPayload(r)) as unknown[]
    expect(parsed[0]).toBe('total-audit-v1')
    expect(parsed).toHaveLength(14)
    expect(parsed.at(-1)).toBe(GENESIS_HASH)
  })

  it('an intact chain verifies and reports its head', () => {
    const rows = chain(5)
    const v = verifyAuditChain(rows, sha, 5)
    expect(v.ok).toBe(true)
    expect(v.headId).toBe(5)
    expect(v.headHash).toBe(rows[4]!.rowHash)
    expect(verificationSummary(v)).toMatch(/^Chain verified: 5 entries, rows 1–5/)
  })

  it('detects an edited row (altered) and names it as the first break', () => {
    const rows = chain(5)
    rows[2] = { ...rows[2]!, afterJson: '{"n":999}' }
    const v = verifyAuditChain(rows, sha, 5)
    expect(v.ok).toBe(false)
    expect(v.firstBreak).toMatchObject({ rowId: 3, kind: 'altered' })
    expect(rowStatuses(v).get(3)).toBe('altered')
    expect(verificationSummary(v)).toMatch(/BROKEN at row 3/)
  })

  it('detects a deleted row in the middle and at the head', () => {
    const rows = chain(5)
    const middle = rows.filter((r) => r.id !== 3)
    expect(verifyAuditChain(middle, sha, 5).firstBreak).toMatchObject({ rowId: 4, kind: 'link_broken', message: expect.stringContaining('row 3 is missing') })
    const tail = rows.slice(0, 4)
    expect(verifyAuditChain(tail, sha, 5).firstBreak).toMatchObject({ rowId: 4, kind: 'missing_tail' })
    // Without sqlite_sequence the tail deletion is invisible — that's why the head is exported.
    expect(verifyAuditChain(tail, sha, null).ok).toBe(true)
  })

  it('accepts gaps recorded by a prune row, and only those', () => {
    const rows = chain(6).filter((r) => r.id !== 2 && r.id !== 3)
    // A prune row appended at the end that records ids 2-3 — it must be hashed into the chain.
    const head = rows[rows.length - 1]!
    const pruneBase = {
      id: 7, entity: 'audit_log', entityId: 0, action: 'prune', at: '2026-10-07 10:00:00', atIso: null, beforeJson: null,
      afterJson: JSON.stringify({ ranges: [[2, 3]] }), userName: 'system', userId: null, appVersion: '0.7.0', clockSkewNote: null, prevHash: head.rowHash
    }
    const withPrune = [...rows, { ...pruneBase, rowHash: auditRowHash(pruneBase, sha) }]
    const v = verifyAuditChain(withPrune, sha, 7)
    expect(v.ok).toBe(true)
    expect(v.prunedRows).toBe(2)
    // Same deletion without the record is a break.
    expect(verifyAuditChain(rows, sha, 6).ok).toBe(false)
  })

  it('flags a row inserted outside the app (no hash)', () => {
    const rows = chain(3)
    const forged: AuditChainRow = { ...rows[2]!, id: 4, prevHash: null, rowHash: null }
    const v = verifyAuditChain([...rows, forged], sha, 4)
    expect(v.firstBreak).toMatchObject({ rowId: 4, kind: 'unsealed' })
  })

  it('range helpers merge and cover', () => {
    const m = mergeRanges([[5, 6], [1, 2], [3, 3], [9, 9]])
    expect(m).toEqual([[1, 3], [5, 6], [9, 9]])
    expect(rangeCovered(m, 2, 3)).toBe(true)
    expect(rangeCovered(m, 2, 6)).toBe(false)
    expect(rangeCovered(mergeRanges([[1, 3], [4, 6]]), 1, 6)).toBe(true)
    expect(rangeCovered(m, 6, 9)).toBe(false)
    expect(rangeCovered(m, 3, 2)).toBe(false)
  })

  it('clock skew note only when the clock goes backwards', () => {
    expect(clockSkewNote('2026-10-07T10:00:00.000+05:30', null, '2026-10-07T10:00:01.000+05:30')).toBeNull()
    expect(clockSkewNote('2026-10-07T10:00:00.000+05:30', null, '2026-10-07T09:59:00.000+05:30')).toMatch(/went backwards: .* 60s earlier/)
    expect(clockSkewNote(null, '2026-10-07 04:30:00', '2026-10-07T09:59:00.000+05:30')).toMatch(/60s earlier/)
    expect(clockSkewNote(null, null, '2026-10-07T09:59:00.000+05:30')).toBeNull()
  })

  it('local ISO carries the numeric offset', () => {
    const s = localIsoWithOffset(new Date('2026-10-07T04:30:00.123Z'))
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.123[+-]\d{2}:\d{2}$/)
    expect(Date.parse(s)).toBe(Date.parse('2026-10-07T04:30:00.123Z'))
  })
})

describe('audit retention floor (Companies Act s.128(5): 8 preceding FYs + the current one)', () => {
  it('floor is 1 April of current FY start − 8', () => {
    expect(statutoryRetentionFloor('2026-10-07')).toBe('2018-04-01')
    expect(statutoryRetentionFloor('2027-03-31')).toBe('2018-04-01')
    expect(statutoryRetentionFloor('2027-04-01')).toBe('2019-04-01')
  })
  it('cutoff never moves past the floor', () => {
    expect(auditPruneCutoff('2026-10-07', 30)).toBe('2018-04-01')
    expect(auditPruneCutoff('2026-10-07', 5000)).toBe('2013-01-28')
  })
})
