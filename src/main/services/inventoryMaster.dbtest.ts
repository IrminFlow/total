import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import {
  createStockGroup,
  createStockItem,
  effectiveItemTax,
  findItem,
  listStockGroups,
  updateStockItem
} from './masters'
import { nearExpiry } from './stockAnalysis'
import { createBatch } from './masters'
import { saveVoucher } from './vouchers'
import { stockGroupInputSchema, stockItemInputSchema } from '@shared/schemas'

type Db = ReturnType<typeof seededDb>

const unitId = (db: Db): number => (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id

/** Parsed through the schema, like the IPC layer does — so defaults apply and the test exercises
 *  the same shape the app actually saves. */
function item(db: Db, name: string, over: Record<string, unknown> = {}) {
  return createStockItem(db, stockItemInputSchema.parse({ name, unitId: unitId(db), ...over }))
}

function makeGroup(db: Db, over: Record<string, unknown>) {
  return createStockGroup(db, stockGroupInputSchema.parse(over))
}

describe('tax inherited from the item group', () => {
  it('takes the group rate when the item states none', () => {
    const db = seededDb()
    const group = makeGroup(db, { name: 'Textiles', gstRate: 5, hsn: '5208' })
    const i = item(db, 'Cotton Shirt', { groupId: group.id })
    const tax = effectiveItemTax(db, i.id)
    expect(tax.gstRate).toBe(5)
    expect(tax.hsn).toBe('5208')
    expect(tax.inherited).toEqual({ gstRate: true, cessRate: false, hsn: true })
    expect(tax.fromGroup).toBe('Textiles')
  })

  it('lets the item override its group', () => {
    const db = seededDb()
    const group = makeGroup(db, { name: 'Textiles', gstRate: 5, hsn: '5208' })
    const i = item(db, 'Silk Shirt', { groupId: group.id, gstRate: 12 })
    const tax = effectiveItemTax(db, i.id)
    expect(tax.gstRate).toBe(12)
    expect(tax.inherited.gstRate).toBe(false)
    // The HSN was not overridden, so it still follows the group.
    expect(tax.hsn).toBe('5208')
    expect(tax.inherited.hsn).toBe(true)
  })

  it('walks up the tree, nearest ancestor winning', () => {
    const db = seededDb()
    const parent = makeGroup(db, { name: 'Food', gstRate: 5, hsn: '2106' })
    const child = makeGroup(db, { name: 'Beverages', parentId: parent.id, gstRate: 18 })
    const i = item(db, 'Cola', { groupId: child.id })
    const tax = effectiveItemTax(db, i.id)
    expect(tax.gstRate).toBe(18)
    // Nothing nearer states an HSN, so the grandparent's is used.
    expect(tax.hsn).toBe('2106')
  })

  it('inherits nothing when nothing states anything', () => {
    const db = seededDb()
    const group = makeGroup(db, { name: 'Misc' })
    const i = item(db, 'Odds and Ends', { groupId: group.id })
    expect(effectiveItemTax(db, i.id)).toMatchObject({ gstRate: null, hsn: null, fromGroup: null })
  })

  it('round-trips the group rate through create and list', () => {
    const db = seededDb()
    makeGroup(db, { name: 'Spices', gstRate: 5, cessRate: 12, hsn: '0904' })
    const saved = listStockGroups(db).find((g) => g.name === 'Spices')!
    expect(saved).toMatchObject({ gstRate: 5, cessRate: 12, hsn: '0904' })
  })
})

describe('finding an item the way a person at a counter would', () => {
  it('finds by code, barcode or exact name', () => {
    const db = seededDb()
    const i = item(db, 'Parle-G Biscuit 200g', { code: 'PG200', barcode: '8901719100017' })
    expect(findItem(db, 'PG200')!.id).toBe(i.id)
    expect(findItem(db, 'pg200')!.id).toBe(i.id)
    expect(findItem(db, '8901719100017')!.id).toBe(i.id)
    expect(findItem(db, 'Parle-G Biscuit 200g')!.id).toBe(i.id)
    expect(findItem(db, 'nothing like this')).toBeNull()
    expect(findItem(db, '  ')).toBeNull()
  })

  it('prefers the coded item when a name collides with a code', () => {
    const db = seededDb()
    const coded = item(db, 'Widget', { code: '12' })
    item(db, '12')
    expect(findItem(db, '12')!.id).toBe(coded.id)
  })

  it('keeps codes unique but lets any number of items have none', () => {
    const db = seededDb()
    item(db, 'A', { code: 'X1' })
    expect(() => item(db, 'B', { code: 'X1' })).toThrow()
    item(db, 'C')
    item(db, 'D')
    expect(findItem(db, 'X1')!.name).toBe('A')
  })

  it('normalises a cleared code to null so two blanks do not collide', () => {
    const db = seededDb()
    const a = item(db, 'A', { code: 'X1' })
    const b = item(db, 'B', { code: 'X2' })
    updateStockItem(db, a.id, stockItemInputSchema.parse({ name: 'A', unitId: unitId(db), code: '  ' }))
    updateStockItem(db, b.id, stockItemInputSchema.parse({ name: 'B', unitId: unitId(db), code: '' }))
    expect(findItem(db, 'X1')).toBeNull()
  })
})

describe('alternate units on the item master', () => {
  it('stores a unit and its conversion together, or neither', () => {
    const db = seededDb()
    const u = unitId(db)
    const both = item(db, 'Boxed', { altUnitId: u, altConversionMilli: 12_000 })
    expect(both).toMatchObject({ altUnitId: u, altConversionMilli: 12_000 })

    // Half the pair is meaningless: toBase would be a silent no-op that looks like it worked.
    const halfA = item(db, 'Unit only', { altUnitId: u })
    expect(halfA.altUnitId).toBeNull()
    const halfB = item(db, 'Conversion only', { altConversionMilli: 12_000 })
    expect(halfB.altConversionMilli).toBeNull()
  })
})

describe('near-expiry, with what it is worth', () => {
  function stocked(db: Db, name: string, expiry: string | null, qty: number, rate: number) {
    const i = item(db, name)
    const batch = createBatch(db, { stockItemId: i.id, name: `${name}-B1`, mfgDate: null, expiryDate: expiry })
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'purchase'").get() as { id: number }
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const purchases = (db.prepare("SELECT id FROM groups WHERE name = 'Purchase Accounts'").get() as { id: number }).id
    const acct = (db.prepare('SELECT id FROM ledgers WHERE name = ?').get('Purchase Account') as { id: number } | undefined)?.id
      ?? (db.prepare('INSERT INTO ledgers (name, group_id, opening_balance) VALUES (?, ?, 0) RETURNING id')
        .get('Purchase Account', purchases) as { id: number }).id
    const amount = Math.round((qty * rate) / 1000)
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-01-01', number: `P-${name}`, partyLedgerId: null,
      lines: [
        { ledgerId: acct, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: cash, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [{ stockItemId: i.id, batchId: batch.id, qtyMilli: qty, ratePaise: rate, amount, direction: 'in', godownId: null }],
      billRefs: [], tds: null
    } as never)
    return { item: i, batch }
  }

  it('values each batch at what the books say the item is worth', () => {
    const db = seededDb()
    stocked(db, 'Expiring', '2026-02-15', 10_000, 100_00)
    const r = nearExpiry(db, '2026-02-01')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.bucket).toBe('within30')
    expect(r.rows[0]!.daysToExpiry).toBe(14)
    expect(r.rows[0]!.value).toBe(10 * 100_00)
    expect(r.atRisk).toBe(10 * 100_00)
  })

  it('keeps expired stock in the report — it is still on the shelf', () => {
    const db = seededDb()
    stocked(db, 'Gone', '2026-01-15', 5_000, 200_00)
    const r = nearExpiry(db, '2026-02-01')
    expect(r.rows[0]!.bucket).toBe('expired')
    expect(r.expired).toBe(5 * 200_00)
    expect(r.atRisk).toBe(r.expired)
  })

  it('counts batches with no expiry date rather than reporting a clean bill of health', () => {
    const db = seededDb()
    stocked(db, 'Undated', null, 7_000, 50_00)
    const r = nearExpiry(db, '2026-02-01')
    expect(r.rows).toHaveLength(0)
    expect(r.undatedBatches).toBe(1)
    expect(r.undatedQtyMilli).toBe(7_000)
    expect(r.atRisk).toBe(0)
  })

  it('sorts the soonest to die first', () => {
    const db = seededDb()
    stocked(db, 'Later', '2026-06-01', 1_000, 10_00)
    stocked(db, 'Sooner', '2026-02-10', 1_000, 10_00)
    expect(nearExpiry(db, '2026-02-01').rows.map((r) => r.itemName)).toEqual(['Sooner', 'Later'])
  })

  it('always reports every bucket, so the table keeps its shape', () => {
    const db = seededDb()
    stocked(db, 'One', '2026-02-10', 1_000, 10_00)
    const r = nearExpiry(db, '2026-02-01')
    expect(r.summary.map((s) => s.bucket)).toEqual(['expired', 'within30', 'within90', 'later', 'none'])
    expect(r.summary.reduce((s, b) => s + b.value, 0)).toBe(r.rows.reduce((s, x) => s + x.value, 0))
  })

  it('drops a batch that sold out — it cannot expire', () => {
    const db = seededDb()
    const { item: i, batch } = stocked(db, 'SoldOut', '2026-02-10', 1_000, 10_00)
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
    const salesGroup = (db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }).id
    const sales = (db.prepare('INSERT INTO ledgers (name, group_id, opening_balance) VALUES (?, ?, 0) RETURNING id')
      .get('Sales Account', salesGroup) as { id: number }).id
    saveVoucher(db, {
      voucherTypeId: vt.id, date: '2026-01-20', number: 'S-1', partyLedgerId: null,
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 20_00, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 20_00, costAllocations: [] }
      ],
      inventory: [{ stockItemId: i.id, batchId: batch.id, qtyMilli: 1_000, ratePaise: 20_00, amount: 20_00, direction: 'out', godownId: null }],
      billRefs: [], tds: null
    } as never)
    expect(nearExpiry(db, '2026-02-01').rows).toHaveLength(0)
  })
})
