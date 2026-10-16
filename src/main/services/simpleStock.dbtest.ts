// WP 9.7 — Stock and Made goods against the books:
//   - the product list's quantity and value ARE the accountant Stock summary's (the one valuation
//     pass) — on the demo seed and after a count;
//   - a stock count (the form's answers → countIntentFrom → simple:post) equals the physical-stock
//     entry an accountant types into the Physical Stock editor in a twin company, row for row, opens
//     in that editor unchanged, and the valuation engine prices the difference (hand-worked);
//   - Made goods equals the manufacture an accountant saves in the twin (consumption at the
//     engine's cost, the finished goods at materials + labour — the derived rule), with labour
//     "already recorded" (no lines) or "wages still to pay" (Labour Charges / Wages Payable);
//   - refusals (not enough material → qty, no recipe → item, lock / closed year → date, a viewer)
//     leave no trace; Undo bins the entry as one group; the same clientId replays;
//   - "Change price" adds a dated row on the default price level (earlier bills keep the old
//     price); Home's attention row counts what the list calls running low;
//   - the recipe editor's Save = the BOM version the accountant editor saves (bom.saveBomVersion
//     with the same dates), row for row and audit row for audit row; Made goods after it = the
//     hand-entered manufacture with the new recipe; refusals and unchanged answers leave no trace.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import { openCompanyDb, type DB } from '../db/connection'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import type { CompanyInfo, Voucher } from '@shared/domain'
import { todayISO } from '@shared/dates'
import { stockItemInputSchema } from '@shared/schemas'
import { buildPhysicalPayload, emptyPhysicalState, manufactureRepresentation, physicalRepresentation } from '@shared/voucherEdit'
import type { ManufactureInput } from '@shared/manufacture'
import { countIntentFrom, emptyMakeForm, makeIntentFrom, recipeLabour, recipeRows, type MakeForm } from '@shared/simple/stock'
import { createGodown, createLedger, createStockItem, listStockItems, updateStockItem } from './masters'
import { getVoucher, saveVoucher, setLockDate } from './vouchers'
import { stockSummary } from './stockAnalysis'
import { listBomVersions, saveBomVersion, setBom } from './bom'
import { getManufactureDetails, saveManufacture } from './manufacture'
import { postClose } from './yearEnd'
import { undoSave } from './undo'
import { pricingLoader } from './pricing'
import { previewIntent, postIntent } from './simplePost'
import { madeGoodsSetup, saveRecipe, savedCount, setSellingPrice, stockList, stockProduct } from './simpleStock'
import { simpleHomeAttention } from './simpleHome'
import { createDemoCompany } from './demo'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>>()
vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../updater', () => ({ checkForUpdatesInteractive: async () => null }))
process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-simple-stock-'))
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Simple Stock Co', gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRegistrationType: 'regular' }
const TODAY = '2025-08-14'
const DAY = '2025-08-10'

let db: DB
let twin: DB
let seq = 0
const groupId = (d: DB, name: string): number => (d.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const I = (name: string, d: DB = db): number => (d.prepare('SELECT id FROM stock_items WHERE name = ?').get(name) as { id: number }).id
const L = (name: string, d: DB = db): number | undefined => (d.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined)?.id
const typeId = (d: DB, kind: string): number => (d.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id').get(kind) as { id: number }).id
const unitId = (d: DB, symbol: string): number => (d.prepare('SELECT id FROM units WHERE symbol = ?').get(symbol) as { id: number }).id

/** Flour 100 kg at ₹40 a kg (₹4,000), boxes 50 at ₹10 (₹500, warn below 60), bread (made: ½ kg
 *  flour + 1 box each), a supplier and the purchase account. */
function company(): DB {
  const d = seededDb()
  writeCompanyInfo(d, INFO)
  createLedger(d, {
    name: 'Purchases', groupId: groupId(d, 'Purchase Accounts'), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
    tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
  createStockItem(d, stockItemInputSchema.parse({ name: 'Flour', unitId: unitId(d, 'Kg'), openingQtyMilli: 100_000, openingValue: 400_000 }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Box', unitId: unitId(d, 'Nos'), openingQtyMilli: 50_000, openingValue: 50_000, reorderLevelMilli: 60_000 }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Bread', unitId: unitId(d, 'Nos'), gstRate: 5 }))
  createStockItem(d, stockItemInputSchema.parse({ name: 'Jam', unitId: unitId(d, 'Nos') }))
  setBom(d, { itemId: I('Bread', d), lines: [{ componentId: I('Flour', d), qtyMilliPerUnit: 500 }, { componentId: I('Box', d), qtyMilliPerUnit: 1000 }] })
  return d
}

const post = (intent: object, d: DB = db, info: CompanyInfo = INFO) => postIntent(d, info, { clientId: `stock-${++seq}-x`, ...intent }, TODAY)

/** Everything a refusal must leave untouched. */
function trace(d: DB = db): Record<string, number> {
  const n = (sql: string): number => (d.prepare(sql).get() as { n: number }).n
  return {
    vouchers: n('SELECT COUNT(*) AS n FROM vouchers'),
    inventory: n('SELECT COUNT(*) AS n FROM inventory_lines'),
    lines: n('SELECT COUNT(*) AS n FROM voucher_lines'),
    ledgers: n('SELECT COUNT(*) AS n FROM ledgers'),
    details: n('SELECT COUNT(*) AS n FROM manufacture_details'),
    posts: n('SELECT COUNT(*) AS n FROM simple_posts'),
    audit: n('SELECT COUNT(*) AS n FROM audit_log')
  }
}

/** A voucher as the books hold it, ids and line uids aside (the twin's masters have the same ids). */
function shape(v: Voucher): unknown {
  return {
    number: v.number, date: v.date, narration: v.narration, partyLedgerId: v.partyLedgerId,
    lines: v.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })),
    inventory: v.inventory.map((l) => ({ item: l.stockItemId, qty: l.qtyMilli, rate: l.ratePaise, amount: l.amount, direction: l.direction, absolute: l.isAbsolute, godownId: l.godownId }))
  }
}

