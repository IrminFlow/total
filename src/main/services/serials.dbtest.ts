import { describe, it, expect } from 'vitest'
import { saveVoucher, deleteVoucher, restoreVoucher } from './vouchers'
import { listSerials, serialCounts, serialHistory } from './serials'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem, updateStockItem } from './masters'
import type { DrCr } from '@shared/domain'

/**
 * Serial numbers end to end (roadmap E #115).
 *
 * The rules are unit-tested in `@shared/serials`; what these tests are about is that the movements
 * are written, that status is DERIVED from them (so an alteration or a bin corrects it), and that
 * a serial cannot go out twice.
 */
function books() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const sales = createLedger(db, { name: 'Sales', groupId: groupId('Sales Accounts') }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id
  const supplier = createLedger(db, { name: 'Supplier Co', groupId: groupId('Sundry Creditors') }).id

  const item = (name: string, trackSerials: boolean): number =>
    createStockItem(db, {
      name, unitId, groupId: null, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, trackSerials
    }).id

  const move = (
    kind: 'purchase' | 'sales',
    stockItemId: number,
    serials: string[],
    opts: { date?: string; qtyMilli?: number; voucherId?: number } = {}
  ): number => {
    const out = kind === 'sales'
    const qtyMilli = opts.qtyMilli ?? serials.length * 1000
    const amount = (qtyMilli / 1000) * 100_000
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = out
      ? [{ ledgerId: cash, drCr: 'dr', amount }, { ledgerId: sales, drCr: 'cr', amount }]
      : [{ ledgerId: purchases, drCr: 'dr', amount }, { ledgerId: supplier, drCr: 'cr', amount }]
    return saveVoucher(
      db,
      {
        voucherTypeId: vtId(kind),
        date: opts.date ?? '2026-05-01',
        partyLedgerId: out ? null : supplier,
        posOverride: null,
        lines: lines.map((l) => ({ ...l, costAllocations: [] })),
        inventory: [
          {
            stockItemId, godownId: null, batchId: null, qtyMilli, ratePaise: 100_000,
            discountPaise: 0, amount, direction: out ? 'out' : 'in', isAbsolute: false, serials
          }
        ],
        billRefs: [], tds: null
      },
      opts.voucherId
    ).id
  }

  return { db, item, move, vtId, unitId }
}

