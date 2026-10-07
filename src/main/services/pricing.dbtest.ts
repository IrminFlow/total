// WP 2.6 — price lists (levels, slabs, grid, bulk %, copy, CSV), party-wise rates, schemes, the
// resolver end to end against the database, and "remember last price".
import { describe, it, expect } from 'vitest'
import { pricingFixture } from './pricingFixture.testutil'
import {
  bulkUpdateRates, copyLevel, defaultPriceLevel, deletePriceLevel, exportRatesCsv, importRatesCsv, listPriceLevels, listRates,
  rateFor, rateGrid, savePriceLevel, saveRate, setGridRate
} from './priceLevels'
import {
  deletePartyRate, deleteScheme, getPricingConfig, listPartyRates, listSchemes, rememberSalePrices, resolveLines, savePartyRate,
  saveScheme, setPricingConfig
} from './pricing'
import { saveVoucher } from './vouchers'
import { updateLedger, updateStockItem, listStockItems } from './masters'
import type { DB } from '../db/connection'

const sale = (db: DB, f: ReturnType<typeof pricingFixture>, opts: { date: string; party: number; itemId: number; qtyMilli: number; rate: number; discount?: number }): number => {
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
  const gross = Math.round((opts.qtyMilli * opts.rate) / 1000)
  const amount = gross - (opts.discount ?? 0)
  return saveVoucher(db, {
    voucherTypeId: vt, date: opts.date, partyLedgerId: opts.party, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: opts.party, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: f.sales, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [{ stockItemId: opts.itemId, godownId: null, qtyMilli: opts.qtyMilli, ratePaise: opts.rate, discountPaise: opts.discount ?? 0, amount, direction: 'out' }],
    billRefs: [], tds: null
  }).id
}

const purchase = (db: DB, f: ReturnType<typeof pricingFixture>, opts: { date: string; itemId: number; qtyMilli: number; rate: number }): number => {
  const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }).id
  const purchaseAc = (db.prepare("SELECT id FROM groups WHERE name = 'Purchase Accounts'").get() as { id: number }).id
  const acc = Number(db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Purchases', ?) ON CONFLICT DO NOTHING").run(purchaseAc).lastInsertRowid) ||
    (db.prepare("SELECT id FROM ledgers WHERE name = 'Purchases'").get() as { id: number }).id
  const amount = Math.round((opts.qtyMilli * opts.rate) / 1000)
  return saveVoucher(db, {
    voucherTypeId: vt, date: opts.date, partyLedgerId: f.krishna, narration: null, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: acc, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: f.krishna, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [{ stockItemId: opts.itemId, godownId: null, qtyMilli: opts.qtyMilli, ratePaise: opts.rate, amount, direction: 'in' }],
    billRefs: [], tds: null
  }).id
}

const resolve1 = (db: DB, partyId: number | null, itemId: number, qtyMilli: number, date = '2025-10-07') =>
  resolveLines(db, { date, partyLedgerId: partyId, currency: '', supply: 'intra', lines: [{ key: 1, itemId, qtyMilli }] })[0]!.result

