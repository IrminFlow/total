import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem } from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'
import { globalSearch } from './search'

function group(db: ReturnType<typeof seededDb>, name: string): number {
  return (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
}

function unit(db: ReturnType<typeof seededDb>): number {
  return (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
}

function ledger(db: ReturnType<typeof seededDb>, name: string): number {
  return createLedger(db, {
    name, groupId: group(db, 'Sundry Debtors'), openingBalance: 0, gstin: null, stateCode: null,
    address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null,
    creditDays: null, exportType: null
  }).id
}

function journal(db: ReturnType<typeof seededDb>, number: string, narration: string | null): ReturnType<typeof saveVoucher> {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const other = ledger(db, `Other for ${number}`)
  return saveVoucher(db, {
    voucherTypeId: vt.id, date: '2025-04-01', number, partyLedgerId: null, narration, reference: null,
    instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
    currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: cash, drCr: 'dr', amount: 100, costAllocations: [] },
      { ledgerId: other, drCr: 'cr', amount: 100, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  })
}

describe('globalSearch', () => {
  it('matches ledgers by name substring, sub = group name', () => {
    const db = seededDb()
    ledger(db, 'Acme Traders')
    ledger(db, 'Beta Corp')
    const hits = globalSearch(db, 'acme')
    expect(hits).toContainEqual({ kind: 'ledger', id: expect.any(Number), label: 'Acme Traders', sub: 'Sundry Debtors' })
    expect(hits.find((h) => h.label === 'Beta Corp')).toBeUndefined()
  })

  it('matches stock items, sub = "Stock item"', () => {
    const db = seededDb()
    createStockItem(db, {
      name: 'Widget Pro', groupId: null, unitId: unit(db), hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
    })
    const hits = globalSearch(db, 'widget')
    expect(hits).toContainEqual({ kind: 'item', id: expect.any(Number), label: 'Widget Pro', sub: 'Stock item' })
  })

  it('matches vouchers by number or narration, excludes soft-deleted, orders by date desc', () => {
    const db = seededDb()
    const v1 = journal(db, 'JV-100', 'Rent for April')
    journal(db, 'JV-200', null)
    const hits = globalSearch(db, 'jv-1')
    expect(hits.some((h) => h.kind === 'voucher' && h.label.includes('JV-100'))).toBe(true)

    const byNarration = globalSearch(db, 'rent')
    expect(byNarration.some((h) => h.kind === 'voucher' && h.id === v1.id)).toBe(true)

    deleteVoucher(db, v1.id)
    const afterDelete = globalSearch(db, 'jv-1')
    expect(afterDelete.some((h) => h.kind === 'voucher' && h.id === v1.id)).toBe(false)
  })

  it('escapes % and _ so they behave as literals, not wildcards', () => {
    const db = seededDb()
    ledger(db, '50% Off Ltd')
    ledger(db, '50X Off Ltd')
    const hits = globalSearch(db, '50%')
    expect(hits.map((h) => h.label)).toEqual(['50% Off Ltd'])
  })

  it('caps each category at 5 results', () => {
    const db = seededDb()
    for (let i = 0; i < 7; i++) ledger(db, `Zeta Client ${i}`)
    const hits = globalSearch(db, 'zeta')
    expect(hits.filter((h) => h.kind === 'ledger').length).toBe(5)
  })
})
