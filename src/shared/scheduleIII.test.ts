import { describe, expect, it } from 'vitest'
import { scheduleIIIBalanceSheet, scheduleIIIProfitAndLoss } from './scheduleIII'
import type { BalanceSheet, ProfitAndLoss, StatementNode } from './reports'

const group = (name: string, children: StatementNode[]): StatementNode => ({
  id: 0,
  kind: 'group',
  name,
  amount: children.reduce((s, c) => s + c.amount, 0),
  children
})
const ledger = (name: string, amount: number): StatementNode => ({ id: 1, kind: 'ledger', name, amount, children: [] })

const bs = (over: Partial<BalanceSheet> = {}): BalanceSheet => ({
  asOn: '2027-03-31',
  liabilities: [
    group('Capital Account', [ledger('Owner’s Capital', 5_00_000_00), group('Reserves & Surplus', [ledger('General Reserve', 1_00_000_00)])]),
    group('Current Liabilities', [group('Sundry Creditors', [ledger('Ram & Co', 2_00_000_00)]), group('Duties & Taxes', [ledger('CGST Payable', 50_000_00)])])
  ],
  assets: [
    group('Fixed Assets', [ledger('Plant', 4_00_000_00)]),
    group('Current Assets', [
      group('Bank Accounts', [ledger('HDFC', 1_50_000_00)]),
      group('Cash-in-Hand', [ledger('Cash', 50_000_00)]),
      group('Sundry Debtors', [ledger('Acme', 2_50_000_00)])
    ])
  ],
  profitCurrentPeriod: 0,
  totalAssets: 8_50_000_00,
  totalLiabilities: 8_50_000_00,
  ...over
})

const extras = { msmeTradePayables: null as number | null, profitForPeriod: 0 }

describe('scheduleIIIBalanceSheet', () => {
  it('maps the seeded group tree onto the prescribed face', () => {
    const s = scheduleIIIBalanceSheet(bs(), extras)
    const by = (key: string) => s.equityAndLiabilities.concat(s.assets).find((l) => l.key === key)!
    expect(by('shareCapital').amount).toBe(5_00_000_00)
    expect(by('reserves').amount).toBe(1_00_000_00)
    expect(by('tradePayables').amount).toBe(2_00_000_00)
    expect(by('otherCurrentLiabilities').amount).toBe(50_000_00)
    expect(by('ppe').amount).toBe(4_00_000_00)
    expect(by('tradeReceivables').amount).toBe(2_50_000_00)
  })

  it('puts bank and cash together under cash and cash equivalents, not under "other"', () => {
    // Both sit inside Current Assets, which has a mapping of its own. Taking the whole subtree at
    // the first match would file every bank balance under other current assets.
    const s = scheduleIIIBalanceSheet(bs(), extras)
    expect(s.assets.find((l) => l.key === 'cash')!.amount).toBe(2_00_000_00)
    expect(s.assets.find((l) => l.key === 'otherCurrentAssets')!.amount).toBe(0)
  })

  it('ties to the balance sheet it was built from', () => {
    const s = scheduleIIIBalanceSheet(bs(), extras)
    expect(s.totalAssets).toBe(8_50_000_00)
    expect(s.totalEquityAndLiabilities).toBe(8_50_000_00)
    expect(s.balanced).toBe(true)
  })

  it('inherits a mapping into a user’s own sub-group', () => {
    const withSub = bs({
      liabilities: [group('Current Liabilities', [group('Sundry Creditors', [group('Local Creditors', [ledger('Ram', 1_00_000_00)])])])]
    })
    const s = scheduleIIIBalanceSheet(withSub, extras)
    expect(s.equityAndLiabilities.find((l) => l.key === 'tradePayables')!.amount).toBe(1_00_000_00)
  })

  it('shows a balance no Schedule III line claims rather than dropping it', () => {
    // A face that does not tie is the one failure this report must never have.
    const odd = bs({ liabilities: [...bs().liabilities, { id: -4, kind: 'computed', name: 'Difference in Opening Balances', amount: 1_00_00, children: [] }] })
    const s = scheduleIIIBalanceSheet(odd, extras)
    expect(s.unmapped).toHaveLength(1)
    expect(s.unmapped[0]!.amount).toBe(1_00_00)
    expect(s.totalEquityAndLiabilities).toBe(8_50_000_00 + 1_00_00)
  })

  it('moves the period’s profit into reserves instead of counting it twice', () => {
    const withProfit = bs({
      liabilities: [...bs().liabilities, { id: -3, kind: 'computed', name: 'Profit & Loss A/c', amount: 1_00_000_00, children: [] }],
      profitCurrentPeriod: 1_00_000_00
    })
    const s = scheduleIIIBalanceSheet(withProfit, { msmeTradePayables: null, profitForPeriod: 1_00_000_00 })
    expect(s.equityAndLiabilities.find((l) => l.key === 'reserves')!.amount).toBe(2_00_000_00)
    expect(s.unmapped).toHaveLength(0)
    expect(s.totalEquityAndLiabilities).toBe(9_50_000_00)
  })

  it('splits trade payables when the suppliers have been classified', () => {
    const s = scheduleIIIBalanceSheet(bs(), { msmeTradePayables: 75_000_00, profitForPeriod: 0 })
    expect(s.equityAndLiabilities.find((l) => l.key === 'tradePayablesMsme')!.amount).toBe(75_000_00)
    expect(s.equityAndLiabilities.find((l) => l.key === 'tradePayablesOthers')!.amount).toBe(1_25_000_00)
  })

  it('says the split is missing rather than printing an unclassified zero', () => {
    // "We have not classified our suppliers" and "we owe nothing to a micro enterprise" are
    // different statements and must not print as the same one.
    const s = scheduleIIIBalanceSheet(bs(), extras)
    expect(s.equityAndLiabilities.find((l) => l.key === 'tradePayablesMsme')).toBeUndefined()
    expect(s.caveats.join(' ')).toContain('24 March 2021')
  })

  it('produces an empty but balanced face for a company with no transactions', () => {
    const s = scheduleIIIBalanceSheet(bs({ liabilities: [], assets: [], totalAssets: 0, totalLiabilities: 0 }), extras)
    expect(s.totalAssets).toBe(0)
    expect(s.balanced).toBe(true)
  })
})