describe('price levels and rates', () => {
  it('levels: inclusive flag, one default at a time, delete guarded by assigned ledgers', () => {
    const { db, umbrella } = pricingFixture()
    const retail = savePriceLevel(db, { name: 'Retail', isDefault: true })
    const shop = savePriceLevel(db, { name: 'Shop', inclusiveOfTax: true })
    expect(defaultPriceLevel(db)?.id).toBe(retail.id)
    savePriceLevel(db, { name: 'Shop', isDefault: true }, shop.id)
    expect(defaultPriceLevel(db)?.id).toBe(shop.id)
    expect(listPriceLevels(db).find((l) => l.id === retail.id)?.isDefault).toBe(false)
    expect(listPriceLevels(db).find((l) => l.id === shop.id)).toMatchObject({ inclusiveOfTax: true, isDefault: true })
    // An update without the flags keeps them.
    savePriceLevel(db, { name: 'Shop MRP' }, shop.id)
    expect(listPriceLevels(db).find((l) => l.id === shop.id)).toMatchObject({ name: 'Shop MRP', inclusiveOfTax: true, isDefault: true })
    const l = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(umbrella) as Record<string, unknown>
    void l
    db.prepare('UPDATE ledgers SET price_level_id = ? WHERE id = ?').run(retail.id, umbrella)
    expect(() => deletePriceLevel(db, retail.id)).toThrow(/assigned/)
  })

  it('rates: slabs, end dates, currency rows; rateFor reads the open ₹ base slab', () => {
    const { db, pen } = pricingFixture()
    const lv = savePriceLevel(db, { name: 'Wholesale' })
    saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 1000, effectiveFrom: '2025-04-01', effectiveTo: '2025-09-30' })
    saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 1100, effectiveFrom: '2025-10-01' })
    saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 950, effectiveFrom: '2025-10-01', minQtyMilli: 50_000, discountBp: 200 })
    saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 15, effectiveFrom: '2025-04-01', currency: 'usd' })
    expect(listRates(db, lv.id)).toHaveLength(4)
    expect(rateFor(db, lv.id, pen, '2025-09-30')).toBe(1000)
    expect(rateFor(db, lv.id, pen, '2025-10-01')).toBe(1100)
    expect(rateFor(db, lv.id, pen, '2025-03-31')).toBeNull()
    // Upsert on (level, item, currency, slab, from).
    saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 1150, effectiveFrom: '2025-10-01' })
    expect(rateFor(db, lv.id, pen, '2025-10-02')).toBe(1150)
    expect(listRates(db, lv.id)).toHaveLength(4)
    expect(() => saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 1, effectiveFrom: '2025-10-01', effectiveTo: '2025-09-01' })).toThrow(/end date/)
  })

  it('grid: items × levels as on a date; an inline edit re-prices the row in force or adds one', () => {
    const { db, pen, tea } = pricingFixture()
    const a = savePriceLevel(db, { name: 'A' })
    const b = savePriceLevel(db, { name: 'B' })
    saveRate(db, { priceLevelId: a.id, stockItemId: pen, rate: 1000, effectiveFrom: '2025-04-01' })
    saveRate(db, { priceLevelId: a.id, stockItemId: pen, rate: 900, effectiveFrom: '2025-04-01', minQtyMilli: 10_000 })
    const g = rateGrid(db, '2025-10-07')
    expect(g.levels.map((l) => l.name)).toEqual(['A', 'B'])
    const penRow = g.rows.find((r) => r.itemId === pen)!
    expect(penRow.rates[a.id]).toMatchObject({ rate: 1000, slabs: 1 })
    expect(penRow.rates[b.id]).toBeNull()
    setGridRate(db, a.id, pen, '2025-10-07', 1050) // in place
    setGridRate(db, b.id, tea, '2025-10-07', 5000) // new row from the date
    expect(listRates(db, a.id).filter((r) => r.minQtyMilli === 0)).toHaveLength(1)
    expect(rateFor(db, a.id, pen, '2025-05-01')).toBe(1050)
    expect(rateFor(db, b.id, tea, '2025-10-07')).toBe(5000)
    expect(rateFor(db, b.id, tea, '2025-10-06')).toBeNull()
    setGridRate(db, b.id, tea, '2025-10-07', null)
    expect(listRates(db, b.id)).toHaveLength(0)
  })

  it('bulk %: in place (rounded), or from a date keeping the history; copy level ± %', () => {
    const { db, pen, tea } = pricingFixture()
    const lv = savePriceLevel(db, { name: 'Retail' })
    saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 1049, effectiveFrom: '2025-04-01' })
    saveRate(db, { priceLevelId: lv.id, stockItemId: tea, rate: 20000, effectiveFrom: '2025-04-01' })
    expect(bulkUpdateRates(db, { priceLevelId: lv.id, changeBp: 1000, roundToPaise: 100 }).updated).toBe(2)
    expect(rateFor(db, lv.id, pen, '2025-05-01')).toBe(1200) // 1153.9 → ₹12
    expect(rateFor(db, lv.id, tea, '2025-05-01')).toBe(22000)
    expect(bulkUpdateRates(db, { priceLevelId: lv.id, changeBp: -500, roundToPaise: 1, stockItemIds: [tea], effectiveFrom: '2025-11-01' }).updated).toBe(1)
    expect(rateFor(db, lv.id, tea, '2025-10-31')).toBe(22000)
    expect(rateFor(db, lv.id, tea, '2025-11-01')).toBe(20900)
    expect(rateFor(db, lv.id, pen, '2025-11-01')).toBe(1200)
    const copy = copyLevel(db, { fromLevelId: lv.id, name: 'Wholesale', changeBp: -1000 })
    expect(copy.rateCount).toBe(3)
    expect(rateFor(db, copy.id, tea, '2025-11-01')).toBe(18810)
  })

  it('CSV: export → import round-trips (barcode / name match, new levels created); a bad row writes nothing', () => {
    const { db, pen, tea } = pricingFixture()
    const lv = savePriceLevel(db, { name: 'Retail' })
    saveRate(db, { priceLevelId: lv.id, stockItemId: pen, rate: 1050, effectiveFrom: '2025-04-01', minQtyMilli: 12_500, discountBp: 250 })
    saveRate(db, { priceLevelId: lv.id, stockItemId: tea, rate: 20000, effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31' })
    const csv = exportRatesCsv(db)
    expect(csv).toContain('Retail,Gel Pen,890100000001,10.50,2025-04-01,,12.5,2.5,INR')
    const renamed = csv.replace(/Retail/g, 'Online')
    const dry = importRatesCsv(db, renamed, true)
    expect(dry).toMatchObject({ rows: 2, newLevels: ['Online'], errors: [], applied: false })
    expect(listPriceLevels(db).some((l) => l.name === 'Online')).toBe(false)
    const res = importRatesCsv(db, renamed)
    expect(res.applied).toBe(true)
    const online = listPriceLevels(db).find((l) => l.name === 'Online')!
    expect(listRates(db, online.id).map((r) => [r.itemName, r.rate, r.minQtyMilli, r.discountBp, r.effectiveTo])).toEqual([
      ['Gel Pen', 1050, 12_500, 250, null],
      ['Tea Pack', 20000, 0, 0, '2026-03-31']
    ])
    const bad = importRatesCsv(db, 'Level,Item,Rate\nOnline,Gel Pen,12\nOnline,Nope,5\nOnline,Tea Pack,abc\n')
    expect(bad.applied).toBe(false)
    expect(bad.errors.map((e) => e.line)).toEqual([3, 4])
    expect(rateFor(db, online.id, pen, '2025-05-01')).toBeNull() // the slab row only; the good row wasn't written
  })
})

