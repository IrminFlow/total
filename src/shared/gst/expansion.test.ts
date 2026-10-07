// WP 3.4 — pure builders: GSTR-9 workings, ITC-04, IMS rows, self-invoice numbering, the
// Circular 170 GSTR-3B re-shaping and the annual compliance deadlines.
import { describe, expect, it } from 'vitest'
import { applySetOff, buildGstr1, buildGstr3b, circular170Inputs, EMPTY_GST3B_MANUAL, type GstDoc } from './returns'
import { buildGstr9, gstr1JsonTotals, setOffDetail, type Gstr3bFigures, type Gstr9Month } from './gstr9'
import { buildItc04, itc04Csv, itc04Json, itc04Periodicity, itc04Periods } from './itc04'
import { bulkAcceptKeys, imsActionsCsv, imsActionsJson, imsRows, type ImsActionRecord } from './ims'
import { isValidSelfInvoiceNumber, selfInvoiceNumber, selfInvoiceStatus } from './selfInvoice'
import { upcomingDeadlines } from '../compliance'
import { GST_SOURCES, GST_UNVERIFIED } from './sources'
import type { Recon2bPair } from './recon2b'

const doc = (o: Partial<GstDoc>): GstDoc => ({
  voucherId: 1, kind: 'sales', date: '2026-05-10', number: 'S1', partyName: 'Buyer', partyGstin: '27AAPFU0939F1ZV', pos: '27',
  invoiceValue: 118000, items: [{ rate: 18, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 }], hsnLines: [
    { hsn: '8471', description: 'Laptop', uqc: 'NOS', qtyMilli: 1000, rate: 18, taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0 }
  ], ...o
})

const ZERO = { igst: 0, cgst: 0, sgst: 0, cess: 0 }

function monthFrom(docs: GstDoc[], period: string): Gstr9Month {
  const g1 = buildGstr1(docs, '27AAAAA0000A1Z5', '27', period)
  const g3 = buildGstr3b({ docs, itc: { impg: ZERO, isrc: ZERO, oth: { igst: 0, cgst: 1000, sgst: 1000, cess: 0 }, blocked: ZERO }, rcmInward: { taxable: 0, ...ZERO } }, '27AAAAA0000A1Z5', period)
  const fig: Gstr3bFigures = {
    outward: g3.outward, zeroRated: g3.zeroRated, nilExempt: g3.nilExempt, rcm: g3.rcm, itcParts: g3.itcParts, manual: EMPTY_GST3B_MANUAL,
    blocked175: ZERO, netPayable: g3.netPayable, rcmPayable: g3.rcmPayable
  }
  return { period, source: 'books', exportedAt: null, gstr1: gstr1JsonTotals(g1.json), gstr3b: fig, reversalSplit: null }
}

