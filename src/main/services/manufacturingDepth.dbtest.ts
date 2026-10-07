// WP 2.4 — deeper manufacturing on a real (in-memory) company: migration 023 + the BOM backfill,
// BOM versions, by-products / scrap (value conservation, re-pricing), the 'transfer' costing rule,
// job work end to end (send → material at job workers → receipt with job charges → return, with
// the ITC-04 data), the live-repriced register and the manufacturing reports.
import { beforeEach, describe, expect, it } from 'vitest'
import { freshPartialDb, seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { seedCompany } from '../db/seed'
import { stockItemInputSchema, type VoucherInput } from '@shared/schemas'
import type { ManufactureInput } from '@shared/manufacture'
import { createGodown, createLedger, createStockItem, updateGodown } from './masters'
import { deleteVoucher, getVoucher, saveVoucher, JOB_WORK_EDIT_ELSEWHERE } from './vouchers'
import { costPreview, getManufactureDetails, manufactureRegister, saveManufacture } from './manufacture'
import { stockSummary, stockValue } from './stockAnalysis'
import { deleteBomVersion, explode, getBom, itemsWithBom, listBomVersions, saveBomVersion, setBom } from './bom'
import { itc04Data, materialAtJobWorkers, saveJobWorkChallan, sendChallans } from './jobWork'
import { costSheetReport, marginReport, materialVarianceReport, productionRegisterReport } from './manufactureReports'
import { trialBalance } from './reports'
import { seedStockFixture } from './stockFixture.testutil'

let db: DB
let steel: number, paint: number, chair: number, offcut: number, frame: number
let cash: number, purchases: number, sales: number

const typeId = (kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const ledgerId = (name: string): number | undefined =>
  (db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined)?.id

function item(name: string, openingQtyMilli = 0, openingValue = 0, valuationMethod: 'weighted_avg' | 'fifo' = 'weighted_avg'): number {
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }
  return createStockItem(db, stockItemInputSchema.parse({ name, unitId: unit.id, openingQtyMilli, openingValue, valuationMethod, hsn: '7308' })).id
}
function ledger(name: string, group: string, gstin: string | null = null): number {
  return createLedger(db, {
    name, groupId: groupId(group), openingBalance: 0, gstin, stateCode: gstin ? '27' : null, address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}
const blank = {
  partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
  vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null
}
function purchase(date: string, itemId: number, qtyMilli: number, amount: number, godownId: number | null = null): number {
  return saveVoucher(db, {
    ...blank, voucherTypeId: typeId('purchase'), date,
    lines: [{ ledgerId: purchases, drCr: 'dr', amount }, { ledgerId: cash, drCr: 'cr', amount }],
    inventory: [{ stockItemId: itemId, godownId, qtyMilli, ratePaise: Math.round((amount * 1000) / qtyMilli), amount, direction: 'in' }]
  }).id
}
function sale(date: string, itemId: number, qtyMilli: number, amount: number): number {
  return saveVoucher(db, {
    ...blank, voucherTypeId: typeId('sales'), date,
    lines: [{ ledgerId: cash, drCr: 'dr', amount }, { ledgerId: sales, drCr: 'cr', amount }],
    inventory: [{ stockItemId: itemId, godownId: null, qtyMilli, ratePaise: Math.round((amount * 1000) / qtyMilli), amount, direction: 'out' }]
  }).id
}
/** The screen's figure: profit = sale − (engine consumption + labour − by-products). */
function priced(input: Omit<ManufactureInput, 'profitPaise'> & { profitPaise?: number }, voucherId?: number): ManufactureInput {
  const p = costPreview(db, { date: input.date, voucherId, lines: input.raw.map((r) => ({ itemId: r.stockItemId, qtyMilli: r.qtyMilli })) })
  const saleAmount = Math.round((input.qtyMilli * input.saleRatePaise) / 1000)
  const bp = (input.byProducts ?? []).reduce((s, b) => s + b.valuePaise, 0)
  return { ...input, profitPaise: input.profitPaise ?? saleAmount - (p.totalPaise + input.labourPaise - bp), confirmLoss: true }
}
const row = (asOn: string, id: number, godownId?: number) => stockSummary(db, asOn, { godownId }).find((r) => r.stockItemId === id)!

beforeEach(() => {
  db = seededDb()
  cash = ledgerId('Cash')!
  purchases = ledger('Purchases', 'Purchase Accounts')
  sales = ledger('Sales', 'Sales Accounts')
  steel = item('Steel Rod', 10000, 150000) // 10 @ ₹150
  paint = item('Paint', 2000, 80000) // 2 @ ₹400
  chair = item('Chair')
  offcut = item('Steel Offcut')
  frame = item('Frame')
})

// ---------- migration 023 ----------

describe('migration 023', () => {
  const at = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE bom_versions'))

  it('is migration 023, appended after 022 (WP 3.2) and self-contained', () => {
    expect(at + 1).toBe(23)
    expect(MIGRATIONS[at - 1]).toContain('tds_exemptions')
    expect(MIGRATIONS[at]).toContain('CREATE VIEW bom_lines')
  })

  it('backfills every item BOM as a default "v1" version; bom_lines becomes a view of it; stock figures unchanged', () => {
    const pre = freshPartialDb(at)
    seedCompany(pre, TEST_INFO)
    const unit = (pre.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    const ins = pre.prepare('INSERT INTO stock_items (name, unit_id) VALUES (?, ?)')
    const [a, b, c, d] = ['Table', 'Leg', 'Top', 'Wood'].map((n) => Number(ins.run(n, unit).lastInsertRowid)) as [number, number, number, number]
    const bl = pre.prepare('INSERT INTO bom_lines (item_id, component_id, qty_milli_per_unit) VALUES (?, ?, ?)')
    bl.run(a, c, 1000)
    bl.run(a, b, 4000)
    bl.run(b, d, 500)
    pre.prepare("INSERT INTO godowns (name) VALUES ('Old godown')").run()
    seedStockFixture(pre, { vouchers: 200, items: 6, seed: 23 })
    migrate(pre)

    const versions = listBomVersions(pre)
    expect(versions.map((v) => [v.itemId, v.name, v.isDefault, v.effectiveFrom, v.effectiveTo])).toEqual([
      [a, 'v1', true, null, null], [b, 'v1', true, null, null]
    ])
    // Line order = the old row order (by id), scrap none.
    expect(versions[0]!.lines).toEqual([{ componentId: c, qtyMilliPerUnit: 1000, scrapPctBp: null }, { componentId: b, qtyMilliPerUnit: 4000, scrapPctBp: null }])
    expect(pre.prepare('SELECT item_id, component_id, qty_milli_per_unit FROM bom_lines ORDER BY item_id, component_id').all()).toEqual([
      { item_id: a, component_id: b, qty_milli_per_unit: 4000 }, { item_id: a, component_id: c, qty_milli_per_unit: 1000 },
      { item_id: b, component_id: d, qty_milli_per_unit: 500 }
    ])
    expect(() => pre.prepare('INSERT INTO bom_lines (item_id, component_id, qty_milli_per_unit) VALUES (?, ?, ?)').run(c, d, 1)).toThrow()
    expect(getBom(pre, a).map((l) => l.componentName)).toEqual(['Leg', 'Top'])
    expect(pre.prepare("SELECT kind, party_ledger_id FROM godowns WHERE name = 'Old godown'").get()).toEqual({ kind: 'own', party_ledger_id: null })
    // No journal is marked for transfer costing on upgrade — legacy figures can't move.
    expect(pre.prepare('SELECT COUNT(*) AS n FROM stock_transfers').get()).toEqual({ n: 0 })
    const fresh = seededDb()
    seedStockFixture(fresh, { vouchers: 200, items: 6, seed: 23 })
    expect(stockValue(pre, '2026-03-31')).toBe(stockValue(fresh, '2026-03-31'))
  })

  it('constraints: one default per item, valid effective range, outputs cascade with the details row', () => {
    const v = saveBomVersion(db, { itemId: chair, name: 'v1', isDefault: true, lines: [{ componentId: steel, qtyMilliPerUnit: 1000 }] })
    expect(() => db.prepare("INSERT INTO bom_versions (item_id, name, is_default) VALUES (?, 'x', 1)").run(chair)).toThrow(/UNIQUE/)
    expect(() => db.prepare("INSERT INTO bom_versions (item_id, name, effective_from, effective_to) VALUES (?, 'y', '2025-02-01', '2025-01-01')").run(chair)).toThrow(/CHECK/)
    expect(() => db.prepare("INSERT INTO godowns (name, kind) VALUES ('Z', 'third')").run()).toThrow(/CHECK/)
    expect(v.isDefault).toBe(true)
  })
})

// ---------- BOM versions ----------

describe('BOM versions', () => {
  it('first version is the default; making another default demotes it; bom:get/set act on the default', () => {
    const v1 = saveBomVersion(db, { itemId: chair, name: 'v1', isDefault: false, lines: [{ componentId: steel, qtyMilliPerUnit: 2000 }] })
    expect(v1.isDefault).toBe(true)
    const v2 = saveBomVersion(db, { itemId: chair, name: 'v2', effectiveFrom: '2025-07-01', isDefault: true, lines: [{ componentId: paint, qtyMilliPerUnit: 500, scrapPctBp: 1000 }] })
    expect(listBomVersions(db, chair).map((v) => [v.name, v.isDefault])).toEqual([['v1', false], ['v2', true]])
    expect(getBom(db, chair).map((l) => [l.componentId, l.qtyMilliPerUnit])).toEqual([[paint, 500]])
    setBom(db, { itemId: chair, lines: [{ componentId: paint, qtyMilliPerUnit: 600 }, { componentId: steel, qtyMilliPerUnit: 100 }] })
    const after = listBomVersions(db, chair).find((v) => v.id === v2.id)!
    // setBom keeps the scrap allowance of a component that stays.
    expect(after.lines).toEqual([{ componentId: paint, qtyMilliPerUnit: 600, scrapPctBp: 1000 }, { componentId: steel, qtyMilliPerUnit: 100, scrapPctBp: null }])
    expect(itemsWithBom(db)).toEqual([{ itemId: chair, name: 'Chair', components: 2 }])
    deleteBomVersion(db, v2.id)
    expect(listBomVersions(db, chair).map((v) => [v.name, v.isDefault])).toEqual([['v1', true]])
  })

  it('setBom on an item without versions creates "v1"; names are unique per item', () => {
    setBom(db, { itemId: frame, lines: [{ componentId: steel, qtyMilliPerUnit: 1000 }] })
    expect(listBomVersions(db, frame).map((v) => v.name)).toEqual(['v1'])
    expect(() => saveBomVersion(db, { itemId: frame, name: 'V1', isDefault: false, lines: [] })).toThrow(/already has a BOM version/)
  })

  it('refuses cycles through ANY version of any item (multi-level)', () => {
    saveBomVersion(db, { itemId: chair, name: 'v1', isDefault: true, lines: [{ componentId: frame, qtyMilliPerUnit: 1000 }] })
    saveBomVersion(db, { itemId: frame, name: 'old', isDefault: true, lines: [{ componentId: steel, qtyMilliPerUnit: 1000 }] })
    saveBomVersion(db, { itemId: frame, name: 'new', isDefault: false, lines: [{ componentId: paint, qtyMilliPerUnit: 1000 }] })
    expect(() => saveBomVersion(db, { itemId: paint, name: 'v1', isDefault: true, lines: [{ componentId: chair, qtyMilliPerUnit: 1000 }] })).toThrow(/cycle/)
    expect(() => setBom(db, { itemId: steel, lines: [{ componentId: chair, qtyMilliPerUnit: 1 }] })).toThrow(/cycle/)
  })

  it('bom:explode — version by date, single vs full levels', () => {
    saveBomVersion(db, { itemId: chair, name: 'v1', isDefault: true, lines: [{ componentId: frame, qtyMilliPerUnit: 1000 }, { componentId: paint, qtyMilliPerUnit: 250 }] })
    const v2 = saveBomVersion(db, { itemId: chair, name: 'v2', effectiveFrom: '2025-08-01', isDefault: false, lines: [{ componentId: frame, qtyMilliPerUnit: 1000 }] })
    saveBomVersion(db, { itemId: frame, name: 'v1', isDefault: true, lines: [{ componentId: steel, qtyMilliPerUnit: 2000, scrapPctBp: 500 }] })
    const single = explode(db, { itemId: chair, qtyMilli: 2000, date: '2025-06-10', levels: 'single' })
    expect(single.ok && single.rows).toEqual([{ componentId: frame, qtyMilli: 2000 }, { componentId: paint, qtyMilli: 500 }])
    const full = explode(db, { itemId: chair, qtyMilli: 2000, date: '2025-06-10', levels: 'full' })
    expect(full.ok && full.rows).toEqual([{ componentId: steel, qtyMilli: 4200 }, { componentId: paint, qtyMilli: 500 }])
    const later = explode(db, { itemId: chair, qtyMilli: 1000, date: '2025-08-02', levels: 'single' })
    expect(later.ok && later.versionId).toBe(v2.id)
  })
})

// ---------- by-products / scrap ----------

describe('by-products and scrap', () => {
  const run = (over: Partial<ManufactureInput> = {}) =>
    saveManufacture(db, priced({
      date: '2025-06-10', finishedItemId: chair, qtyMilli: 2000, saleRatePaise: 100000,
      raw: [{ stockItemId: steel, qtyMilli: 4000 }, { stockItemId: paint, qtyMilli: 500 }],
      labourPaise: 30000, labourPosted: true,
      byProducts: [{ stockItemId: offcut, qtyMilli: 1000, valuePaise: 10000, kind: 'scrap' }],
      ...over
    }))

  it('Σ consumption + labour = finished value + Σ by-product values; profit is net of by-products', () => {
    const saved = run()
    // materials 60000 + 20000, labour 30000 = 110000; scrap 10000 → chair 100000.
    expect(getVoucher(db, saved.id)!.inventory.map((l) => [l.stockItemId, l.direction, l.amount])).toEqual([
      [steel, 'out', 60000], [paint, 'out', 20000], [chair, 'in', 100000], [offcut, 'in', 10000]
    ])
    expect(saved.manufacture.profitPaise).toBe(200000 - 100000)
    expect(saved.manufacture.byProducts).toEqual([{ lineOrder: 3, stockItemId: offcut, qtyMilli: 1000, valuePaise: 10000, kind: 'scrap' }])
    expect(row('2025-06-30', chair).closingValue).toBe(100000)
    expect(row('2025-06-30', offcut).closingValue).toBe(10000)
    const total = stockValue(db, '2025-06-30')
    expect(total).toBe(150000 + 80000 + 30000) // labour capitalised; value conserved
  })

  it('a backdated purchase re-prices the finished item; the by-product keeps its assigned value; the register shows cost at save vs now', () => {
    const saved = run()
    purchase('2025-06-05', steel, 10000, 250000) // avg → ₹200
    expect(row('2025-06-30', chair).closingValue).toBe(80000 + 20000 + 30000 - 10000)
    expect(row('2025-06-30', offcut).closingValue).toBe(10000)
    const [r] = manufactureRegister(db, '2025-06-01', '2025-06-30')
    expect(r).toMatchObject({
      voucherId: saved.id, costAtSave: 100000, productionCost: 120000, materialPaise: 100000, byProductPaise: 10000,
      saleAmount: 200000, profitAtSave: 100000, profitPaise: 80000, repriced: true
    })
  })

  it('rejects by-products worth more than materials + labour, and a by-product that is the finished item', () => {
    expect(() => run({ byProducts: [{ stockItemId: offcut, qtyMilli: 1000, valuePaise: 200000, kind: 'by_product' }] })).toThrow(/worth more than materials/)
    expect(() => run({ byProducts: [{ stockItemId: chair, qtyMilli: 1000, valuePaise: 1, kind: 'by_product' }] })).toThrow(/can't also be a by-product/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
  })

  it('editing away the by-products removes their rows; binning keeps them for restore', () => {
    const saved = run()
    saveManufacture(db, priced({
      date: '2025-06-10', finishedItemId: chair, qtyMilli: 2000, saleRatePaise: 100000,
      raw: [{ stockItemId: steel, qtyMilli: 4000 }], labourPaise: 0, labourPosted: true
    }, saved.id), saved.id)
    expect(getManufactureDetails(db, saved.id)!.byProducts).toEqual([])
    expect(row('2025-06-30', offcut).closingQtyMilli).toBe(0)
  })
})

// ---------- transfer rule ----------

describe("godown transfers are 'transfer'-costed (no drift after backdated changes)", () => {
  const transfer = (date: string, qty: number, amount: number, from: number, to: number): number =>
    saveVoucher(db, {
      ...blank, voucherTypeId: typeId('stock_journal'), date, lines: [],
      inventory: [
        { stockItemId: steel, godownId: from, batchId: null, qtyMilli: qty, ratePaise: Math.round((amount * 1000) / qty), amount, direction: 'out' },
        { stockItemId: steel, godownId: to, batchId: null, qtyMilli: qty, ratePaise: Math.round((amount * 1000) / qty), amount, direction: 'in' }
      ]
    }).id

  it('the inward leg tracks the outward leg’s engine cost; item value conserved; the godown view follows', () => {
    const a = createGodown(db, { name: 'A' }).id
    const b = createGodown(db, { name: 'B' }).id
    purchase('2025-06-01', steel, 10000, 150000, a) // A holds 10 @ ₹150 (opening 10 has no godown)
    const t = transfer('2025-06-10', 4000, 60000, a, b) // priced at save: ₹150
    expect(db.prepare('SELECT voucher_id FROM stock_transfers').all()).toEqual([{ voucher_id: t }])
    const before = stockValue(db, '2025-06-30')
    purchase('2025-06-05', steel, 10000, 450000, a) // backdated: average ₹250 at the transfer
    // Company value = opening + both purchases; the transfer never adds or removes value.
    expect(stockValue(db, '2025-06-30')).toBe(150000 + 80000 + 150000 + 450000)
    expect(before).toBe(150000 + 80000 + 150000)
    // Godown B received 4 at the engine cost NOW (₹250 average), not the stored ₹150.
    expect(row('2025-06-30', steel, b)).toMatchObject({ closingQtyMilli: 4000, closingValue: 100000 })
  })

  it('a hand-entered journal of the same shape saved before 0.6.0 (no mark) keeps stored costing', () => {
    const a = createGodown(db, { name: 'A' }).id
    const b = createGodown(db, { name: 'B' }).id
    const t = transfer('2025-06-10', 4000, 70000, a, b)
    db.prepare('DELETE FROM stock_transfers WHERE voucher_id = ?').run(t) // as if saved pre-023
    // stored: out at engine ₹150 (60000), in at the typed ₹70000 → value +10000.
    expect(stockValue(db, '2025-06-30')).toBe(150000 + 80000 + 10000)
  })

  it('a journal that stops being a pure transfer loses the mark', () => {
    const a = createGodown(db, { name: 'A' }).id
    const b = createGodown(db, { name: 'B' }).id
    const t = transfer('2025-06-10', 1000, 15000, a, b)
    saveVoucher(db, {
      ...blank, voucherTypeId: typeId('stock_journal'), date: '2025-06-10', lines: [],
      inventory: [{ stockItemId: steel, godownId: a, batchId: null, qtyMilli: 1000, ratePaise: 15000, amount: 15000, direction: 'out' }]
    }, t)
    expect(db.prepare('SELECT COUNT(*) AS n FROM stock_transfers').get()).toEqual({ n: 0 })
  })
})

// ---------- job work ----------

describe('job work end to end (send → at job worker → receive with job charges → return) + ITC-04 data', () => {
  let own: number, jw: number, worker: number
  const sj = () => typeId('stock_journal')
  const send = (date: string, qty: number, over: { godownId?: number; from?: number } = {}) => {
    const cost = costPreview(db, { date, lines: [{ itemId: steel, qtyMilli: qty }] }).totalPaise
    return saveJobWorkChallan(db, {
      voucher: {
        ...blank, voucherTypeId: sj(), date, lines: [],
        inventory: [
          { stockItemId: steel, godownId: over.from ?? own, batchId: null, qtyMilli: qty, ratePaise: 0, amount: cost, direction: 'out' },
          { stockItemId: steel, godownId: over.godownId ?? jw, batchId: null, qtyMilli: qty, ratePaise: 0, amount: cost, direction: 'in' }
        ]
      } as VoucherInput,
      challan: { kind: 'send', godownId: jw, natureOfProcessing: 'Bending and welding', goodsType: 'inputs' }
    })
  }

  beforeEach(() => {
    worker = ledger('Ravi Fabricators', 'Sundry Creditors', '27AAPFU0939F1ZV')
    own = createGodown(db, { name: 'Main' }).id
    jw = createGodown(db, { name: 'Ravi (job work)', kind: 'job_worker', partyLedgerId: worker }).id
    purchase('2025-04-01', steel, 20000, 300000, own) // 20 @ ₹150 in Main
  })

  it('godown kind rules: a job worker godown needs a party; kind is frozen once challans exist', () => {
    expect(() => createGodown(db, { name: 'X', kind: 'job_worker' })).toThrow(/party ledger/)
    send('2025-05-01', 5000)
    expect(() => updateGodown(db, jw, { name: 'Ravi', kind: 'own' })).toThrow(/must stay a job worker/)
  })

  it('send challan: a value-conserving transfer into the job worker’s godown, ITC-04 facts stored', () => {
    const s = send('2025-05-01', 8000)
    expect(s.challan).toMatchObject({ kind: 'send', godownId: jw, partyLedgerId: worker, natureOfProcessing: 'Bending and welding', goodsType: 'inputs' })
    expect(row('2025-05-31', steel, jw)).toMatchObject({ closingQtyMilli: 8000, closingValue: 120000 })
    expect(stockValue(db, '2025-05-31')).toBe(150000 + 80000 + 300000)
    expect(() => saveVoucher(db, { ...blank, voucherTypeId: sj(), date: '2025-05-01', lines: [], inventory: [] }, s.id)).toThrow(JOB_WORK_EDIT_ELSEWHERE)
    expect(sendChallans(db, jw).map((c) => c.voucherId)).toEqual([s.id])
    // A row that doesn't go to the job worker is refused.
    expect(() => send('2025-05-02', 1000, { godownId: own, from: jw })).toThrow(/go to the job worker/)
  })

  it('material at job workers: quantity, value, age and what is pending beyond N days', () => {
    send('2025-01-10', 3000)
    send('2025-05-01', 5000)
    const rows = materialAtJobWorkers(db, '2025-06-30', 90)
    expect(rows).toEqual([
      expect.objectContaining({
        godownId: jw, partyLedgerId: worker, partyName: 'Ravi Fabricators', stockItemId: steel, qtyMilli: 8000, valuePaise: 120000,
        oldestDate: '2025-01-10', ageDays: 171, pendingQtyMilli: 3000, pendingValuePaise: 45000
      })
    ])
  })

  it('receipt: raw consumed at the job worker, job charges Dr Job Work Charges / Cr the job worker, capitalised; losses kept', () => {
    const s = send('2025-05-01', 8000)
    const got = saveManufacture(db, priced({
      date: '2025-05-20', godownId: own, finishedItemId: frame, qtyMilli: 4000, saleRatePaise: 60000,
      raw: [{ stockItemId: steel, qtyMilli: 6000, lossQtyMilli: 400 }], labourPaise: 20000, labourPosted: true,
      jobWork: { godownId: jw, challanNo: 'RF/112', challanDate: '2025-05-19', natureOfProcessing: 'Bending and welding', originalChallanVoucherId: s.id }
    }))
    const v = getVoucher(db, got.id)!
    expect(v.inventory.map((l) => [l.stockItemId, l.godownId, l.direction, l.amount])).toEqual([[steel, jw, 'out', 90000], [frame, own, 'in', 110000]])
    const charges = ledgerId('Job Work Charges')!
    expect(v.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[charges, 'dr', 20000], [worker, 'cr', 20000]])
    expect(got.manufacture.jobWork).toEqual({
      godownId: jw, partyLedgerId: worker, challanNo: 'RF/112', challanDate: '2025-05-19', natureOfProcessing: 'Bending and welding',
      originalChallanVoucherId: s.id, losses: [{ lineOrder: 0, lossQtyMilli: 400 }]
    })
    expect(row('2025-05-31', frame)).toMatchObject({ closingQtyMilli: 4000, closingValue: 110000 })
    expect(row('2025-05-31', steel, jw)).toMatchObject({ closingQtyMilli: 2000, closingValue: 30000 })
    const tb = trialBalance(db, '2025-05-31')
    expect(tb.rows.find((r) => r.ledgerId === worker)).toMatchObject({ credit: 20000 })
    // Material at job workers now holds the remaining 2.
    expect(materialAtJobWorkers(db, '2025-05-31', 30)[0]).toMatchObject({ qtyMilli: 2000, valuePaise: 30000, pendingQtyMilli: 0 })
    // The register flags it as job work.
    expect(manufactureRegister(db, '2025-05-01', '2025-05-31')[0]).toMatchObject({ jobWork: true, productionCost: 110000 })
  })

  it('refuses a receipt from an own godown and an original challan of another job worker', () => {
    const base = {
      date: '2025-05-20', finishedItemId: frame, qtyMilli: 1000, saleRatePaise: 0,
      raw: [{ stockItemId: steel, qtyMilli: 1000 }], labourPaise: 0, labourPosted: true
    }
    expect(() => saveManufacture(db, priced({ ...base, jobWork: { godownId: own } }))).toThrow(/not a job worker godown/)
    const other = createGodown(db, { name: 'Other JW', kind: 'job_worker', partyLedgerId: worker }).id
    const s = send('2025-05-01', 1000)
    expect(() => saveManufacture(db, priced({ ...base, jobWork: { godownId: other, originalChallanVoucherId: s.id } }))).toThrow(/not a send challan to this job worker/)
  })

  it('return challan + the ITC-04 data: sent, received (with losses and original challan), returned', () => {
    const s = send('2025-05-01', 8000)
    saveManufacture(db, priced({
      date: '2025-05-20', godownId: own, finishedItemId: frame, qtyMilli: 4000, saleRatePaise: 0,
      raw: [{ stockItemId: steel, qtyMilli: 6000, lossQtyMilli: 400 }], labourPaise: 20000, labourPosted: false,
      jobWork: { godownId: jw, challanNo: 'RF/112', challanDate: '2025-05-19', natureOfProcessing: 'Bending and welding', originalChallanVoucherId: s.id }
    }))
    const r = saveJobWorkChallan(db, {
      voucher: {
        ...blank, voucherTypeId: sj(), date: '2025-05-25', lines: [],
        inventory: [
          { stockItemId: steel, godownId: jw, batchId: null, qtyMilli: 2000, ratePaise: 15000, amount: 30000, direction: 'out' },
          { stockItemId: steel, godownId: own, batchId: null, qtyMilli: 2000, ratePaise: 15000, amount: 30000, direction: 'in' }
        ]
      } as VoucherInput,
      challan: { kind: 'return', godownId: jw, challanNo: 'RF/115', challanDate: '2025-05-25', goodsType: 'inputs', originalChallanVoucherId: s.id }
    })
    expect(row('2025-05-31', steel, jw).closingQtyMilli).toBe(0)
    expect(materialAtJobWorkers(db, '2025-05-31', 30)).toEqual([])

    const data = itc04Data(db, '2025-04-01', '2025-06-30')
    const sv = getVoucher(db, s.id)!
    expect(data.sent).toEqual([{
      voucherId: s.id, challanNo: sv.number, challanDate: '2025-05-01', jobWorkerName: 'Ravi Fabricators', gstin: '27AAPFU0939F1ZV',
      stateCode: '27', stockItemId: steel, itemName: 'Steel Rod', hsn: '7308', unit: expect.any(String), qtyMilli: 8000,
      taxableValuePaise: 120000, goodsType: 'inputs', natureOfProcessing: 'Bending and welding'
    }])
    expect(data.received).toHaveLength(1)
    expect(data.received[0]).toMatchObject({
      challanNo: 'RF/112', challanDate: '2025-05-19', originalChallanNo: sv.number, originalChallanDate: '2025-05-01',
      goods: [expect.objectContaining({ stockItemId: frame, qtyMilli: 4000 })],
      inputs: [expect.objectContaining({ stockItemId: steel, qtyMilli: 6000, lossQtyMilli: 400 })]
    })
    expect(data.returned).toEqual([expect.objectContaining({ voucherId: r.id, challanNo: 'RF/115', challanDate: '2025-05-25', originalChallanNo: sv.number, qtyMilli: 2000 })])
    // Binned challans drop out of the ITC-04 data.
    deleteVoucher(db, r.id)
    expect(itc04Data(db, '2025-04-01', '2025-06-30').returned).toEqual([])
  })
})

// ---------- reports ----------

describe('manufacturing reports', () => {
  beforeEach(() => {
    saveBomVersion(db, { itemId: chair, name: 'std', isDefault: true, lines: [{ componentId: steel, qtyMilliPerUnit: 2000 }, { componentId: paint, qtyMilliPerUnit: 250 }] })
  })
  const make = (date: string, qty: number, steelQty: number, paintQty: number, bomVersionId?: number) =>
    saveManufacture(db, priced({
      date, finishedItemId: chair, qtyMilli: qty, saleRatePaise: 100000,
      raw: [{ stockItemId: steel, qtyMilli: steelQty }, ...(paintQty ? [{ stockItemId: paint, qtyMilli: paintQty }] : [])],
      labourPaise: 10000, labourPosted: true, bomVersionId: bomVersionId ?? listBomVersions(db, chair)[0]!.id,
      byProducts: [{ stockItemId: offcut, qtyMilli: 500, valuePaise: 2000, kind: 'scrap' }]
    }))

  it('production register, cost sheet (per manufacture + average), margin and variance', () => {
    const m1 = make('2025-06-10', 2000, 4000, 500) // steel 60000, paint 20000
    make('2025-06-12', 1000, 2500, 0) // steel 37500 (over standard by 0.5), no paint (under by 0.25)
    sale('2025-06-20', chair, 2000, 180000)

    const [p] = productionRegisterReport(db, '2025-06-01', '2025-06-30')
    expect(p).toMatchObject({
      finishedItemId: chair, manufactures: 2, qtyMilli: 3000, materialPaise: 117500, labourPaise: 20000, grossCost: 137500,
      byProductPaise: 4000, productionCost: 133500, saleAmount: 300000, marginPaise: 166500, unitCostPaise: 44500
    })

    const sheet = costSheetReport(db, chair, '2025-06-01', '2025-06-30')
    expect(sheet.manufactures[0]).toMatchObject({ voucherId: m1.id, qtyMilli: 2000, productionCost: 88000, unitCostPaise: 44000 })
    expect(sheet.manufactures[0]!.lines.map((l) => [l.kind, l.itemId, l.qtyMilli, l.ratePaise, l.amountPaise])).toEqual([
      ['material', steel, 4000, 15000, 60000], ['material', paint, 500, 40000, 20000], ['labour', null, 0, 0, 10000], ['scrap', offcut, 500, 4000, -2000]
    ])
    expect(sheet.average).toMatchObject({ qtyMilli: 3000, productionCost: 133500, unitCostPaise: 44500 })
    expect(sheet.average.lines.find((l) => l.itemId === steel)).toMatchObject({ qtyMilli: 6500, qtyPerUnitMilli: 2167, amountPaise: 97500 })

    const [m] = marginReport(db, '2025-06-01', '2025-06-30')
    expect(m).toMatchObject({ itemId: chair, madeQtyMilli: 3000, expectedSaleAmount: 300000, expectedMarginPaise: 166500, soldQtyMilli: 2000, salesValue: 180000 })
    // Realised COGS = 2 chairs at the engine's average production cost (133500 / 3).
    expect(m!.cogs).toBe(89000)
    expect(m!.realisedMarginPaise).toBe(91000)

    const variance = materialVarianceReport(db, '2025-06-01', '2025-06-30')
    expect(variance.map((r) => [r.voucherId === m1.id ? 1 : 2, r.componentId, r.standardQtyMilli, r.actualQtyMilli, r.qtyVarianceMilli, r.valueVariancePaise])).toEqual([
      [1, steel, 4000, 4000, 0, 0],
      [1, paint, 500, 500, 0, 0],
      [2, steel, 2000, 2500, 500, 7500],
      [2, paint, 250, 0, -250, -10000] // unconsumed: valued at paint's average (₹400) before the voucher
    ])
    expect(variance[0]!.bomVersionName).toBe('std')
  })

  it('a manufacture without a recorded version uses the version in force; items without a BOM have no variance rows', () => {
    saveManufacture(db, priced({
      date: '2025-06-10', finishedItemId: frame, qtyMilli: 1000, saleRatePaise: 0, raw: [{ stockItemId: steel, qtyMilli: 1000 }],
      labourPaise: 0, labourPosted: true
    }))
    saveManufacture(db, priced({
      date: '2025-06-11', finishedItemId: chair, qtyMilli: 1000, saleRatePaise: 0, raw: [{ stockItemId: steel, qtyMilli: 2000 }, { stockItemId: paint, qtyMilli: 250 }],
      labourPaise: 0, labourPosted: true
    }))
    const rows = materialVarianceReport(db, '2025-06-01', '2025-06-30')
    expect(rows.map((r) => [r.finishedItemId, r.componentId, r.qtyVarianceMilli])).toEqual([[chair, steel, 0], [chair, paint, 0]])
  })
})
