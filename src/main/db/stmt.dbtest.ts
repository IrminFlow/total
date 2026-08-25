import { describe, it, expect } from 'vitest'
import { openBigBook } from './bigbook'
import { clearPrepared, prep, preparedCount } from './stmt'
import { saveVoucher } from '../services/vouchers'

/**
 * The prepared-statement cache, and the property it exists for (roadmap K#228).
 *
 * The assertion with teeth is the COUNT, not a time. `saveVoucher` used to compile 26 statements
 * on every save — 233 µs of a 754 µs write on the shared fixture, 31% of the hot path spent
 * re-compiling the same strings. Measured against the same code with the cache cleared before
 * every call, caching them took a save from 1,431 µs to 1,046 µs (minimum of 40 paired runs on a
 * loaded machine, −27%).
 *
 * A timing ceiling would be the obvious test and the wrong one: it would measure the machine. The
 * count is machine-independent, it is the thing the change actually did, and it is what a
 * refactor that reinstates `db.prepare` in the save path would break while every timing still
 * passed.
 */
describe('prepared statements are reused across calls in the hot write path', () => {
  const book = openBigBook({ invoices: 900 })
  const { db } = book
  const party = book.ledgerId('Perf Party 1')
  const sales = book.ledgerId(book.shape.salesLedger)
  const salesType = (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get('sales') as { id: number }).id

  const save = (n: number): void => {
    saveVoucher(db, {
      voucherTypeId: salesType,
      date: '2026-04-01',
      partyLedgerId: party,
      narration: `stmt cache ${n}`,
      reference: null,
      lines: [
        { ledgerId: party, drCr: 'dr', amount: 100000, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 100000, costAllocations: [] }
      ],
      inventory: [],
      billRefs: [],
      tds: null
    })
  }

  /** Count `db.prepare` calls made while `fn` runs, by standing in front of it. */
  function compilesDuring(fn: () => void): number {
    const real = db.prepare.bind(db)
    let n = 0
    const patched = (sql: string): ReturnType<typeof real> => {
      n++
      return real(sql)
    }
    ;(db as unknown as { prepare: unknown }).prepare = patched
    try {
      fn()
    } finally {
      ;(db as unknown as { prepare: unknown }).prepare = real
    }
    return n
  }

  it('compiles a saveVoucher only once, not once per save', () => {
    const first = compilesDuring(() => save(1))
    const second = compilesDuring(() => save(2))
    const third = compilesDuring(() => save(3))
    console.log(`[stmt] saveVoucher compiles: first ${first}, second ${second}, third ${third}`)

    // The first save on a connection pays for everything; the ones after it must not.
    expect(second).toBeLessThan(first)
    expect(third).toBe(second)
    // 26 before the cache. The remaining few are SQL assembled per call — nextVoucherNumber's
    // optional FY and series clauses — which deliberately stay on db.prepare. Raising this
    // number means a statement went back to being compiled on every save; say which, and why.
    expect(
      third,
      'saveVoucher is compiling more SQL per call than it should — has a hot query gone back to db.prepare?'
    ).toBeLessThanOrEqual(5)
  })

  it('hands back the same statement for the same SQL, and forgets it on demand', () => {
    const sql = 'SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL'
    const a = prep(db, sql)
    expect(prep(db, sql)).toBe(a)
    expect(preparedCount(db)).toBeGreaterThan(0)
    clearPrepared(db)
    expect(preparedCount(db)).toBe(0)
    expect(prep(db, sql)).not.toBe(a)
  })

  it('keeps one connection out of another connection cache', () => {
    const other = openBigBook({ invoices: 900 })
    try {
      const sql = 'SELECT COUNT(*) AS n FROM ledgers'
      const mine = prep(db, sql)
      const theirs = prep(other.db, sql)
      // Statements belong to the connection that compiled them. Sharing one across two open
      // companies would run a query against the wrong company's books.
      expect(theirs).not.toBe(mine)
      expect((theirs.get() as { n: number }).n).toBeGreaterThan(0)
    } finally {
      other.close()
    }
  })
})