describe('GSTR-9 workings', () => {
  const may = [
    doc({ voucherId: 1 }),
    doc({ voucherId: 2, partyGstin: null, partyName: null, number: 'S2', pos: '27' }), // B2C
    doc({ voucherId: 3, kind: 'credit_note', number: 'CN1', items: [{ rate: 18, taxable: 10000, cgst: 900, sgst: 900, igst: 0, cess: 0 }], hsnLines: [] }),
    doc({ voucherId: 4, number: 'E1', invTyp: 'EXPWOP', partyGstin: null, pos: '96', items: [{ rate: 18, taxable: 50000, cgst: 0, sgst: 0, igst: 0, cess: 0 }], hsnLines: [] }),
    doc({ voucherId: 5, number: 'N1', items: [], nilLines: [{ taxable: 7000 }], hsnLines: [] })
  ]
  const june = [doc({ voucherId: 6, date: '2026-06-02', number: 'S3', pos: '29', items: [{ rate: 18, taxable: 20000, cgst: 0, sgst: 0, igst: 3600, cess: 0 }], hsnLines: [] })]
  const r = buildGstr9({
    fyLabel: '2026-27', gstin: '27AAAAA0000A1Z5', docs: [...may, ...june], advances: [], advanceAdjustments: [],
    itcDocs: [
      { voucherId: 10, number: 'P1', date: '2026-05-02', kind: 'purchase', partyName: 'Vendor', partyLedgerId: 9, taxable: 11111, igst: 0, cgst: 1000, sgst: 1000, cess: 0, bucket: 'inputs', source: 'domestic' },
      { voucherId: 11, number: 'P2', date: '2026-06-02', kind: 'purchase', partyName: 'Vendor', partyLedgerId: 9, taxable: 11111, igst: 0, cgst: 1000, sgst: 1000, cess: 0, bucket: 'input_services', source: 'domestic' }
    ],
    hsnInward: [],
    months: [monthFrom(may, '052026'), monthFrom(june, '062026')]
  })
  const row = (id: string) => r.rows.find((x) => x.id === id)!

  it('lays out tables 4 and 5 from the documents', () => {
    expect(row('4B').amounts).toMatchObject({ taxable: 120000, igst: 3600, cgst: 9000 })
    expect(row('4A').amounts.taxable).toBe(100000)
    expect(row('4I').amounts.taxable).toBe(10000)
    expect(row('5A').amounts.taxable).toBe(50000)
    expect(row('5E').amounts.taxable).toBe(7000)
    expect(row('4N').amounts.taxable).toBe(120000 + 100000 - 10000)
    expect(row('5N').amounts.taxable).toBe(row('4N').amounts.taxable + 57000)
    expect(row('4B').docs.map((d) => d.voucherId)).toEqual([1, 6])
  })

  it('every comparison against Σ monthly GSTR-1 / GSTR-3B is nil when nothing changed', () => {
    for (const c of r.compare) expect({ id: c.id, diff: c.diff }).toEqual({ id: c.id, diff: { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 } })
  })

  it('a month changed after export shows up as a difference', () => {
    const exported = monthFrom([doc({ voucherId: 1 })], '052026') // the CN, B2C sale, export and nil sale came later
    const r2 = buildGstr9({ ...{ fyLabel: '2026-27', gstin: 'X', advances: [], advanceAdjustments: [], itcDocs: [], hsnInward: [] }, docs: may, months: [exported] })
    expect(r2.compare.find((c) => c.id === 'g1-taxable')!.diff.taxable).toBe(100000 - 10000)
    expect(r2.compare.find((c) => c.id === 'g1-nil')!.diff.taxable).toBe(7000)
  })

  it('table 6 splits ITC by inputs / input services and ties 6J to nil', () => {
    expect(row('6B-I').amounts.cgst).toBe(1000)
    expect(row('6B-IS').amounts.cgst).toBe(1000)
    expect(row('6A').amounts.cgst).toBe(2000)
    expect(row('6J').amounts).toEqual({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 })
  })

  it('rows the books cannot derive are flagged, not silently zero', () => {
    for (const id of ['4K', '4L', '8A', '10', '11', '12', '13', '6K']) expect(row(id).source).toBe('na')
  })

  it('table 9 cash + ITC paid covers what is payable', () => {
    for (const p of r.paid.slice(0, 4)) {
      const itc = p.paidItc.igst + p.paidItc.cgst + p.paidItc.sgst + p.paidItc.cess
      expect(p.paidCash + itc).toBe(p.payable)
    }
  })
})

describe('setOffDetail mirrors applySetOff', () => {
  it.each([
    [{ igst: 500, cgst: 300, sgst: 300, cess: 10 }, { igst: 700, cgst: 100, sgst: 50, cess: 0 }],
    [{ igst: 0, cgst: 1000, sgst: 1000, cess: 0 }, { igst: 1500, cgst: 0, sgst: 0, cess: 5 }],
    [{ igst: 1000, cgst: 0, sgst: 0, cess: 0 }, { igst: 0, cgst: 600, sgst: 600, cess: 0 }]
  ])('residual equals applySetOff for %o / %o', (payable, credit) => {
    const d = setOffDetail(payable, credit)
    expect(d.residual).toEqual(applySetOff(payable, credit))
    const usedAgainst = (h: 'igst' | 'cgst' | 'sgst' | 'cess') => d.used.igst[h] + d.used.cgst[h] + d.used.sgst[h] + d.used.cess[h]
    for (const h of ['igst', 'cgst', 'sgst', 'cess'] as const) expect(usedAgainst(h) + d.residual[h]).toBe(payable[h])
  })
})

describe('Circular 170 re-shaping of GSTR-3B Table 4', () => {
  it('avails s.17(5) credit in 4(A)(5), reverses it in 4(B)(1), reclaim in 4(A)(5) + 4(D)(1); 4(C) unchanged by blocked credit', () => {
    const books = { impg: ZERO, isrc: ZERO, oth: { igst: 1000, cgst: 0, sgst: 0, cess: 0 }, blocked: { igst: 300, cgst: 0, sgst: 0, cess: 0 } }
    const reclaimed = { igst: 50, cgst: 0, sgst: 0, cess: 0 }
    const { itc, manual } = circular170Inputs(books, EMPTY_GST3B_MANUAL, reclaimed)
    expect(itc.oth.igst).toBe(1350)
    expect(manual.itcRevRul.igst).toBe(300)
    const g = buildGstr3b({ docs: [], itc, rcmInward: { taxable: 0, ...ZERO }, manual }, 'X', '052026')
    expect(g.itc.igst).toBe(1000 + 50) // net = old net + reclaim
    const elg = g.json.itc_elg as { itc_inelg: { ty: string; iamt: number }[]; itc_rev: { ty: string; iamt: number }[] }
    expect(elg.itc_inelg.find((x) => x.ty === 'RUL')!.iamt).toBe(0.5)
    expect(elg.itc_rev.find((x) => x.ty === 'RUL')!.iamt).toBe(3)
  })
})

