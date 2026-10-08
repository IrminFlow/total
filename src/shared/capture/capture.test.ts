// WP 5.4 — the pure capture engine: reading an extraction (amounts only through parseAmountText),
// recomputing a bill from its lines, duplicate rules, the statement categoriser and the PDF
// text-layer reader.
import { describe, expect, it } from 'vitest'
import { deflateSync, inflateSync } from 'zlib'
import { amountFromText, cleanGstin, dateFromText, parseExtraction, qtyFromText, rateFromText, stateFromText } from './parse'
import { BILL_EXTRACTION_SCHEMA, readExtraction, type BillExtraction } from './schema'
import { recomputeBill } from './totals'
import { findDuplicates, normaliseInvoiceNo, type DuplicateCandidate } from './duplicates'
import { applyModelPicks, categoriseLines, categoriseResponseSchema, historyVote, narrationPrefix, type CatLedger, type CatLine, type HistoryEntry } from './categorise'
import { extractPdfText, parseToUnicode, textLooksUsable } from './pdfText'
import { FIXTURE_BILL_LINES, makeTestPdf } from './pdfFixture.testutil'

const TODAY = '2025-08-20'
const inflate = (b: Uint8Array): Uint8Array => new Uint8Array(inflateSync(b))
const deflate = (b: Uint8Array): Uint8Array => new Uint8Array(deflateSync(b))

export function sampleExtraction(over: Partial<BillExtraction> = {}): BillExtraction {
  return {
    documentType: 'tax_invoice',
    supplier: { name: 'Bharat Steel Suppliers', gstin: '27AABCG3456H1ZN', address: 'MIDC Bhosari, Pune', stateCode: '27' },
    buyerGstin: '27AAPFU0939F1ZV',
    invoiceNumber: 'BSS/2025-26/0142',
    invoiceDate: '12/08/2025',
    invoiceDateIso: '2025-08-12',
    placeOfSupply: '27-Maharashtra',
    paymentTerms: '30 days',
    dueDate: null,
    currency: 'INR',
    lines: [
      { description: 'Office Chair', hsn: '9401', qty: '4', unit: 'Nos', rate: '5,000.00', discount: null, taxable: '20,000.00', gstRate: '18%', cgst: '1,800.00', sgst: '1,800.00', igst: null, cess: null, amount: '23,600.00' },
      { description: 'Steel Filing Cabinet', hsn: '9403', qty: '1', unit: 'Nos', rate: '9,500.00', discount: null, taxable: '9,500.00', gstRate: '12%', cgst: '570.00', sgst: '570.00', igst: null, cess: null, amount: '10,640.00' }
    ],
    taxSummary: [],
    roundOff: '0.00',
    total: '₹ 34,240.00',
    confidence: 'high',
    notes: null,
    ...over
  }
}

