import { describe, expect, it } from 'vitest'
import { translator, en } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import {
  attentionText, cashWhy, deadlineText, gstLine, gstWhy, moneyInWhy, moneyOutWhy, payablesWhy, profitSentence, profitWhy, receivablesWhy, shortDate
} from './explain'
import { attentionItems, daysSince, owedSummary, type HomeCash, type HomeGst, type HomeOwed, type HomeProfit } from './home'

const t = translator('en')
const hi = translator('hi')
const TODAY = '2026-10-13'

const owed = (o: Partial<HomeOwed> = {}): HomeOwed => ({ total: 0, parties: 0, overdue: 0, overdueBills: 0, oldest: null, nextDue: null, ...o })

describe('explain sentences (WP 8.6)', () => {
  it('money in / out: counts with plurals, and a plain sentence when nothing moved', () => {
    expect(moneyInWhy({ amount: 420000, entries: 3 }, t)).toBe('₹4,200.00 came into your cash and bank today, in 3 entries.')
    expect(moneyInWhy({ amount: 50000, entries: 1 }, t)).toBe('₹500.00 came into your cash and bank today, in 1 entry.')
    expect(moneyInWhy({ amount: 0, entries: 0 }, t)).toBe('No money has come into your cash or bank today yet.')
    expect(moneyOutWhy({ amount: 120000, entries: 2 }, t)).toBe('₹1,200.00 went out of your cash and bank today, in 2 entries.')
    expect(moneyOutWhy({ amount: 0, entries: 0 }, t)).toBe('No money has gone out of your cash or bank today yet.')
  })

  it('customers owe you: amount, customer count, the oldest bill; overdue part when there is one', () => {
    const o = owed({ total: 420000, parties: 3, oldest: { ledgerId: 1, name: 'Ramesh', days: 12 } })
    expect(receivablesWhy(o, t)).toBe('₹4,200.00 is what 3 customers still owe you; the oldest bill is for Ramesh, 12 days old.')
    expect(receivablesWhy({ ...o, parties: 1, oldest: { ledgerId: 1, name: 'Ramesh', days: 1 } }, t)).toBe('₹4,200.00 is what 1 customer still owes you; the oldest bill is for Ramesh, 1 day old.')
    expect(receivablesWhy({ ...o, oldest: { ledgerId: 1, name: 'Ramesh', days: 0 } }, t)).toContain('for Ramesh, from today.')
    expect(receivablesWhy({ ...o, overdue: 100000, overdueBills: 1 }, t)).toBe(
      '₹4,200.00 is what 3 customers still owe you; ₹1,000.00 of it is past its due date, and the oldest bill is for Ramesh, 12 days old.'
    )
    expect(receivablesWhy(owed(), t)).toBe('Nobody owes you money right now.')
  })

  it('you owe suppliers: next due date, overdue first, no due date, nothing owed', () => {
    const o = owed({ total: 900000, parties: 2, nextDue: { ledgerId: 5, name: 'Sharma Traders', date: '2026-10-20', amount: 500000 } })
    expect(payablesWhy(o, TODAY, t)).toBe('You owe ₹9,000.00 to 2 suppliers; the next payment, to Sharma Traders, is due 20 Oct.')
    expect(payablesWhy({ ...o, nextDue: { ...o.nextDue!, date: '2027-01-05' } }, TODAY, t)).toContain('is due 5 Jan 2027.')
    expect(payablesWhy({ ...o, overdue: 400000 }, TODAY, t)).toBe('You owe ₹9,000.00 to 2 suppliers; ₹4,000.00 of it is already past its due date.')
    expect(payablesWhy({ ...o, parties: 1, nextDue: null }, TODAY, t)).toBe('You owe ₹9,000.00 to 1 supplier; none of it has a due date.')
    expect(payablesWhy(owed(), TODAY, t)).toBe('You don’t owe any supplier right now.')
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

  it('GST: amount by the due date, nothing to pay, no date in reach', () => {
    const g = (payable: number, gstr3bDue: string | null): Extract<HomeGst, { kind: 'regular' }> => ({
      kind: 'regular', filing: 'monthly', row: { period: '2026-09', gstr1Due: null, gstr3bDue, liability: 180000, itc: 60000, payable, annual: [] }
    })
    expect(gstLine(g(120000, '2026-10-20'), TODAY, t)).toBe('₹1,200.00 by 20 Oct')
    expect(gstLine(g(0, '2026-10-20'), TODAY, t)).toBe('Nothing to pay by 20 Oct')
    expect(gstLine(g(120000, null), TODAY, t)).toBe('₹1,200.00 for Sep 2026')
    expect(gstWhy(g(120000, '2026-10-20'), t)).toBe('For Sep 2026, GST on your sales is ₹1,800.00 and GST you paid on purchases is ₹600.00; ₹1,200.00 is left to pay in cash.')
    expect(gstWhy(g(0, '2026-10-20'), t)).toBe('For Sep 2026, GST on your sales is ₹1,800.00 and GST you paid on purchases is ₹600.00, so there is nothing to pay in cash.')
  })

  it('needs attention: plain words per kind, plurals, a fallback for an unknown key', () => {
    expect(attentionText({ source: 'close', key: 'overdue_bills', count: 1, amount: 100, level: 'medium' }, '2026-09', t)).toBe(
      '1 bill is past the due date — remind the customer or record the payment'
    )
    expect(attentionText({ source: 'close', key: 'overdue_bills', count: 4, amount: 100, level: 'medium' }, '2026-09', t)).toMatch(/^4 bills are past/)
    expect(attentionText({ source: 'anomaly', key: 'duplicate_bill_number', count: 2, amount: null, level: 'high' }, '2026-09', t)).toBe('2 bill numbers are entered twice')
    expect(attentionText({ source: 'close', key: 'lock', count: 1, amount: null, level: 'medium' }, '2026-09', t)).toBe('A month-end check needs a look')
    expect(attentionText({ source: 'close', key: 'gst_returns', count: 1, amount: null, level: 'medium' }, '2026-09', t)).toBe('The GST files for Sep 2026 are not prepared yet')
    expect(attentionText({ source: 'close', key: 'pdc_due', count: 2, amount: 5, level: 'medium' }, '2026-09', t)).toBe('2 cheques dated by the end of Sep 2026 are still waiting to be cleared')
  })

  it('deadlines: plain words per kind with a short date', () => {
    expect(deadlineText({ kind: 'tds', form: 'TDS', date: '2026-11-07' }, TODAY, t)).toBe('Pay the TDS (tax deducted at source) you deducted — by 7 Nov')
    expect(deadlineText({ kind: 'gst', form: 'GSTR-9', date: '2026-12-31' }, TODAY, t)).toBe('GSTR-9 — by 31 Dec')
    expect(shortDate('2027-03-15', TODAY)).toBe('15 Mar 2027')
  })

  it('Hindi falls back to English per key and keeps the figures', () => {
    expect(moneyInWhy({ amount: 420000, entries: 3 }, hi)).toContain('₹4,200.00')
  })

  it('every explain / attention / home sentence is free of the banned words', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('simple.explain.') || k.startsWith('simple.attention.') || k.startsWith('simple.home.'))
    expect(keys.length).toBeGreaterThan(40)
    for (const k of keys) expect(bannedWordsIn(en[k as keyof typeof en]), k).toEqual([])
  })
})

