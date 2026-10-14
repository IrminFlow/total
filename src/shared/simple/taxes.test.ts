// WP 9.9: the Taxes screen's pure rules — due dates against the cited texts (rule 61(1) / 61(3) /
// 62(1) CGST Rules, Notification 83/2020-CT, rule 30(2) of the 1962 Income-tax Rules), the
// compliance calendar's corrections, the period picker, the ARN check and the sentences.
import { describe, expect, it } from 'vitest'
import { translator } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import { cmp08DueDate, gstr1DueDate, gstr3bDueDate, gstr4DueDate, pmt06DueDate, qrmp3bDay } from '../gst/filing'
import { upcomingDeadlines } from '../compliance'
import { creditParts, gstPeriodChoices, gstPeriodFor, nextCompositionDue, normalizeArn, normalizeGstFiled, stepsDone, type SimpleTaxes } from './taxes'
import { applySetOff } from '../gst/returns'
import { collectedWhy, creditStatus, onPurchasesWhy, taxesPeriodLabel, toPayWhy, withholdingUnpaidText } from './explain'
import { GST_STATES } from '../gst/states'

const t = translator('en')

describe('GST due dates (cited fixtures)', () => {
  it('rule 61(1)(i): monthly GSTR-3B on the 20th of the next month; Notification 83/2020: GSTR-1 on the 11th', () => {
    expect(gstr3bDueDate('2026-09', 'monthly', '27')).toEqual({ date: '2026-10-20', unverified: false })
    expect(gstr3bDueDate('2026-12', 'monthly', '07')).toEqual({ date: '2027-01-20', unverified: false })
    expect(gstr1DueDate('2026-09', 'monthly')).toBe('2026-10-11')
    // Proviso to Notification 83/2020: quarterly filers' GSTR-1 on the 13th after the quarter.
    expect(gstr1DueDate('2026-09', 'quarterly')).toBe('2026-10-13')
    expect(gstr1DueDate('2027-03', 'quarterly')).toBe('2027-04-13')
  })

  it('rule 61(1)(ii) Table: the 22nd for entry 1 states, the 24th for entry 2', () => {
    // Entry 1: Chhattisgarh, MP, Gujarat, Maharashtra, Karnataka, Goa, Kerala, Tamil Nadu,
    // Telangana, Andhra Pradesh, Daman and Diu / DNH, Puducherry, A&N, Lakshadweep.
    for (const code of ['22', '23', '24', '27', '29', '30', '32', '33', '36', '37', '25', '26', '34', '35', '31']) {
      expect(gstr3bDueDate('2026-09', 'quarterly', code), code).toEqual({ date: '2026-10-22', unverified: false })
    }
    // Entry 2: HP, Punjab, Uttarakhand, Haryana, Rajasthan, UP, Bihar, Sikkim, Arunachal,
    // Nagaland, Manipur, Mizoram, Tripura, Meghalaya, Assam, WB, Jharkhand, Odisha, J&K, Ladakh,
    // Chandigarh, Delhi.
    for (const code of ['02', '03', '05', '06', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '01', '38', '04', '07']) {
      expect(gstr3bDueDate('2026-12', 'quarterly', code), code).toEqual({ date: '2027-01-24', unverified: false })
    }
    // Every state code the app knows is in one entry, except the non-state codes.
    const unplaced = Object.keys(GST_STATES).filter((c) => qrmp3bDay(c) == null)
    expect(unplaced.sort()).toEqual(['96', '97'])
    expect(gstr3bDueDate('2026-09', 'quarterly', '97')).toEqual({ date: '2026-10-22', unverified: true })
    expect(gstr3bDueDate('2026-09', 'quarterly', null)).toEqual({ date: '2026-10-22', unverified: true })
  })

  it('rule 61(3): PMT-06 by the 25th for a quarter’s first two months; rule 62(1): CMP-08 the 18th, GSTR-4 30 April / 30 June from FY 2024-25', () => {
    expect(pmt06DueDate('2026-07')).toBe('2026-08-25')
    expect(pmt06DueDate('2026-08')).toBe('2026-09-25')
    expect(pmt06DueDate('2026-09')).toBeNull()
    expect(cmp08DueDate('2026-09')).toBe('2026-10-18')
    expect(cmp08DueDate('2027-03')).toBe('2027-04-18')
    expect(gstr4DueDate(2023)).toBe('2024-04-30')
    expect(gstr4DueDate(2024)).toBe('2025-06-30')
    expect(gstr4DueDate(2026)).toBe('2027-06-30')
  })

  it('the compliance calendar: a quarterly filer’s GSTR-3B by state; TDS for March deductions on 30 April (rule 30(2))', () => {
    const q = (state: string | undefined): string[] => upcomingDeadlines('2026-12-20', 'regular', false, 40, { gstFiling: 'quarterly', stateCode: state }).filter((d) => d.form === 'GSTR-3B').map((d) => d.date)
    expect(q('07')).toEqual(['2027-01-24'])
    expect(q('27')).toEqual(['2027-01-22'])
    expect(q(undefined)).toEqual(['2027-01-22'])
    const cited = upcomingDeadlines('2026-12-20', 'regular', false, 40, { gstFiling: 'quarterly', stateCode: '07' }).find((d) => d.form === 'GSTR-3B')!
    expect(cited.title).not.toMatch(/UNVERIFIED/)
    const tds = upcomingDeadlines('2027-04-01', 'regular', false, 30).filter((d) => d.kind === 'tds').map((d) => [d.date, d.title])
    expect(tds).toEqual([['2027-04-30', 'TDS deposit — challan for March 2027']])
    // Other months stay the 7th of the next month.
    expect(upcomingDeadlines('2027-04-20', 'regular', false, 20).filter((d) => d.kind === 'tds').map((d) => d.date)).toEqual(['2027-04-30', '2027-05-07'])
  })
})

