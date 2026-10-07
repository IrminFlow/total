// WP 3.3 — TCS on sales over the shared TDS tables (migration 027): seeded sections, the
// suggestion, save-time payable creation + validation, Eligible / Move to TCS / remove, challans
// (kind-isolated), the ledger summary, 27EQ / Form 143 data + CSV, Form 27D data — and that none
// of it leaks into the TDS lists.
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger, createStockItem } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { listRates, listSections, listChallans, unallocatedEntries } from './tds'
import { tcsSuggestion } from './tcs'
import { applyTcsToVoucher, export27eqCsv, form27dData, form27eqData, removeTcsFromVoucher, tcsEligible } from './tcsWorkbench'
import {
  autoAllocate, challanFromPayment, challanInterest, exemptVoucher, tdsDeducted, tdsEligible, tdsLedgerSummary, tdsPaymentCandidates
} from './tdsWorkbench'
import { ensureCompanyTree } from '../paths'
import { extractEdocInvoices } from './edocs'
import { extractOutwardDocs } from './gst'
import { buildEInvoiceJson } from '@shared/gst/edocs'
import type { VoucherInput } from '@shared/schemas'

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-tcs-test-'))
})

const sid = (db: DB, code: string): number => (db.prepare('SELECT id FROM tds_sections WHERE code = ?').get(code) as { id: number }).id
const gid = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const vtId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id

function ledger(db: DB, name: string, group: string, extra: Record<string, unknown> = {}): number {
  return createLedger(db, {
    name, groupId: gid(db, group), openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...extra
  } as Parameters<typeof createLedger>[1]).id
}

function fixture(db: DB) {
  const unit = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
  const scrap = createStockItem(db, {
    name: 'Iron Scrap', groupId: null, unitId: unit, hsn: '7204', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0,
    barcode: null, reorderLevelMilli: null, tcsSectionId: sid(db, '206C(1) SCRAP')
  }).id
  const widget = createStockItem(db, {
    name: 'Widget', groupId: null, unitId: unit, hsn: '8479', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0,
    barcode: null, reorderLevelMilli: null
  }).id
  return {
    scrap, widget,
    dealer: ledger(db, 'Scrap Buyer Pvt Ltd', 'Sundry Debtors', { pan: 'AABCS1234D' }),
    carBuyer: ledger(db, 'Car Buyer', 'Sundry Debtors', { pan: 'ABCPK1234L', tcsSectionId: sid(db, '206C(1F) VEHICLE') }),
    noPan: ledger(db, 'Cash Buyer', 'Sundry Debtors', { tcsSectionId: sid(db, '206C(1) SCRAP') }),
    sales: ledger(db, 'Sales', 'Sales Accounts'),
    cgst: ledger(db, 'CGST Output', 'Duties & Taxes', { taxType: 'cgst' }),
    sgst: ledger(db, 'SGST Output', 'Duties & Taxes', { taxType: 'sgst' }),
    bank: ledger(db, 'HDFC Bank', 'Bank Accounts')
  }
}
type Fx = ReturnType<typeof fixture>

/** Sale: Dr Buyer total (+tcs) / Cr Sales taxable / Cr CGST+SGST 9% each (/ Cr TCS via autoPayable). */
function sale(db: DB, fx: Fx, date: string, party: number, taxable: number, opts: { item?: number; tcs?: VoucherInput['tcs'] } = {}): number {
  const tax = Math.round(taxable * 0.09)
  const total = taxable + 2 * tax + (opts.tcs?.tcsAmount ?? 0)
  return saveVoucher(db, {
    voucherTypeId: vtId(db, 'sales'), date, partyLedgerId: party,
    lines: [
      { ledgerId: party, drCr: 'dr', amount: total }, { ledgerId: fx.sales, drCr: 'cr', amount: taxable },
      { ledgerId: fx.cgst, drCr: 'cr', amount: tax }, { ledgerId: fx.sgst, drCr: 'cr', amount: tax }
    ],
    inventory: opts.item ? [{ stockItemId: opts.item, godownId: null, qtyMilli: 1000, ratePaise: taxable, amount: taxable, direction: 'out' }] : [],
    billRefs: [{ kind: 'new', name: `S-${date}-${taxable}`, amount: total, dueDate: null }],
    tcs: opts.tcs ?? null
  }).id
}