const summaryOf = (d: DB, asOn: string) => stockSummary(d, asOn).map((r) => ({ itemId: r.stockItemId, qtyMilli: r.closingQtyMilli, value: r.closingValue }))
const listOf = (d: DB, asOn: string) => stockList(d, asOn).rows.map((r) => ({ itemId: r.itemId, qtyMilli: r.qtyMilli, value: r.value })).sort((a, b) => a.itemId - b.itemId)

beforeEach(() => {
  db = company()
  twin = company()
})

describe('the product list is the Stock summary', () => {
  it('on the demo seed: every product’s quantity and value, to the paisa — and after a count', () => {
    const { slug } = createDemoCompany()
    const demo = openCompanyDb(slug)
    const info = readCompanyInfo(demo)
    const today = todayISO()
    expect(listOf(demo, today)).toEqual(summaryOf(demo, today).sort((a, b) => a.itemId - b.itemId))
    expect(stockList(demo, today).rows.length).toBeGreaterThan(0)
    // Count the first product with stock one short.
    const first = stockSummary(demo, today).find((r) => r.closingQtyMilli >= 2000)!
    postIntent(demo, info, { clientId: 'demo-count-0001', ...countIntentFrom({ date: today, counted: { [first.stockItemId]: String((first.closingQtyMilli - 1000) / 1000) } }) }, today)
    expect(listOf(demo, today)).toEqual(summaryOf(demo, today).sort((a, b) => a.itemId - b.itemId))
    expect(stockList(demo, today).rows.find((r) => r.itemId === first.stockItemId)!.qtyMilli).toBe(first.closingQtyMilli - 1000)
    demo.close()
  })

  it('hand-worked after a sale, a return and a count: the list, the Stock summary and the arithmetic agree', () => {
    const L0 = { gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, openingBalance: 0 }
    createLedger(db, { ...L0, name: 'Sales', groupId: groupId(db, 'Sales Accounts') })
    createLedger(db, { ...L0, name: 'Ramesh', groupId: groupId(db, 'Sundry Debtors'), stateCode: '27' })
    // 10 kg of flour sold at ₹50 (it cost ₹40): 90 kg, ₹3,600 left.
    const sale = post({ kind: 'sale', date: DAY, customerId: L('Ramesh'), items: [{ itemId: I('Flour'), qty: '10', rate: '50' }], payment: { how: 'credit' } })
    const bill = getVoucher(db, sale.voucherIds[0]!)!
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Flour'))).toEqual({ itemId: I('Flour'), qtyMilli: 90_000, value: 360_000 })
    // 4 kg come back: they return at what they went out at (₹40) → 94 kg, ₹3,760.
    post({ kind: 'return_sale', date: DAY, billId: bill.id, items: [{ lineUid: bill.inventory[0]!.lineUid!, qty: '4' }] })
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Flour'))).toEqual({ itemId: I('Flour'), qtyMilli: 94_000, value: 376_000 })
    // Counted 93 kg: 1 kg short at the ₹40 average → ₹3,720.
    const count = post(countIntentFrom({ date: DAY, counted: { [I('Flour')]: '93' } }))
    expect(count.facts.count!.lines[0]).toMatchObject({ beforeMilli: 94_000, countedMilli: 93_000, valueChange: -4000 })
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Flour'))).toEqual({ itemId: I('Flour'), qtyMilli: 93_000, value: 372_000 })
    expect(listOf(db, TODAY)).toEqual(summaryOf(db, TODAY).sort((a, b) => a.itemId - b.itemId))
  })

  it('running low: below the reorder level, else out of what has been in stock (never a product never stocked)', () => {
    const list = stockList(db, TODAY)
    const level = (name: string) => list.rows.find((r) => r.name === name)!.level
    expect(level('Box')).toBe('low') // 50 < 60
    expect(level('Flour')).toBe('ok')
    expect(level('Jam')).toBe('ok') // never stocked: not "running low"
    expect(level('Bread')).toBe('ok')
    expect(list.lowCount).toBe(1)
    // Count the flour to zero: out.
    post(countIntentFrom({ date: DAY, counted: { [I('Flour')]: '0' } }))
    expect(stockList(db, TODAY).rows.find((r) => r.name === 'Flour')!.level).toBe('out')
    expect(stockList(db, TODAY).lowCount).toBe(2)
  })
})