const pnl = (over: Partial<ProfitAndLoss> = {}): ProfitAndLoss => ({
  period: { from: '2026-04-01', to: '2027-03-31' },
  openingStock: 1_00_000_00,
  closingStock: 1_50_000_00,
  tradingIncomes: [group('Sales Accounts', [ledger('Sales', 20_00_000_00)])],
  tradingExpenses: [group('Purchase Accounts', [ledger('Purchases', 12_00_000_00)])],
  indirectIncomes: [group('Indirect Incomes', [ledger('Interest Received', 20_000_00)])],
  indirectExpenses: [
    group('Indirect Expenses', [
      ledger('Salaries', 3_00_000_00),
      ledger('Bank Interest', 50_000_00),
      ledger('Depreciation', 1_00_000_00),
      ledger('Printing & Stationery', 20_000_00)
    ])
  ],
  grossProfit: 0,
  netProfit: 0,
  ...over
})

describe('scheduleIIIProfitAndLoss', () => {
  it('presents stock as a change rather than as opening and closing lines', () => {
    // That is the whole difference between the trading-account face and the Schedule III one.
    const s = scheduleIIIProfitAndLoss(pnl())
    expect(s.lines.find((l) => l.key === 'changeInInventories')!.amount).toBe(-50_000_00)
  })

  it('names employee benefits, finance costs and depreciation separately', () => {
    const s = scheduleIIIProfitAndLoss(pnl())
    expect(s.lines.find((l) => l.key === 'employeeBenefits')!.amount).toBe(3_00_000_00)
    expect(s.lines.find((l) => l.key === 'financeCosts')!.amount).toBe(50_000_00)
    expect(s.lines.find((l) => l.key === 'depreciation')!.amount).toBe(1_00_000_00)
    expect(s.lines.find((l) => l.key === 'otherExpenses')!.amount).toBe(20_000_00)
  })

  it('lists the ledgers behind each classified head, so a misfile is visible', () => {
    const s = scheduleIIIProfitAndLoss(pnl())
    expect(s.lines.find((l) => l.key === 'financeCosts')!.sources).toEqual(['Bank Interest'])
    expect(s.lines.find((l) => l.key === 'financeCosts')!.note).toContain('ledger name')
  })

  it('reconciles: total income less total expenses is the profit before tax', () => {
    const s = scheduleIIIProfitAndLoss(pnl())
    expect(s.profitBeforeTax).toBe(s.totalIncome - s.totalExpenses)
    expect(s.profitBeforeTax).toBe(20_20_000_00 - (12_00_000_00 - 50_000_00 + 4_70_000_00))
  })

  it('produces a statement for a year with nothing in it', () => {
    const s = scheduleIIIProfitAndLoss(
      pnl({ tradingIncomes: [], tradingExpenses: [], indirectIncomes: [], indirectExpenses: [], openingStock: 0, closingStock: 0 })
    )
    expect(s.totalIncome).toBe(0)
    expect(s.profitBeforeTax).toBe(0)
  })
})