describe('party-wise rates and schemes', () => {
  it('party rates CRUD; editing a remembered price makes it negotiated', () => {
    const { db, umbrella, pen } = pricingFixture()
    const r = savePartyRate(db, { ledgerId: umbrella, stockItemId: pen, ratePaise: 900, discountBp: 100, effectiveFrom: '2025-04-01' })
    expect(listPartyRates(db, umbrella)).toMatchObject([{ id: r.id, ledgerName: 'Umbrella Retail', itemName: 'Gel Pen', ratePaise: 900, source: 'manual' }])
    savePartyRate(db, { ledgerId: umbrella, stockItemId: pen, ratePaise: 950 }, r.id)
    expect(listPartyRates(db)[0]).toMatchObject({ ratePaise: 950, discountBp: 0, effectiveFrom: null })
    deletePartyRate(db, r.id)
    expect(listPartyRates(db)).toHaveLength(0)
    expect(() => savePartyRate(db, { ledgerId: umbrella, stockItemId: pen, ratePaise: 1, effectiveFrom: '2025-05-01', effectiveTo: '2025-04-01' })).toThrow(/end date/)
  })

  it('schemes CRUD with validation', () => {
    const { db, pen, paperGroup } = pricingFixture()
    const s = saveScheme(db, { name: 'Diwali 10%', kind: 'flat', appliesTo: 'all', slabs: [{ discountBp: 1000 }], fromDate: '2025-10-15', toDate: '2025-11-05', priority: 5 })
    expect(listSchemes(db)).toMatchObject([{ id: s.id, name: 'Diwali 10%', slabs: [{ minQtyMilli: 0, discountBp: 1000 }] }])
    saveScheme(db, { name: 'Paper bulk', kind: 'qty_slab', appliesTo: 'group', targetId: paperGroup, slabs: [{ minQtyMilli: 10_000, discountBp: 500 }, { minQtyMilli: 50_000, discountBp: 800 }] })
    expect(listSchemes(db).find((x) => x.name === 'Paper bulk')).toMatchObject({ targetName: 'Paper', slabs: [{ minQtyMilli: 10_000 }, { minQtyMilli: 50_000 }] })
    expect(() => saveScheme(db, { name: 'X', kind: 'buy_x_get_y', appliesTo: 'item', targetId: pen, slabs: [{ minQtyMilli: 2000, discountBp: 100 }] })).toThrow(/quantity free|quantities only/)
    expect(() => saveScheme(db, { name: 'Y', kind: 'qty_slab', appliesTo: 'item', slabs: [{ minQtyMilli: 1000, discountBp: 100 }] })).toThrow(/Pick the item/)
    expect(() => saveScheme(db, { name: 'Z', kind: 'value_slab', appliesTo: 'all', slabs: [{ minQtyMilli: 1000, discountBp: 100 }] })).toThrow(/minimum line value/)
    deleteScheme(db, s.id)
    expect(listSchemes(db)).toHaveLength(1)
  })
})