describe('ITC-04', () => {
  it('periodicity: half-yearly above ₹5 crore preceding-FY turnover, else annual; due dates', () => {
    expect(itc04Periodicity(5_00_00_000 * 100)).toBe('annual')
    expect(itc04Periodicity(5_00_00_000 * 100 + 1)).toBe('half_yearly')
    expect(itc04Periods(2026, 'half_yearly').map((p) => [p.kind, p.from, p.to, p.dueDate])).toEqual([
      ['H1', '2026-04-01', '2026-09-30', '2026-10-25'],
      ['H2', '2026-10-01', '2027-03-31', '2027-04-25']
    ])
    expect(itc04Periods(2026, 'annual')).toEqual([expect.objectContaining({ kind: 'FY', dueDate: '2027-04-25' })])
  })

  const period = itc04Periods(2026, 'annual')[0]!
  const party = { jobWorkerName: 'Ravi', gstin: '29AAPFU0939F1ZV', stateCode: '29' }
  const r = buildItc04({
    period, companyStateCode: '27', supplies: [],
    data: {
      sent: [{ voucherId: 1, challanNo: 'JW-1', challanDate: '2026-05-01', ...party, stockItemId: 5, itemName: 'Steel', hsn: '7308', unit: 'kg', qtyMilli: 8000, taxableValuePaise: 120000, goodsType: 'inputs', natureOfProcessing: 'Welding' }],
      received: [{
        voucherId: 2, voucherNumber: 'M-1', voucherDate: '2026-05-20', challanNo: 'RF/112', challanDate: '2026-05-19', originalChallanNo: 'JW-1', originalChallanDate: '2026-05-01', ...party,
        natureOfProcessing: 'Welding', goods: [{ stockItemId: 6, itemName: 'Frame', hsn: '7308', unit: 'Nos', qtyMilli: 4000 }],
        inputs: [{ stockItemId: 5, itemName: 'Steel', hsn: '7308', unit: 'kg', qtyMilli: 6000, lossQtyMilli: 400 }]
      }],
      returned: [{ voucherId: 3, challanNo: 'RF/115', challanDate: '2026-05-25', originalChallanNo: 'JW-1', originalChallanDate: '2026-05-01', ...party, stockItemId: 5, itemName: 'Steel', hsn: null, unit: 'kg', qtyMilli: 2000, natureOfProcessing: null }],
      itemRates: { 5: { gstRate: 18, cessRate: 0 } }
    }
  })

  it('Table 4 carries GSTIN, challan, UQC, quantity, value, goods type and inter-state IGST rate', () => {
    expect(r.sent[0]).toMatchObject({ jwGstin: '29AAPFU0939F1ZV', jwStateCode: '29', challanNo: 'JW-1', uqc: 'KGS', qtyMilli: 8000, taxableValuePaise: 120000, goodsType: 'inputs', igstRate: 18, cgstRate: 0 })
  })

  it('Table 5A: processed goods with losses and the original challan; unprocessed returns', () => {
    expect(r.received).toEqual([
      expect.objectContaining({ kind: 'processed', jwChallanNo: 'RF/112', originalChallanNo: 'JW-1', description: 'Frame', uqc: 'NOS', qtyMilli: 4000, lossUqc: 'KGS', lossQtyMilli: 400 }),
      expect.objectContaining({ kind: 'unprocessed', jwChallanNo: 'RF/115', qtyMilli: 2000, lossQtyMilli: 0 })
    ])
    expect(r.totals).toMatchObject({ sentQtyMilli: 8000, receivedQtyMilli: 6000, lossQtyMilli: 400 })
    expect(r.issues.some((i) => /HSN/.test(i.message))).toBe(true)
  })

  it('exports JSON (flagged as the app’s own layout) and CSV', () => {
    const j = itc04Json(r, '27AAAAA0000A1Z5') as { verified_against_offline_tool: boolean; table4: unknown[]; table5a: unknown[] }
    expect(j.verified_against_offline_tool).toBe(false)
    expect(j.table4).toHaveLength(1)
    expect(j.table5a).toHaveLength(2)
    const csv = itc04Csv(r).split('\n')
    expect(csv).toHaveLength(4)
    expect(csv[1]!.startsWith('4,29AAPFU0939F1ZV,')).toBe(true)
  })
})

