import { describe, expect, it } from 'vitest'
import { translator, en } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import {
  attentionText, cashWhy, deadlineText, gstLine, gstLinkLabel, gstPeriodLabel, gstWhy, moneyInWhy, moneyOutWhy, payablesWhy, profitSentence, profitWhy, receivablesWhy, shortDate
} from './explain'
import {
  attentionItems, daysSince, homeAttentionRows, isEmptyHome, owedAttention, owedSummary,
  type HomeCash, type HomeGst, type HomeOwed, type HomeProfit, type SimpleHomeData
} from './home'
import type { DashGst } from '../dashboard'

const t = translator('en')
const hi = translator('hi')
const TODAY = '2026-10-13'

const owed = (o: Partial<HomeOwed> = {}): HomeOwed => ({ total: 0, parties: 0, overdue: 0, overdueBills: 0, oldest: null, nextDue: null, advances: 0, advanceParties: 0, ...o })
const day = (amount: number, entries: number, loans = 0): { amount: number; entries: number; loans: number } => ({ amount, entries, loans })
type Regular = Extract<HomeGst, { kind: 'regular' }>
const gst = (row: Partial<DashGst> = {}, credit: Regular['credit'] = { checked: 'none', awaiting: 0 }): Regular => ({
  kind: 'regular',
  filing: row.quarterly ? 'quarterly' : 'monthly',
  credit,
  row: { period: '2026-09', from: '2026-09-01', to: '2026-09-30', gstr1Due: null, gstr3bDue: '2026-10-20', liability: 180000, outwardTax: 180000, rcmTax: 0, itc: 60000, payable: 120000, annual: [], ...row }
})