describe('resolver against the books', () => {
  it('walks the precedence: party rate > party level > scheme > default level > MRP > last purchase', () => {
    const f = pricingFixture()
    const { db, umbrella, krishna, pen } = f
    expect(resolve1(db, umbrella, pen, 1000).source).toBe('none')
    purchase(db, f, { date: '2025-06-01', itemId: pen, qtyMilli: 100_000, rate: 600 })
    expect(resolve1(db, umbrella, pen, 1000)).toMatchObject({ source: 'last_purchase', ratePaise: 600 })
    expect(resolve1(db, umbrella, pen, 1000, '2025-05-31').source).toBe('none') // before the purchase
    const item = listStockItems(db).find((i) => i.id === pen)!
    updateStockItem(db, pen, { ...item, mrpPaise: 1180 })
    expect(resolve1(db, umbrella, pen, 1000)).toMatchObject({ source: 'mrp', ratePaise: 1000 })
    const retail = savePriceLevel(db, { name: 'Retail', isDefault: true })
    saveRate(db, { priceLevelId: retail.id, stockItemId: pen, rate: 1100, effectiveFrom: '2025-04-01' })
    expect(resolve1(db, umbrella, pen, 1000)).toMatchObject({ source: 'default_level', ratePaise: 1100, label: 'Level: Retail' })
    saveScheme(db, { name: 'Diwali 10%', kind: 'flat', appliesTo: 'all', slabs: [{ discountBp: 1000 }], fromDate: '2025-10-01', toDate: '2025-10-31' })
    expect(resolve1(db, umbrella, pen, 2000)).toMatchObject({ source: 'scheme', label: 'Scheme: Diwali 10%', ratePaise: 1100, discountPaise: 220 })
    expect(resolve1(db, umbrella, pen, 2000, '2025-11-01').source).toBe('default_level')
    const wholesale = savePriceLevel(db, { name: 'Wholesale' })
    saveRate(db, { priceLevelId: wholesale.id, stockItemId: pen, rate: 1000, effectiveFrom: '2025-04-01' })
    saveRate(db, { priceLevelId: wholesale.id, stockItemId: pen, rate: 950, effectiveFrom: '2025-04-01', minQtyMilli: 10_000 })
    const party = db.prepare('SELECT * FROM ledgers WHERE id = ?').get(umbrella) as { name: string; group_id: number; state_code: string }
    updateLedger(db, umbrella, {
      name: party.name, groupId: party.group_id, openingBalance: 0, gstin: null, stateCode: party.state_code, address: null, taxType: null,
      gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, priceLevelId: wholesale.id
    })
    expect(resolve1(db, umbrella, pen, 9000)).toMatchObject({ source: 'party_level', ratePaise: 1000 })
    expect(resolve1(db, umbrella, pen, 10_000)).toMatchObject({ source: 'party_level', ratePaise: 950 })
    expect(resolve1(db, krishna, pen, 2000).source).toBe('scheme') // another party: no level
    savePartyRate(db, { ledgerId: umbrella, stockItemId: pen, ratePaise: 880 })
    expect(resolve1(db, umbrella, pen, 10_000)).toMatchObject({ source: 'party_rate', ratePaise: 880, label: 'Party rate' })
    expect(resolve1(db, null, pen, 1000).source).toBe('scheme') // no party at all
  })

  it('group schemes match the item\'s stock group and its parents', () => {
    const { db, paper, stationery } = pricingFixture()
    const retail = savePriceLevel(db, { name: 'Retail', isDefault: true })
    saveRate(db, { priceLevelId: retail.id, stockItemId: paper, rate: 30000, effectiveFrom: '2025-04-01' })
    saveScheme(db, { name: 'Stationery week', kind: 'qty_slab', appliesTo: 'group', targetId: stationery, slabs: [{ minQtyMilli: 5000, discountBp: 500 }] })
    expect(resolve1(db, null, paper, 4000).source).toBe('default_level')
    expect(resolve1(db, null, paper, 5000)).toMatchObject({ source: 'scheme', discountPaise: 7500 })
  })
})