describe('periods, the ARN, the filed marks', () => {
  it('a month, or the quarter a month belongs to; still running = so far to today', () => {
    expect(gstPeriodFor('2026-09', 'monthly', '2026-10-14')).toEqual({ period: '2026-09', from: '2026-09-01', to: '2026-09-30', quarterly: false, soFar: false })
    expect(gstPeriodFor('2026-10', 'monthly', '2026-10-14')).toEqual({ period: '2026-10', from: '2026-10-01', to: '2026-10-14', quarterly: false, soFar: true })
    expect(gstPeriodFor('2026-11', 'monthly', '2026-10-14')).toBeNull()
    expect(gstPeriodFor('2026-08', 'quarterly', '2026-10-14')).toEqual({ period: '2026-09', from: '2026-07-01', to: '2026-09-30', quarterly: true, soFar: false })
    expect(gstPeriodFor('2026-10', 'quarterly', '2026-10-14')).toEqual({ period: '2026-12', from: '2026-10-01', to: '2026-10-14', quarterly: true, soFar: true })
    expect(gstPeriodChoices('quarterly', '2026-10-14').map((p) => p.period)).toEqual(['2026-12', '2026-09', '2026-06', '2026-03', '2025-12'])
    expect(gstPeriodChoices('monthly', '2026-10-14')).toHaveLength(7)
  })

  it('ARN: letters and digits, spaces / dashes dropped, 10–20 long (format UNVERIFIED)', () => {
    expect(normalizeArn(' aa270926 123456x ')).toBe('AA270926123456X')
    expect(normalizeArn('AA-2709-26123456X')).toBe('AA270926123456X')
    expect(normalizeArn('12345')).toBeNull()
    expect(normalizeArn('AA27092612345€')).toBeNull()
  })

  it('stored marks: malformed → none', () => {
    expect(normalizeGstFiled(null)).toEqual({})
    expect(normalizeGstFiled({ '2026-09': { gstr1: { arn: 'X', date: 'bad', by: null, at: '' } } })).toEqual({})
    const ok = { '2026-09': { gstr3b: { arn: 'AA270926123456X', date: '2026-10-19', by: 'Asha', at: '2026-10-19T10:00:00.000Z' } } }
    expect(normalizeGstFiled(ok)).toEqual(ok)
  })

  it('composition: the next CMP-08 and GSTR-4 as on a day', () => {
    expect(nextCompositionDue('2026-10-14', cmp08DueDate, gstr4DueDate)).toEqual({
      cmp08: { from: '2026-07-01', to: '2026-09-30', due: '2026-10-18' },
      gstr4: { fyLabel: '2026-27', due: '2027-06-30' }
    })
    expect(nextCompositionDue('2026-10-20', cmp08DueDate, gstr4DueDate).cmp08).toEqual({ from: '2026-10-01', to: '2026-12-31', due: '2027-01-18' })
    expect(nextCompositionDue('2026-05-10', cmp08DueDate, gstr4DueDate).gstr4).toEqual({ fyLabel: '2025-26', due: '2026-06-30' })
  })
})

