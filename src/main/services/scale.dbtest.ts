import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { saveVoucher } from './vouchers'
import { createLedger } from './masters'
import * as reports from './reports'
import * as analysis from './analysis'

/**
 * Where the reports actually fall over.
 *
 * Total's reports are unpaginated by design: each one materialises a whole period and ships it
 * over IPC as a single JSON payload. That is fine for a demo company and unknown for a real one,
 * so this measures it rather than assuming. A distributor doing 200 invoices a month for three
 * years is ~7k vouchers and ~30k lines; this builds that scale and records the timings.
 *
 * Not a pass/fail perf gate — thresholds are generous and machine-dependent. It exists so a
 * change that makes a report quadratic shows up here instead of on a customer's books.
 */

/**
 * 4,000 by default keeps this under a few seconds in CI. Raise it to see the shape hold:
 *   SCALE_VOUCHERS=30000 npm run test:db -- scale
 * At 30k vouchers / 60k lines the queries stay in the tens of milliseconds; what grows is the
 * IPC payload, which is what the pagination below addresses.
 */
const VOUCHERS = Number(process.env.SCALE_VOUCHERS ?? 4000)

function bigBook(): { db: ReturnType<typeof seededDb>; cash: number } {
  const db = seededDb()
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
  const debtors = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

  const ledger = (name: string, groupId: number): number =>
    createLedger(db, {
      name,
      groupId,
      openingBalance: 0,
      gstin: null,
      stateCode: null,
      address: null,
      taxType: null,
      gstRate: null,
      hsn: null,
      tdsSectionId: null,
      pan: null,
      creditDays: null,
      creditLimit: null
    }).id

  const sales = ledger('Sales A/c', group.id)
  const parties = Array.from({ length: 40 }, (_, i) => ledger(`Party ${i + 1}`, debtors.id))
  const typeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id

  // One transaction for the whole build: 6000 individual transactions would measure SQLite's
  // fsync, not the reports.
  db.transaction(() => {
    for (let i = 0; i < VOUCHERS; i++) {
      // Spread across exactly three financial years, which is what a business migrating off
      // Tally actually brings with it. Dates repeat; that is realistic and keeps every voucher
      // inside the queried window.
      const day = (i % 28) + 1
      const month = (i % 12) + 1
      const year = 2025 + (i % 3)
      const amount = 100000 + (i % 500) * 137
      saveVoucher(db, {
        date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        voucherTypeId: typeId,
        partyLedgerId: parties[i % parties.length]!,
        narration: `Invoice ${i}`,
        lines: [
          { ledgerId: parties[i % parties.length]!, drCr: 'dr', amount, costAllocations: [] },
          { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }
        ]
      })
    }
  })()

  return { db, cash }
}

function timed<T>(label: string, fn: () => T): { ms: number; result: T } {
  const started = Date.now()
  const result = fn()
  const ms = Date.now() - started
  console.log(`[scale] ${label.padEnd(26)} ${String(ms).padStart(5)} ms`)
  return { ms, result }
}

describe(`reports at ${VOUCHERS.toLocaleString('en-IN')} vouchers`, () => {
  it('records where the time goes', { timeout: 600_000 }, () => {
    const built = timed('build book', bigBook)
    const { db } = built.result
    const lines = (db.prepare('SELECT COUNT(*) AS n FROM voucher_lines').get() as { n: number }).n
    console.log(`[scale] ${'voucher lines'.padEnd(26)} ${String(lines).padStart(5)}`)

    const from = '2025-01-01'
    const to = '2028-12-31'

    // Aggregates: grouped in SQL, so the result is small however big the book is.
    const tb = timed('trialBalance', () => reports.trialBalance(db, to))
    const pl = timed('profitAndLoss', () => reports.profitAndLoss(db, from, to))
    const bs = timed('balanceSheet', () => reports.balanceSheet(db, from, to))
    expect(tb.result.rows.length).toBeLessThan(100)
    expect(pl.ms).toBeLessThan(5000)
    expect(bs.ms).toBeLessThan(5000)

    // Row reports: these return one row per voucher, which is the part that scales with the book.
    const day = timed('dayBook (whole period)', () => reports.dayBook(db, from, to))
    const list = timed('listVouchers', () => reports.dayBook(db, from, to))
    console.log(`[scale] ${'dayBook rows'.padEnd(26)} ${String(day.result.length).padStart(5)}`)
    expect(day.result.length).toBe(VOUCHERS)
    expect(list.ms).toBeLessThan(15000)

    // The payload is what crosses IPC, and it is the number that matters for the renderer.
    const bytes = JSON.stringify(day.result).length
    console.log(`[scale] ${'dayBook payload'.padEnd(26)} ${String(Math.round(bytes / 1024)).padStart(5)} KB`)

    const outstandings = timed('outstandings', () => analysis.outstandings(db, 'receivable', to))
    expect(outstandings.ms).toBeLessThan(15000)

    const register = timed('registerByPeriod month', () => analysis.registerByPeriod(db, 'sales', from, to, 'month'))
    expect(register.result.length).toBeGreaterThan(0)

    // Payload is the number that decided the Day Book fix: the SQL was never slow, but
    // serialising a whole period and structure-cloning it across IPC was. Measure every row
    // report the same way, so paging effort goes where the bytes actually are.
    const ledgerId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Sales A/c'").get() as { id: number }).id
    const payloads: [string, unknown][] = [
      ['dayBook', day.result],
      ['ledgerStatement', reports.ledgerStatement(db, ledgerId, from, to)],
      ['trialBalance', tb.result],
      ['outstandings', outstandings.result],
      ['registerByPeriod', register.result],
      ['stockSummary', reports.stockSummary(db, to)]
    ]
    for (const [name, value] of payloads) {
      const kb = Math.round(JSON.stringify(value).length / 1024)
      console.log(`[scale] payload ${name.padEnd(18)} ${String(kb).padStart(6)} KB`)
    }

    db.close()
  })
})