describe('remember last price', () => {
  it('off by default; on: the sale remembers rate + discount, later sales update it, back-dated ones do not', () => {
    const f = pricingFixture()
    const { db, umbrella, pen } = f
    expect(getPricingConfig(db)).toEqual({ autoApply: true, rememberLastPrice: false })
    const v1 = sale(db, f, { date: '2025-10-01', party: umbrella, itemId: pen, qtyMilli: 10_000, rate: 1200 })
    expect(rememberSalePrices(db, v1)).toBe(0)
    setPricingConfig(db, { autoApply: true, rememberLastPrice: true })
    expect(rememberSalePrices(db, v1)).toBe(1)
    expect(listPartyRates(db, umbrella)).toMatchObject([{ source: 'last_sale', ratePaise: 1200, discountBp: 0, lastSoldAt: '2025-10-01', lastVoucherId: v1 }])
    expect(resolve1(db, umbrella, pen, 1000)).toMatchObject({ source: 'last_price', ratePaise: 1200 })
    const v2 = sale(db, f, { date: '2025-10-05', party: umbrella, itemId: pen, qtyMilli: 10_000, rate: 1250, discount: 1250 })
    rememberSalePrices(db, v2)
    expect(listPartyRates(db, umbrella)).toMatchObject([{ ratePaise: 1250, discountBp: 1000, lastSoldAt: '2025-10-05' }])
    const v0 = sale(db, f, { date: '2025-09-01', party: umbrella, itemId: pen, qtyMilli: 1000, rate: 999 })
    rememberSalePrices(db, v0)
    expect(listPartyRates(db, umbrella)).toHaveLength(1)
    expect(listPartyRates(db, umbrella)[0]!.ratePaise).toBe(1250)
    // A negotiated rate still wins over the remembered one.
    savePartyRate(db, { ledgerId: umbrella, stockItemId: pen, ratePaise: 1100 })
    expect(resolve1(db, umbrella, pen, 1000).source).toBe('party_rate')
  })
})
