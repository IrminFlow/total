// Lane Q, task Q2 #97: per-line trade discount (migration 017's inventory_lines.discount_paise).
// The load-bearing invariant: `amount` IS the post-discount taxable value — GST derives from
// `amount` alone, so the discount can never change tax by construction. Asserted here end-to-end
// through saveVoucher -> extractEdocInvoices.
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger, createStockItem } from './masters'
import { saveVoucher, getVoucher } from './vouchers'
import { extractEdocInvoices } from './edocs'
import type { CompanyInfo } from '@shared/domain'
import { TEST_INFO } from '../db/testdb'

type DB = ReturnType<typeof seededDb>

const INFO: CompanyInfo = { ...TEST_INFO }

function debtor(db: DB): number {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }
  return createLedger(db, {
    name: 'Discount Buyer', groupId: group.id, openingBalance: 0, gstin: null, stateCode: '27', address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function salesLedger(db: DB): number {
  const existing = db.prepare("SELECT id FROM ledgers WHERE name = 'Sales Account'").get() as { id: number } | undefined
  if (existing) return existing.id
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }
  return createLedger(db, {
    name: 'Sales Account', groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}

function widget(db: DB): number {
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }
  return createStockItem(db, {
    name: 'Widget', groupId: null, unitId: unit.id, hsn: '8471', gstRate: 18, cessRate: null,
    openingQtyMilli: 0, openingValue: 0, barcode: null
  }).id
}

describe('inventory line discount (Q2 #97)', () => {
  it('persists discount_paise, keeps amount as the post-discount value, and round-trips via getVoucher', () => {
    const db = seededDb()
    const partyId = debtor(db)
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    // gross = qty x rate = 2 x 50000 = 100000; discount 10000 -> amount 90000.
    const saved = saveVoucher(db, {
      voucherTypeId: vt.id, date: '2025-05-01', number: 'SV-D1', partyLedgerId: partyId,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: partyId, drCr: 'dr', amount: 90000, costAllocations: [] },
        { ledgerId: salesLedger(db), drCr: 'cr', amount: 90000, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: widget(db), godownId: null, qtyMilli: 2000, ratePaise: 50000, discountPaise: 10000, amount: 90000, direction: 'out' }
      ],
      billRefs: [], tds: null
    })

    const row = db
      .prepare('SELECT discount_paise AS discount, amount FROM inventory_lines WHERE voucher_id = ?')
      .get(saved.id) as { discount: number; amount: number }
    expect(row).toEqual({ discount: 10000, amount: 90000 })

    const fetched = getVoucher(db, saved.id)!
    expect(fetched.inventory[0]).toMatchObject({ discountPaise: 10000, amount: 90000, ratePaise: 50000, qtyMilli: 2000 })
  })

  it('omitted discountPaise defaults to 0 (existing callers unaffected)', () => {
    const db = seededDb()
    const partyId = debtor(db)
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    const saved = saveVoucher(db, {
      voucherTypeId: vt.id, date: '2025-05-01', number: 'SV-D2', partyLedgerId: partyId,
      narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
      vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: partyId, drCr: 'dr', amount: 50000, costAllocations: [] },
        { ledgerId: salesLedger(db), drCr: 'cr', amount: 50000, costAllocations: [] }
      ],
      inventory: [
        { stockItemId: widget(db), godownId: null, qtyMilli: 1000, ratePaise: 50000, amount: 50000, direction: 'out' }
      ],
      billRefs: [], tds: null
    })
    expect(getVoucher(db, saved.id)!.inventory[0]!.discountPaise).toBe(0)
  })

  it('GST taxable stays inventory_lines.amount — the discount never reaches the tax path', () => {
    const db = seededDb()
    const partyId = debtor(db)
    const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }
    const itemId = widget(db)

    const save = (number: string, discountPaise: number | undefined): number =>
      saveVoucher(db, {
        voucherTypeId: vt.id, date: '2025-05-01', number, partyLedgerId: partyId,
        narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
        vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
        lines: [
          { ledgerId: partyId, drCr: 'dr', amount: 90000, costAllocations: [] },
          { ledgerId: salesLedger(db), drCr: 'cr', amount: 90000, costAllocations: [] }
        ],
        inventory: [
          { stockItemId: itemId, godownId: null, qtyMilli: 2000, ratePaise: 50000, discountPaise, amount: 90000, direction: 'out' }
        ],
        billRefs: [], tds: null
      }).id

    const withDiscountId = save('SV-D3', 10000)
    const withoutDiscountId = save('SV-D4', undefined)

    const [withDiscount] = extractEdocInvoices(db, INFO, '0000-01-01', '9999-12-31', withDiscountId)
    const [withoutDiscount] = extractEdocInvoices(db, INFO, '0000-01-01', '9999-12-31', withoutDiscountId)

    // Identical amounts -> identical taxable and identical tax, discount or not.
    expect(withDiscount!.items[0]!.taxablePaise).toBe(90000)
    expect(withoutDiscount!.items[0]!.taxablePaise).toBe(90000)
    expect(withDiscount!.taxable).toBe(withoutDiscount!.taxable)
    expect(withDiscount!.cgst).toBe(withoutDiscount!.cgst)
    expect(withDiscount!.sgst).toBe(withoutDiscount!.sgst)
    expect(withDiscount!.igst).toBe(withoutDiscount!.igst)
  })
})
