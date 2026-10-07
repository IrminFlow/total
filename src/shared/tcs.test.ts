import { describe, it, expect } from 'vitest'
import {
  addTcsToLines, classifyTcsVoucher, collecteeCodeForReturn, isDeclarationReason, removeTcsFromLines, tcsBasePaise,
  tcsDepositDueDate, tcsStatementDueDate, validateTcsEntries, TCS_NO_PAN_MULTIPLE, type TcsLedgerFacts
} from './tcs'
import { applicableRate, computeWithholdingPaise, type WithholdingRateRow } from './withholding'
import { lateDepositInterest } from './tdsInterest'

const BUYER = 1
const SALES = 2
const SCRAP_SALES = 3
const CGST = 4
const SGST = 5
const PAYABLE = 6
const BANK = 7
const SCRAP = 1
const VEHICLE = 2

const facts = (over: Partial<Record<number, Partial<TcsLedgerFacts>>> = {}) => (id: number): TcsLedgerFacts | null => {
  const base: Record<number, TcsLedgerFacts> = {
    [BUYER]: { isCollecteeCandidate: true, tcsSectionId: null, defaultSectionId: null, isTax: false, isTcsPayable: false, isCashBank: false },
    [SALES]: { isCollecteeCandidate: false, tcsSectionId: null, defaultSectionId: null, isTax: false, isTcsPayable: false, isCashBank: false },
    [SCRAP_SALES]: { isCollecteeCandidate: false, tcsSectionId: null, defaultSectionId: SCRAP, isTax: false, isTcsPayable: false, isCashBank: false },
    [CGST]: { isCollecteeCandidate: false, tcsSectionId: null, defaultSectionId: null, isTax: true, isTcsPayable: false, isCashBank: false },
    [SGST]: { isCollecteeCandidate: false, tcsSectionId: null, defaultSectionId: null, isTax: true, isTcsPayable: false, isCashBank: false },
    [PAYABLE]: { isCollecteeCandidate: false, tcsSectionId: null, defaultSectionId: null, isTax: false, isTcsPayable: true, isCashBank: false },
    [BANK]: { isCollecteeCandidate: false, tcsSectionId: null, defaultSectionId: null, isTax: false, isTcsPayable: false, isCashBank: true }
  }
  const f = base[id]
  return f ? { ...f, ...(over[id] ?? {}) } : null
}

const sale = (salesLedger = SALES, items: { stockItemId: number; amount: number }[] = []) => ({
  kind: 'sales' as const,
  partyLedgerId: BUYER,
  lines: [
    { ledgerId: BUYER, drCr: 'dr' as const, amount: 11800000 },
    { ledgerId: salesLedger, drCr: 'cr' as const, amount: 10000000 },
    { ledgerId: CGST, drCr: 'cr' as const, amount: 900000 },
    { ledgerId: SGST, drCr: 'cr' as const, amount: 900000 }
  ],
  inventory: items.map((i) => ({ ...i, direction: 'out' as const }))
})
const itemSection = (id: number): number | null => (id === 10 ? SCRAP : null)

describe('classifyTcsVoucher', () => {
  it('a sale to a flagged buyer: the whole invoice, GST split out', () => {
    const c = classifyTcsVoucher(sale(), facts({ [BUYER]: { tcsSectionId: VEHICLE } }), itemSection)!
    expect(c).toMatchObject({ eventKind: 'credit', sectionId: VEHICLE, sectionFrom: 'party', taxablePaise: 10000000, gstPaise: 1800000, grossPaise: 11800000 })
    expect(tcsBasePaise(c, { baseIncludesGst: true })).toBe(11800000)
    expect(tcsBasePaise(c, { baseIncludesGst: false })).toBe(10000000)
  })
  it('goods flagged with a section take only their share (and their share of GST)', () => {
    const c = classifyTcsVoucher(sale(SALES, [{ stockItemId: 10, amount: 4000000 }, { stockItemId: 11, amount: 6000000 }]), facts(), itemSection)!
    expect(c).toMatchObject({ sectionId: SCRAP, sectionFrom: 'goods', taxablePaise: 4000000, gstPaise: 720000, stockItemId: 10 })
  })
  it('a sales ledger default applies when neither buyer nor goods are flagged; nothing flagged → null', () => {
    expect(classifyTcsVoucher(sale(SCRAP_SALES), facts(), itemSection)).toMatchObject({ sectionId: SCRAP, sectionFrom: 'ledger' })
    expect(classifyTcsVoucher(sale(), facts(), itemSection)).toBeNull()
  })
  it('a TCS already on the voucher is not part of the invoice value', () => {
    const v = sale()
    v.lines[0]!.amount += 118000
    v.lines.push({ ledgerId: PAYABLE, drCr: 'cr', amount: 118000 })
    expect(classifyTcsVoucher(v, facts({ [BUYER]: { tcsSectionId: SCRAP } }), itemSection)).toMatchObject({ grossPaise: 11800000, gstPaise: 1800000 })
  })
  it('a receipt from a buyer is the payment event, base = amount received', () => {
    const r = classifyTcsVoucher({
      kind: 'receipt', partyLedgerId: BUYER,
      lines: [{ ledgerId: BANK, drCr: 'dr', amount: 500000 }, { ledgerId: BUYER, drCr: 'cr', amount: 500000 }]
    }, facts(), itemSection)!
    expect(r).toMatchObject({ eventKind: 'payment', sectionId: null, sectionFrom: 'credits', taxablePaise: 500000 })
    expect(classifyTcsVoucher({ ...sale(), kind: 'purchase' }, facts({ [BUYER]: { tcsSectionId: SCRAP } }), itemSection)).toBeNull()
  })
})

