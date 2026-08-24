import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger, createStockItem, updateLedger } from './masters'
import { saveVoucher } from './vouchers'
import { reorderAlerts } from './inventoryReorder'
import type { DrCr } from '@shared/domain'

/**
 * Item-wise reorder alerts (roadmap #121).
 *
 * The report already knew what was low; what is tested here is the part that reaches a person —
 * one message per supplier, the supplier being whoever the item was last bought from, and an
 * honest answer when there is nobody to ask.
 */
function books() {
  const db: DB = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id

  const supplier = (name: string, phone: string | null, email: string | null): number => {
    const led = createLedger(db, { name, groupId: groupId('Sundry Creditors') })
    updateLedger(db, led.id, { name, groupId: groupId('Sundry Creditors'), phone, email })
    return led.id
  }

  const item = (name: string, reorderLevelMilli: number | null, openingQtyMilli = 0): number =>
    createStockItem(db, {
      name, groupId: null, unitId, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli, openingValue: 0, barcode: null, reorderLevelMilli, valuationMethod: 'weighted_avg'
    }).id

  const buy = (party: number | null, date: string, stockItemId: number, qtyMilli: number, ratePaise: number): void => {
    const amount = Math.round((qtyMilli * ratePaise) / 1000)
    const lines: { ledgerId: number; drCr: DrCr; amount: number; costAllocations: [] }[] = [
      { ledgerId: purchases, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: party ?? purchases, drCr: 'cr', amount, costAllocations: [] }
    ]
    saveVoucher(db, {
      voucherTypeId: vtId('purchase'), date, partyLedgerId: party, posOverride: null, lines,
      inventory: [
        { stockItemId, godownId: null, batchId: null, qtyMilli, ratePaise, discountPaise: 0, amount, direction: 'in', isAbsolute: false }
      ],
      billRefs: [], tds: null
    })
  }

  return { db, item, supplier, buy }
}

const ASON = '2026-12-31'

describe('reorderAlerts', () => {
  it('says nothing when nothing is below its reorder level', () => {
    const b = books()
    b.item('Comfortable', 5_000, 20_000)
    expect(reorderAlerts(b.db, 'Demo Traders', ASON)).toEqual({ asOn: ASON, messages: [], unsourced: [] })
  })

  it('writes one message per supplier, with a wa.me link and an email draft', () => {
    const b = books()
    const acme = b.supplier('Acme Hardware', '9876543210', 'sales@acme.example')
    const bolts = b.item('Bolts', 10_000)
    const nuts = b.item('Nuts', 10_000)
    b.buy(acme, '2026-04-01', bolts, 2_000, 12_500)
    b.buy(acme, '2026-04-01', nuts, 1_000, 10_000)

    const { messages, unsourced } = reorderAlerts(b.db, 'Demo Traders', ASON)
    expect(unsourced).toEqual([])
    expect(messages).toHaveLength(1)
    const m = messages[0]!
    expect(m.supplierName).toBe('Acme Hardware')
    expect(m.items.map((i) => i.name).sort()).toEqual(['Bolts', 'Nuts'])
    expect(m.whatsapp).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    expect(m.mailto).toContain('mailto:sales@acme.example')
    expect(m.body).toContain('Bolts')
    expect(m.body).toContain('Demo Traders')
  })

  it('splits two suppliers into two messages, biggest first', () => {
    const b = books()
    const acme = b.supplier('Acme Hardware', '9876543210', null)
    const beta = b.supplier('Beta Supplies', null, 'hi@beta.example')
    const bolts = b.item('Bolts', 10_000)
    const steel = b.item('Steel', 10_000)
    b.buy(acme, '2026-04-01', bolts, 1_000, 100)
    b.buy(beta, '2026-04-01', steel, 1_000, 500_00)

    const { messages } = reorderAlerts(b.db, 'Demo Traders', ASON)
    expect(messages.map((m) => m.supplierName)).toEqual(['Beta Supplies', 'Acme Hardware'])
    expect(messages[1]!.whatsapp).toMatch(/wa\.me/)
    expect(messages[0]!.whatsapp).toBeNull()
  })

  it('follows the LAST purchase when the supplier changed', () => {
    const b = books()
    const old = b.supplier('Old Supplier', '9876543210', null)
    const current = b.supplier('Current Supplier', '9812345678', null)
    const bolts = b.item('Bolts', 10_000)
    b.buy(old, '2026-04-01', bolts, 1_000, 100)
    b.buy(current, '2026-06-01', bolts, 1_000, 200)

    const { messages } = reorderAlerts(b.db, 'Demo Traders', ASON)
    expect(messages.map((m) => m.supplierName)).toEqual(['Current Supplier'])
  })

  it('lists an item nobody has ever bought as unsourced rather than dropping it', () => {
    const b = books()
    const acme = b.supplier('Acme Hardware', '9876543210', null)
    const bolts = b.item('Bolts', 10_000)
    const mystery = b.item('Mystery widget', 10_000)
    b.buy(acme, '2026-04-01', bolts, 1_000, 100)

    const { messages, unsourced } = reorderAlerts(b.db, 'Demo Traders', ASON)
    expect(messages).toHaveLength(1)
    expect(unsourced.map((r) => r.name)).toEqual(['Mystery widget'])
    expect(unsourced[0]!.stockItemId).toBe(mystery)
    expect(unsourced[0]!.estimatedCost).toBeNull()
  })

  it('treats a cash purchase with no party as unsourced', () => {
    const b = books()
    const bolts = b.item('Bolts', 10_000)
    b.buy(null, '2026-04-01', bolts, 1_000, 100)
    const { messages, unsourced } = reorderAlerts(b.db, 'Demo Traders', ASON)
    expect(messages).toEqual([])
    expect(unsourced.map((r) => r.name)).toEqual(['Bolts'])
  })

  it('states the shortfall, not the whole reorder level', () => {
    const b = books()
    const acme = b.supplier('Acme Hardware', '9876543210', null)
    const bolts = b.item('Bolts', 10_000)
    b.buy(acme, '2026-04-01', bolts, 4_000, 10_000)
    const { messages } = reorderAlerts(b.db, 'Demo Traders', ASON)
    // 10 needed, 4 on hand: order 6, not 10.
    expect(messages[0]!.items[0]!.shortfallQtyMilli).toBe(6_000)
    expect(messages[0]!.estimatedTotal).toBe(60_000)
    expect(messages[0]!.body).toContain('6 Box')
  })
})
