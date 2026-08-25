import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem, createGodown } from './masters'
import { saveVoucher, setLockDate } from './vouchers'
import { listVersions, listAsOn, previewRevision, applyRevision, deleteVersion } from './priceListVersions'
import { savePriceLevel, rateFor } from './priceLevels'
import { saveStandardCost, listStandardCosts, varianceReport, deleteStandardCost } from './standardCosts'
import { sendForJobWork, receiveFromJobWork, listChallans, getChallan, deleteChallan, itc04Rows } from './jobWork'
import { planLabelJob, renderLabelJob } from './labels'
import { scratchpad, scratchpadLedgerId, reclassify } from './scratchpad'
import type { DrCr } from '@shared/domain'

/**
 * The inventory lane's last five (#111, #115 lives in serials.dbtest.ts, #118, #127, #128) and the
 * scratchpad (#46), against a real database.
 *
 * The pure rules are unit-tested in `src/shared`; what is asserted here is the wiring — that the
 * right rows are written, that a movement is a movement and not a posting, and that the dated
 * lookups answer about a date rather than about now.
 */
function books() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const purchases = createLedger(db, { name: 'Purchases', groupId: groupId('Purchase Accounts') }).id
  const supplier = createLedger(db, { name: 'Supplier Co', groupId: groupId('Sundry Creditors') }).id
  const printing = createLedger(db, { name: 'Printing & Stationery', groupId: groupId('Indirect Expenses') }).id

  const item = (name: string, extra: Record<string, unknown> = {}): number =>
    createStockItem(db, {
      name, unitId, groupId: null, hsn: '7318', gstRate: 18, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, ...extra
    }).id

  /** Buy `qty` units for `amount` paise on `date`. */
  const buy = (stockItemId: number, qtyMilli: number, amount: number, date = '2026-05-01'): number => {
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
      { ledgerId: purchases, drCr: 'dr', amount },
      { ledgerId: supplier, drCr: 'cr', amount }
    ]
    return saveVoucher(db, {
      voucherTypeId: vtId('purchase'), date, partyLedgerId: supplier, posOverride: null,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [{
        stockItemId, godownId: null, batchId: null, qtyMilli,
        ratePaise: Math.round((amount * 1000) / qtyMilli), discountPaise: 0, amount,
        direction: 'in', isAbsolute: false
      }],
      billRefs: [], tds: null
    }).id
  }

  return { db, item, buy, cash, purchases, supplier, printing, groupId, vtId, unitId }
}

// ---------- #128 price list versioning ----------

