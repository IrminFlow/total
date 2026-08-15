import { describe, it, expect } from 'vitest'
import { freshDb, seededDb, postSimpleVoucher } from './testdb'
import { checkIntegrity } from './integrity'

describe('checkIntegrity', () => {
  it('reports ok on a healthy, seeded database', () => {
    const db = seededDb()
    const voucher = postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })
    expect(voucher.id).toBeGreaterThan(0)

    const result = checkIntegrity(db)
    expect(result.quickCheck).toBe('ok')
    expect(result.unbalancedVoucherIds).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('reports the voucher id of an unbalanced voucher', () => {
    const db = seededDb()
    const voucher = postSimpleVoucher(db, { date: '2025-04-10', amount: 50000, kind: 'receipt' })

    const line = db
      .prepare('SELECT id, ledger_id FROM voucher_lines WHERE voucher_id = ? LIMIT 1')
      .get(voucher.id) as { id: number; ledger_id: number }
    // Corrupt the voucher by inserting a lone extra line so debits no longer equal credits.
    db.prepare(
      `INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order)
       VALUES (?, ?, 'dr', 12345, 99)`
    ).run(voucher.id, line.ledger_id)

    const result = checkIntegrity(db)
    expect(result.quickCheck).toBe('ok')
    expect(result.unbalancedVoucherIds).toEqual([voucher.id])
    expect(result.ok).toBe(false)
  })

  it('never throws — reports a failed check if the balance query itself errors', () => {
    const db = freshDb()
    // Simulates the corruption this feature exists to detect: quick_check can pass clean while
    // a later read over real table pages still throws (e.g. a malformed voucher_lines table).
    db.exec('DROP TABLE voucher_lines')

    const result = checkIntegrity(db)
    expect(result.ok).toBe(false)
    expect(result.quickCheck.startsWith('error')).toBe(true)
    expect(result.unbalancedVoucherIds).toEqual([])
  })
})