describe('day book pagination', () => {
  it('returns a window without changing the order, and counts the rest', { timeout: 600_000 }, () => {
    const { db } = bigBook()
    const from = '2025-01-01'
    const to = '2028-12-31'

    const all = reports.dayBook(db, from, to)
    const total = reports.dayBookCount(db, from, to)
    expect(total).toBe(all.length)

    const first = reports.dayBook(db, from, to, { limit: 50 })
    expect(first).toHaveLength(50)
    // The window is the head of the same ordering, not an arbitrary 50 rows.
    expect(first.map((r) => r.voucherId)).toEqual(all.slice(0, 50).map((r) => r.voucherId))

    const second = reports.dayBook(db, from, to, { limit: 50, offset: 50 })
    expect(second.map((r) => r.voucherId)).toEqual(all.slice(50, 100).map((r) => r.voucherId))
    // No overlap: a "Show more" that repeated rows would double-count on screen.
    expect(new Set([...first, ...second].map((r) => r.voucherId)).size).toBe(100)

    // Off the end is empty, not an error.
    expect(reports.dayBook(db, from, to, { limit: 50, offset: total + 10 })).toEqual([])

    // Callers that need the whole book -- the CA pack, the Tally export -- still get it.
    expect(reports.dayBook(db, from, to)).toHaveLength(total)

    // A window is a fraction of the payload, which is the entire point.
    const wholeKb = JSON.stringify(all).length / 1024
    const windowKb = JSON.stringify(first).length / 1024
    console.log(`[scale] payload whole ${Math.round(wholeKb)} KB vs window ${Math.round(windowKb)} KB`)
    expect(windowKb).toBeLessThan(wholeKb / 4)

    db.close()
  })

  it('a paged ledger statement still foots', { timeout: 600_000 }, () => {
    const { db } = bigBook()
    const from = '2025-01-01'
    const to = '2028-12-31'
    const ledgerId = (db.prepare("SELECT id FROM ledgers WHERE name = 'Sales A/c'").get() as { id: number }).id

    const whole = reports.ledgerStatement(db, ledgerId, from, to)
    const page = reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: 50 })

    expect(page.rows).toHaveLength(50)
    expect(page.totalRows).toBe(whole.rows.length)
    // The figures that make a statement a statement are computed over every row, not the page.
    expect(page.opening).toBe(whole.opening)
    expect(page.closing).toBe(whole.closing)
    expect(page.totalDebit).toBe(whole.totalDebit)
    expect(page.totalCredit).toBe(whole.totalCredit)
    // And the page is the head of the same ordering.
    expect(page.rows.map((r) => r.voucherId)).toEqual(whole.rows.slice(0, 50).map((r) => r.voucherId))

    const wholeKb = JSON.stringify(whole).length / 1024
    const pageKb = JSON.stringify(page).length / 1024
    console.log(`[scale] ledgerStatement whole ${Math.round(wholeKb)} KB vs page ${Math.round(pageKb)} KB`)
    expect(pageKb).toBeLessThan(wholeKb / 4)
    db.close()
  })

  it('an outstandings summary omits bills but keeps every figure', { timeout: 600_000 }, () => {
    const { db } = bigBook()
    const asOn = '2028-12-31'
    const full = analysis.outstandings(db, 'receivable', asOn)
    const summary = analysis.outstandings(db, 'receivable', asOn, { includeBills: false })

    expect(summary).toHaveLength(full.length)
    for (const [i, party] of summary.entries()) {
      // The bucket totals and the pending figure are what the screen renders, and they come
      // from every bill regardless of whether the bills themselves were sent.
      expect(party.pending, party.name).toBe(full[i]!.pending)
      expect(party.buckets, party.name).toEqual(full[i]!.buckets)
      expect(party.billCount, party.name).toBe(full[i]!.bills.length)
      expect(party.bills).toEqual([])
    }

    const fullKb = JSON.stringify(full).length / 1024
    const summaryKb = JSON.stringify(summary).length / 1024
    console.log(`[scale] outstandings full ${Math.round(fullKb)} KB vs summary ${Math.round(summaryKb)} KB`)
    expect(summaryKb).toBeLessThan(fullKb / 4)
    db.close()
  })

  it('counts only what is in the books unless asked otherwise', { timeout: 600_000 }, () => {
    const db = seededDb()
    expect(reports.dayBookCount(db, '2025-01-01', '2028-12-31')).toBe(0)
    expect(reports.dayBookCount(db, '2025-01-01', '2028-12-31', true)).toBe(0)
    db.close()
  })
})