describe('the GST answer sentences', () => {
  const regular = (over: Partial<Extract<SimpleTaxes, { kind: 'regular' }>['figures']> = {}): Extract<SimpleTaxes, { kind: 'regular' }> => ({
    kind: 'regular', today: '2026-10-14', filing: 'monthly',
    period: { period: '2026-09', from: '2026-09-01', to: '2026-09-30', quarterly: false, soFar: false },
    periods: [], figures: { collected: 18_000_00, reverseCharge: 0, onPurchases: 10_800_00, awaiting: 0, checked: 'none', toPay: 7_200_00, cashOnSales: 7_200_00, rcmCash: 0, creditUsed: 10_800_00, creditLeft: 0, ...over },
    due: { gstr1: '2026-10-11', gstr3b: '2026-10-20', gstr3bUnverified: false, pmt06: [] },
    missing: [], supplierBills: [], prepared: { gstr1: null, gstr3b: null }, filesMonthly: false, filed: {}, withholding: []
  })

  it('three separate figures, the 2B status, who files', () => {
    const x = regular()
    expect(collectedWhy(x, t)).toBe('GST you charged on your sales from 1 Sep 2026 to 30 Sep 2026: ₹18,000.00. It is the government’s money that you hold until you pay it.')
    expect(onPurchasesWhy(x, t)).toBe('GST you paid on your purchases from 1 Sep 2026 to 30 Sep 2026: ₹10,800.00. It is taken off what you owe — not checked against GSTR-2B yet.')
    expect(toPayWhy(x, t)).toBe(
      'After the GST on purchases is used against what you collected, ₹7,200.00 is left to pay in cash by 20 Oct. These are the same figures the GSTR-3B return shows. Total prepares these figures; you file the return and pay on gst.gov.in.'
    )
    expect(creditStatus({ ...x.figures, checked: 'all', awaiting: 1_200_00 }, t)).toBe('of which ₹1,200.00 awaits confirmation in GSTR-2B')
    expect(creditStatus({ ...x.figures, checked: 'all', awaiting: 0 }, t)).toBe('all of it confirmed in GSTR-2B')
    expect(toPayWhy(regular({ toPay: 0 }), t)).toContain('nothing to pay in cash')
    expect(toPayWhy(regular({ reverseCharge: 500_00, toPay: 7_700_00 }), t)).toContain('It includes ₹500.00 under reverse charge, which is always paid in cash.')
    expect(collectedWhy(regular({ reverseCharge: 500_00 }), t)).toContain('reverse charge')
    expect(taxesPeriodLabel(x.period, t)).toBe('Sep 2026')
    expect(taxesPeriodLabel({ period: '2026-12', from: '2026-10-01', to: '2026-10-14', quarterly: true, soFar: true }, t)).toBe('Oct – Dec 2026 so far')
    for (const s of [collectedWhy(x, t), onPurchasesWhy(x, t), toPayWhy(x, t)]) expect(bannedWordsIn(s)).toEqual([])
  })

  it('steps done; TDS unpaid lines', () => {
    const x = regular()
    expect(stepsDone(x)).toEqual({ missing: true, supplier: false, files: false, filed: false })
    expect(withholdingUnpaidText({ month: '2026-09', amount: 1_000_00, dueDate: '2026-10-07', late: true }, '2026-10-14', t)).toBe('Sep 2026: ₹1,000.00 still to pay, due 7 Oct — late')
    expect(withholdingUnpaidText({ month: '2026-10', amount: 500_00, dueDate: '2026-11-07', late: false }, '2026-10-14', t)).toBe('Oct 2026: ₹500.00 still to pay, due 7 Nov')
    expect(withholdingUnpaidText({ month: null, amount: 500_00, dueDate: null, late: true }, '2026-10-14', t)).toBe('From before your books began: ₹500.00 still to pay.')
  })
})

describe('the credit used / left (WP 10.2 review)', () => {
  const sum = (s: { igst: number; cgst: number; sgst: number; cess: number }): number => s.igst + s.cgst + s.sgst + s.cess
  const parts = (liability: { igst: number; cgst: number; sgst: number; cess: number }, credit: typeof liability): ReturnType<typeof creditParts> & { cash: number } => {
    const cash = sum(applySetOff(liability, credit))
    return { ...creditParts(sum(liability), cash, sum(credit)), cash }
  }
  it('an ordinary month: used = collected − cash, left = credit − used', () => {
    // CGST 900 / SGST 900 collected, credit CGST 540 / SGST 540 → 360 + 360 cash.
    expect(parts({ igst: 0, cgst: 900_00, sgst: 900_00, cess: 0 }, { igst: 0, cgst: 540_00, sgst: 540_00, cess: 0 })).toEqual({ cash: 720_00, creditUsed: 1_080_00, creditLeft: 0 })
    // More credit than tax: CGST credit 1,000 pays CGST 500, SGST 500 stays cash (CGST can't pay SGST).
    expect(parts({ igst: 0, cgst: 500_00, sgst: 500_00, cess: 0 }, { igst: 0, cgst: 1_000_00, sgst: 0, cess: 0 })).toEqual({ cash: 500_00, creditUsed: 500_00, creditLeft: 500_00 })
  })
  it('a month of returns (negative sales tax) never reads as negative credit used or as credit the purchases did not give', () => {
    // CGST −100 on sales (returns), no purchases: the set-off pays nothing; nothing is "left over".
    expect(parts({ igst: 0, cgst: -100_00, sgst: 0, cess: 0 }, { igst: 0, cgst: 0, sgst: 0, cess: 0 })).toEqual({ cash: 0, creditUsed: 0, creditLeft: 0 })
    // With ₹1,000 of credit: all of it is left (the return is not credit from purchases).
    expect(parts({ igst: 0, cgst: -100_00, sgst: 0, cess: 0 }, { igst: 0, cgst: 1_000_00, sgst: 0, cess: 0 })).toEqual({ cash: 0, creditUsed: 0, creditLeft: 1_000_00 })
  })
})
