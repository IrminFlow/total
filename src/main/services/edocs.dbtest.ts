import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CompanyInfo, DrCr } from '@shared/domain'
import { seededDb, TEST_INFO } from '../db/testdb'
import { ensureCompanyTree } from '../paths'
import { createLedger } from './masters'
import { saveVoucher } from './vouchers'
import {
  exportEInvoices, exportEwb, extractEdocInvoices, getTransport, setTransport
} from './edocs'
import { deleteVoucher } from './vouchers'

const INFO: CompanyInfo = {
  ...TEST_INFO,
  gstin: '27AAPFU0939F1ZV',
  address: '12 MG Road, Pune 411001'
}

const SLUG = 'edocs-test'

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-edocs-test-'))
  ensureCompanyTree(SLUG)
})

function setup() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const vtId = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

  const buyer = createLedger(db, {
    name: 'Buyer', groupId: groupId('Sundry Debtors'), gstin: '27AAPFU0939F1ZV',
    stateCode: '27', address: 'Shop 4, Mumbai 400001'
  }).id
  const sales = createLedger(db, { name: 'Sales 18', groupId: groupId('Sales Accounts'), gstRate: 18, hsn: '9983' }).id
  const cgstL = createLedger(db, { name: 'CGST', groupId: groupId('Duties & Taxes'), taxType: 'cgst' }).id
  const sgstL = createLedger(db, { name: 'SGST', groupId: groupId('Duties & Taxes'), taxType: 'sgst' }).id

  const unitId = (db.prepare("SELECT id FROM units WHERE symbol = 'Pcs'").get() as { id: number }).id
  const itemId = Number(
    db.prepare("INSERT INTO stock_items (name, unit_id, hsn, gst_rate) VALUES ('Laptop', ?, '8471', 18)")
      .run(unitId).lastInsertRowid
  )

  const post = (
    kind: string, date: string, partyId: number | null,
    lines: { ledgerId: number; drCr: DrCr; amount: number }[],
    inventory: { stockItemId: number; qtyMilli: number; ratePaise: number; amount: number; direction: 'in' | 'out' }[] = [],
    reference: string | null = null
  ) =>
    saveVoucher(db, {
      voucherTypeId: vtId(kind), date, partyLedgerId: partyId, reference,
      lines: lines.map((l) => ({ ...l, costAllocations: [] })),
      inventory: inventory.map((l) => ({ ...l, godownId: null })),
      billRefs: [], tds: null
    })

  return { db, buyer, sales, cgstL, sgstL, itemId, post }
}

