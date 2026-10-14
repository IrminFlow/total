// WP 7.1 review — checkStock reads its movements two ways (a save's few items by item; a scan of
// more than 20 — negativeStock / the close checklist — by date, split per item). Both must give
// each item exactly the answer it gets checked on its own, negative items included.
import { describe, it, expect } from 'vitest'
import { freshDb } from '../db/testdb'
import { seedLarge, PERF_TODAY } from '../perf/seedLarge'
import { checkStock } from './vouchers'
import { negativeStock } from './stockAnalysis'
import { addDaysISO } from '@shared/dates'

describe('checkStock: the many-item scan equals checking each item alone', () => {
  const db = freshDb()
  seedLarge(db, { vouchers: 2_000 })
  // No opening stock for most items, so their sales take them below zero (master data only).
  db.prepare('UPDATE stock_items SET opening_qty_milli = 0 WHERE id % 3 <> 0').run()
  const ids = (db.prepare('SELECT id FROM stock_items ORDER BY id').all() as { id: number }[]).map((r) => r.id)

  for (const date of [PERF_TODAY, addDaysISO(PERF_TODAY, -250), addDaysISO(PERF_TODAY, -600)]) {
    it(`as on ${date}`, () => {
      const one = ids.flatMap((id) => checkStock(db, [id], date))
      expect(one.length).toBeGreaterThan(20)
      expect(ids.length).toBeGreaterThan(20)
      expect(checkStock(db, ids, date)).toEqual(one)
      expect(negativeStock(db, date)).toEqual(one)
      // A few items (the save path) in any order: the same rows in master order.
      const few = [ids[7]!, ids[2]!, ids[1]!]
      expect(checkStock(db, few, date)).toEqual(checkStock(db, [...few].sort((a, b) => a - b), date))
    })
  }
})
