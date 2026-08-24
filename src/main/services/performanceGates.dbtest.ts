import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { dayBook, ledgerStatement, trialBalance } from './reports'

const LINE_TARGET = Math.max(10_000, Number(process.env.TOTAL_LARGE_BOOK_LINES ?? 100_000))
const VOUCHER_TARGET = Math.floor(LINE_TARGET / 2)
const REPORT_BUDGET_MS = 3_000

function seedLargeBook(): { db: ReturnType<typeof seededDb>; cashId: number; voucherLines: number } {
  const db = seededDb()
  const cashId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const salesGroup = db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
  const sales = createLedger(db, {
    name: 'Performance Sales', groupId: salesGroup.id, openingBalance: 0, gstin: null, stateCode: null,
    address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null,
    creditDays: null, exportType: null
  })
  const typeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
  const insertVoucher = db.prepare('INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, ?, ?)')
  const insertLine = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < VOUCHER_TARGET; i++) {
      const month = String((i % 12) + 1).padStart(2, '0')
      const day = String((i % 28) + 1).padStart(2, '0')
      const voucherId = Number(insertVoucher.run(typeId, `2025-${month}-${day}`, `PERF-${i + 1}`).lastInsertRowid)
      const amount = 100 + (i % 100_000)
      insertLine.run(voucherId, cashId, 'dr', amount, 0)
      insertLine.run(voucherId, sales.id, 'cr', amount, 1)
    }
  })()
  db.exec('ANALYZE')
  return { db, cashId, voucherLines: VOUCHER_TARGET * 2 }
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now()
  const value = run()
  return { value, ms: performance.now() - started }
}

describe(`large-book release gates (${LINE_TARGET.toLocaleString()} requested voucher lines)`, () => {
  it('keeps critical reports correct and within their fixed query budget', () => {
    const { db, cashId, voucherLines } = seedLargeBook()
    expect(voucherLines).toBeGreaterThanOrEqual(100_000)

    const tb = timed(() => trialBalance(db, '2026-03-31'))
    expect(tb.value.totalDebit).toBe(tb.value.totalCredit)
    expect(tb.ms).toBeLessThan(REPORT_BUDGET_MS)

    const ledger = timed(() => ledgerStatement(db, cashId, '2025-01-01', '2025-12-31'))
    expect(ledger.value.rows.length).toBe(VOUCHER_TARGET)
    expect(ledger.ms).toBeLessThan(REPORT_BUDGET_MS)

    const april = timed(() => dayBook(db, '2025-04-01', '2025-04-30'))
    expect(april.value.length).toBeGreaterThan(0)
    expect(april.ms).toBeLessThan(REPORT_BUDGET_MS)
  }, 30_000)

  it('keeps ledger/date lookups on named indexes instead of full-scanning voucher lines', () => {
    const { db, cashId } = seedLargeBook()
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT v.id, vl.amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND v.deleted_at IS NULL
       ORDER BY v.date, v.id`
    ).all(cashId, '2025-04-01', '2026-03-31') as Array<{ detail: string }>
    const details = plan.map((row) => row.detail).join('\n')
    expect(details).toMatch(/idx_lines_ledger|idx_lines_ledger_voucher/)
    expect(details).not.toMatch(/SCAN (?:TABLE )?voucher_lines|SCAN vl\b/)
  }, 30_000)
})