describe('price list versions', () => {
  it('groups rates into versions and answers what the list said on a past date', () => {
    const b = books()
    const level = savePriceLevel(b.db, { name: 'Wholesale' }).id
    const bolt = b.item('Bolt')
    const nut = b.item('Nut')
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, bolt, 10_000, '2025-04-01')
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, nut, 5_000, '2025-04-01')
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, bolt, 12_000, '2025-10-01')

    const versions = listVersions(b.db, level, '2026-01-01')
    expect(versions.map((v) => v.effectiveFrom)).toEqual(['2025-10-01', '2025-04-01'])
    expect(versions[0]!.itemCount).toBe(1)

    // The whole point: September still says ₹100, not ₹120.
    expect(listAsOn(b.db, level, '2025-09-30').find((r) => r.stockItemId === bolt)!.rate).toBe(10_000)
    expect(listAsOn(b.db, level, '2025-10-01').find((r) => r.stockItemId === bolt)!.rate).toBe(12_000)
  })

  it('the screen and the invoice agree about what is in force', () => {
    // listAsOn resolves through the same pure rule as rateFor, which is what prices an invoice.
    const b = books()
    const level = savePriceLevel(b.db, { name: 'Retail' }).id
    const bolt = b.item('Bolt')
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, bolt, 10_000, '2025-04-01')
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, bolt, 12_000, '2025-10-01')
    for (const date of ['2025-04-01', '2025-09-30', '2025-10-01', '2026-06-01']) {
      expect(listAsOn(b.db, level, date).find((r) => r.stockItemId === bolt)?.rate).toBe(
        rateFor(b.db, level, bolt, date)
      )
    }
  })

  it('a revision moves the list by a percentage from a date, and records only what moved', () => {
    const b = books()
    const level = savePriceLevel(b.db, { name: 'Wholesale' }).id
    const bolt = b.item('Bolt')
    const nut = b.item('Nut')
    for (const [item, rate] of [[bolt, 10_000], [nut, 20_000]] as const) {
      b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
        .run(level, item, rate, '2025-04-01')
    }

    const preview = previewRevision(b.db, { priceLevelId: level, effectiveFrom: '2026-04-01', changeBp: 500 })
    expect(preview.errors).toEqual([])
    expect(preview.rows.map((r) => r.rate).sort((x, y) => x - y)).toEqual([10_500, 21_000])
    expect(preview.names[bolt]).toBe('Bolt')

    const result = applyRevision(b.db, { priceLevelId: level, effectiveFrom: '2026-04-01', changeBp: 500 })
    expect(result.rows).toBe(2)
    expect(rateFor(b.db, level, bolt, '2026-04-01')).toBe(10_500)
    // And the old version keeps saying what it said.
    expect(rateFor(b.db, level, bolt, '2026-03-31')).toBe(10_000)
  })

  it('reads its base from the day BEFORE the new version, so previewing twice does not compound', () => {
    const b = books()
    const level = savePriceLevel(b.db, { name: 'Wholesale' }).id
    const bolt = b.item('Bolt')
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, bolt, 10_000, '2025-04-01')
    applyRevision(b.db, { priceLevelId: level, effectiveFrom: '2026-04-01', changeBp: 500 })
    const again = previewRevision(b.db, { priceLevelId: level, effectiveFrom: '2026-04-01', changeBp: 500 })
    expect(again.rows[0]!.fromRate).toBe(10_000)
    expect(again.rows[0]!.rate).toBe(10_500)
  })

  it('undoes a whole version at once', () => {
    const b = books()
    const level = savePriceLevel(b.db, { name: 'Wholesale' }).id
    const bolt = b.item('Bolt')
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, bolt, 10_000, '2025-04-01')
    applyRevision(b.db, { priceLevelId: level, effectiveFrom: '2026-04-01', changeBp: 500 })
    expect(deleteVersion(b.db, level, '2026-04-01')).toBe(1)
    expect(rateFor(b.db, level, bolt, '2026-06-01')).toBe(10_000)
  })
})

// ---------- #118 standard costing ----------

