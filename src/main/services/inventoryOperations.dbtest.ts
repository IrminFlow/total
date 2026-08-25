import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createGodown, createStockItem } from './masters'
import { saveVoucher } from './vouchers'
import * as ops from './inventoryOperations'

function setup(db: DB): { itemId: number; godownId: number } {
  const unitId = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
  const itemId = createStockItem(db, { name: 'Control Widget', groupId: null, unitId, hsn: null, gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: 'CW-1', reorderLevelMilli: null, valuationMethod: 'weighted_avg' }).id
  const godownId = createGodown(db, { name: 'Main warehouse', address: null, gstRegistrationId: null }).id
  return { itemId, godownId }
}

function postStock(db: DB, itemId: number, godownId: number, qtyMilli: number): void {
  const type = db.prepare("SELECT id FROM voucher_types WHERE kind='stock_journal'").get() as { id: number }
  saveVoucher(db, { voucherTypeId: type.id, date: '2025-06-01', partyLedgerId: null, narration: 'Opening receipt', reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, lines: [], inventory: [{ stockItemId: itemId, godownId, batchId: null, qtyMilli, ratePaise: 10000, amount: qtyMilli * 10, direction: 'in' }], billRefs: [], tds: null })
}

describe('inventory operations control plane', () => {
  it('nets reservations and open supply into a lead-time reorder decision', () => {
    const db = seededDb(); const { itemId, godownId } = setup(db); postStock(db, itemId, godownId, 10000)
    ops.savePlanningPolicy(db, { stockItemId: itemId, leadTimeDays: 14, safetyStockMilli: 5000, reorderQtyMilli: 20000, preferredSupplierLedgerId: null, forecastMethod: 'velocity' }, 'owner')
    ops.createReservation(db, { stockItemId: itemId, godownId, batchId: null, qtyMilli: 8000, requiredDate: '2025-06-30', reference: 'SO-101', customerLedgerId: null }, 'owner')
    const row = ops.planningDashboard(db, '2025-06-30').find((r) => r.stockItemId === itemId)!
    expect(row.availableQtyMilli).toBe(2000)
    expect(row.suggestedOrderMilli).toBe(20000)
    expect(row.risk).toBe('reorder')
  })

  it('rejects over-reservation at a location and records resolution', () => {
    const db = seededDb(); const { itemId, godownId } = setup(db); postStock(db, itemId, godownId, 5000)
    expect(() => ops.createReservation(db, { stockItemId: itemId, godownId, batchId: null, qtyMilli: 6000, requiredDate: '2025-06-30', reference: 'SO-X', customerLedgerId: null }, 'owner')).toThrow(/exceeds available/)
    const reservation = ops.createReservation(db, { stockItemId: itemId, godownId, batchId: null, qtyMilli: 4000, requiredDate: '2025-06-30', reference: 'SO-OK', customerLedgerId: null }, 'owner')
    expect(ops.setReservationStatus(db, reservation.id, 'fulfilled').status).toBe('fulfilled')
  })

  it('posts a reviewed godown count as an absolute physical-stock voucher', () => {
    const db = seededDb(); const { itemId, godownId } = setup(db); postStock(db, itemId, godownId, 10000)
    let session = ops.createCountSession(db, { name: 'June cycle count', countDate: '2025-06-30', godownId, blindCount: true }, 'counter')
    const line = session.lines.find((row) => row.stockItemId === itemId)!
    expect(line.expectedQtyMilli).toBe(10000)
    session = ops.saveCountLine(db, { sessionId: session.id, lineId: line.id, countedQtyMilli: 8500, note: 'One damaged carton' }, 'counter')
    expect(session.status).toBe('counting')
    session = ops.setCountStatus(db, session.id, 'review', 'reviewer')
    session = ops.setCountStatus(db, session.id, 'posted', 'owner')
    expect(session.postedVoucherId).toBeTypeOf('number')
    expect(ops.planningDashboard(db, '2025-06-30').find((r) => r.stockItemId === itemId)?.closingQtyMilli).toBe(8500)
  })

  it('keeps forecast overrides and slow-stock actions as audited non-posting evidence', () => {
    const db = seededDb(); const { itemId } = setup(db)
    ops.saveDemandOverride(db, { stockItemId: itemId, month: '2025-07', qtyMilli: 30000, reason: 'Festival promotion' }, 'planner')
    const action = ops.createAction(db, { stockItemId: itemId, action: 'discount', dueDate: '2025-07-10', owner: 'Sales', note: 'Clear aged units' }, 'planner')
    expect(ops.setActionStatus(db, action.id, 'done').status).toBe('done')
    expect(ops.listDemandOverrides(db)[0]?.qtyMilli).toBe(30000)
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity IN ('demand_override','inventory_action')").get() as { n: number }).n).toBe(3)
  })
})