describe('serial numbers', () => {
  it('records a purchase and puts the serials in stock', () => {
    const b = books()
    const laptop = b.item('Laptop 14"', true)
    b.move('purchase', laptop, ['SN001', 'SN002'])

    const rows = listSerials(b.db)
    expect(rows.map((r) => r.serial)).toEqual(['SN001', 'SN002'])
    expect(rows.every((r) => r.status === 'in_stock')).toBe(true)
    expect(rows[0]!.ratePaise).toBe(0) // the movement's own rate, not the line's — see below
  })

  it('marks a serial issued when it is sold, and keeps the purchase in its history', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['SN001', 'SN002'], { date: '2026-04-01' })
    b.move('sales', laptop, ['SN001'], { date: '2026-05-01' })

    const rows = listSerials(b.db)
    expect(rows.find((r) => r.serial === 'SN001')!.status).toBe('issued')
    expect(rows.find((r) => r.serial === 'SN002')!.status).toBe('in_stock')

    const history = serialHistory(b.db, rows.find((r) => r.serial === 'SN001')!.id)
    expect(history.map((h) => h.direction)).toEqual(['in', 'out'])
    expect(history[0]!.movedOn).toBe('2026-04-01')
  })

  it('refuses to sell the same unit twice', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['SN001'])
    b.move('sales', laptop, ['SN001'])
    expect(() => b.move('sales', laptop, ['SN001'])).toThrow(/already been issued/)
  })

  it('refuses to sell a serial that was never received', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    expect(() => b.move('sales', laptop, ['SN404'])).toThrow(/never received/)
  })

  it('refuses a line whose serial count does not match its quantity', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    expect(() => b.move('purchase', laptop, ['SN001'], { qtyMilli: 2000 })).toThrow(/only 1 serial/)
  })

  it('refuses the same serial twice on one voucher', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    // Both are new, so nothing on disk contradicts either — the clash is within the entry itself.
    expect(() => b.move('purchase', laptop, ['SN001', 'sn001'], { qtyMilli: 2000 })).toThrow(/twice/)
  })

  it('refuses a serial-tracked line with no serials at all', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    expect(() => b.move('purchase', laptop, [], { qtyMilli: 1000 })).toThrow(/only 0 serial/)
  })

  it('leaves an untracked item entirely alone', () => {
    const b = books()
    const nails = b.item('Nails', false)
    expect(() => b.move('purchase', nails, [], { qtyMilli: 5000 })).not.toThrow()
    expect(listSerials(b.db)).toEqual([])
  })

  it('refuses a serial that belongs to another item', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    const printer = b.item('Printer', true)
    b.move('purchase', laptop, ['SN001'])
    expect(() => b.move('sales', printer, ['SN001'])).toThrow(/different item|never received/)
  })

  it('altering the sale to drop a serial puts it back in stock', () => {
    // The whole reason status is derived: the movement is REPLACED, not appended to.
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['SN001', 'SN002'])
    const saleId = b.move('sales', laptop, ['SN001'])
    expect(listSerials(b.db).find((r) => r.serial === 'SN001')!.status).toBe('issued')

    b.move('sales', laptop, ['SN002'], { voucherId: saleId })
    const after = listSerials(b.db)
    expect(after.find((r) => r.serial === 'SN001')!.status).toBe('in_stock')
    expect(after.find((r) => r.serial === 'SN002')!.status).toBe('issued')
  })

  it('binning the sale puts the unit back on the shelf, and restoring it takes it off again', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['SN001'])
    const saleId = b.move('sales', laptop, ['SN001'])

    deleteVoucher(b.db, saleId)
    expect(listSerials(b.db).find((r) => r.serial === 'SN001')!.status).toBe('in_stock')

    restoreVoucher(b.db, saleId)
    expect(listSerials(b.db).find((r) => r.serial === 'SN001')!.status).toBe('issued')
  })

  it('a binned purchase leaves nothing sellable', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    const purchaseId = b.move('purchase', laptop, ['SN001'])
    deleteVoucher(b.db, purchaseId)
    expect(listSerials(b.db)).toEqual([])
    expect(() => b.move('sales', laptop, ['SN001'])).toThrow(/never received/)
  })

  it('takes a serial back in on a sales return', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['SN001'])
    b.move('sales', laptop, ['SN001'])
    // A credit note is an inward movement; the serial is issued, so receiving it is legal.
    expect(() => b.move('purchase', laptop, ['SN001'], { date: '2026-06-01' })).not.toThrow()
    expect(listSerials(b.db).find((r) => r.serial === 'SN001')!.status).toBe('in_stock')
  })

  it('normalises case, so the purchase spelling and the sale spelling are one unit', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['ab12cd'])
    expect(() => b.move('sales', laptop, ['AB12CD'])).not.toThrow()
    expect(listSerials(b.db)).toHaveLength(1)
  })

  it('filters the register by item, status and a partial number', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    const printer = b.item('Printer', true)
    b.move('purchase', laptop, ['LAP001', 'LAP002'])
    b.move('purchase', printer, ['PRN001'])
    b.move('sales', laptop, ['LAP001'])

    expect(listSerials(b.db, { stockItemId: printer })).toHaveLength(1)
    expect(listSerials(b.db, { status: 'issued' }).map((r) => r.serial)).toEqual(['LAP001'])
    expect(listSerials(b.db, { search: 'lap' }).map((r) => r.serial)).toEqual(['LAP001', 'LAP002'])
  })

  it('counts what is on the shelf per item', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['SN001', 'SN002', 'SN003'])
    b.move('sales', laptop, ['SN001'])
    const counts = serialCounts(b.db)
    expect(counts).toEqual([{ stockItemId: laptop, itemName: 'Laptop', inStock: 2, issued: 1 }])
  })

  it('turning tracking off later does not strand the serials already recorded', () => {
    const b = books()
    const laptop = b.item('Laptop', true)
    b.move('purchase', laptop, ['SN001'])
    const before = b.db.prepare('SELECT * FROM stock_items WHERE id = ?').get(laptop) as { unit_id: number }
    // An update that does not mention trackSerials must leave it alone (schemas.ts says so).
    updateStockItem(b.db, laptop, {
      name: 'Laptop', unitId: before.unit_id, groupId: null, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
    })
    const row = b.db.prepare('SELECT track_serials AS t FROM stock_items WHERE id = ?').get(laptop) as { t: number }
    expect(row.t).toBe(1)
    expect(listSerials(b.db)).toHaveLength(1)
  })
})