describe('standard costing', () => {
  it('is dated: a revision leaves the earlier period scored against the earlier standard', () => {
    const b = books()
    const steel = b.item('Steel')
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-04-01', standardCost: 20_000 })
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-07-01', standardCost: 25_000 })

    // 10 units for ₹2,100 in June — ₹210 each against a ₹200 standard, so ₹100 adverse.
    b.buy(steel, 10_000, 210_000, '2026-06-15')
    const june = varianceReport(b.db, { from: '2026-06-01', to: '2026-06-30', basis: 'purchase' })
    expect(june.standardCostPaise).toBe(200_000)
    expect(june.totalVariancePaise).toBe(10_000)
    expect(june.lines[0]!.verdict).toBe('adverse')

    // The same purchase in August scores against ₹250 and comes out favourable.
    b.buy(steel, 10_000, 210_000, '2026-08-15')
    const august = varianceReport(b.db, { from: '2026-08-01', to: '2026-08-31', basis: 'purchase' })
    expect(august.standardCostPaise).toBe(250_000)
    expect(august.lines[0]!.verdict).toBe('favourable')
  })

  it('scores each movement against the standard on its own date, not one standard per period', () => {
    const b = books()
    const steel = b.item('Steel')
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-04-01', standardCost: 20_000 })
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-07-01', standardCost: 25_000 })
    b.buy(steel, 10_000, 200_000, '2026-06-15') // exactly on the June standard, ₹200 each
    b.buy(steel, 10_000, 250_000, '2026-08-15') // exactly on the August standard, ₹250 each

    const quarter = varianceReport(b.db, { from: '2026-06-01', to: '2026-09-30', basis: 'purchase' })
    expect(quarter.totalVariancePaise).toBe(0)
    expect(quarter.standardCostPaise).toBe(450_000)
  })

  it('lists an item with no standard rather than scoring it as on standard', () => {
    const b = books()
    const packing = b.item('Packing')
    b.buy(packing, 1_000, 50_000, '2026-06-01')
    const report = varianceReport(b.db, { from: '2026-06-01', to: '2026-06-30', basis: 'purchase' })
    expect(report.lines).toEqual([])
    expect(report.withoutStandard).toEqual([{ stockItemId: packing, name: 'Packing', actualCostPaise: 50_000 }])
    expect(report.totalVariancePaise).toBe(0)
  })

  it('leaves a post-dated purchase out — it has not happened yet', () => {
    const b = books()
    const steel = b.item('Steel')
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-04-01', standardCost: 20_000 })
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
      { ledgerId: b.purchases, drCr: 'dr', amount: 210_000 },
      { ledgerId: b.supplier, drCr: 'cr', amount: 210_000 }
    ]
    saveVoucher(b.db, {
      voucherTypeId: b.vtId('purchase'), date: '2026-06-15', partyLedgerId: b.supplier, posOverride: null,
      postDated: true,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [{
        stockItemId: steel, godownId: null, batchId: null, qtyMilli: 10_000, ratePaise: 21_000,
        discountPaise: 0, amount: 210_000, direction: 'in', isAbsolute: false
      }],
      billRefs: [], tds: null
    })
    const report = varianceReport(b.db, { from: '2026-06-01', to: '2026-06-30', basis: 'purchase' })
    expect(report.lines).toEqual([])
  })

  it('corrects the same day twice rather than stacking two standards on one date', () => {
    const b = books()
    const steel = b.item('Steel')
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-04-01', standardCost: 20_000 })
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-04-01', standardCost: 21_000 })
    const all = listStandardCosts(b.db, steel)
    expect(all).toHaveLength(1)
    expect(all[0]!.standardCost).toBe(21_000)
  })

  it('deleting a standard falls back to the one before it', () => {
    const b = books()
    const steel = b.item('Steel')
    saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-04-01', standardCost: 20_000 })
    const later = saveStandardCost(b.db, { stockItemId: steel, effectiveFrom: '2026-07-01', standardCost: 25_000 })
    b.buy(steel, 10_000, 200_000, '2026-08-15')
    expect(varianceReport(b.db, { from: '2026-08-01', to: '2026-08-31', basis: 'purchase' }).standardCostPaise).toBe(250_000)
    deleteStandardCost(b.db, later.id)
    expect(varianceReport(b.db, { from: '2026-08-01', to: '2026-08-31', basis: 'purchase' }).standardCostPaise).toBe(200_000)
  })
})

// ---------- #127 job work ----------