const deposit = (db: DB, fx: Fx, date: string, payable: number, amount: number): number =>
  saveVoucher(db, {
    voucherTypeId: vtId(db, 'payment'), date, partyLedgerId: null,
    lines: [{ ledgerId: payable, drCr: 'dr', amount }, { ledgerId: fx.bank, drCr: 'cr', amount }]
  }).id

describe('migration 027 — TCS sections and rates', () => {
  it('seeds kind-tagged TCS sections with cited, effective-dated rows; TDS lists are untouched', () => {
    const db = seededDb()
    const tcs = listSections(db, 'tcs')
    expect(tcs.map((s) => s.code)).toEqual(expect.arrayContaining(['206C(1) SCRAP', '206C(1F) VEHICLE', '206C(1H)', '206C(1G) TOUR']))
    expect(tcs.every((s) => s.kind === 'tcs')).toBe(true)
    expect(listSections(db).some((s) => s.code.startsWith('206C'))).toBe(false)
    const scrap = listRates(db, sid(db, '206C(1) SCRAP'))
    expect(scrap.map((r) => [r.effectiveFrom, r.effectiveTo, r.rateBp, r.returnCode, r.baseIncludesGst])).toEqual([
      ['2025-04-01', '2026-03-31', 100, 'E', true],
      ['2026-04-01', null, 200, '1073', true]
    ])
    expect(scrap.every((r) => r.source?.includes('accessed 2026-10-07'))).toBe(true)
    // 1H ends the day before Finance Act 2025's proviso switched it off.
    expect(listRates(db, sid(db, '206C(1H)')).map((r) => r.effectiveTo)).toEqual(['2025-03-31'])
    expect(listRates(db, undefined, 'tcs').length).toBeGreaterThan(15)
    expect(listRates(db).some((r) => r.sectionId === sid(db, '206C(1) SCRAP'))).toBe(false)
  })
})

