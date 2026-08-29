import { describe, it, expect } from 'vitest'
import { saveVoucher } from './vouchers'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem, updateStockItem } from './masters'
import { getFeatures, setFeatures } from './config'
import type { DrCr } from '@shared/domain'

/**
 * Negative stock, per item.
 *
 * The company-wide flag is all-or-nothing, and a business that books a sale before the purchase
 * invoice arrives has to leave it off — which leaves it off for the items where going negative
 * really is always a mistake. These tests pin the three states: follow the company, always block,
 * always permit.
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

  const item = (name: string, blockNegative: boolean | null): number =>
    createStockItem(db, {
      name, unitId, groupId: null, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, blockNegative
    }).id

  /** Sell one unit of something with no stock — the entry the guard exists to catch. */
  const sellShort = (stockItemId: number): void => {
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
      { ledgerId: cash, drCr: 'dr', amount: 10000 },
      { ledgerId: sales, drCr: 'cr', amount: 10000 }
    ]
    saveVoucher(db, {
      voucherTypeId: vtId('sales'), date: '2026-05-01', partyLedgerId: null, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [{
        stockItemId, godownId: null, batchId: null, qtyMilli: 1000, ratePaise: 10000,
        discountPaise: 0, amount: 10000, direction: 'out', isAbsolute: false
      }],
      billRefs: [], tds: null
    })
  }

  return { db, item, sellShort }
}

describe('per-item negative-stock block', () => {
  it('follows the company setting when the item has no opinion', () => {
    const b = books()
    const id = b.item('Ordinary', null)

    // Company flag off: it warns and saves.
    expect(() => b.sellShort(id)).not.toThrow()

    setFeatures(b.db, { ...getFeatures(b.db), preventNegativeStock: true })
    expect(() => b.sellShort(id)).toThrow(/Insufficient stock/)
  })

  it('blocks an item that says so, even with the company flag off', () => {
    // The case the company-wide flag cannot express: block these, allow the rest.
    const b = books()
    const strict = b.item('Serial Numbered', true)
    const relaxed = b.item('Ordinary', null)

    expect(() => b.sellShort(strict)).toThrow(/Insufficient stock/)
    expect(() => b.sellShort(relaxed)).not.toThrow()
  })

  it('permits an item that says so, even with the company flag on', () => {
    // The opposite exemption: one item that legitimately goes negative in a strict book.
    const b = books()
    setFeatures(b.db, { ...getFeatures(b.db), preventNegativeStock: true })
    const exempt = b.item('Booked Before Invoice', false)
    const ordinary = b.item('Ordinary', null)

    expect(() => b.sellShort(exempt)).not.toThrow()
    expect(() => b.sellShort(ordinary)).toThrow(/Insufficient stock/)
  })

  it('names only the items that are actually blocked', () => {
    // A message listing an item the user is allowed to oversell would send them looking for a
    // problem that is not there.
    const b = books()
    const strict = b.item('Strict', true)
    b.item('Relaxed', false)

    let message = ''
    try {
      b.sellShort(strict)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/Strict/)
    expect(message).not.toMatch(/Relaxed/)
  })

  it('round-trips the three states through the master', () => {
    const b = books()
    const id = b.item('Tri-state', null)
    const read = (): boolean | null =>
      (b.db.prepare('SELECT block_negative AS v FROM stock_items WHERE id = ?').get(id) as { v: number | null }).v ===
      null
        ? null
        : (b.db.prepare('SELECT block_negative AS v FROM stock_items WHERE id = ?').get(id) as { v: number }).v === 1

    expect(read()).toBeNull()
    const base = {
      name: 'Tri-state', unitId: (b.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id,
      groupId: null, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
    }
    updateStockItem(b.db, id, { ...base, blockNegative: true })
    expect(read()).toBe(true)
    updateStockItem(b.db, id, { ...base, blockNegative: false })
    expect(read()).toBe(false)
    updateStockItem(b.db, id, { ...base, blockNegative: null })
    expect(read()).toBeNull()
  })
})