describe('Count your stock = the hand-entered physical stock entry', () => {
  it('flour 2 kg short, boxes 2 extra: the same entry as the editor’s, priced by the engine (−₹80 / +₹20)', () => {
    const out = post(countIntentFrom({ date: DAY, counted: { [I('Flour')]: '98', [I('Box')]: '52', [I('Jam')]: '' } }))
    expect(out.voucherIds).toHaveLength(1)
    // The twin: an accountant types the same counts into the Physical Stock editor.
    const state = { ...emptyPhysicalState(DAY), rows: [
      { itemId: I('Flour', twin), qtyText: '98', godownId: null, batchId: null },
      { itemId: I('Box', twin), qtyText: '52', godownId: null, batchId: null }
    ] }
    const built = buildPhysicalPayload(state, { voucherTypeId: typeId(twin, 'physical_stock'), itemName: () => '' })
    if (!built.ok) throw new Error(built.error)
    const hand = saveVoucher(twin, built.payload)
    const mine = getVoucher(db, out.voucherIds[0]!)!
    expect(shape(mine)).toEqual(shape(getVoucher(twin, hand.id)!))
    // It opens in the Physical Stock editor and round-trips unchanged.
    expect(physicalRepresentation(mine, { itemName: () => '' }).ok).toBe(true)
    // The engine priced the differences (hand-worked: 2 kg × ₹40 off; 2 boxes in at the ₹10 average).
    expect(out.facts.count!.lines.map((l) => [l.name, l.beforeMilli, l.countedMilli, l.valueChange])).toEqual([
      ['Flour', 100_000, 98_000, -8000],
      ['Box', 50_000, 52_000, 2000]
    ])
    expect(out.sentences.join(' ')).toContain('Flour: 2 Kg short')
    expect(out.sentences.join(' ')).toContain('worth ₹60.00 less')
    expect(summaryOf(db, TODAY)).toEqual(summaryOf(twin, TODAY))
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Flour'))).toEqual({ itemId: I('Flour'), qtyMilli: 98_000, value: 392_000 })
  })

  it('preview says the same and leaves no trace; a product counted twice is refused on the counts', () => {
    const before = trace()
    const p = previewIntent(db, INFO, { clientId: 'preview-0001', kind: 'stock_count', date: DAY, counts: [{ itemId: I('Flour'), qty: '98' }] }, TODAY)
    expect(p.sentences.join(' ')).toContain('worth ₹80.00 less')
    expect(p.entries[0]!.items).toEqual([expect.objectContaining({ itemId: I('Flour'), qtyMilli: 98_000, amount: 0 })])
    expect(trace()).toEqual(before)
    expect(() => post({ kind: 'stock_count', date: DAY, counts: [{ itemId: I('Flour'), qty: 1 }, { itemId: I('Flour'), qty: 2 }] })).toThrow(
      expect.objectContaining({ code: 'simple_count_twice', field: 'counts' })
    )
    expect(trace()).toEqual(before)
  })

  it('Undo bins the count as one group (the stock is back); the same clientId replays without a second entry', () => {
    const intent = { clientId: 'count-replay-01', ...countIntentFrom({ date: DAY, counted: { [I('Box')]: '45' } }) }
    const a = postIntent(db, INFO, intent, TODAY)
    const b = postIntent(db, INFO, intent, TODAY)
    expect(b.replayed).toBe(true)
    expect(b.voucherIds).toEqual(a.voucherIds)
    expect(a.summary.undo.undoable).toBe(true)
    undoSave(db, a.voucherIds)
    expect(getVoucher(db, a.voucherIds[0]!)!.deletedAt).not.toBeNull()
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Box'))!.qtyMilli).toBe(50_000)
  })
})

describe('A saved count reopened shows the difference the engine recorded (PR #91 to-do)', () => {
  it('before = the Stock summary the day before, counted − before (never 0 because the total includes it), the value = the summary’s change', () => {
    const out = post(countIntentFrom({ date: DAY, counted: { [I('Flour')]: '98', [I('Box')]: '52' } }))
    // Later movements must not change what the count recorded.
    post(countIntentFrom({ date: '2025-08-12', counted: { [I('Flour')]: '90' } }))
    const view = savedCount(db, out.voucherIds[0]!)!
    const before = new Map(summaryOf(db, '2025-08-09').map((r) => [r.itemId, r]))
    const after = new Map(summaryOf(db, DAY).map((r) => [r.itemId, r]))
    expect(view.inBooks).toBe(true)
    expect(view.lines.map((l) => [l.name, l.beforeMilli, l.countedMilli, l.countedMilli - l.beforeMilli!, l.valueChange])).toEqual([
      ['Flour', 100_000, 98_000, -2000, -8000],
      ['Box', 50_000, 52_000, 2000, 2000]
    ])
    for (const l of view.lines) {
      expect(l.beforeMilli).toBe(before.get(l.itemId)!.qtyMilli)
      expect(l.countedMilli).toBe(after.get(l.itemId)!.qtyMilli)
      expect(l.valueChange).toBe(after.get(l.itemId)!.value - before.get(l.itemId)!.value)
    }
    // The entry itself, as the Physical Stock editor would show it, holds 98 / 52 — the books
    // total on the day includes it, so "counted − total" would read 0.
    expect(stockSummary(db, DAY).find((r) => r.stockItemId === I('Flour'))!.closingQtyMilli).toBe(98_000)
  })

  it('a binned count says so (no figures); anything that is not a count is null', () => {
    const out = post(countIntentFrom({ date: DAY, counted: { [I('Box')]: '45' } }))
    undoSave(db, out.voucherIds)
    const view = savedCount(db, out.voucherIds[0]!)!
    expect(view).toMatchObject({ inBooks: false, lines: [{ name: 'Box', countedMilli: 45_000, beforeMilli: null, valueChange: null }] })
    const made = post(makeIntentFrom({ ...emptyMakeForm(DAY), itemId: I('Bread'), qtyText: '1', price: 5000 }))
    expect(savedCount(db, made.voucherIds[0]!)).toBeNull()
    expect(savedCount(db, 999_999)).toBeNull()
  })
})