describe('home rules (WP 8.6)', () => {
  it('owedSummary: total = sum of party pending; overdue, the oldest bill and the next due date', () => {
    const s = owedSummary(
      [
        { ledgerId: 1, name: 'A', pending: 300, bills: [{ pending: 200, ageDays: 40, dueDate: '2026-09-30', overdueDays: 13 }, { pending: 100, ageDays: 2, dueDate: '2026-11-10', overdueDays: 0 }] },
        { ledgerId: 2, name: 'B', pending: 50, bills: [{ pending: 50, ageDays: 5, dueDate: '2026-10-20', overdueDays: 0 }] },
        { ledgerId: 3, name: 'C', pending: 0, bills: [] }
      ],
      TODAY
    )
    expect(s).toEqual({
      total: 350, parties: 2, overdue: 200, overdueBills: 1,
      oldest: { ledgerId: 1, name: 'A', days: 40 },
      nextDue: { ledgerId: 2, name: 'B', date: '2026-10-20', amount: 50 }
    })
    expect(owedSummary([], TODAY)).toEqual({ total: 0, parties: 0, overdue: 0, overdueBills: 0, oldest: null, nextDue: null })
  })

  it('attentionItems: failing checks and high findings first; housekeeping rows, ok / done checks, low and dismissed findings left out', () => {
    const items = attentionItems(
      [
        { key: 'overdue_bills', effective: 'warn', count: 3, amount: 900 },
        { key: 'negative_stock', effective: 'fail', count: 1, amount: null },
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
      'close:negative_stock:1', 'anomaly:duplicate_bill_number:2', 'close:overdue_bills:3', 'anomaly:amount_outlier:1'
    ])
    expect(attentionItems([], [])).toEqual([])
  })

  it('daysSince counts whole local days, never negative', () => {
    const at = new Date(2026, 9, 1, 18, 30).getTime()
    expect(daysSince(at, '2026-10-13')).toBe(12)
    expect(daysSince(at, '2026-10-01')).toBe(0)
    expect(daysSince(at, '2026-09-30')).toBe(0)
  })
})