describe('edocs service — transport, per-bill EWB, service invoices, preceding docs', () => {
  it('voucher_transport round-trips and feeds the EWB (ship-to => transactionType 2)', () => {
    const s = setup()
    const v = s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 11800000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 10000000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 900000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 900000 }
    ], [{ stockItemId: s.itemId, qtyMilli: 2000, ratePaise: 5000000, amount: 10000000, direction: 'out' }])

    expect(getTransport(s.db, v.id)).toBeNull()
    setTransport(s.db, v.id, {
      transMode: '1', transDistanceKm: 150, transporterId: null, transporterName: 'VRL',
      transDocNo: 'LR-9', transDocDate: '2026-07-05', vehicleNo: 'MH01AB1234', vehicleType: 'R',
      shipToName: 'Buyer Depot', shipToGstin: null, shipToAddr1: 'Plot 9', shipToAddr2: null,
      shipToPlace: 'Nashik', shipToPincode: '422001', shipToState: '27'
    })
    const t = getTransport(s.db, v.id)!
    expect(t.transDocNo).toBe('LR-9')
    expect(t.shipToPlace).toBe('Nashik')

    const r = exportEwb(s.db, INFO, SLUG, '2026-07-01', '2026-07-31', '072026')
    expect(r.count).toBe(1)
    expect(r.skipped).toEqual([])
    expect(existsSync(r.path)).toBe(true)
    const perBill = join(r.dir, `ewb-${v.number}-v${v.id}.json`)
    expect(existsSync(perBill)).toBe(true)
    const bill = (JSON.parse(readFileSync(perBill, 'utf8')) as any).billLists[0]
    expect(bill.transactionType).toBe(2)
    expect(bill.fromPlace).toBe('Pune')
    expect(bill.toPlace).toBe('Nashik')
    expect(bill.toPincode).toBe(422001)
    expect(bill.transDocNo).toBe('LR-9')
    expect(bill.vehicleNo).toBe('MH01AB1234')
    expect(bill.mainHsnCode).toBe('8471')
  })

  it('services-only invoices export to e-invoice (ledger-line items) but are skipped from EWB with a reason', () => {
    const s = setup()
    s.post('sales', '2026-07-06', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 295000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 250000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 22500 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 22500 }
    ])

    const [inv] = extractEdocInvoices(s.db, INFO, '2026-07-01', '2026-07-31')
    expect(inv!.items).toHaveLength(1)
    expect(inv!.items[0]).toMatchObject({ isService: true, hsn: '9983', taxablePaise: 250000, cgst: 22500 })

    const e = exportEInvoices(s.db, INFO, SLUG, '2026-07-01', '2026-07-31', '072026')
    expect(e.count).toBe(1)
    const [doc] = JSON.parse(readFileSync(e.path, 'utf8')) as any[]
    expect(doc.ItemList).toHaveLength(1)
    expect(doc.ItemList[0]).toMatchObject({ IsServc: 'Y', HsnCd: '9983', Qty: 1, Unit: 'OTH' })

    const r = exportEwb(s.db, INFO, SLUG, '2026-07-01', '2026-07-31', '072026')
    expect(r.count).toBe(0)
    expect(r.skipped[0]!.reason).toMatch(/Services only/)
  })

  it('credit notes resolve their preceding invoice from voucher.reference (null-safe)', () => {
    const s = setup()
    const orig = s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ])
    const crn = s.post('credit_note', '2026-07-10', s.buyer, [
      { ledgerId: s.buyer, drCr: 'cr', amount: 11800 },
      { ledgerId: s.sales, drCr: 'dr', amount: 10000 },
      { ledgerId: s.cgstL, drCr: 'dr', amount: 900 },
      { ledgerId: s.sgstL, drCr: 'dr', amount: 900 }
    ], [], orig.number)
    const orphan = s.post('credit_note', '2026-07-11', s.buyer, [
      { ledgerId: s.buyer, drCr: 'cr', amount: 5900 },
      { ledgerId: s.sales, drCr: 'dr', amount: 5000 },
      { ledgerId: s.cgstL, drCr: 'dr', amount: 450 },
      { ledgerId: s.sgstL, drCr: 'dr', amount: 450 }
    ], [], 'NO-SUCH-INVOICE')

    const docs = extractEdocInvoices(s.db, INFO, '2026-07-01', '2026-07-31')
    const crnDoc = docs.find((d) => d.voucherId === crn.id)!
    expect(crnDoc.docType).toBe('CRN')
    expect(crnDoc.precedingDoc).toEqual({ invNo: orig.number, invDate: '2026-07-05' })
    const orphanDoc = docs.find((d) => d.voucherId === orphan.id)!
    expect(orphanDoc.precedingDoc).toBeNull()
  })

  it('exportEInvoices excludes purchase-side debit notes (no spurious IRN for purchase returns)', () => {
    const s = setup()
    const groupId = (name: string): number =>
      (s.db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const vendor = createLedger(s.db, {
      name: 'Vendor', groupId: groupId('Sundry Creditors'), gstin: '27AABCS1429B1ZU', stateCode: '27'
    }).id
    const purchases = createLedger(s.db, { name: 'Purchases 18', groupId: groupId('Purchase Accounts'), gstRate: 18 }).id

    // Regular sale — must export.
    s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ])
    // Outward debit note (credits income) — must export as DBN.
    const outDbn = s.post('debit_note', '2026-07-06', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 11800 },
      { ledgerId: s.sales, drCr: 'cr', amount: 10000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 900 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 900 }
    ])
    // Purchase-return debit note to a GSTIN-bearing supplier — must NOT export.
    const purDbn = s.post('debit_note', '2026-07-07', vendor, [
      { ledgerId: vendor, drCr: 'dr', amount: 5900 },
      { ledgerId: purchases, drCr: 'cr', amount: 5000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 450 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 450 }
    ])

    const e = exportEInvoices(s.db, INFO, SLUG, '2026-07-01', '2026-07-31', '072026')
    expect(e.count).toBe(2)
    const docs = JSON.parse(readFileSync(e.path, 'utf8')) as any[]
    const numbers = docs.map((d) => d.DocDtls.No)
    expect(numbers).toContain(outDbn.number)
    expect(numbers).not.toContain(purDbn.number)
    expect(docs.filter((d) => d.DocDtls.Typ === 'DBN')).toHaveLength(1)
  })

  it('same-state SEZ buyers get IGST (sec 7(5)(b) IGST Act), never CGST/SGST, in the e-doc payload', () => {
    const s = setup()
    const groupId = (name: string): number =>
      (s.db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const sez = createLedger(s.db, {
      name: 'SEZ Unit 27', groupId: groupId('Sundry Debtors'), gstin: '27AABCS1429B1ZU',
      stateCode: '27', exportType: 'sez_wp', address: 'SEZ Phase 1, Pune 411057'
    }).id
    const v = s.post('sales', '2026-07-08', sez, [
      { ledgerId: sez, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ], [{ stockItemId: s.itemId, qtyMilli: 1000, ratePaise: 100000, amount: 100000, direction: 'out' }])

    const inv = extractEdocInvoices(s.db, INFO, '2026-07-01', '2026-07-31').find((d) => d.voucherId === v.id)!
    expect(inv.supTyp).toBe('SEZWP')
    expect(inv.pos).toBe('27') // POS stays the SEZ unit's real state
    expect(inv.igst).toBe(18000)
    expect(inv.cgst).toBe(0)
    expect(inv.sgst).toBe(0)
  })

  it('e-invoice RegRev is Y for RCM-flagged parties', () => {
    const s = setup()
    const groupId = (name: string): number =>
      (s.db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
    const rcmBuyer = createLedger(s.db, {
      name: 'RCM Buyer', groupId: groupId('Sundry Debtors'), gstin: '29AACCR7832C1ZD', stateCode: '29', rcm: true
    }).id
    s.post('sales', '2026-07-09', rcmBuyer, [
      { ledgerId: rcmBuyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ])
    const e = exportEInvoices(s.db, INFO, SLUG, '2026-07-01', '2026-07-31', '072026')
    const [doc] = JSON.parse(readFileSync(e.path, 'utf8')) as any[]
    expect(doc.TranDtls.RegRev).toBe('Y')
  })

  it('per-bill EWB files include the voucher id so sanitised-number collisions cannot overwrite', () => {
    const s = setup()
    // Sales invoice and outward debit note both auto-number '1' in their own series — the
    // sanitised file names collide unless the voucher id disambiguates.
    const inv = s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ], [{ stockItemId: s.itemId, qtyMilli: 1000, ratePaise: 100000, amount: 100000, direction: 'out' }])
    const dbn = s.post('debit_note', '2026-07-06', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ], [{ stockItemId: s.itemId, qtyMilli: 1000, ratePaise: 100000, amount: 100000, direction: 'out' }])
    expect(inv.number).toBe(dbn.number) // the collision precondition — both series start at 1

    const r = exportEwb(s.db, INFO, SLUG, '2026-07-01', '2026-07-31', '072026', { includeBelowThreshold: true })
    expect(r.count).toBe(2)
    expect(existsSync(join(r.dir, `ewb-${inv.number}-v${inv.id}.json`))).toBe(true)
    expect(existsSync(join(r.dir, `ewb-${dbn.number}-v${dbn.id}.json`))).toBe(true)
  })

  it('setTransport refuses a binned voucher; getTransport reads as absent once binned', () => {
    const s = setup()
    const v = s.post('sales', '2026-07-05', s.buyer, [
      { ledgerId: s.buyer, drCr: 'dr', amount: 118000 },
      { ledgerId: s.sales, drCr: 'cr', amount: 100000 },
      { ledgerId: s.cgstL, drCr: 'cr', amount: 9000 },
      { ledgerId: s.sgstL, drCr: 'cr', amount: 9000 }
    ])
    const input = {
      transMode: '1' as const, transDistanceKm: 10, transporterId: null, transporterName: null,
      transDocNo: null, transDocDate: null, vehicleNo: null, vehicleType: null,
      shipToName: null, shipToGstin: null, shipToAddr1: null, shipToAddr2: null,
      shipToPlace: null, shipToPincode: null, shipToState: null
    }
    setTransport(s.db, v.id, input)
    deleteVoucher(s.db, v.id)
    expect(getTransport(s.db, v.id)).toBeNull()
    expect(() => setTransport(s.db, v.id, input)).toThrow(/not found/i)
  })
})