describe('reading printed figures', () => {
  it('reads amounts only through parseAmountText — rupee signs, grouping, signs; floats and garbage refused', () => {
    expect(amountFromText('₹ 1,20,000.00')).toBe(12_000_000)
    expect(amountFromText('Rs. 450/-')).toBe(45_000)
    expect(amountFromText('34,240')).toBe(3_424_000)
    expect(amountFromText('-0.40')).toBe(-40)
    expect(amountFromText('(0.40)')).toBe(-40)
    expect(amountFromText('0.40 Cr')).toBe(40)
    expect(amountFromText('1234.5600000001')).toBeNull() // a float artefact is never rounded
    expect(amountFromText('1234.567')).toBeNull()
    expect(amountFromText('12,34,5')).toBeNull()
    expect(amountFromText('about 500')).toBeNull()
    expect(amountFromText('1e3')).toBeNull()
    expect(amountFromText('')).toBeNull()
    expect(amountFromText(null)).toBeNull()
  })

  it('reads rates, quantities, dates, GSTINs and states', () => {
    expect(rateFromText('18%')).toBe(1800)
    expect(rateFromText('9+9')).toBe(1800)
    expect(rateFromText('2.5 %')).toBe(250)
    expect(rateFromText('eighteen')).toBeNull()
    expect(qtyFromText('2.5')).toEqual({ qtyMilli: 2500, unit: null })
    expect(qtyFromText('1,000 Nos')).toEqual({ qtyMilli: 1_000_000, unit: 'Nos' })
    expect(qtyFromText('0')).toBeNull()
    expect(qtyFromText('two')).toBeNull()
    expect(dateFromText('2025-08-12', '13/08/2025', TODAY)).toBe('2025-08-12')
    expect(dateFromText(null, '12/08/2025', TODAY)).toBe('2025-08-12') // day-first
    expect(dateFromText('2025-02-30', '12-Aug-25', TODAY)).toBe('2025-08-12')
    expect(dateFromText(null, 'yesterday', TODAY)).toBeNull()
    expect(cleanGstin(' 27aabcg3456h1zn ')).toBe('27AABCG3456H1ZN')
    expect(cleanGstin('[GSTIN …1ZN]')).toBeNull()
    expect(stateFromText('29-Karnataka')).toBe('29')
    expect(stateFromText('Maharashtra')).toBe('27')
  })

  it('parses a whole extraction and warns about each unreadable figure', () => {
    const p = parseExtraction(
      sampleExtraction({
        lines: [{ description: 'Chair', hsn: '9401', qty: 'four', unit: null, rate: '5000.555', discount: null, taxable: '20,000.00', gstRate: '18', cgst: null, sgst: null, igst: null, cess: null, amount: null }]
      }),
      TODAY
    )
    expect(p.supplierGstin).toBe('27AABCG3456H1ZN')
    expect(p.date).toBe('2025-08-12')
    expect(p.placeOfSupply).toBe('27')
    expect(p.total).toBe(3_424_000)
    expect(p.lines[0]).toMatchObject({ qtyMilli: null, ratePaise: null, taxablePaise: 2_000_000, gstRateBp: 1800 })
    expect(p.warnings.join(' ')).toMatch(/quantity: “four”/)
    expect(p.warnings.join(' ')).toMatch(/rate: “5000.555” is not a rupee amount/)
  })

  it('the response schema is strict (every key required, no extra keys) and the reader refuses a bad answer', () => {
    const s = BILL_EXTRACTION_SCHEMA as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> }
    expect(s.additionalProperties).toBe(false)
    expect(s.required.sort()).toEqual(Object.keys(s.properties).sort())
    expect(readExtraction(JSON.stringify(sampleExtraction())).invoiceNumber).toBe('BSS/2025-26/0142')
    expect(() => readExtraction('not json')).toThrow(/did not return JSON/)
    expect(() => readExtraction(JSON.stringify({ ...sampleExtraction(), total: 34240 }))).toThrow(/total/)
    expect(() => readExtraction(JSON.stringify({ ...sampleExtraction(), extra: 1 }))).toThrow(/schema/)
  })
})

describe('recomputing the bill', () => {
  it('agrees with a consistent bill', () => {
    const t = recomputeBill(parseExtraction(sampleExtraction(), TODAY))
    expect(t).toMatchObject({ taxable: 2_950_000, cgst: 237_000, sgst: 237_000, igst: 0, computedTotal: 3_424_000, printedTotal: 3_424_000 })
    expect(t.discrepancies).toEqual([])
  })

  it('flags a printed total that differs, a line that does not add up, and unequal halves', () => {
    const x = sampleExtraction({ total: '34,340.00' })
    x.lines[0]!.taxable = '19,000.00'
    x.lines[1]!.sgst = '575.00'
    const t = recomputeBill(parseExtraction(x, TODAY))
    expect(t.lineTaxable[0]).toBe(2_000_000) // qty × rate wins; the printed one is flagged
    expect(t.discrepancies.join('\n')).toMatch(/Line 1 .*₹20,000.00 but ₹19,000.00 is printed/)
    expect(t.discrepancies.join('\n')).toMatch(/CGST .* and SGST .* differ/)
    expect(t.discrepancies.join('\n')).toMatch(/printed total ₹34,340.00 differs/)
  })

  it('uses the tax summary when lines carry no tax, and counts the round-off', () => {
    const x = sampleExtraction({
      roundOff: '-0.40',
      total: '34,239.60',
      taxSummary: [
        { rate: '18%', taxable: '20,000.00', cgst: '1,800.00', sgst: '1,800.00', igst: null, cess: null },
        { rate: '12%', taxable: '9,500.00', cgst: '570.00', sgst: '570.00', igst: null, cess: null }
      ]
    })
    for (const l of x.lines) l.cgst = l.sgst = null
    const t = recomputeBill(parseExtraction(x, TODAY))
    expect(t).toMatchObject({ tax: 474_000, roundOff: -40, computedTotal: 3_423_960 })
    expect(t.discrepancies).toEqual([])
  })
})