describe('Undo never leaves stock below zero (PR #91 to-do)', () => {
  const blank = { partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null }
  const useUp = (item: number, qtyMilli: number, date = TODAY) =>
    saveVoucher(db, { ...blank, voucherTypeId: typeId(db, 'stock_journal'), date, lines: [], inventory: [
      { stockItemId: item, godownId: null, batchId: null, qtyMilli, ratePaise: 0, amount: 0, direction: 'out' }
    ] } as Parameters<typeof saveVoucher>[1])
  const code = (fn: () => unknown): unknown => {
    try {
      fn()
    } catch (err) {
      return { code: (err as { code?: string }).code, field: (err as { field?: string }).field, params: (err as { params?: unknown }).params }
    }
    return null
  }

  it('a count after which more was used than the books had without it: Undo refused, nothing binned, no audit row', () => {
    const out = post(countIntentFrom({ date: DAY, counted: { [I('Box')]: '60' } }))
    useUp(I('Box'), 55_000) // 60 − 55 = 5 left; without the count 50 − 55 = −5
    const before = trace()
    expect(code(() => undoSave(db, out.voucherIds))).toEqual({ code: 'simple_undo_negative_stock', field: undefined, params: { name: 'Box' } })
    expect(trace()).toEqual(before)
    expect(getVoucher(db, out.voucherIds[0]!)!.deletedAt).toBeNull()
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Box'))!.qtyMilli).toBe(5000)
  })

  it('a batch made whose goods were used since: refused; with enough left it undoes as before', () => {
    const made = post(makeIntentFrom({ ...emptyMakeForm(DAY), itemId: I('Bread'), qtyText: '4', price: 5000 }))
    useUp(I('Bread'), 3000)
    expect(code(() => undoSave(db, made.voucherIds))).toMatchObject({ code: 'simple_undo_negative_stock', params: { name: 'Bread' } })
    expect(getVoucher(db, made.voucherIds[0]!)!.deletedAt).toBeNull()
    // A count that only some later use rests on — still ≥ 0 without it — undoes as before.
    const count = post(countIntentFrom({ date: DAY, counted: { [I('Flour')]: '90' } }))
    useUp(I('Flour'), 10_000)
    undoSave(db, count.voucherIds)
    expect(getVoucher(db, count.voucherIds[0]!)!.deletedAt).not.toBeNull()
  })

  it('a product already below zero before the count may go back to that level; used since = refused', () => {
    useUp(I('Box'), 60_000, '2025-08-05') // 50 − 60 = −10 before the count (accountant mode allows it)
    const back = post(countIntentFrom({ date: DAY, counted: { [I('Box')]: '5' } }))
    undoSave(db, back.voucherIds) // nothing moved since: back to −10, as before the count
    expect(getVoucher(db, back.voucherIds[0]!)!.deletedAt).not.toBeNull()
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Box'))!.qtyMilli).toBe(-10_000)
    const again = post(countIntentFrom({ date: DAY, counted: { [I('Box')]: '5' } }))
    useUp(I('Box'), 8000, '2025-08-12') // 5 − 8 = −3 with the count; −18 without it, below the −10 before it
    const before = trace()
    expect(code(() => undoSave(db, again.voucherIds))).toMatchObject({ code: 'simple_undo_negative_stock', params: { name: 'Box' } })
    expect(trace()).toEqual(before)
  })
})

describe('Made goods = the hand-entered manufacture', () => {
  const make = (f: Partial<MakeForm>, d: DB = db) => post(makeIntentFrom({ ...emptyMakeForm(DAY), itemId: I('Bread', d), qtyText: '10', price: 5000, ...f }), d)

  /** What the Manufacture screen saves for 10 bread at ₹50 with labour (hand-worked: 5 kg flour
   *  × ₹40 = ₹200, 10 boxes × ₹10 = ₹100, + labour ₹50 → ₹350; sold at ₹500 → ₹150 profit). */
  function handInput(d: DB, labourPosted: boolean): ManufactureInput {
    return {
      date: DAY, finishedItemId: I('Bread', d), qtyMilli: 10_000, saleRatePaise: 5000,
      raw: [{ stockItemId: I('Flour', d), qtyMilli: 5000 }, { stockItemId: I('Box', d), qtyMilli: 10_000 }],
      labourPaise: 5000, labourPosted, profitPaise: 15_000, bomVersionId: (d.prepare('SELECT id FROM bom_versions').get() as { id: number }).id, narration: null, godownId: null
    }
  }

  it('labour still to pay: the same stock journal as the editor’s (Labour Charges / Wages Payable), bread at ₹350', () => {
    const out = make({ labour: 5000, labourRecorded: false })
    const hand = saveManufacture(twin, handInput(twin, true))
    const mine = getVoucher(db, out.voucherIds[0]!)!
    expect(shape(mine)).toEqual(shape(getVoucher(twin, hand.id)!))
    const { voucherId: _a, ...dm } = getManufactureDetails(db, mine.id)!
    const { voucherId: _b, ...dt } = getManufactureDetails(twin, hand.id)!
    expect(dm).toEqual(dt)
    expect(mine.inventory.map((l) => l.amount)).toEqual([20_000, 10_000, 35_000])
    expect(mine.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[L('Labour Charges'), 'dr', 5000], [L('Wages Payable'), 'cr', 5000]])
    expect(out.facts.made).toMatchObject({ materialPaise: 30_000, labourPaise: 5000, valuePaise: 35_000, profitPaise: 15_000 })
    // It opens in the Manufacture screen and round-trips unchanged.
    expect(manufactureRepresentation(mine, getManufactureDetails(db, mine.id), { itemName: () => 'x' }).ok).toBe(true)
    expect(summaryOf(db, TODAY)).toEqual(summaryOf(twin, TODAY))
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Bread'))).toEqual({ itemId: I('Bread'), qtyMilli: 10_000, value: 35_000 })
  })

  it('labour already recorded: no lines, still in the bread’s value; no labour: materials only', () => {
    const out = make({ labour: 5000, labourRecorded: true })
    const hand = saveManufacture(twin, handInput(twin, false))
    expect(shape(getVoucher(db, out.voucherIds[0]!)!)).toEqual(shape(getVoucher(twin, hand.id)!))
    expect(getVoucher(db, out.voucherIds[0]!)!.lines).toEqual([])
    expect(L('Wages Payable')).toBeUndefined()
    const plain = make({ qtyText: '2' })
    expect(getVoucher(db, plain.voucherIds[0]!)!.inventory.at(-1)!.amount).toBe(2 * 2000 + 2 * 1000)
    expect(plain.sentences[0]).toBe('Made 2 Nos of Bread.')
  })

  it('the price defaults to the editor’s suggestion (the price list) and is margin only', () => {
    setSellingPrice(db, I('Bread'), 6000, '2025-04-01')
    const out = post({ kind: 'make_goods', date: DAY, itemId: I('Bread'), qty: 1000 })
    expect(getManufactureDetails(db, out.voucherIds[0]!)!.saleRatePaise).toBe(6000)
    expect(madeGoodsSetup(db, DAY).products).toEqual([expect.objectContaining({ name: 'Bread', suggestedPrice: 6000 })])
  })

  it('refusals on their questions, leaving no trace: not enough flour → qty; no recipe → item; no price → price', () => {
    const before = trace()
    expect(() => make({ qtyText: '300' })).toThrow(expect.objectContaining({ code: 'simple_not_enough_material', field: 'qty', params: expect.objectContaining({ names: 'Flour, Box' }) }))
    expect(() => post({ kind: 'make_goods', date: DAY, itemId: I('Jam'), qty: 1000, price: 100 })).toThrow(expect.objectContaining({ code: 'simple_no_recipe', field: 'item' }))
    expect(() => post({ kind: 'make_goods', date: DAY, itemId: I('Bread'), qty: 1000 })).toThrow(expect.objectContaining({ code: 'simple_no_sale_price', field: 'price' }))
    expect(trace()).toEqual(before)
  })

  it('a locked date and a closed year are refused under the date; Undo bins the batch (materials back)', () => {
    setLockDate(db, '2025-08-31')
    const before = trace()
    expect(() => make({})).toThrow(expect.objectContaining({ code: 'books_locked', field: 'date' }))
    expect(() => post(countIntentFrom({ date: DAY, counted: { [I('Box')]: '1' } }))).toThrow(expect.objectContaining({ code: 'books_locked', field: 'date' }))
    expect(trace()).toEqual(before)
    setLockDate(db, null)
    const out = make({ labour: 5000, labourRecorded: false })
    undoSave(db, out.voucherIds)
    expect(listOf(db, TODAY).find((r) => r.itemId === I('Flour'))!.qtyMilli).toBe(100_000)
    make({ labour: 5000, labourRecorded: false }) // some labour cost for the year-end close to close
    postClose(db, INFO, 2025)
    setLockDate(db, null)
    const closed = trace()
    expect(() => post(makeIntentFrom({ ...emptyMakeForm('2025-09-01'), itemId: I('Bread'), qtyText: '1', price: 5000 }))).toThrow(expect.objectContaining({ code: 'simple_year_closed', field: 'date' }))
    expect(trace()).toEqual(closed)
  })
})