describe('explain sentences (WP 8.6)', () => {
  it('money in / out: counts with plurals, a loan noted, a plain sentence when nothing moved', () => {
    expect(moneyInWhy(day(420000, 3), t)).toBe('₹4,200.00 came into your cash and bank today, in 3 entries.')
    expect(moneyInWhy(day(50000, 1), t)).toBe('₹500.00 came into your cash and bank today, in 1 entry.')
    expect(moneyInWhy(day(0, 0), t)).toBe('No money has come into your cash or bank today yet.')
    expect(moneyInWhy(day(2500000, 2, 2000000), t)).toBe(
      '₹25,000.00 came into your cash and bank today, in 2 entries. That includes ₹20,000.00 borrowed on a loan — money you have to pay back, not income.'
    )
    expect(moneyOutWhy(day(120000, 2), t)).toBe('₹1,200.00 went out of your cash and bank today, in 2 entries.')
    expect(moneyOutWhy(day(120000, 1, 100000), t)).toContain('That includes ₹1,000.00 paid towards a loan, which is not an expense.')
    expect(moneyOutWhy(day(0, 0), t)).toBe('No money has gone out of your cash or bank today yet.')
  })

  it('customers owe you: amount, customer count, the oldest bill; overdue part; advances held', () => {
    const o = owed({ total: 420000, parties: 3, oldest: { ledgerId: 1, name: 'Ramesh', days: 12 } })
    expect(receivablesWhy(o, t)).toBe('₹4,200.00 is what 3 customers still owe you; the oldest bill is for Ramesh, 12 days old.')
    expect(receivablesWhy({ ...o, parties: 1, oldest: { ledgerId: 1, name: 'Ramesh', days: 1 } }, t)).toBe('₹4,200.00 is what 1 customer still owes you; the oldest bill is for Ramesh, 1 day old.')
    expect(receivablesWhy({ ...o, oldest: { ledgerId: 1, name: 'Ramesh', days: 0 } }, t)).toContain('for Ramesh, from today.')
    expect(receivablesWhy({ ...o, overdue: 100000, overdueBills: 1 }, t)).toBe(
      '₹4,200.00 is what 3 customers still owe you; ₹1,000.00 of it is past its due date, and the oldest bill is for Ramesh, 12 days old.'
    )
    expect(receivablesWhy({ ...o, advances: 50000, advanceParties: 1 }, t)).toBe(
      '₹4,200.00 is what 3 customers still owe you; the oldest bill is for Ramesh, 12 days old. You also hold ₹500.00 that 1 customer paid you in advance.'
    )
    expect(receivablesWhy(owed(), t)).toBe('Nobody owes you money right now.')
    expect(receivablesWhy(owed({ advances: 90000, advanceParties: 2 }), t)).toBe('Nobody owes you money right now. You also hold ₹900.00 that 2 customers paid you in advance.')
  })

  it('you owe suppliers: next due date, overdue first, no due date, nothing owed, advances paid', () => {
    const o = owed({ total: 900000, parties: 2, nextDue: { ledgerId: 5, name: 'Sharma Traders', date: '2026-10-20', amount: 500000 } })
    expect(payablesWhy(o, TODAY, t)).toBe('You owe ₹9,000.00 to 2 suppliers; the next payment, to Sharma Traders, is due 20 Oct.')
    expect(payablesWhy({ ...o, nextDue: { ...o.nextDue!, date: '2027-01-05' } }, TODAY, t)).toContain('is due 5 Jan 2027.')
    expect(payablesWhy({ ...o, overdue: 400000 }, TODAY, t)).toBe('You owe ₹9,000.00 to 2 suppliers; ₹4,000.00 of it is already past its due date.')
    expect(payablesWhy({ ...o, parties: 1, nextDue: null }, TODAY, t)).toBe('You owe ₹9,000.00 to 1 supplier; none of it has a due date.')
    expect(payablesWhy(owed(), TODAY, t)).toBe('You don’t owe any supplier right now.')
    expect(payablesWhy(owed({ advances: 30000, advanceParties: 1 }), TODAY, t)).toBe('You don’t owe any supplier right now. You have also paid ₹300.00 in advance to 1 supplier.')
  })

  it('cash and bank: split, cash-only, and cash below zero', () => {
    const cash: HomeCash = {
      accounts: [
        { ledgerId: 1, name: 'Cash', kind: 'cash', balance: 100000 },
        { ledgerId: 2, name: 'HDFC Bank', kind: 'bank', balance: 250000 }
      ],
      cash: 100000, bank: 250000, total: 350000
    }
    expect(cashWhy(cash, t)).toBe('₹3,500.00 is what you have today: ₹1,000.00 in cash and ₹2,500.00 in 1 bank account.')
    expect(cashWhy({ accounts: [cash.accounts[0]!], cash: 100000, bank: 0, total: 100000 }, t)).toBe('₹1,000.00 is the cash in hand today; no bank account is added yet.')
    expect(cashWhy({ ...cash, cash: -5000, total: 245000 }, t)).toBe('Cash in hand shows ₹50.00 below zero — more cash went out than came in, so an entry may be missing.')
  })

  it('profit: one signed sentence for the month and the year; zero reads as no profit or loss', () => {
    const p = (month: number, year: number, closingStock = 0): HomeProfit => ({
      month: { month: '2026-10', from: '2026-10-01', to: TODAY, netProfit: month, openingStock: 0, closingStock },
      year: { from: '2026-04-01', to: TODAY, netProfit: year, openingStock: 0, closingStock }
    })
    expect(profitSentence(p(150000, 8882000), t)).toBe('This month you made a profit of ₹1,500.00; since 1 Apr 2026 you made a profit of ₹88,820.00.')
    expect(profitSentence(p(-20000, 100), t)).toBe('This month you made a loss of ₹200.00; since 1 Apr 2026 you made a profit of ₹1.00.')
    expect(profitSentence(p(0, -500000), t)).toBe('This month you have no profit or loss yet; since 1 Apr 2026 you made a loss of ₹5,000.00.')
    expect(profitSentence(p(0, 0), t)).toBe('No profit or loss yet since 1 Apr 2026.')
    expect(profitWhy(p(0, 0, 15400000), t)).toBe(
      'Profit is what you sold minus what the goods cost you and your expenses; the ₹1,54,000.00 of goods still on your shelf is counted as yours, not as a cost.'
    )
    expect(profitWhy(p(0, 0), t)).toBe('Profit is what you sold minus what the goods cost you and your expenses, from 1 Apr 2026 to today.')
  })

  it('GST line: amount by the due date, nothing to pay, a running quarter "so far"', () => {
    expect(gstLine(gst(), TODAY, t)).toBe('₹1,200.00 by 20 Oct')
    expect(gstLine(gst({ payable: 0 }), TODAY, t)).toBe('Nothing to pay by 20 Oct')
    expect(gstLine(gst({ gstr3bDue: null }), TODAY, t)).toBe('₹1,200.00 for Sep 2026')
    const running = gst({ quarterly: true, soFar: true, from: '2026-10-01', to: TODAY, period: '2026-10', gstr3bDue: null, payable: 90000 })
    expect(gstLine(running, TODAY, t)).toBe('So far this quarter: ₹900.00')
    expect(gstPeriodLabel(running, t)).toBe('Oct 2026 so far')
    expect(gstPeriodLabel(gst({ quarterly: true, from: '2026-07-01', to: '2026-09-30', gstr3bDue: '2026-10-22' }), t)).toBe('Jul – Sep 2026')
    expect(gstPeriodLabel(gst({ quarterly: true, soFar: true, from: '2026-10-01', to: '2026-11-13', period: '2026-11' }), t)).toBe('Oct – Nov 2026 so far')
  })

  it('GST "Why?": sales without reverse charge, purchases vs GSTR-2B, cash by the date, then reverse charge and who files', () => {
    expect(gstWhy(gst(), TODAY, t)).toBe(
      'For Sep 2026: GST collected on your sales ₹1,800.00; GST you paid on purchases ₹600.00 (booked, not yet checked against GSTR-2B — the GST portal’s list of your suppliers’ bills); ₹1,200.00 to pay in cash by 20 Oct. Total prepares these figures; you file the return and pay on gst.gov.in.'
    )
    // Reverse charge: never inside "GST on your sales", a separate sentence when there is some.
    const rcm = gst({ liability: 230000, outwardTax: 180000, rcmTax: 50000 }, { checked: 'all', awaiting: 15000 })
    expect(gstWhy(rcm, TODAY, t)).toBe(
      'For Sep 2026: GST collected on your sales ₹1,800.00; GST you paid on purchases ₹600.00 (₹150.00 of it booked but not yet confirmed in GSTR-2B); ₹1,200.00 to pay in cash by 20 Oct. You also owe ₹500.00 of GST under reverse charge — tax on some purchases that you pay instead of the supplier. Total prepares these figures; you file the return and pay on gst.gov.in.'
    )
    expect(gstWhy(rcm, TODAY, t)).not.toContain('₹2,300.00')
    expect(gstWhy(gst({}, { checked: 'all', awaiting: 0 }), TODAY, t)).toContain('(all of it confirmed in GSTR-2B)')
    expect(gstWhy(gst({}, { checked: 'some', awaiting: 0 }), TODAY, t)).toContain('(checked against GSTR-2B for some months only)')
    expect(gstWhy(gst({ payable: 0 }), TODAY, t)).toContain('; nothing to pay in cash.')
    const running = gst({ quarterly: true, soFar: true, from: '2026-10-01', to: TODAY, period: '2026-10', gstr3bDue: null })
    expect(gstWhy(running, TODAY, t)).toContain('For Oct 2026 so far: ')
    expect(gstWhy(running, TODAY, t)).toContain('₹1,200.00 to pay in cash so far.')
  })

  it('GST link says what opens', () => {
    expect(gstLinkLabel(gst(), t)).toBe('See what to pay and file for Sep 2026')
    expect(gstLinkLabel(gst({ quarterly: true, from: '2026-07-01', to: '2026-09-30' }), t)).toBe('See what to pay and file for the quarter from Jul 2026')
  })

  it('needs attention: plain words per kind, plurals, overdue rows by side, a fallback for an unknown key', () => {
    expect(attentionText({ source: 'owed', key: 'receivable', count: 3, amount: 2293750, level: 'medium' }, '2026-09', t)).toBe('3 customer bills (₹22,937.50) past the due date')
    expect(attentionText({ source: 'owed', key: 'payable', count: 1, amount: 100, level: 'medium' }, '2026-09', t)).toBe('1 supplier bill (₹1.00) past the due date')
    expect(attentionText({ source: 'anomaly', key: 'duplicate_bill_number', count: 2, amount: null, level: 'high' }, '2026-09', t)).toBe('2 bill numbers are entered twice')
    expect(attentionText({ source: 'close', key: 'lock', count: 1, amount: null, level: 'medium' }, '2026-09', t)).toBe('A month-end check needs a look')
    expect(attentionText({ source: 'close', key: 'gst_returns', count: 1, amount: null, level: 'medium' }, '2026-09', t)).toBe('The GST files for Sep 2026 are not prepared yet')
    expect(attentionText({ source: 'close', key: 'pdc_due', count: 2, amount: 5, level: 'medium' }, '2026-09', t)).toBe('2 cheques dated by the end of Sep 2026 are still waiting to be cleared')
    expect(attentionText({ source: 'close', key: 'depreciation', count: 1, amount: null, level: 'high' }, '2026-09', t)).toBe('Wear and tear of things you own (depreciation) is not entered for Sep 2026')
    expect(attentionText({ source: 'close', key: 'suspense', count: 1, amount: 5, level: 'high' }, '2026-09', t)).toBe('Money parked in Suspense needs a home — move it to the right account')
    expect(attentionText({ source: 'close', key: 'drafts', count: 2, amount: null, level: 'medium' }, '2026-09', t)).toBe('2 entries are waiting for your review')
  })

  it('deadlines: plain words per kind with a short date', () => {
    expect(deadlineText({ kind: 'tds', form: 'TDS', date: '2026-11-07' }, TODAY, t)).toBe('Pay the TDS (tax deducted at source) you deducted — by 7 Nov')
    expect(deadlineText({ kind: 'gst', form: 'GSTR-9', date: '2026-12-31' }, TODAY, t)).toBe('GSTR-9 — by 31 Dec')
    expect(shortDate('2027-03-15', TODAY)).toBe('15 Mar 2027')
  })

  it('Hindi falls back to English per key and keeps the figures', () => {
    expect(moneyInWhy(day(420000, 3), hi)).toContain('₹4,200.00')
  })

  it('every explain / attention / home sentence is free of the banned words and the plan’s jargon', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('simple.explain.') || k.startsWith('simple.attention.') || k.startsWith('simple.home.'))
    expect(keys.length).toBeGreaterThan(40)
    for (const k of keys) {
      const v = en[k as keyof typeof en]
      expect(bannedWordsIn(v), k).toEqual([])
      expect(v, k).not.toMatch(/QRMP|holding account|\bdraft/i)
      if (/CMP-08/.test(v)) expect(v, k).toContain('the composition return (CMP-08)')
      if (/depreciation/.test(v)) expect(v, k).toContain('Wear and tear of things you own (depreciation)')
    }
  })
})