describe('duplicate rules', () => {
  const existing = (over: Partial<DuplicateCandidate>): DuplicateCandidate => ({ voucherId: 9, number: 'P/7', date: '2025-08-12', partyLedgerId: 5, invoiceNos: ['BSS/2025-26/142'], total: 3_424_000, ...over })
  it('normalises invoice numbers', () => {
    expect(normaliseInvoiceNo('INV/2025-26/0042')).toBe(normaliseInvoiceNo('inv-2025-26-42'))
    expect(normaliseInvoiceNo('A12')).not.toBe(normaliseInvoiceNo('A121'))
  })
  it('same supplier + invoice number within the FY refuses; another FY or supplier does not', () => {
    const bill = { partyLedgerId: 5, invoiceNo: 'BSS/2025-26/0142', date: '2025-08-12', total: 100 }
    expect(findDuplicates(bill, [existing({})])[0]).toMatchObject({ kind: 'same_invoice', voucherId: 9 })
    expect(findDuplicates(bill, [existing({ date: '2025-03-30' })])).toEqual([])
    expect(findDuplicates(bill, [existing({ partyLedgerId: 6 })])).toEqual([])
  })
  it('same supplier + amount within ±7 days flags; 8 days does not', () => {
    const bill = { partyLedgerId: 5, invoiceNo: 'X-1', date: '2025-08-12', total: 3_424_000 }
    expect(findDuplicates(bill, [existing({ date: '2025-08-19' })])[0]).toMatchObject({ kind: 'same_amount' })
    expect(findDuplicates(bill, [existing({ date: '2025-08-20' })])).toEqual([])
    expect(findDuplicates(bill, [existing({ date: '2025-08-05', total: 3_424_001 })])).toEqual([])
  })
})

describe('statement categoriser (history first, the model only for the residual)', () => {
  const ledgers: CatLedger[] = [
    { id: 1, name: 'HDFC Bank', kind: 'cash_bank' },
    { id: 2, name: 'Cash', kind: 'cash_bank' },
    { id: 3, name: 'Electricity Charges', kind: 'expense' },
    { id: 4, name: 'Bharat Steel Suppliers', kind: 'creditor' },
    { id: 5, name: 'Umbrella Retail', kind: 'debtor' },
    { id: 6, name: 'Bank Charges', kind: 'expense' },
    { id: 7, name: 'Interest Received', kind: 'income' }
  ]
  const line = (id: number, description: string, side: CatLine['side'] = 'withdrawal'): CatLine => ({ id, date: '2025-08-10', description, reference: '', side, amount: 100_000 })
  const history: HistoryEntry[] = [
    { description: 'ACH/MSEDCL BILL/0042198', side: 'withdrawal', ledgerId: 3, partyLedgerId: null, date: '2025-06-10' },
    { description: 'ACH/MSEDCL BILL/0052231', side: 'withdrawal', ledgerId: 3, partyLedgerId: null, date: '2025-07-10' },
    { description: 'CHRG/SMS ALERT', side: 'withdrawal', ledgerId: 6, partyLedgerId: null, date: '2025-07-01' },
    { description: 'CHRG/SMS ALERT', side: 'withdrawal', ledgerId: 3, partyLedgerId: null, date: '2025-07-02' }
  ]

  it('takes the ledger used before for the same narration prefix', () => {
    expect(narrationPrefix('ACH/MSEDCL BILL/0099/UTR123456')).toBe('MSEDCL BILL')
    const [p] = categoriseLines([line(1, 'ACH/MSEDCL BILL/0063311')], { history, ledgers, bankLedgerId: 1 })
    expect(p).toMatchObject({ ledgerId: 3, kind: 'payment', source: 'history', oldestBillsFirst: false })
    expect(p!.why).toMatch(/all 2 times/)
  })

  it('split history is not decided — it becomes the residual with both ledgers as candidates', () => {
    expect(historyVote(line(1, 'CHRG/SMS ALERT'), history)).toMatchObject({ share: 0.5 })
    const [p] = categoriseLines([line(1, 'CHRG/SMS ALERT Q2')], { history, ledgers, bankLedgerId: 1 })
    expect(p).toMatchObject({ source: 'none', ledgerId: null })
    expect(p!.candidates.map((c) => c.id).slice(0, 2).sort()).toEqual([3, 6])
    expect(p!.candidates.some((c) => c.id === 1)).toBe(false) // never the bank itself
  })

  it('a named party is a receipt / payment allocated oldest bill first; a rule hint wins first; memory hook is optional', () => {
    const [a, b] = categoriseLines([line(1, 'NEFT-UMBRELLA RETAIL-UTR99887766', 'deposit'), line(2, 'NEFT/BHARAT STEEL SUPPLIERS/HDFC0001234')], { history, ledgers, bankLedgerId: 1 })
    expect(a).toMatchObject({ ledgerId: 5, partyLedgerId: 5, kind: 'receipt', source: 'party', oldestBillsFirst: true })
    expect(b).toMatchObject({ ledgerId: 4, kind: 'payment', source: 'party' })
    const hints = new Map([[3, { source: 'rule' as const, ruleId: 11, ledgerId: 6, partyLedgerId: null, status: 'manual' as const, confidence: 1, why: 'bank rule “SMS”' }]])
    const [c] = categoriseLines([line(3, 'ACH/MSEDCL BILL/1')], { history, ledgers, bankLedgerId: 1, hints })
    expect(c).toMatchObject({ ledgerId: 6, source: 'rule', ruleId: 11 })
    const [d] = categoriseLines([line(4, 'SOMETHING NEW')], { history, ledgers, bankLedgerId: 1, memory: () => ({ ledgerId: 7, why: 'remembered' }) })
    expect(d).toMatchObject({ ledgerId: 7, source: 'memory' })
    const [e] = categoriseLines([line(5, 'CASH WDL ATM 0042', 'withdrawal')], { history: [{ description: 'CASH WDL ATM 1', side: 'withdrawal', ledgerId: 2, partyLedgerId: null, date: '2025-07-01' }], ledgers, bankLedgerId: 1 })
    expect(e).toMatchObject({ ledgerId: 2, kind: 'contra' })
  })

  it('model picks count only from the line’s own candidates; the schema enumerates the ids', () => {
    const props = categoriseLines([line(1, 'CHRG/SMS ALERT Q2'), line(2, 'ZZZ UNKNOWN')], { history, ledgers, bankLedgerId: 1 })
    const res = applyModelPicks(props, [{ lineId: 1, ledgerId: 6, reason: 'bank charge' }, { lineId: 2, ledgerId: 999, reason: 'made up' }], ledgers)
    expect(res.proposals[0]).toMatchObject({ ledgerId: 6, source: 'ai', kind: 'payment' })
    expect(res.proposals[1]).toMatchObject({ ledgerId: null, source: 'none' })
    expect(res.rejected).toEqual([{ lineId: 2, ledgerId: 999, reason: 'not one of the line’s candidates' }])
    const schema = categoriseResponseSchema([1, 2], [3, 6]) as { properties: { picks: { items: { properties: { ledgerId: { enum: unknown[] } } } } } }
    expect(schema.properties.picks.items.properties.ledgerId.enum).toEqual([3, 6, null])
  })
})

