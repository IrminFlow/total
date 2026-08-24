import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import { dailyPosition, forecast, liquidityAlerts, saveScenario, setAlertSettings } from './treasury'

const defaults = { gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: 0, exportType: null }

function group(db: ReturnType<typeof seededDb>, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function bill(db: ReturnType<typeof seededDb>, side: 'receivable' | 'payable', amount: number, dueDate: string): void {
  const party = createLedger(db, { ...defaults, name: side === 'receivable' ? 'Forecast Customer' : 'Forecast Supplier', groupId: group(db, side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'), openingBalance: 0 }).id
  const account = createLedger(db, { ...defaults, name: side === 'receivable' ? 'Forecast Sales' : 'Forecast Purchases', groupId: group(db, side === 'receivable' ? 'Sales Accounts' : 'Purchase Accounts'), openingBalance: 0 }).id
  const voucherTypeId = (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(side === 'receivable' ? 'sales' : 'purchase') as { id: number }).id
  saveVoucher(db, {
    voucherTypeId, date: '2026-08-24', partyLedgerId: party, narration: 'Forecast bill', reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: side === 'receivable'
      ? [{ ledgerId: party, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: account, drCr: 'cr', amount, costAllocations: [] }]
      : [{ ledgerId: account, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: party, drCr: 'cr', amount, costAllocations: [] }],
    inventory: [], billRefs: [{ kind: 'new', name: `${side}-1`, amount, dueDate }], tds: null
  })
}

describe('treasury position and scenarios', () => {
  it('uses one deterministic model for daily position, 13-week forecast, scenarios and alerts', () => {
    const db = seededDb()
    db.prepare("UPDATE ledgers SET opening_balance = 100000 WHERE name = 'Cash'").run()
    bill(db, 'receivable', 50_000, '2026-08-27')
    bill(db, 'payable', 20_000, '2026-08-29')

    const position = dailyPosition(db, '2026-08-24')
    expect(position).toMatchObject({ availableNow: 100000, expectedReceipts: 50000, expectedPayments: 20000, projectedAvailable: 130000 })
    const base = forecast(db, '2026-08-24')
    expect(base.weeks).toHaveLength(13)
    expect(base.weeks[0]).toMatchObject({ inflows: 50000, outflows: 20000, closing: 130000 })

    const stress = saveScenario(db, {
      name: 'Collections delayed', collectionDelayDays: 14, collectionRealizationBp: 5000,
      paymentDelayDays: 0,
      events: [{ date: '2026-08-31', label: 'Tax payment', direction: 'outflow', amount: 150000, kind: 'tax' }]
    }, 'Asha')
    const stressed = forecast(db, '2026-08-24', stress.id)
    expect(stressed.weeks[0]).toMatchObject({ inflows: 0, outflows: 20000, closing: 80000 })
    expect(stressed.weeks[1]!.closing).toBe(-70000)

    setAlertSettings(db, { minimumLiquidity: 0, idleCashThreshold: 120000, sustainedWeeks: 2 })
    expect(liquidityAlerts(db, '2026-08-24').some((alert) => alert.kind === 'idle_cash')).toBe(true)
    expect(liquidityAlerts(db, '2026-08-24', stress.id).some((alert) => alert.kind === 'shortfall')).toBe(true)
  })

  it('keeps monthly commitments on their calendar day across a short February', () => {
    const db = seededDb()
    const paymentTypeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }).id
    db.prepare(
      `INSERT INTO recurring_templates
       (name, voucher_json, cadence, day_of_month, next_due, voucher_type_id, active)
       VALUES (?, ?, 'monthly', 31, '2027-01-31', ?, 1)`
    ).run('Month-end rent', JSON.stringify({ lines: [{ drCr: 'dr', amount: 10000 }, { drCr: 'cr', amount: 10000 }] }), paymentTypeId)
    const result = forecast(db, '2027-01-31')
    const dates = result.weeks.flatMap((week) => week.events).filter((event) => event.source === 'recurring').map((event) => event.date)
    expect(dates).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'])
  })
})