describe('home rules (WP 8.6)', () => {
  it('owedSummary: total = sum of party pending; overdue, the oldest bill, the next due date, advances', () => {
    const s = owedSummary(
      [
        { ledgerId: 1, name: 'A', pending: 300, bills: [{ pending: 200, ageDays: 40, dueDate: '2026-09-30', overdueDays: 13 }, { pending: 100, ageDays: 2, dueDate: '2026-11-10', overdueDays: 0 }] },
        { ledgerId: 2, name: 'B', pending: 50, bills: [{ pending: 50, ageDays: 5, dueDate: '2026-10-20', overdueDays: 0 }] },
        { ledgerId: 3, name: 'C', pending: 0, bills: [] }
      ],
      TODAY,
      { amount: 70, parties: 1 }
    )
    expect(s).toEqual({
      total: 350, parties: 2, overdue: 200, overdueBills: 1,
      oldest: { ledgerId: 1, name: 'A', days: 40 },
      nextDue: { ledgerId: 2, name: 'B', date: '2026-10-20', amount: 50 },
      advances: 70, advanceParties: 1
    })
    expect(owedSummary([], TODAY)).toEqual(owed())
  })

  it('attentionItems: failing checks and high findings first; overdue bills, housekeeping rows, ok / done checks, low and dismissed findings left out', () => {
    const items = attentionItems(
      [
        { key: 'overdue_bills', effective: 'warn', count: 3, amount: 900 },
        { key: 'negative_stock', effective: 'fail', count: 1, amount: null },
        { key: 'unallocated', effective: 'warn', count: 2, amount: 50 },
        { key: 'lock', effective: 'warn', count: 0, amount: null },
        { key: 'narration', effective: 'warn', count: 9, amount: null },
        { key: 'bank_reconciliation', effective: 'warn', count: 5, amount: null },
        { key: 'drafts', effective: 'done', count: 2, amount: null },
        { key: 'suspense', effective: 'ok', count: 0, amount: null }
      ],
      [
        { kind: 'duplicate_bill_number', severity: 'high', amount: 10 },
        { kind: 'duplicate_bill_number', severity: 'high', amount: 20 },
        { kind: 'round_amount', severity: 'low', amount: 30 },
        { kind: 'amount_outlier', severity: 'medium', amount: 40 },
        { kind: 'amount_outlier', severity: 'medium', amount: 50, dismissed: { note: null } }
      ]
    )
    expect(items.map((i) => `${i.source}:${i.key}:${i.count}`)).toEqual([
      'close:negative_stock:1', 'anomaly:duplicate_bill_number:2', 'close:unallocated:2', 'anomaly:amount_outlier:1'
    ])
    expect(attentionItems([], [])).toEqual([])
  })

  it('overdue rows come from the tiles, one per side, placed after the high findings', () => {
    const rows = owedAttention(owed({ overdue: 500, overdueBills: 2 }), owed({ overdue: 0, overdueBills: 0 }))
    expect(rows).toEqual([{ source: 'owed', key: 'receivable', count: 2, amount: 500, level: 'medium' }])
    expect(owedAttention(owed(), owed({ overdue: 9, overdueBills: 1 })).map((r) => r.key)).toEqual(['payable'])
    const merged = homeAttentionRows(rows, [
      { source: 'close', key: 'negative_stock', count: 1, amount: null, level: 'high' },
      { source: 'close', key: 'unallocated', count: 1, amount: null, level: 'medium' }
    ])
    expect(merged.map((r) => r.key)).toEqual(['negative_stock', 'receivable', 'unallocated'])
  })

  it('isEmptyHome: no entries and no balances', () => {
    const base = {
      setup: { voucherCount: 0 }, cash: { accounts: [{ balance: 0 }] }, receivables: owed(), payables: owed()
    } as unknown as SimpleHomeData
    expect(isEmptyHome(base)).toBe(true)
    expect(isEmptyHome({ ...base, setup: { ...base.setup, voucherCount: 1 } })).toBe(false)
    expect(isEmptyHome({ ...base, cash: { ...base.cash, accounts: [{ ledgerId: 1, name: 'Cash', kind: 'cash', balance: 100 }] } })).toBe(false)
    expect(isEmptyHome({ ...base, receivables: owed({ total: 5 }) })).toBe(false)
  })

  it('daysSince counts whole local days, never negative', () => {
    const at = new Date(2026, 9, 1, 18, 30).getTime()
    expect(daysSince(at, '2026-10-13')).toBe(12)
    expect(daysSince(at, '2026-10-01')).toBe(0)
    expect(daysSince(at, '2026-09-30')).toBe(0)
  })
})