describe('the product view, Change price, Home', () => {
  it('a product’s view: the list’s figures, its recipe, and its history this year in words', () => {
    post(countIntentFrom({ date: DAY, counted: { [I('Flour')]: '98' } }))
    post(makeIntentFrom({ ...emptyMakeForm(DAY), itemId: I('Bread'), qtyText: '4', price: 5000 }))
    const flour = stockProduct(db, I('Flour'), TODAY)!
    expect(flour).toMatchObject({ qtyMilli: 96_000, value: 384_000, unitCost: 4000, level: 'ok' })
    expect(flour.history.openingMilli).toBe(100_000)
    expect(flour.history.rows.map((r) => [r.what, r.inMilli, r.outMilli, r.balanceMilli])).toEqual([['counted', 0, 2000, 98_000], ['used', 0, 2000, 96_000]])
    const bread = stockProduct(db, I('Bread'), TODAY)!
    expect(bread.recipe!.lines.map((l) => [l.name, l.qtyMilliPerUnit])).toEqual([['Flour', 500], ['Box', 1000]])
    expect(bread.history.rows.map((r) => r.what)).toEqual(['made'])
  })

  it('history: a stock journal that is not a manufacture is never "used to make goods" (a write-off reads "Changed by hand", a transfer "Moved")', () => {
    const blank = { partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null }
    const main = createGodown(db, { name: 'Shop' }).id
    const back = createGodown(db, { name: 'Back room' }).id
    // 1 kg of flour written off by hand in the full app's stock journal.
    saveVoucher(db, { ...blank, voucherTypeId: typeId(db, 'stock_journal'), date: DAY, lines: [], inventory: [
      { stockItemId: I('Flour'), godownId: main, batchId: null, qtyMilli: 1000, ratePaise: 0, amount: 4000, direction: 'out' }
    ] } as Parameters<typeof saveVoucher>[1])
    // 2 kg moved from the shop to the back room.
    saveVoucher(db, { ...blank, voucherTypeId: typeId(db, 'stock_journal'), date: DAY, lines: [], inventory: [
      { stockItemId: I('Flour'), godownId: main, batchId: null, qtyMilli: 2000, ratePaise: 0, amount: 8000, direction: 'out' },
      { stockItemId: I('Flour'), godownId: back, batchId: null, qtyMilli: 2000, ratePaise: 0, amount: 8000, direction: 'in' }
    ] } as Parameters<typeof saveVoucher>[1])
    post(makeIntentFrom({ ...emptyMakeForm(DAY), itemId: I('Bread'), qtyText: '2', price: 5000 }))
    const flour = stockProduct(db, I('Flour'), TODAY)!
    expect(flour.history.rows.map((r) => [r.what, r.inMilli, r.outMilli])).toEqual([
      ['adjusted', 0, 1000], ['other', 0, 2000], ['other', 2000, 0], ['used', 0, 1000]
    ])
    expect(stockProduct(db, I('Bread'), TODAY)!.history.rows.map((r) => r.what)).toEqual(['made'])
  })

  it('Change price: a new row from the date on the default level; earlier bills keep the old price', () => {
    setSellingPrice(db, I('Box'), 1500, '2025-04-01')
    setSellingPrice(db, I('Box'), 1800, TODAY)
    const price = pricingLoader(db)
    const at = (date: string) => price({ date, partyLedgerId: null, currency: 'INR', supply: 'intra' }, I('Box'), 1000).ratePaise
    expect(at('2025-05-01')).toBe(1500)
    expect(at(TODAY)).toBe(1800)
    expect(stockList(db, TODAY).rows.find((r) => r.name === 'Box')!.sellingPrice).toBe(1800)
    const rows = db.prepare('SELECT rate, effective_from AS f, effective_to AS t FROM price_list_rates WHERE stock_item_id = ? ORDER BY effective_from').all(I('Box'))
    expect(rows).toEqual([{ rate: 1500, f: '2025-04-01', t: '2025-08-13' }, { rate: 1800, f: TODAY, t: null }])
    // The same price again changes nothing; a change on the same day replaces that day's row.
    const audit = trace().audit
    setSellingPrice(db, I('Box'), 1800, TODAY)
    expect(trace().audit).toBe(audit)
    setSellingPrice(db, I('Box'), 1900, TODAY)
    expect(at(TODAY)).toBe(1900)
    expect((db.prepare('SELECT COUNT(*) AS n FROM price_list_rates').get() as { n: number }).n).toBe(2)
  })

  it('Tell me when it runs low: the masters item update with the stored item sets the level the list reads; 0 / none = only when out; audited', () => {
    const flour = I('Flour')
    const stored = listStockItems(db).find((i) => i.id === flour)!
    expect(stockList(db, TODAY).rows.find((r) => r.itemId === flour)!.level).toBe('ok')
    // What ProductView sends: the stored item with only the level changed (120 kg > the 100 on hand).
    updateStockItem(db, flour, stockItemInputSchema.parse({ ...stored, reorderLevelMilli: 120_000 }))
    expect(stockList(db, TODAY).rows.find((r) => r.itemId === flour)).toMatchObject({ reorderLevelMilli: 120_000, level: 'low' })
    expect(stockProduct(db, flour, TODAY)).toMatchObject({ reorderLevelMilli: 120_000, level: 'low' })
    expect(simpleHomeAttention(db, INFO, TODAY).items.find((i) => i.source === 'stock')!.count).toBe(2)
    // Nothing else about the product moved (figures unchanged).
    const after = listStockItems(db).find((i) => i.id === flour)!
    expect({ ...after, reorderLevelMilli: null }).toEqual({ ...stored, reorderLevelMilli: null })
    expect(summaryOf(db, TODAY)).toEqual(summaryOf(twin, TODAY))
    const audit = db.prepare("SELECT before_json, after_json FROM audit_log WHERE entity = 'stockItem' AND entity_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1").get(flour) as { before_json: string; after_json: string }
    expect([JSON.parse(audit.before_json).reorderLevelMilli, JSON.parse(audit.after_json).reorderLevelMilli]).toEqual([null, 120_000])
    updateStockItem(db, flour, stockItemInputSchema.parse({ ...stored, reorderLevelMilli: null }))
    // Every column of a fully filled-in product round-trips; only reorder_level_milli changes.
    const full = createStockItem(db, stockItemInputSchema.parse({
      name: 'Saffron', unitId: unitId(db, 'Kg'), hsn: '0910', gstRate: 5, cessRate: 1, openingQtyMilli: 2500, openingValue: 12_345,
      barcode: '890123', reorderLevelMilli: 1000, valuationMethod: 'fifo', trackSerials: true, mrpPaise: 99_900, standardCostPaise: 45_600
    }))
    const raw = (): Record<string, unknown> => db.prepare('SELECT * FROM stock_items WHERE id = ?').get(full.id) as Record<string, unknown>
    const levels = (): unknown => db.prepare('SELECT * FROM price_list_rates ORDER BY id').all()
    const [rowBefore, levelsBefore] = [raw(), levels()]
    const listed = listStockItems(db).find((i) => i.id === full.id)!
    updateStockItem(db, full.id, stockItemInputSchema.parse({ ...listed, reorderLevelMilli: 3000 }))
    expect(raw()).toEqual({ ...rowBefore, reorder_level_milli: 3000 })
    expect(levels()).toEqual(levelsBefore)
    expect(stockList(db, TODAY).rows.find((r) => r.itemId === flour)!.level).toBe('ok')
  })

  it('Home: “N products running low” is the list’s own count', () => {
    const att = simpleHomeAttention(db, INFO, TODAY)
    expect(att.items.find((i) => i.source === 'stock')).toEqual({ source: 'stock', key: 'low_stock', count: 1, amount: null, level: 'medium' })
  })
})