describe('PDF text layer', () => {
  it('reads a Helvetica PDF, compressed or not, in page order', () => {
    for (const d of [undefined, deflate]) {
      const r = extractPdfText(makeTestPdf(FIXTURE_BILL_LINES, { deflate: d }), inflate)
      expect(r.pageCount).toBe(1)
      expect(r.pages[0]).toContain('Invoice No: BSS/2025-26/0142')
      expect(r.pages[0]).toContain('GSTIN: 27AABCG3456H1ZN')
      expect(r.pages[0]!.split('\n')).toHaveLength(FIXTURE_BILL_LINES.length)
      expect(textLooksUsable(r.pages.join('\n'))).toBe(true)
    }
    const two = extractPdfText(makeTestPdf([], { pages: [['Page one total 1,000.00'], ['Page two']], deflate }), inflate)
    expect(two.pageCount).toBe(2)
    expect(two.pages).toEqual(['Page one total 1,000.00', 'Page two'])
  })

  it('reads a Type0 font through its ToUnicode CMap, inside an object stream', () => {
    const lines = ['TAX INVOICE ₹ 34,240.00', 'GSTIN 27AABCG3456H1ZN']
    const r = extractPdfText(makeTestPdf(lines, { font: 'cid', deflate, objectStream: true }), inflate)
    expect(r.pages[0]).toBe(lines.join('\n'))
    const cm = parseToUnicode('1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0010> <0012> <0041> endbfrange')
    expect(cm.bytesPerCode).toBe(2)
    expect([cm.map.get(0x10), cm.map.get(0x12)]).toEqual(['A', 'C'])
  })

  it('a scan (no text) is not usable; a non-PDF is refused', () => {
    expect(textLooksUsable('')).toBe(false)
    expect(textLooksUsable('\u0001\u0002 ##### ')).toBe(false)
    expect(() => extractPdfText(new TextEncoder().encode('hello'), inflate)).toThrow(/Not a PDF/)
  })
})
