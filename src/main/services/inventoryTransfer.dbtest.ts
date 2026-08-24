import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createGodown, createLedger, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import { godownAvailability, listTransfers, previewTransfer, saveTransfer } from './inventoryTransfer'
import { stockByGodown, stockSummary } from './stockAnalysis'
import type { DrCr } from '@shared/domain'

/**
 * Moving stock between godowns (roadmap #112).
 *
 * The two things a transfer has to get right are opposites of each other: per-godown stock must
 * change, and company-wide stock must not. Every test here checks both sides of that.
 */
function books(valuationMethod: 'weighted_avg' | 'fifo' = 'weighted_avg') {
  const db: DB = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id
  const supplier = createLedger(db, { name: 'Acme', groupId: groupId('Sundry Creditors') }).id

  const main = createGodown(db, { name: 'Main', address: null }).id
  const branch = createGodown(db, { name: 'Branch', address: null }).id

  const item = (name: string): number =>
    createStockItem(db, {
      name, groupId: null, unitId, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod
    }).id

  /** Buy `qtyMilli` into a godown at `ratePaise` per whole unit. */
  const buy = (date: string, stockItemId: number, godownId: number, qtyMilli: number, ratePaise: number): void => {
    const amount = Math.round((qtyMilli * ratePaise) / 1000)
    const lines: { ledgerId: number; drCr: DrCr; amount: number; costAllocations: [] }[] = [
      { ledgerId: purchases, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: supplier, drCr: 'cr', amount, costAllocations: [] }
    ]
    saveVoucher(db, {
      voucherTypeId: vtId('purchase'), date, partyLedgerId: supplier, posOverride: null, lines,
      inventory: [
        { stockItemId, godownId, batchId: null, qtyMilli, ratePaise, discountPaise: 0, amount, direction: 'in', isAbsolute: false }
      ],
      billRefs: [], tds: null
    })
  }

  return { db, main, branch, item, buy }
}

const ASON = '2026-12-31'

/** Closing quantity and value of one item across the whole company. */
function companyTotal(db: DB, stockItemId: number): { qty: number; value: number } {
  const row = stockSummary(db, ASON).find((r) => r.stockItemId === stockItemId)!
  return { qty: row.closingQtyMilli, value: row.closingValue }
}

const inGodown = (db: DB, stockItemId: number, godownId: number): number =>
  stockByGodown(db, ASON).find((r) => r.stockItemId === stockItemId && r.godownId === godownId)?.closingQtyMilli ?? 0