describe('job work', () => {
  function jobBooks() {
    const b = books()
    const worker = createLedger(b.db, { name: 'Sharma Fabrication', groupId: b.groupId('Sundry Creditors') }).id
    const bracket = b.item('Bracket')
    b.buy(bracket, 100_000, 1_000_000, '2023-01-01')
    return { ...b, worker, bracket }
  }

  it('moves stock to a godown named for the job worker without touching the books', () => {
    const b = jobBooks()
    const before = b.db.prepare('SELECT COUNT(*) AS n FROM voucher_lines').get() as { n: number }
    const challan = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 40_000 }]
    })
    expect(challan.godownName).toBe('Job work — Sharma Fabrication')
    // Not a sale: no ledger line was written at all.
    const after = b.db.prepare('SELECT COUNT(*) AS n FROM voucher_lines').get() as { n: number }
    expect(after.n).toBe(before.n)
    // But stock moved: an out from unallocated and an in at the job worker's godown.
    const inv = b.db.prepare('SELECT direction, godown_id AS godownId, qty_milli AS qty FROM inventory_lines WHERE voucher_id = ?')
      .all(challan.voucherId) as { direction: string; godownId: number | null; qty: number }[]
    expect(inv).toHaveLength(2)
    expect(inv.find((l) => l.direction === 'out')!.godownId).toBeNull()
    expect(inv.find((l) => l.direction === 'in')!.godownId).toBe(challan.godownId)
  })

  it('puts a section 143 clock on it — one year for inputs, three for capital goods', () => {
    const b = jobBooks()
    const inputs = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-IN', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    const capital = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-CAP', sentOn: '2026-02-01', goodsType: 'capital',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    expect(inputs.status.dueDate).toBe('2027-02-01')
    expect(capital.status.dueDate).toBe('2029-02-01')
  })

  it('receives goods back, brings them into stock, and closes the challan', () => {
    const b = jobBooks()
    const challan = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 40_000 }]
    })
    const after = receiveFromJobWork(b.db, {
      challanId: challan.id, receivedOn: '2026-03-01',
      lines: [{ stockItemId: b.bracket, qtyMilli: 40_000, kind: 'goods' }]
    })
    expect(after.status.state).toBe('closed')
    expect(after.status.pendingQtyMilli).toBe(0)
    const inv = b.db.prepare('SELECT direction, godown_id AS godownId FROM inventory_lines WHERE voucher_id = ?')
      .all(after.returns[0]!.voucherId) as { direction: string; godownId: number | null }[]
    expect(inv).toHaveLength(2)
    expect(inv.find((l) => l.direction === 'in')!.godownId).toBeNull()
  })

  it('waste leaves the job worker and does NOT come back into stock', () => {
    // Section 143(5): the job worker may supply the waste directly. Bringing it back would
    // inflate closing stock by the scrap of every job ever sent out.
    const b = jobBooks()
    const challan = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 40_000 }]
    })
    const after = receiveFromJobWork(b.db, {
      challanId: challan.id, receivedOn: '2026-03-01',
      lines: [
        { stockItemId: b.bracket, qtyMilli: 38_000, kind: 'goods' },
        { stockItemId: b.bracket, qtyMilli: 2_000, kind: 'waste' }
      ]
    })
    const inv = b.db.prepare("SELECT direction, COUNT(*) AS n FROM inventory_lines WHERE voucher_id = ? GROUP BY direction")
      .all(after.returns[0]!.voucherId) as { direction: string; n: number }[]
    expect(inv.find((l) => l.direction === 'out')!.n).toBe(2)
    expect(inv.find((l) => l.direction === 'in')!.n).toBe(1)
    expect(after.status.state).toBe('closed')
  })

  it('refuses to receive more than is still out', () => {
    const b = jobBooks()
    const challan = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 40_000 }]
    })
    expect(() =>
      receiveFromJobWork(b.db, {
        challanId: challan.id, receivedOn: '2026-03-01',
        lines: [{ stockItemId: b.bracket, qtyMilli: 41_000, kind: 'goods' }]
      })
    ).toThrow(/still out/)
  })

  it('refuses to send more than the godown holds', () => {
    const b = jobBooks()
    expect(() =>
      sendForJobWork(b.db, {
        partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
        lines: [{ stockItemId: b.bracket, qtyMilli: 200_000 }]
      })
    ).toThrow(/Not enough/)
  })

  it('refuses a duplicate challan number, and a locked period', () => {
    const b = jobBooks()
    sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    expect(() =>
      sendForJobWork(b.db, {
        partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-02', goodsType: 'input',
        lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
      })
    ).toThrow(/already exists/)

    setLockDate(b.db, '2026-03-31')
    expect(() =>
      sendForJobWork(b.db, {
        partyLedgerId: b.worker, challanNo: 'JW-002', sentOn: '2026-03-01', goodsType: 'input',
        lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
      })
    ).toThrow(/locked/)
  })

  it('filters to what is still out and what is overdue', () => {
    const b = jobBooks()
    sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-OLD', sentOn: '2024-01-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    const fresh = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-NEW', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    receiveFromJobWork(b.db, {
      challanId: fresh.id, receivedOn: '2026-03-01',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000, kind: 'goods' }]
    })

    const asOn = '2026-06-01'
    expect(listChallans(b.db, { state: 'all', asOn })).toHaveLength(2)
    expect(listChallans(b.db, { state: 'pending', asOn }).map((c) => c.challanNo)).toEqual(['JW-OLD'])
    expect(listChallans(b.db, { state: 'overdue', asOn }).map((c) => c.challanNo)).toEqual(['JW-OLD'])
  })

  it('cancels a challan and bins the movement, but not once goods have come back', () => {
    const b = jobBooks()
    const challan = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    deleteChallan(b.db, challan.id)
    expect(getChallan(b.db, challan.id)).toBeNull()
    const binned = b.db.prepare('SELECT deleted_at AS d FROM vouchers WHERE id = ?').get(challan.voucherId) as { d: string | null }
    expect(binned.d).not.toBeNull()

    const second = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-002', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    receiveFromJobWork(b.db, {
      challanId: second.id, receivedOn: '2026-03-01',
      lines: [{ stockItemId: b.bracket, qtyMilli: 5_000, kind: 'goods' }]
    })
    expect(() => deleteChallan(b.db, second.id)).toThrow(/already come back/)
  })

  it('produces the rows an ITC-04 needs, with the GSTIN and the clock', () => {
    const b = jobBooks()
    b.db.prepare('UPDATE ledgers SET gstin = ? WHERE id = ?').run('27AAAAA0000A1Z5', b.worker)
    sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 40_000 }]
    })
    const rows = itc04Rows(b.db, '2026-01-01', '2026-03-31')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.partyGstin).toBe('27AAAAA0000A1Z5')
    expect(rows[0]!.hsn).toBe('7318')
    expect(rows[0]!.sentQtyMilli).toBe(40_000)
    expect(rows[0]!.pendingQtyMilli).toBe(40_000)
    expect(rows[0]!.dueDate).toBe('2027-02-01')
  })

  it('a godown that already exists for the job worker is reused rather than duplicated', () => {
    const b = jobBooks()
    createGodown(b.db, { name: 'Job work — Sharma Fabrication' })
    const challan = sendForJobWork(b.db, {
      partyLedgerId: b.worker, challanNo: 'JW-001', sentOn: '2026-02-01', goodsType: 'input',
      lines: [{ stockItemId: b.bracket, qtyMilli: 10_000 }]
    })
    const count = b.db.prepare("SELECT COUNT(*) AS n FROM godowns WHERE name LIKE 'Job work%'").get() as { n: number }
    expect(count.n).toBe(1)
    expect(challan.godownName).toBe('Job work — Sharma Fabrication')
  })
})