describe('IMS action list', () => {
  const p = { gstin: '27ABCDE1234F1Z5', number: 'INV-1', date: '2026-06-05', value: 118000, taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0, kind: 'b2b' as const }
  const pairs: Recon2bPair[] = [
    { bucket: 'matched', portal: p, book: null, valueDiffPaise: 0, taxDiffPaise: null },
    { bucket: 'missingInBooks', portal: { ...p, number: 'INV-2' }, book: null, valueDiffPaise: null, taxDiffPaise: null },
    { bucket: 'missingInPortal', portal: null, book: null, valueDiffPaise: null, taxDiffPaise: null }
  ]
  const stored: ImsActionRecord[] = [{ period: '062026', supplierGstin: p.gstin, docType: 'INV', docNo: 'INV-2', docDate: p.date, action: 'reject', note: 'Not ours', decidedAt: 'x', voucherId: null, value: 1, taxable: 1, igst: 0, cgst: 0, sgst: 0, cess: 0 }]

  it('one row per portal record, joined to stored decisions, with a suggestion', () => {
    const rows = imsRows('062026', pairs, stored)
    expect(rows.map((x) => [x.portal.number, x.action, x.suggested])).toEqual([['INV-1', null, 'accept'], ['INV-2', 'reject', 'pending']])
    expect(bulkAcceptKeys(rows)).toEqual(['062026|27ABCDE1234F1Z5|INV|INV-1'])
  })

  it('exports A/R/P actions as JSON and CSV', () => {
    const j = imsActionsJson('27AAAAA0000A1Z5', '062026', stored) as { records: { action: string; idt: string }[]; verified_against_portal_schema: boolean }
    expect(j.records[0]).toMatchObject({ action: 'R', idt: '05-06-2026' })
    expect(j.verified_against_portal_schema).toBe(false)
    expect(imsActionsCsv(stored).split('\n')[1]).toContain('Reject')
  })
})

describe('self-invoice (rule 46(b) / rule 47A)', () => {
  it('numbers a consecutive FY series within 16 characters', () => {
    expect(selfInvoiceNumber('SI/', '2026-27', 7)).toBe('SI/26-27/0007')
    expect(isValidSelfInvoiceNumber('SI/26-27/0007')).toBe(true)
    expect(() => selfInvoiceNumber('SELFINV/', '2026-27', 1)).toThrow(/rule 46/)
    expect(isValidSelfInvoiceNumber('SI 1')).toBe(false)
  })

  it('due 30 days after receipt (from 1 Nov 2024); late / overdue / binned', () => {
    expect(selfInvoiceStatus('2026-06-01', null, '2026-06-20')).toEqual({ status: 'due', dueDate: '2026-07-01', daysLeft: 11 })
    expect(selfInvoiceStatus('2026-06-01', null, '2026-07-05').status).toBe('overdue')
    expect(selfInvoiceStatus('2026-06-01', '2026-06-10', '2026-07-05').status).toBe('generated')
    expect(selfInvoiceStatus('2026-06-01', '2026-07-10', '2026-07-15').status).toBe('generated_late')
    expect(selfInvoiceStatus('2024-10-01', null, '2026-01-01')).toEqual({ status: 'due', dueDate: null, daysLeft: null })
    expect(selfInvoiceStatus('2026-06-01', 'x', 'y', true).status).toBe('cancelled')
  })
})

describe('annual GST deadlines (compliance)', () => {
  it('GSTR-9 on 31 December for regular registrations', () => {
    const d = upcomingDeadlines('2026-12-10', 'regular', false, 30)
    expect(d.find((x) => x.form === 'GSTR-9')).toMatchObject({ date: '2026-12-31', title: expect.stringContaining('2025-26') })
    expect(upcomingDeadlines('2026-12-10', 'composition', false, 30).some((x) => x.form === 'GSTR-9')).toBe(false)
  })

  it('ITC-04 only with job work; 25 October appears only when half-yearly', () => {
    expect(upcomingDeadlines('2026-10-10', 'regular', false, 30).some((x) => x.form === 'ITC-04')).toBe(false)
    expect(upcomingDeadlines('2026-10-10', 'regular', false, 30, { jobWork: true, itc04: 'annual' }).some((x) => x.form === 'ITC-04')).toBe(false)
    expect(upcomingDeadlines('2026-10-10', 'regular', false, 30, { jobWork: true, itc04: 'half_yearly' }).find((x) => x.form === 'ITC-04')).toMatchObject({ date: '2026-10-25' })
    expect(upcomingDeadlines('2027-04-10', 'regular', false, 30, { jobWork: true, itc04: 'annual' }).find((x) => x.form === 'ITC-04')).toMatchObject({ date: '2027-04-25', title: expect.stringContaining('2026-27') })
  })
})

describe('sources', () => {
  it('every source has an URL and an access date; UNVERIFIED items name real sources', () => {
    for (const s of Object.values(GST_SOURCES)) {
      expect(s.url).toMatch(/^https:\/\//)
      expect(s.accessed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    for (const u of GST_UNVERIFIED) for (const id of u.sources) expect(GST_SOURCES[id]).toBeDefined()
  })
})