describe('godown transfer', () => {
  it('moves quantity out of one godown and into the other, leaving the company total alone', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 100_000, 5000)
    const before = companyTotal(b.db, bolts)

    const result = saveTransfer(b.db, {
      date: '2026-05-01',
      fromGodownId: b.main,
      toGodownId: b.branch,
      items: [{ stockItemId: bolts, qtyMilli: 40_000 }]
    })

    expect(result.lineCount).toBe(1)
    expect(inGodown(b.db, bolts, b.main)).toBe(60_000)
    expect(inGodown(b.db, bolts, b.branch)).toBe(40_000)
    expect(companyTotal(b.db, bolts)).toEqual(before)
  })

  it('conserves value to the paisa under FIFO, where the cost out is not the average', () => {
    const b = books('fifo')
    const bolts = b.item('Bolts')
    // Two layers at very different costs: an average-priced transfer would shift company value.
    b.buy('2026-04-01', bolts, b.main, 10_000, 100_00)
    b.buy('2026-04-10', bolts, b.main, 10_000, 900_00)
    const before = companyTotal(b.db, bolts)

    saveTransfer(b.db, {
      date: '2026-05-01', fromGodownId: b.main, toGodownId: b.branch,
      items: [{ stockItemId: bolts, qtyMilli: 15_000 }]
    })
    expect(companyTotal(b.db, bolts)).toEqual(before)
  })

  it('conserves value when the cost per unit does not divide evenly', () => {
    const b = books()
    const bolts = b.item('Bolts')
    // 1000 paise across 3 units: no whole-paisa rate exists, so the amount cannot come from one.
    b.buy('2026-04-01', bolts, b.main, 3000, 333)
    const before = companyTotal(b.db, bolts)
    saveTransfer(b.db, {
      date: '2026-05-01', fromGodownId: b.main, toGodownId: b.branch,
      items: [{ stockItemId: bolts, qtyMilli: 1000 }]
    })
    expect(companyTotal(b.db, bolts)).toEqual(before)
  })

  it('refuses to move more than the source godown holds, and writes nothing', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    const before = companyTotal(b.db, bolts)

    expect(() =>
      saveTransfer(b.db, {
        date: '2026-05-01', fromGodownId: b.main, toGodownId: b.branch,
        items: [{ stockItemId: bolts, qtyMilli: 10_001 }]
      })
    ).toThrow(/only 10 Box in the source godown/)
    expect(companyTotal(b.db, bolts)).toEqual(before)
    expect(inGodown(b.db, bolts, b.branch)).toBe(0)
  })

  it('refuses to move stock out of a godown that never held it', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    expect(() =>
      saveTransfer(b.db, {
        date: '2026-05-01', fromGodownId: b.branch, toGodownId: b.main,
        items: [{ stockItemId: bolts, qtyMilli: 1000 }]
      })
    ).toThrow(/only 0 Box/)
  })

  it('refuses a move to the same godown', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    expect(() =>
      saveTransfer(b.db, {
        date: '2026-05-01', fromGodownId: b.main, toGodownId: b.main,
        items: [{ stockItemId: bolts, qtyMilli: 1000 }]
      })
    ).toThrow(/different godown/i)
  })

  it('posts no ledger lines — nothing was bought or sold', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    const { voucherId } = saveTransfer(b.db, {
      date: '2026-05-01', fromGodownId: b.main, toGodownId: b.branch,
      items: [{ stockItemId: bolts, qtyMilli: 1000 }]
    })
    const { n } = b.db.prepare('SELECT COUNT(*) AS n FROM voucher_lines WHERE voucher_id = ?').get(voucherId) as { n: number }
    expect(n).toBe(0)
  })

  it('previews the same refusal the save would give, before anything is written', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    const plan = previewTransfer(b.db, {
      date: '2026-05-01', fromGodownId: b.main, toGodownId: b.branch,
      items: [{ stockItemId: bolts, qtyMilli: 99_000 }]
    })
    expect(plan.errors).toHaveLength(1)
    expect(plan.lines).toEqual([])
  })

  it('offers only what the source godown actually holds', () => {
    const b = books()
    const bolts = b.item('Bolts')
    const nuts = b.item('Nuts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    b.buy('2026-04-01', nuts, b.branch, 10_000, 5000)
    expect(godownAvailability(b.db, ASON, b.main).map((r) => r.name)).toEqual(['Bolts'])
    expect(godownAvailability(b.db, ASON, b.branch).map((r) => r.name)).toEqual(['Nuts'])
  })

  it('lists the transfer afterwards, recognised by its shape rather than a flag', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    saveTransfer(b.db, {
      date: '2026-05-01', fromGodownId: b.main, toGodownId: b.branch,
      items: [{ stockItemId: bolts, qtyMilli: 4000 }]
    })
    const rows = listTransfers(b.db, '2026-04-01', ASON)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ fromGodown: 'Main', toGodown: 'Branch', items: 1, totalValue: 20_000 })
    expect(rows[0]!.narration).toBe('Stock transfer: Main → Branch')
  })

  it('leaves a deleted transfer out of the listing and puts the stock back', () => {
    const b = books()
    const bolts = b.item('Bolts')
    b.buy('2026-04-01', bolts, b.main, 10_000, 5000)
    const { voucherId } = saveTransfer(b.db, {
      date: '2026-05-01', fromGodownId: b.main, toGodownId: b.branch,
      items: [{ stockItemId: bolts, qtyMilli: 4000 }]
    })
    b.db.prepare("UPDATE vouchers SET deleted_at = datetime('now') WHERE id = ?").run(voucherId)
    expect(listTransfers(b.db, '2026-04-01', ASON)).toEqual([])
    expect(inGodown(b.db, bolts, b.main)).toBe(10_000)
  })
})
