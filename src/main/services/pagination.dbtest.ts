import { describe, it, expect } from 'vitest'
import { openBigBook } from '../db/bigbook'
import { seededDb, TEST_INFO } from '../db/testdb'
import { saveVoucher, deleteVoucher } from './vouchers'
import { createLedger } from './masters'
import * as reports from './reports'
import { decodeCursor } from '@shared/keyset'

/**
 * Where keyset pagination breaks, tested on purpose.
 *
 * A cursor is a promise that the rows after it are exactly the rows the reader has not seen. The
 * promise fails at a page boundary where the leading sort key repeats — the same date on the last
 * row of one page and the first row of the next — and it fails silently: the reader sees a
 * plausible list with a voucher missing from the middle of it, and finds out at the trial balance.
 *
 * So these walk the whole book a page at a time and compare the result against the unpaged
 * answer, row for row. The fixture deliberately repeats dates (see bigbook.ts).
 */

const FIXTURE = { invoices: 900 }

describe('day book pages', () => {
  const book = openBigBook(FIXTURE)
  const { db } = book
  const { from, to } = book.shape

  it('walks the whole book with no row repeated and none skipped', () => {
    const whole = reports.dayBook(db, from, to)
    expect(whole.length).toBeGreaterThan(1000)

    const walked: typeof whole = []
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const page: typeof whole = reports.dayBook(db, from, to, { limit: 137, after: cursor })
      if (page.length === 0) break
      walked.push(...page)
      cursor = reports.dayBookCursor(page[page.length - 1]!)
      pages++
      expect(pages, 'page walk did not terminate').toBeLessThan(1000)
    }

    // 137 is deliberately not a divisor of the row count, so the last page is a short one.
    expect(walked.map((r) => r.voucherId)).toEqual(whole.map((r) => r.voucherId))
    expect(new Set(walked.map((r) => r.voucherId)).size).toBe(whole.length)
  })

  it('crosses a boundary that falls inside a single date', () => {
    const whole = reports.dayBook(db, from, to)
    // Find a page size whose boundary row shares its date with the row after it — the case a
    // date-only cursor gets wrong.
    const cut = whole.findIndex((r, i) => i > 0 && i < whole.length - 1 && whole[i + 1]!.date === r.date)
    expect(cut, 'fixture has no two vouchers sharing a date').toBeGreaterThan(0)

    const first = reports.dayBook(db, from, to, { limit: cut + 1 })
    const next = reports.dayBook(db, from, to, {
      limit: 50,
      after: reports.dayBookCursor(first[first.length - 1]!)
    })
    expect(first[first.length - 1]!.date).toBe(next[0]!.date)
    expect(next[0]!.voucherId).toBe(whole[cut + 1]!.voucherId)
    expect(next.map((r) => r.voucherId)).toEqual(whole.slice(cut + 1, cut + 51).map((r) => r.voucherId))
  })

  it('gives the same rows as the offset path it replaces', () => {
    const whole = reports.dayBook(db, from, to)
    const byOffset = reports.dayBook(db, from, to, { limit: 200, offset: 400 })
    const cursor = reports.dayBookCursor(whole[399]!)
    const byCursor = reports.dayBook(db, from, to, { limit: 200, after: cursor })
    expect(byCursor).toEqual(byOffset)
  })

  it('ends with a complete last page and then an empty one', () => {
    const whole = reports.dayBook(db, from, to)
    const tailStart = whole.length - 10
    const last = reports.dayBook(db, from, to, { limit: 500, after: reports.dayBookCursor(whole[tailStart - 1]!) })
    // The last page is every remaining row, not a truncated one.
    expect(last).toHaveLength(10)
    expect(last[last.length - 1]!.voucherId).toBe(whole[whole.length - 1]!.voucherId)
    expect(reports.dayBook(db, from, to, { limit: 500, after: reports.dayBookCursor(last[last.length - 1]!) })).toEqual([])
  })

  it('ignores a malformed cursor rather than throwing the screen away', () => {
    const first = reports.dayBook(db, from, to, { limit: 5 })
    expect(reports.dayBook(db, from, to, { limit: 5, after: 'not-a-cursor' })).toEqual(first)
    expect(reports.dayBook(db, from, to, { limit: 5, after: null })).toEqual(first)
  })

  it('carries every field the single-query version produced', () => {
    // The two-phase rewrite reassembles each row in JavaScript. Any field it forgets would show as
    // an empty column on a screen nobody re-reads, so the shape is asserted, not eyeballed.
    const row = reports.dayBook(db, from, to, { limit: 1 })[0]!
    expect(row.account).not.toBe('')
    expect(row.voucherType).toBeTruthy()
    expect(row.kind).toBeTruthy()
    expect(row.number).toBeTruthy()
    expect(row.debit + row.credit).toBeGreaterThan(0)
    expect(row.isOptional).toBe(false)
    expect(row.postDated).toBe(false)
  })
})