describe('the recipe editor = the accountant BOM editor', () => {
  const NEW_DAY = '2025-08-12'
  const bomRows = (d: DB) => ({
    versions: d.prepare('SELECT * FROM bom_versions ORDER BY id').all(),
    lines: d.prepare('SELECT * FROM bom_version_lines ORDER BY id').all()
  })
  const bomAudit = (d: DB) =>
    (d.prepare("SELECT entity_id AS id, action, before_json AS b, after_json AS a FROM audit_log WHERE entity = 'bom' ORDER BY id").all() as { id: number; action: string; b: string | null; a: string | null }[])
  const recipeTrace = (d: DB = db) => {
    const n = (sql: string): number => (d.prepare(sql).get() as { n: number }).n
    return { versions: n('SELECT COUNT(*) AS n FROM bom_versions'), lines: n('SELECT COUNT(*) AS n FROM bom_version_lines'), audit: n('SELECT COUNT(*) AS n FROM audit_log'), meta: JSON.stringify(d.prepare('SELECT * FROM meta ORDER BY key').all()) }
  }
  const refusal = (fn: () => unknown): { code?: string; field?: string } => {
    try {
      fn()
    } catch (err) {
      const e = err as { code?: string; field?: string }
      return { code: e.code, field: e.field }
    }
    throw new Error('not refused')
  }
  /** Bread changes to 600 g of flour + 1 box, ₹10 labour each, from 12 Aug. */
  const change = (d: DB) => saveRecipe(d, { itemId: I('Bread', d), rows: [{ itemId: I('Flour', d), qtyMilli: 600 }, { itemId: I('Box', d), qtyMilli: 1000 }], labourPerUnit: 1000 }, NEW_DAY)
  /** The same change typed into the full editor: "+ New version" v2, effective from 12 Aug, default. */
  const handChange = (d: DB) =>
    saveBomVersion(d, { itemId: I('Bread', d), name: 'v2', effectiveFrom: NEW_DAY, effectiveTo: null, isDefault: true, lines: [{ componentId: I('Flour', d), qtyMilliPerUnit: 600, scrapPctBp: null }, { componentId: I('Box', d), qtyMilliPerUnit: 1000, scrapPctBp: null }] })

  it('a changed recipe is the full editor’s new version row for row (same audit row); the old one stays for earlier dates', () => {
    const auditBefore = bomAudit(db).length
    const r = change(db)
    handChange(twin)
    expect(r.changed).toBe(true)
    expect(bomRows(db)).toEqual(bomRows(twin))
    // The version's own audit row is the full editor's; the labour per unit is one more `bom` row.
    const mine = bomAudit(db).slice(auditBefore)
    const theirs = bomAudit(twin).slice(auditBefore)
    expect(mine[0]).toEqual(theirs[0])
    expect(mine[0]).toMatchObject({ id: I('Bread'), action: 'create' })
    expect(mine).toHaveLength(2)
    expect(JSON.parse(mine[1]!.a!)).toEqual({ versionId: r.recipe!.versionId, labourPerUnitPaise: 1000 })
    // Before 12 Aug the old recipe (½ kg), from it the new one.
    const versions = listBomVersions(db)
    expect(recipeRows(I('Bread'), 10_000, versions, DAY)!.rows).toEqual([{ componentId: I('Flour'), qtyMilli: 5000 }, { componentId: I('Box'), qtyMilli: 10_000 }])
    expect(recipeRows(I('Bread'), 10_000, versions, NEW_DAY)!.rows).toEqual([{ componentId: I('Flour'), qtyMilli: 6000 }, { componentId: I('Box'), qtyMilli: 10_000 }])
    expect(versions.filter((v) => v.itemId === I('Bread'))).toHaveLength(2)
    // The product view and Made goods read it, with the labour per one.
    const view = stockProduct(db, I('Bread'), TODAY)!.recipe!
    expect(view).toMatchObject({ effectiveFrom: NEW_DAY, labourPerUnit: 1000 })
    expect(view.lines.map((l) => l.qtyMilliPerUnit)).toEqual([600, 1000])
    expect(madeGoodsSetup(db, TODAY).products.find((p) => p.itemId === I('Bread'))!.recipe.labourPerUnit).toBe(1000)
    expect(madeGoodsSetup(db, DAY).products.find((p) => p.itemId === I('Bread'))!.recipe.labourPerUnit).toBeUndefined()
  })

  it('Made goods after it = the hand-entered manufacture with the new recipe (6 kg × ₹40 + 10 × ₹10 + ₹100 labour = ₹440)', () => {
    change(db)
    const v2 = handChange(twin)
    const setup = madeGoodsSetup(db, TODAY).products.find((p) => p.itemId === I('Bread'))!
    const labour = recipeLabour(setup.recipe.labourPerUnit!, 10_000)
    expect(labour).toBe(10_000)
    const out = post(makeIntentFrom({ ...emptyMakeForm(TODAY), itemId: I('Bread'), qtyText: '10', price: 5000, labour, labourRecorded: false }))
    const hand = saveManufacture(twin, {
      date: TODAY, finishedItemId: I('Bread', twin), qtyMilli: 10_000, saleRatePaise: 5000,
      raw: [{ stockItemId: I('Flour', twin), qtyMilli: 6000 }, { stockItemId: I('Box', twin), qtyMilli: 10_000 }],
      labourPaise: 10_000, labourPosted: true, profitPaise: 6000, bomVersionId: v2.id, narration: null, godownId: null
    })
    const mine = getVoucher(db, out.voucherIds[0]!)!
    expect(shape(mine)).toEqual(shape(getVoucher(twin, hand.id)!))
    const { voucherId: _a, ...dm } = getManufactureDetails(db, mine.id)!
    const { voucherId: _b, ...dt } = getManufactureDetails(twin, hand.id)!
    expect(dm).toEqual(dt)
    expect(mine.inventory.map((l) => l.amount)).toEqual([24_000, 10_000, 44_000])
    expect(summaryOf(db, TODAY)).toEqual(summaryOf(twin, TODAY))
  })

  it('a first recipe is in force always; the same answers again write nothing; scrap on a material that stays is kept', () => {
    const r = saveRecipe(db, { itemId: I('Jam'), rows: [{ itemId: I('Flour'), qtyMilli: 250 }], labourPerUnit: null }, NEW_DAY)
    const jam = listBomVersions(db, I('Jam'))
    expect(jam).toEqual([{ id: r.recipe!.versionId, itemId: I('Jam'), name: 'v1', effectiveFrom: null, effectiveTo: null, isDefault: true, lines: [{ componentId: I('Flour'), qtyMilliPerUnit: 250, scrapPctBp: null }] }])
    const before = recipeTrace()
    expect(saveRecipe(db, { itemId: I('Jam'), rows: [{ itemId: I('Flour'), qtyMilli: 250 }], labourPerUnit: 0 }, TODAY)).toMatchObject({ changed: false })
    expect(recipeTrace()).toEqual(before)
    // The accountant gave flour a 5 % scrap allowance; a simple change keeps it.
    saveBomVersion(db, { ...jam[0]!, lines: [{ componentId: I('Flour'), qtyMilliPerUnit: 250, scrapPctBp: 500 }] })
    saveRecipe(db, { itemId: I('Jam'), rows: [{ itemId: I('Flour'), qtyMilli: 300 }, { itemId: I('Box'), qtyMilli: 1000 }], labourPerUnit: null }, TODAY)
    expect(listBomVersions(db, I('Jam')).at(-1)).toMatchObject({ name: 'v2', effectiveFrom: TODAY, isDefault: true, lines: [{ componentId: I('Flour'), qtyMilliPerUnit: 300, scrapPctBp: 500 }, { componentId: I('Box'), qtyMilliPerUnit: 1000, scrapPctBp: null }] })
  })

  it('refusals on the row, leaving no trace: itself, listed twice, no quantity, empty, a loop through another recipe, an unknown product', () => {
    const before = recipeTrace()
    const jam = I('Jam')
    expect(refusal(() => saveRecipe(db, { itemId: jam, rows: [{ itemId: I('Flour'), qtyMilli: 100 }, { itemId: jam, qtyMilli: 1000 }], labourPerUnit: null }, TODAY))).toEqual({ code: 'simple_recipe_self', field: 'rows.1.item' })
    expect(refusal(() => saveRecipe(db, { itemId: jam, rows: [{ itemId: I('Flour'), qtyMilli: 100 }, { itemId: I('Flour'), qtyMilli: 200 }], labourPerUnit: null }, TODAY))).toEqual({ code: 'simple_recipe_twice', field: 'rows.1.item' })
    expect(refusal(() => saveRecipe(db, { itemId: jam, rows: [{ itemId: I('Flour'), qtyMilli: 0 }], labourPerUnit: null }, TODAY))).toEqual({ code: 'simple_recipe_qty', field: 'rows.0.qty' })
    expect(refusal(() => saveRecipe(db, { itemId: jam, rows: [], labourPerUnit: null }, TODAY))).toEqual({ code: 'simple_recipe_empty', field: 'rows' })
    // Bread is made with flour, so flour can't be made with bread.
    expect(refusal(() => saveRecipe(db, { itemId: I('Flour'), rows: [{ itemId: I('Bread'), qtyMilli: 1000 }], labourPerUnit: null }, TODAY))).toEqual({ code: 'simple_recipe_cycle', field: 'rows.0.item' })
    expect(refusal(() => saveRecipe(db, { itemId: jam, rows: [{ itemId: 99_999, qtyMilli: 1000 }], labourPerUnit: null }, TODAY))).toEqual({ code: 'simple_recipe_unknown', field: 'rows.0.item' })
    expect(recipeTrace()).toEqual(before)
  })

  it('a change from a working date BEFORE a later recipe is refused (that recipe would win from its start), leaving no trace', () => {
    change(db) // Bread v2 from 12 Aug
    const before = recipeTrace()
    expect(DAY < NEW_DAY).toBe(true)
    expect(refusal(() => saveRecipe(db, { itemId: I('Bread'), rows: [{ itemId: I('Flour'), qtyMilli: 700 }], labourPerUnit: null }, DAY))).toEqual({ code: 'simple_recipe_later', field: undefined })
    expect(recipeTrace()).toEqual(before)
    // The same answers as the recipe in force that day are still "nothing changed".
    expect(saveRecipe(db, { itemId: I('Bread'), rows: [{ itemId: I('Flour'), qtyMilli: 500 }, { itemId: I('Box'), qtyMilli: 1000 }], labourPerUnit: null }, DAY)).toMatchObject({ changed: false })
    // From the later recipe's own start (or after it) a change is fine.
    expect(saveRecipe(db, { itemId: I('Bread'), rows: [{ itemId: I('Flour'), qtyMilli: 700 }], labourPerUnit: null }, NEW_DAY)).toMatchObject({ changed: true })
  })
})