describe('no-PAN rate (s.206CC) and rounding', () => {
  const row = (rateBp: number): WithholdingRateRow => ({
    id: 1, sectionId: SCRAP, effectiveFrom: '2025-04-01', effectiveTo: null, deducteeType: 'any', rateBp, thresholdSinglePaise: 0,
    thresholdAnnualPaise: 0, thresholdBasis: 'fy', thresholdExcessOnly: false, returnCode: 'E', noPanRateBp: 500, source: null
  })
  const opts = { noPanMultiple: TCS_NO_PAN_MULTIPLE, noPanCapBp: 2000 }
  it('higher of twice the rate and 5%, never above 20%', () => {
    expect(applicableRate({ id: SCRAP, rates: [row(100)] }, '2025-06-01', null, false, null, opts)!.rateBp).toBe(500)
    expect(applicableRate({ id: SCRAP, rates: [row(500)] }, '2025-06-01', null, false, null, opts)!.rateBp).toBe(1000)
    expect(applicableRate({ id: SCRAP, rates: [row(1500)] }, '2025-06-01', null, false, null, opts)!.rateBp).toBe(2000)
    expect(applicableRate({ id: SCRAP, rates: [row(100)] }, '2025-06-01', null, true, null, opts)!.basis).toBe('section')
  })
  it('rounds the collection to the rupee', () => {
    expect(computeWithholdingPaise(11834567, { rateBp: 100, basis: 'section', certificateRateBp: null, certificateRemainingPaise: null })).toBe(118300)
  })
})

describe('validateTcsEntries', () => {
  const tags = new Map([[PAYABLE, SCRAP]])
  const entry = { sectionId: SCRAP, baseAmount: 11800000, tcsAmount: 118000, isManual: false }
  const voucher = (buyerDr: number, payableCr = 118000) => ({
    kind: 'sales' as const, partyLedgerId: BUYER,
    lines: [
      { ledgerId: BUYER, drCr: 'dr' as const, amount: buyerDr }, { ledgerId: SALES, drCr: 'cr' as const, amount: buyerDr - payableCr },
      { ledgerId: PAYABLE, drCr: 'cr' as const, amount: payableCr }
    ]
  })
  const f = () => ({ code: '206C(1) SCRAP', expectedPaise: 118000 })
  it('accepts a sale whose buyer is debited base + TCS and whose payable is credited by it', () => {
    expect(validateTcsEntries(voucher(11918000), [entry], tags, f)).toEqual([])
  })
  it('rejects a buyer debit that does not include the TCS, a mismatched payable, a wrong amount, a wrong kind', () => {
    expect(validateTcsEntries(voucher(11800000), [entry], tags, f).map((e) => e.code)).toEqual(['tcs_party_debit'])
    expect(validateTcsEntries(voucher(11918000, 100000), [entry], tags, f).map((e) => e.code)).toContain('tcs_payable_mismatch')
    expect(validateTcsEntries(voucher(11918000), [{ ...entry, tcsAmount: 100000 }], tags, f).map((e) => e.code)).toContain('tcs_amount_mismatch')
    expect(validateTcsEntries({ ...voucher(11918000), kind: 'purchase' }, [entry], tags, f).map((e) => e.code)).toEqual(['tcs_wrong_kind'])
    expect(validateTcsEntries({ ...voucher(11918000), partyLedgerId: null }, [entry], tags, f).map((e) => e.code)).toEqual(['tcs_no_party'])
  })
})