describe('ledger statement pages', () => {
  const book = openBigBook(FIXTURE)
  const { db } = book
  const { from, to } = book.shape
  const ledgerId = book.ledgerId(book.shape.salesLedger)

  it('walks every row once, in the same order, with the same running balance', () => {
    const whole = reports.ledgerStatement(db, ledgerId, from, to)
    expect(whole.rows.length).toBe(FIXTURE.invoices)

    const walked: typeof whole.rows = []
    let cursor: string | null | undefined = null
    let pages = 0
    for (;;) {
      const page = reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: 61, after: cursor })
      walked.push(...page.rows)
      // Every page reports the period's figures, not the page's — that is what "a paged statement
      // still foots" means.
      expect(page.opening).toBe(whole.opening)
      expect(page.closing).toBe(whole.closing)
      expect(page.totalDebit).toBe(whole.totalDebit)
      expect(page.totalCredit).toBe(whole.totalCredit)
      expect(page.totalRows).toBe(whole.rows.length)
      if (!page.nextCursor) break
      cursor = page.nextCursor
      pages++
      expect(pages).toBeLessThan(1000)
    }

    // The running balance is the assertion that matters: it is cumulative, so a repeated or
    // skipped row anywhere shifts every row after it.
    expect(walked).toEqual(whole.rows)
  })

  it('starts each page from the balance the previous page ended on', () => {
    const whole = reports.ledgerStatement(db, ledgerId, from, to)
    const first = reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: 50 })
    const second = reports.ledgerStatement(db, ledgerId, from, to, undefined, {
      limit: 50,
      after: first.nextCursor
    })
    const lastOfFirst = first.rows[first.rows.length - 1]!
    const firstOfSecond = second.rows[0]!
    expect(firstOfSecond.running).toBe(lastOfFirst.running + firstOfSecond.debit - firstOfSecond.credit)
    expect(second.rows).toEqual(whole.rows.slice(50, 100))
  })

  it('reports no next cursor on the last page', () => {
    const whole = reports.ledgerStatement(db, ledgerId, from, to)
    const tail = reports.ledgerStatement(db, ledgerId, from, to, undefined, {
      limit: 500,
      after: reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: whole.rows.length - 7 }).nextCursor
    })
    expect(tail.rows).toHaveLength(7)
    expect(tail.nextCursor).toBeNull()
    expect(tail.rows).toEqual(whole.rows.slice(-7))
  })

  it('carries a four-part cursor, because the first three keys all repeat', () => {
    const page = reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: 3 })
    expect(decodeCursor(page.nextCursor)).toHaveLength(4)
  })

  it('agrees with the offset path it replaces', () => {
    const byOffset = reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: 40, offset: 120 })
    const head = reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: 120 })
    const byCursor = reports.ledgerStatement(db, ledgerId, from, to, undefined, { limit: 40, after: head.nextCursor })
    expect(byCursor.rows).toEqual(byOffset.rows)
    expect(byCursor.closing).toBe(byOffset.closing)
  })
})

describe('paging respects the bin', () => {
  /**
   * A voucher moved to the bin must leave both the page and the count, on every path. Built small
   * and from scratch rather than on the shared fixture, because it deletes.
   */
  function tinyBook(): { db: ReturnType<typeof seededDb>; ledgerId: number; ids: number[] } {
    const db = seededDb()
    const salesGroup = (db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }).id
    const debtors = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id
    const mk = (name: string, groupId: number): number =>
      createLedger(db, {
        name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
        gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null
      } as Parameters<typeof createLedger>[1]).id
    const sales = mk('Bin Sales', salesGroup)
    const party = mk('Bin Party', debtors)
    const typeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
    const ids: number[] = []
    for (let i = 0; i < 10; i++) {
      // Every voucher on the SAME date, so the id tiebreak is the only thing ordering them.
      ids.push(
        saveVoucher(db, {
          date: '2026-04-01',
          voucherTypeId: typeId,
          partyLedgerId: party,
          narration: `Bin ${i}`,
          reference: null,
          lines: [
            { ledgerId: party, drCr: 'dr', amount: 10000 + i, costAllocations: [] },
            { ledgerId: sales, drCr: 'cr', amount: 10000 + i, costAllocations: [] }
          ],
          inventory: [],
          billRefs: [],
          tds: null
        }).id
      )
    }
    return { db, ledgerId: sales, ids }
  }

  it('skips a binned voucher without leaving a hole in the page', () => {
    const { db, ids } = tinyBook()
    deleteVoucher(db, ids[4]!)
    const all = reports.dayBook(db, '2026-04-01', '2026-04-01')
    expect(all).toHaveLength(9)
    expect(reports.dayBookCount(db, '2026-04-01', '2026-04-01')).toBe(9)

    const walked: number[] = []
    let cursor: string | null = null
    for (;;) {
      const page = reports.dayBook(db, '2026-04-01', '2026-04-01', { limit: 4, after: cursor })
      if (page.length === 0) break
      walked.push(...page.map((r) => r.voucherId))
      cursor = reports.dayBookCursor(page[page.length - 1]!)
    }
    expect(walked).toEqual(all.map((r) => r.voucherId))
    expect(walked).not.toContain(ids[4])
    db.close()
  })

  it('pages ten same-date rows one at a time without repeating any', () => {
    const { db, ledgerId } = tinyBook()
    const whole = reports.ledgerStatement(db, ledgerId, '2026-04-01', '2026-04-01')
    const walked: typeof whole.rows = []
    let cursor: string | null | undefined = null
    for (;;) {
      const page = reports.ledgerStatement(db, ledgerId, '2026-04-01', '2026-04-01', undefined, {
        limit: 1,
        after: cursor
      })
      walked.push(...page.rows)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(walked).toEqual(whole.rows)
    db.close()
  })
})

// Referenced so the unused-import lint (and a reader) can see the fixture's company is the
// standard test company — the pagination behaviour must not depend on company settings.
void TEST_INFO