// ---------- #111 barcode labels ----------

describe('barcode labels', () => {
  it('builds a job from the items and reports what cannot be labelled', () => {
    const b = books()
    const bolt = b.item('Bolt', { barcode: '8901234567890' })
    const nut = b.item('Nut')
    const job = planLabelJob(b.db, { items: [{ stockItemId: bolt, copies: 2 }, { stockItemId: nut, copies: 1 }] })
    expect(job.totalLabels).toBe(2)
    expect(job.errors[0]).toContain('Nut')
    expect(job.preview[0]!.some((l) => l.includes('8901234567890'))).toBe(true)
  })

  it('falls back to the item CODE when there is no barcode — never to the id', () => {
    const b = books()
    const bolt = b.item('Bolt', { code: 'BLT1' })
    const job = planLabelJob(b.db, { items: [{ stockItemId: bolt }] })
    expect(job.errors).toEqual([])
    expect(job.specs[0]!.barcode).toBe('BLT1')
  })

  it('prices from the price list on the date, not from the valuation', () => {
    const b = books()
    const bolt = b.item('Bolt', { barcode: 'B1' })
    // Bought at ₹10 — the cost. The list says ₹25, and the LIST is what a shelf label shows.
    b.buy(bolt, 1_000, 1_000, '2026-01-01')
    const level = savePriceLevel(b.db, { name: 'Retail' }).id
    b.db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, ?, ?)')
      .run(level, bolt, 2_500, '2026-01-01')
    const job = planLabelJob(b.db, { items: [{ stockItemId: bolt }], priceLevelId: level, asOn: '2026-06-01' })
    expect(job.specs[0]!.pricePaise).toBe(2_500)
  })

  it('with no price list, uses the last PURCHASE rate rather than a weighted average', () => {
    const b = books()
    const bolt = b.item('Bolt', { barcode: 'B1' })
    b.buy(bolt, 1_000, 1_000, '2026-01-01')
    b.buy(bolt, 1_000, 3_000, '2026-02-01')
    const job = planLabelJob(b.db, { items: [{ stockItemId: bolt }], asOn: '2026-06-01' })
    // The weighted average would be ₹20; the last purchase is ₹30.
    expect(job.specs[0]!.pricePaise).toBe(3_000)
  })

  it('leaves the price off when asked, and renders a job of real bytes', () => {
    const b = books()
    const bolt = b.item('Bolt', { barcode: 'B1' })
    const job = planLabelJob(b.db, { items: [{ stockItemId: bolt }], includePrice: false })
    expect(job.specs[0]!.pricePaise).toBeUndefined()
    const bytes = renderLabelJob(b.db, { items: [{ stockItemId: bolt, copies: 3 }], includePrice: false })
    const text = String.fromCharCode(...bytes)
    expect(text).toContain('PRINT 3,1')
    expect(text).toContain('BARCODE')
  })

  it('refuses the whole job rather than printing part of it', () => {
    const b = books()
    const bolt = b.item('Bolt', { barcode: 'B1' })
    const nut = b.item('Nut')
    expect(() => renderLabelJob(b.db, { items: [{ stockItemId: bolt }, { stockItemId: nut }] })).toThrow(/Nut/)
  })
})