describe('roles', () => {
  it('a viewer reads the Stock screens but can’t count or make (simple:post refused, nothing written)', async () => {
    const ipc = await import('../ipc')
    ipc.registerIpc()
    const call = async (ch: string, p?: unknown) => handlers.get(ch)!({}, p)
    const ok = async <T,>(ch: string, p?: unknown): Promise<T> => {
      const res = await call(ch, p)
      if (!res.ok) throw new Error(`${ch}: ${res.error}`)
      return res.data as T
    }
    const { slug } = await ok<{ slug: string }>('company:create', { name: 'Viewer Stock Co', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null })
    await ok('company:open', { slug })
    const unit = (await ok<{ id: number; symbol: string }[]>('master:units:list')).find((u) => u.symbol === 'Nos')!
    const item = await ok<{ id: number }>('master:stockItems:create', { name: 'Soap', unitId: unit.id, openingQtyMilli: 5000, openingValue: 5000 })
    await ok('users:save', { data: { name: 'Olive', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    const before = await ok<{ rows: unknown[] }>('simple:stock:list', { today: TODAY })
    const res = await call('simple:post', { intent: { clientId: 'viewer-count-01', kind: 'stock_count', date: TODAY, counts: [{ itemId: item.id, qty: 1000 }] }, today: TODAY })
    expect(res).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(await call('simple:stock:setPrice', { itemId: item.id, ratePaise: 100 })).toMatchObject({ ok: false, code: 'not_permitted' })
    // The recipe editor is the accountant BOM editor's role (bom:saveVersion): a viewer can't save one.
    const versionsBefore = await ok<unknown[]>('bom:versions', {})
    expect(await call('simple:stock:setRecipe', { itemId: item.id, rows: [{ itemId: item.id, qtyMilli: 1000 }] })).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(await ok('bom:versions', {})).toEqual(versionsBefore)
    // "Tell me when it runs low" is the masters item update — accountant and up.
    const soap = (await ok<{ id: number; reorderLevelMilli: number | null }[]>('master:stockItems:list')).find((i) => i.id === item.id)!
    expect(await call('master:stockItems:update', { id: item.id, data: { ...soap, reorderLevelMilli: 2000 } })).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(await ok('simple:stock:list', { today: TODAY })).toEqual(before)
    expect(await call('simple:stock:count', { voucherId: 1 })).toMatchObject({ ok: true })
  })
})
