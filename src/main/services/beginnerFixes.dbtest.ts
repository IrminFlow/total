// WP 10.8 — the beginner study's fixes on the server side.
//   - A regular business that started its books TODAY is not asked about last month: Taxes opens
//     on the running month (no earlier period offered), Home's GST tile is the running month so
//     far, and Home's "Needs attention" has no month-end checks for a month before the books.
//   - A business that started earlier keeps the return the next GSTR-3B files (unchanged).
import { describe, expect, it } from 'vitest'
import { freshDb } from '../db/testdb'
import { readCompanyInfo } from '../db/seed'
import { applySetup } from './companySetup'
import { simpleTaxes } from './simpleTaxes'
import { simpleHome, simpleHomeAttention } from './simpleHome'
import { createStockItem } from './masters'
import { postIntent } from './simplePost'
import { stockItemInputSchema } from '@shared/schemas'
import type { DB } from '../db/connection'

const TODAY = '2026-10-14'

function trader(startDate: string): DB {
  const db = freshDb()
  applySetup(db, { name: 'Agarwal Traders', stateCode: '27', businessType: 'trader', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'monthly', stock: true, startDate, fresh: startDate === TODAY }, TODAY)
  return db
}

describe('WP 10.8: GST periods start with the books', () => {
  it('a business started today: Taxes on the running month only; Home tile so far; no last-month checks', () => {
    const db = trader(TODAY)
    const company = readCompanyInfo(db)
    const x = simpleTaxes(db, company, {}, TODAY)
    if (x.kind !== 'regular') throw new Error('regular expected')
    expect(x.period).toMatchObject({ period: '2026-10', soFar: true })
    expect(x.periods.map((p) => p.period)).toEqual(['2026-10'])
    const home = simpleHome(db, company, { today: TODAY, backups: [] })
    expect(home.gst?.kind === 'regular' && home.gst.row).toMatchObject({ period: '2026-10', soFar: true, from: '2026-10-01', to: TODAY })
    expect(simpleHomeAttention(db, company, TODAY).items.filter((i) => i.source === 'close')).toEqual([])
  })

  it('stock sold before its purchase was recorded is a Home attention row today', () => {
    const db = freshDb()
    applySetup(db, { name: 'Ramesh Kirana', stateCode: '27', businessType: 'retail', gst: 'no', gstin: null, filing: null, stock: true, startDate: '2026-04-01', fresh: true }, TODAY)
    const company = readCompanyInfo(db)
    const unit = (db.prepare("SELECT id FROM units WHERE symbol = 'Pcs'").get() as { id: number }).id
    const soap = createStockItem(db, stockItemInputSchema.parse({ name: 'Soap', unitId: unit }))
    expect(simpleHomeAttention(db, company, TODAY).items.some((i) => i.key === 'negative_stock')).toBe(false)
    postIntent(db, company, { clientId: 'neg-stock-sale-0001', kind: 'sale', date: TODAY, items: [{ itemId: soap.id, qty: '2', rate: '40' }], payment: { how: 'cash' } }, TODAY)
    const row = simpleHomeAttention(db, company, TODAY).items.find((i) => i.key === 'negative_stock')
    expect(row).toMatchObject({ source: 'stock', count: 1, level: 'high' })
  })

  it('a business that started at the FY start keeps the return due next (September)', () => {
    const db = trader('2026-04-01')
    const company = readCompanyInfo(db)
    const x = simpleTaxes(db, company, {}, TODAY)
    if (x.kind !== 'regular') throw new Error('regular expected')
    expect(x.period).toMatchObject({ period: '2026-09', soFar: false })
    expect(x.periods.map((p) => p.period)).toContain('2026-04')
    expect(x.running).toBeUndefined()
    // A GST sale today: September stays the default (its return is due next) and the running
    // month is said beside it, from the same GSTR-3B figures.
    postIntent(db, company, { clientId: 'running-sale-00001', kind: 'sale', date: TODAY, amount: { amount: 1_000_00, gstRate: 18 }, payment: { how: 'cash' } }, TODAY)
    const y = simpleTaxes(db, company, {}, TODAY)
    if (y.kind !== 'regular') throw new Error('regular expected')
    expect(y.period.period).toBe('2026-09')
    expect(y.running).toMatchObject({ period: { period: '2026-10', soFar: true }, collected: 180_00, onPurchases: 0 })
    const oct = simpleTaxes(db, company, { period: '2026-10' }, TODAY)
    expect(oct.kind === 'regular' && oct.figures.collected).toBe(180_00)
    expect(oct.kind === 'regular' && oct.running).toBeUndefined()
  })
})