describe('TCS on a sale — suggestion, save-time payable, validation', () => {
  it('suggests on the goods, GST in the base, and saveVoucher creates the tagged TCS payable ledger', () => {
    const db = seededDb()
    const fx = fixture(db)
    const s = tcsSuggestion(db, {
      partyLedgerId: fx.dealer, date: '2025-06-10', voucherKind: 'sales', taxablePaise: 10000000, gstPaise: 1800000,
      salesLedgerId: fx.sales, items: [{ stockItemId: fx.scrap, amount: 10000000 }]
    })!
    expect(s).toMatchObject({ code: '206C(1) SCRAP', sectionFrom: 'goods', basePaise: 11800000, rateBp: 100, tdsPaise: 118000, gstInBase: true, payableLedgerId: null })
    expect(s.payableLedgerName).toBe('TCS Payable 206C(1) SCRAP')
    // From 1 Apr 2026: 2% (Finance Act 2026 s.85), section reference under the 2025 Act.
    const s26 = tcsSuggestion(db, { partyLedgerId: fx.dealer, date: '2026-06-10', voucherKind: 'sales', taxablePaise: 10000000, gstPaise: 1800000, items: [{ stockItemId: fx.scrap, amount: 10000000 }] })!
    expect(s26).toMatchObject({ rateBp: 200, tdsPaise: 236000, reference: '394(1) Sl. 4' })
    // Only the scrap part of a mixed invoice, with its share of the GST.
    const mixed = tcsSuggestion(db, {
      partyLedgerId: fx.dealer, date: '2025-06-10', voucherKind: 'sales', taxablePaise: 20000000, gstPaise: 3600000,
      items: [{ stockItemId: fx.scrap, amount: 10000000 }, { stockItemId: fx.widget, amount: 10000000 }]
    })!
    expect(mixed.basePaise).toBe(11800000)
    expect(tcsSuggestion(db, { partyLedgerId: fx.dealer, date: '2025-06-10', voucherKind: 'sales', taxablePaise: 100, items: [{ stockItemId: fx.widget, amount: 100 }] })).toBeNull()

    const id = sale(db, fx, '2025-06-10', fx.dealer, 10000000, {
      item: fx.scrap, tcs: { sectionId: s.sectionId, baseAmount: 11800000, tcsAmount: 118000, isManual: false, autoPayable: true }
    })
    const v = getVoucher(db, id)!
    expect(v.tcs).toMatchObject({ tcsAmount: 118000, baseAmount: 11800000, rateBp: 100, gstInBase: true, isManual: false })
    expect(v.tds).toBeNull()
    const last = v.lines[v.lines.length - 1]!
    const payable = db.prepare('SELECT name, tcs_payable_section_id AS t, tds_payable_section_id AS d FROM ledgers WHERE id = ?').get(last.ledgerId) as { name: string; t: number; d: number | null }
    expect(payable).toEqual({ name: 'TCS Payable 206C(1) SCRAP', t: s.sectionId, d: null })
    expect(last).toMatchObject({ drCr: 'cr', amount: 118000 })
    expect(v.lines[0]).toMatchObject({ ledgerId: fx.dealer, drCr: 'dr', amount: 11800000 + 118000 })

    // GST: TCS is not in the value of supply — taxable / GST / round-off unchanged, no value
    // mismatch — but the invoice total includes it, and the e-invoice reports it as OthChrg.
    const inv = extractEdocInvoices(db, TEST_INFO, '2025-06-01', '2025-06-30', id)[0]!
    expect(inv).toMatchObject({ taxable: 10000000, cgst: 900000, sgst: 900000, roundOff: 0, total: 11918000, tcs: { amountPaise: 118000, rateBp: 100, reference: '206C(1)' } })
    const json = buildEInvoiceJson([inv], { name: 'Test Co', gstin: '27AAAAA0000A1Z5', stateCode: '27', address: 'Pune 411001' })[0] as { ValDtls: Record<string, number> }
    expect(json.ValDtls).toMatchObject({ AssVal: 100000, OthChrg: 1180, TotInvVal: 119180 })
    const docs = extractOutwardDocs(db, TEST_INFO, '2025-06-01', '2025-06-30')
    expect(docs.find((d) => d.voucherId === id)).toMatchObject({ invoiceValue: 11918000, validation: { valDiff: 0 } })
  })

  it('rejects a wrong amount, a missing payable credit, a buyer debit without the TCS, and TCS on a purchase', () => {
    const db = seededDb()
    const fx = fixture(db)
    const scrap = sid(db, '206C(1) SCRAP')
    expect(() => sale(db, fx, '2025-06-10', fx.dealer, 10000000, { item: fx.scrap, tcs: { sectionId: scrap, baseAmount: 11800000, tcsAmount: 100000, isManual: false, autoPayable: true } }))
      .toThrow(/TCS u\/s 206C\(1\) SCRAP should be ₹1,180\.00/)
    // Manual skips the rate check but still needs the payable credit.
    const manual = sale(db, fx, '2025-06-11', fx.dealer, 10000000, { item: fx.scrap, tcs: { sectionId: scrap, baseAmount: 11800000, tcsAmount: 100000, isManual: true, autoPayable: true } })
    expect(getVoucher(db, manual)!.tcs).toMatchObject({ isManual: true, rateBp: null })
    // Buyer not debited with the TCS: the payable credit taken out of the sales credit instead.
    const tax = 900000
    expect(() => saveVoucher(db, {
      voucherTypeId: vtId(db, 'sales'), date: '2025-06-12', partyLedgerId: fx.dealer,
      lines: [
        { ledgerId: fx.dealer, drCr: 'dr', amount: 11800000 }, { ledgerId: fx.sales, drCr: 'cr', amount: 10000000 - 118000 },
        { ledgerId: fx.cgst, drCr: 'cr', amount: tax }, { ledgerId: fx.sgst, drCr: 'cr', amount: tax }
      ],
      tcs: { sectionId: scrap, baseAmount: 11800000, tcsAmount: 118000, isManual: false, autoPayable: true }
    })).toThrow(/buyer's debit .* must include the TCS/)
    // A TDS section can't ride as TCS.
    expect(() => sale(db, fx, '2025-06-13', fx.dealer, 10000000, { tcs: { sectionId: sid(db, '194C'), baseAmount: 11800000, tcsAmount: 118000, isManual: true, autoPayable: true } }))
      .toThrow(/Unknown TCS section/)
    expect(() => saveVoucher(db, {
      voucherTypeId: vtId(db, 'purchase'), date: '2025-06-14', partyLedgerId: fx.dealer,
      lines: [{ ledgerId: fx.sales, drCr: 'dr', amount: 100000 }, { ledgerId: fx.dealer, drCr: 'cr', amount: 100000 - 1000 }],
      tcs: { sectionId: scrap, baseAmount: 100000, tcsAmount: 1000, isManual: true, autoPayable: true }
    })).toThrow(/can't carry a TCS collection/)
  })

  it('no PAN: the higher of twice the rate and 5% (s.206CC)', () => {
    const db = seededDb()
    const fx = fixture(db)
    const s = tcsSuggestion(db, { partyLedgerId: fx.noPan, date: '2025-06-10', voucherKind: 'sales', taxablePaise: 10000000, gstPaise: 1800000 })!
    expect(s).toMatchObject({ basis: 'no_pan', rateBp: 500, tdsPaise: 590000, sectionFrom: 'party' })
  })
})

describe('Eligible → Move to TCS → remove; challans; returns', () => {
  it('lists a vehicle sale above Rs 10 lakh and scrap sales without TCS; moves, removes, and keeps TDS clean', () => {
    const db = seededDb()
    const fx = fixture(db)
    const small = sale(db, fx, '2025-07-01', fx.carBuyer, 500000000 / 100) // Rs 50,000 — below the 1F limit
    const car = sale(db, fx, '2025-07-02', fx.carBuyer, 100000000) // Rs 10 lakh + GST = 11.8 lakh > limit
    const scrapSale = sale(db, fx, '2025-07-03', fx.dealer, 5000000, { item: fx.scrap })
    const rows = tcsEligible(db, '2025-07-01', '2025-09-30')
    expect(rows.map((r) => r.voucherId)).toEqual([car, scrapSale])
    expect(rows[0]).toMatchObject({ sectionCode: '206C(1F) VEHICLE', basePaise: 118000000, tdsPaise: 1180000, reason: 'single' })
    expect(rows[1]).toMatchObject({ sectionCode: '206C(1) SCRAP', stockItemName: 'Iron Scrap', reason: 'none', tdsPaise: 59000 })
    expect(rows.some((r) => r.voucherId === small)).toBe(false)
    expect(tdsEligible(db, '2025-07-01', '2025-09-30')).toEqual([])

    const after = applyTcsToVoucher(db, { voucherId: car })!
    expect(after.tcs).toMatchObject({ tcsAmount: 1180000, baseAmount: 118000000 })
    expect(after.lines[0]).toMatchObject({ ledgerId: fx.carBuyer, amount: 118000000 + 1180000 })
    expect(after.billRefs[0]!.amount).toBe(118000000 + 1180000)
    expect(tcsEligible(db, '2025-07-01', '2025-09-30').map((r) => r.voucherId)).toEqual([scrapSale])
    expect(tdsDeducted(db, '2025-04-01', '2026-03-31')).toEqual([])
    expect(tdsDeducted(db, '2025-04-01', '2026-03-31', 'tcs').map((r) => r.voucherId)).toEqual([car])

    // "Not applicable" with a Form 27C declaration: off the list, reported with remark B.
    exemptVoucher(db, scrapSale, 'Form 27C declaration — buyer uses the scrap for manufacture', 'tcs')
    expect(tcsEligible(db, '2025-07-01', '2025-09-30')).toEqual([])
    const eq = form27eqData(db, 2025, 2)
    expect(eq.layout).toBe('form27eq')
    expect(eq.deductees.map((d) => [d.voucherId, d.sectionCode, d.returnCode, d.deducteeCode, d.tdsPaise, d.reasonCode])).toEqual([
      [car, '206C(1F) VEHICLE', 'L', '02', 1180000, ''],
      [scrapSale, '206C(1) SCRAP', 'E', '01', 0, 'B']
    ])

    const removed = removeTcsFromVoucher(db, car)!
    expect(removed.tcs).toBeNull()
    expect(removed.lines.map((l) => l.amount)).toEqual(getVoucher(db, car)!.lines.map((l) => l.amount))
    expect(removed.lines[0]!.amount).toBe(118000000)
    expect(removed.billRefs[0]!.amount).toBe(118000000)
  })

  it('challan from the TCS deposit, allocation kept apart from TDS, interest from rule 37CA, summary, 27EQ CSV and 27D data', () => {
    const db = seededDb()
    const fx = fixture(db)
    const scrap = sid(db, '206C(1) SCRAP')
    const a = sale(db, fx, '2025-07-03', fx.dealer, 10000000, { item: fx.scrap, tcs: { sectionId: scrap, baseAmount: 11800000, tcsAmount: 118000, isManual: false, autoPayable: true } })
    const b = sale(db, fx, '2025-08-05', fx.dealer, 5000000, { item: fx.scrap, tcs: { sectionId: scrap, baseAmount: 5900000, tcsAmount: 59000, isManual: false, autoPayable: true } })
    const payable = getVoucher(db, a)!.lines.at(-1)!.ledgerId
    expect(getVoucher(db, b)!.lines.at(-1)!.ledgerId).toBe(payable)
    const pay = deposit(db, fx, '2025-09-20', payable, 177000)
    expect(tdsPaymentCandidates(db, 2025)).toEqual([])
    expect(tdsPaymentCandidates(db, 2025, 'tcs').map((c) => c.voucherId)).toEqual([pay])
    const ch = challanFromPayment(db, { paymentVoucherId: pay, bsrCode: '0510002', challanNo: '00042', autoAllocate: true }, 'tcs')
    expect(ch).toMatchObject({ quarter: 2, fyStartYear: 2025, amountPaise: 177000, allocatedPaise: 177000, entryCount: 2 })
    expect(listChallans(db, 2025)).toEqual([])
    expect(listChallans(db, 2025, undefined, 'tcs').map((c) => c.id)).toEqual([ch.id])
    expect(unallocatedEntries(db, 2025, 2, 'tcs')).toEqual([])
    // July collection due 7 Aug, paid 20 Sep: 1.5% x 3 months (Jul, Aug, Sep); August's (due 7 Sep) 1.5% x 2.
    const interest = challanInterest(db, ch.id)
    expect(interest.map((i) => [i.dueDate, i.months, i.interestPaise])).toEqual([['2025-08-07', 3, 5300], ['2025-09-07', 2, 1800]])
    expect(autoAllocate(db, ch.id)).toEqual([])

    const summary = tdsLedgerSummary(db, 2025, 2, 'tcs')
    expect(summary).toEqual([expect.objectContaining({ sectionCode: '206C(1) SCRAP', ledgerId: payable, deductedPaise: 177000, depositedPaise: 177000, outstandingPaise: 0, deductees: 1 })])
    expect(tdsLedgerSummary(db, 2025, 2)).toEqual([])

    ensureCompanyTree('tcs-co')
    const csv = readFileSync(export27eqCsv(db, 'tcs-co', 2025, 2), 'utf8')
    expect(csv).toContain('Collectee,PAN,Collectee Code,Section,Return Code')
    expect(csv).toContain('Scrap Buyer Pvt Ltd,AABCS1234D,01,206C(1) SCRAP,E,2025-07-03')
    expect(csv).toContain('0510002')
    const d27 = form27dData(db, { ...TEST_INFO, tan: 'PNET12345F' }, 2025, 2)
    expect(d27.parties).toHaveLength(1)
    expect(d27.parties[0]!.totals).toEqual({ amountPaise: 17700000, tdsPaise: 177000, depositedPaise: 177000 })
  })
})