describe('Move to TCS line edits', () => {
  const lines = [
    { ledgerId: BUYER, drCr: 'dr' as const, amount: 11800000 }, { ledgerId: SALES, drCr: 'cr' as const, amount: 10000000 },
    { ledgerId: CGST, drCr: 'cr' as const, amount: 1800000 }
  ]
  const refs = [{ kind: 'new' as const, name: 'S-1', amount: 11800000, dueDate: null }]
  it('adds the TCS on top of the buyer debit (and its bill), and removes it again', () => {
    const add = addTcsToLines('sales', lines, refs, { partyLedgerId: BUYER, tcsPaise: 118000 })
    expect(add.ok && add.lines[0]!.amount).toBe(11918000)
    expect(add.ok && add.billRefs[0]!.amount).toBe(11918000)
    const withPayable = add.ok ? [...add.lines, { ledgerId: PAYABLE, drCr: 'cr' as const, amount: 118000 }] : []
    const rm = removeTcsFromLines('sales', withPayable, add.ok ? add.billRefs : [], { partyLedgerId: BUYER, isPayableLine: (l) => l.ledgerId === PAYABLE })
    expect(rm.ok && rm.lines).toEqual(lines)
    expect(rm.ok && rm.billRefs).toEqual(refs)
  })
  it('refuses a saved receipt and a purchase', () => {
    expect(addTcsToLines('receipt', lines, refs, { partyLedgerId: BUYER, tcsPaise: 1 }).ok).toBe(false)
    expect(addTcsToLines('purchase', lines, refs, { partyLedgerId: BUYER, tcsPaise: 1 }).ok).toBe(false)
  })
})

describe('deposit, interest, returns', () => {
  it('deposit due date: 7th of next month; March → 7 April (rule 37CA) up to FY 2025-26, 30 April under the 2026 Rules', () => {
    expect(tcsDepositDueDate('2025-07-31')).toBe('2025-08-07')
    expect(tcsDepositDueDate('2025-12-15')).toBe('2026-01-07')
    expect(tcsDepositDueDate('2026-03-10')).toBe('2026-04-07')
    expect(tcsDepositDueDate('2027-03-10')).toBe('2027-04-30')
  })
  it('late payment interest: 1.5% a month or part from collection, against the TCS due date', () => {
    expect(lateDepositInterest(100000, '2026-03-10', '2026-04-20', 150, tcsDepositDueDate)).toMatchObject({ dueDate: '2026-04-07', months: 2, interestPaise: 3000 })
    expect(lateDepositInterest(100000, '2026-03-10', '2026-04-07', 150, tcsDepositDueDate).interestPaise).toBe(0)
  })
  it('statement due dates: 27EQ the 15th (rule 31AA), Form 143 the 31st (rule 219(4)); certificate 15 days later', () => {
    expect(tcsStatementDueDate(2025, 1)).toEqual({ statement: '2025-07-15', certificate: '2025-07-30', form: 'form27eq' })
    expect(tcsStatementDueDate(2025, 4)).toEqual({ statement: '2026-05-15', certificate: '2026-05-30', form: 'form27eq' })
    expect(tcsStatementDueDate(2026, 3)).toEqual({ statement: '2027-01-31', certificate: '2027-02-15', form: 'form143' })
  })
  it('collectee codes from the PAN (Annexure 8), unpadded on Form 143; declaration reasons', () => {
    expect(collecteeCodeForReturn('AABCS1234D', null, 'form27eq')).toBe('01')
    expect(collecteeCodeForReturn('ABCPK1234L', null, 'form27eq')).toBe('02')
    expect(collecteeCodeForReturn('ABCHK1234L', null, 'form27eq')).toBe('03')
    expect(collecteeCodeForReturn('ABCFK1234L', null, 'form143')).toBe('7')
    expect(collecteeCodeForReturn(null, 'company', 'form27eq')).toBe('01')
    expect(collecteeCodeForReturn(null, null, 'form27eq')).toBe('')
    expect(isDeclarationReason('Form 27C declaration received')).toBe(true)
    expect(isDeclarationReason('Buyer is a government department')).toBe(false)
  })
})