// ---------- #46 the scratchpad ----------

describe('the scratchpad ledger', () => {
  function parked() {
    const b = books()
    const scratchId = scratchpadLedgerId(b.db)
    const lines: { ledgerId: number; drCr: DrCr; amount: number }[] = [
      { ledgerId: scratchId, drCr: 'dr', amount: 340_000 },
      { ledgerId: b.cash, drCr: 'cr', amount: 340_000 }
    ]
    const voucher = saveVoucher(b.db, {
      voucherTypeId: b.vtId('payment'), date: '2026-05-01', partyLedgerId: null, posOverride: null,
      narration: 'Paid the printer, no bill yet',
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: [], billRefs: [], tds: null
    })
    return { ...b, scratchId, voucher }
  }

  it('is created on demand, not seeded into every company', () => {
    const b = books()
    expect(scratchpad(b.db).ledgerId).toBeNull()
    const id = scratchpadLedgerId(b.db)
    expect(scratchpad(b.db).ledgerId).toBe(id)
    // And under Suspense, where an accountant already knows to look.
    const row = b.db.prepare('SELECT g.name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?').get(id) as { name: string }
    expect(row.name).toBe('Suspense A/c')
  })

  it('lists what is parked with the other side of the entry, and the balance', () => {
    const b = parked()
    const pad = scratchpad(b.db)
    expect(pad.balancePaise).toBe(340_000)
    expect(pad.entries).toHaveLength(1)
    expect(pad.entries[0]!.contraNames).toContain('Cash')
    expect(pad.entries[0]!.narration).toBe('Paid the printer, no bill yet')
  })

  it('classifying moves the LINE rather than posting a transfer journal', () => {
    const b = parked()
    const before = b.db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    const line = scratchpad(b.db).entries[0]!
    const result = reclassify(b.db, { voucherLineId: line.voucherLineId, targetLedgerId: b.printing })
    expect(result.toLedger).toBe('Printing & Stationery')
    // No second voucher: the payment now says what it always should have said.
    const after = b.db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    expect(after.n).toBe(before.n)
    expect(scratchpad(b.db).entries).toEqual([])
    expect(scratchpad(b.db).balancePaise).toBe(0)
  })

  it('leaves an audit row naming both ledgers', () => {
    const b = parked()
    const line = scratchpad(b.db).entries[0]!
    reclassify(b.db, { voucherLineId: line.voucherLineId, targetLedgerId: b.printing })
    const rows = b.db.prepare("SELECT after_json AS a FROM audit_log WHERE entity = 'voucher' AND action = 'update'").all() as { a: string }[]
    expect(rows.length).toBeGreaterThan(0)
    const before = b.db.prepare("SELECT before_json AS b FROM audit_log WHERE entity = 'voucher' AND action = 'update'").all() as { b: string }[]
    expect(before.some((r) => (r.b ?? '').includes('Printing & Stationery'))).toBe(true)
  })

  it('refuses to rewrite a voucher inside the locked period, and says what to do instead', () => {
    const b = parked()
    setLockDate(b.db, '2026-05-31')
    const line = scratchpad(b.db).entries[0]!
    expect(() => reclassify(b.db, { voucherLineId: line.voucherLineId, targetLedgerId: b.printing })).toThrow(/journal/)
  })

  it('refuses to classify a line back onto the scratchpad, or one already classified', () => {
    const b = parked()
    const line = scratchpad(b.db).entries[0]!
    expect(() => reclassify(b.db, { voucherLineId: line.voucherLineId, targetLedgerId: b.scratchId })).toThrow(/OFF the scratchpad/)
    reclassify(b.db, { voucherLineId: line.voucherLineId, targetLedgerId: b.printing })
    expect(() => reclassify(b.db, { voucherLineId: line.voucherLineId, targetLedgerId: b.printing })).toThrow(/not on the scratchpad/)
  })
})
