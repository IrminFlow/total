// Answer accuracy: every expected figure is computed from the services at seed time (facts) and
// must appear in the answer, sourced from a tool result the model saw (numbers.ts).
import type { EvalCase } from '../types'
import { FY, TODAY, nodeOf, qa, rowOf } from './util'

const month = (ym: string): { from: string; to: string } => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return { from: `${ym}-01`, to: `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` }
}

export const ACCURACY_CASES: EvalCase[] = [
  qa({
    id: 'acc.net-profit-fy', category: 'accuracy', title: 'Net profit for the year',
    question: 'What was our net profit for FY 2025-26?',
    tool: 'profit_and_loss', args: () => ({ ...FY }),
    answer: (r) => `The profit and loss for ${r.period?.from} to ${r.period?.to} shows a net result of ${r.netProfit} (a negative figure is a loss).`,
    figures: (f) => [f.facts.netProfitFy]
  }),
  qa({
    id: 'acc.gross-profit-fy', category: 'accuracy', title: 'Gross profit for the year',
    question: 'What is the gross profit this financial year?',
    tool: 'profit_and_loss', args: () => ({ ...FY }),
    answer: (r) => `Gross profit for FY 2025-26 is ${r.grossProfit}.`,
    figures: (f) => [f.facts.grossProfitFy]
  }),
  qa({
    id: 'acc.sales-july', category: 'accuracy', title: 'Sales in one month',
    question: 'What were sales in July 2025?',
    tool: 'profit_and_loss', args: () => month('2025-07'),
    answer: (r, c) => `Sales in July 2025 were ${nodeOf(r.tradingIncomes, c.f.ids.sales)?.amount} (Sales A/c, profit and loss).`,
    figures: (f) => [f.facts.salesByMonth['2025-07']!]
  }),
  qa({
    id: 'acc.sales-june', category: 'accuracy', title: 'Sales in June (inter-state month)',
    question: 'How much did we sell in June 2025?',
    tool: 'profit_and_loss', args: () => month('2025-06'),
    answer: (r, c) => `Sales for June 2025: ${nodeOf(r.tradingIncomes, c.f.ids.sales)?.amount}.`,
    figures: (f) => [f.facts.salesByMonth['2025-06']!]
  }),
  qa({
    id: 'acc.closing-stock', category: 'accuracy', title: 'Closing stock value',
    question: 'What is the value of closing stock for this year?',
    tool: 'profit_and_loss', args: () => ({ ...FY }),
    answer: (r) => `Closing stock is valued at ${r.closingStock} in the profit and loss for FY 2025-26.`,
    figures: (f) => [f.facts.closingStockFy]
  }),
  qa({
    id: 'acc.cash-balance', category: 'accuracy', title: 'Cash balance',
    question: 'What is our cash balance today?',
    tool: 'ledger_statement', args: (f) => ({ ledgerId: f.ids.cash, from: FY.from, to: TODAY }),
    answer: (r) => `Cash closes at ${r.closing} on ${r.to} (opening ${r.opening}).`,
    figures: (f) => [f.facts.closing.cash]
  }),
  qa({
    id: 'acc.bank-balance', category: 'accuracy', title: 'Bank balance',
    question: 'How much is in HDFC Bank as of today?',
    tool: 'ledger_statement', args: (f) => ({ ledgerId: f.ids.hdfc, from: FY.from, to: TODAY }),
    answer: (r) => `HDFC Bank's book balance is ${r.closing} as on ${r.to}.`,
    figures: (f) => [f.facts.closing.hdfc]
  }),
  qa({
    id: 'acc.umbrella-owes', category: 'accuracy', title: 'What one customer owes',
    question: 'How much does Umbrella Retail owe us?',
    tool: 'outstandings', args: () => ({ side: 'receivable', asOn: TODAY }),
    answer: (r, c) => `Umbrella Retail owes ${rowOf<{ pending: string }>(r.rows, 'ledgerId', c.f.ids.umbrella)?.pending} as on ${r.asOn}.`,
    figures: (f) => [f.facts.receivablePending.umbrella!]
  }),
  qa({
    id: 'acc.krishna-bill', category: 'accuracy', title: 'Pending on one bill (partly received)',
    question: "What is still pending on Krishna Enterprises' invoice EV/S/0003?",
    tool: 'outstandings', args: () => ({ side: 'receivable', asOn: TODAY }),
    answer: (r, c) => {
      const p = rowOf<{ bills: { bill: string; amount: string; pending: string }[] }>(r.rows, 'ledgerId', c.f.ids.krishna)
      const b = p?.bills.find((x) => x.bill === 'EV/S/0003')
      return `Invoice EV/S/0003 (${b?.amount}) has ${b?.pending} pending.`
    },
    figures: (f) => [f.facts.billPending['EV/S/0003']!]
  }),
  qa({
    id: 'acc.sharma-steel-payable', category: 'accuracy', title: 'What we owe one supplier',
    question: 'How much do we owe Sharma Steel?',
    tool: 'outstandings', args: () => ({ side: 'payable', asOn: TODAY }),
    answer: (r, c) => `We owe Sharma Steel ${rowOf<{ pending: string }>(r.rows, 'ledgerId', c.f.ids.sharmaSteel)?.pending}.`,
    figures: (f) => [f.facts.payablePending.sharmaSteel!]
  }),
  qa({
    id: 'acc.tb-total', category: 'accuracy', title: 'Trial balance totals',
    question: 'What are the trial balance totals as on 31 March 2026?',
    tool: 'trial_balance', args: () => ({ asOn: TODAY }),
    answer: (r) => `The trial balance as on ${r.asOn} totals ${r.totalDebit} on both sides (debit ${r.totalDebit}, credit ${r.totalCredit}).`,
    figures: (f) => [f.facts.tbTotalDebit]
  }),
  qa({
    id: 'acc.gst-july-cgst', category: 'accuracy', title: 'Output CGST for a month',
    question: 'How much CGST did we charge on sales in July 2025?',
    tool: 'gst_summary', args: () => ({ period: '2025-07' }),
    answer: (r) => `GSTR-3B for July 2025: outward taxable value ${r.outwardTaxable.taxable}, CGST ${r.outwardTaxable.cgst}, SGST ${r.outwardTaxable.sgst}.`,
    figures: (f) => [f.facts.gst.jul.cgst, f.facts.gst.jul.taxable]
  }),
  qa({
    id: 'acc.gst-nov-igst', category: 'accuracy', title: 'Output IGST for a month',
    question: 'What IGST is on our November 2025 sales?',
    tool: 'gst_summary', args: () => ({ period: '2025-11' }),
    answer: (r) => `November 2025 outward supplies: taxable ${r.outwardTaxable.taxable}, IGST ${r.outwardTaxable.igst}.`,
    figures: (f) => [f.facts.gst.nov.igst]
  }),
  qa({
    id: 'acc.tds-194c', category: 'accuracy', title: 'TDS deducted under one section',
    question: 'How much TDS did we deduct under section 194C this year?',
    tool: 'tds_summary', args: () => ({ fy: 2025 }),
    answer: (r) => {
      const row = (r.rows as { section: string; quarter: string; tds: string }[] | undefined)?.find((x) => x.section === '194C')
      return `Under 194C, ${row?.tds} was deducted in ${row?.quarter}.`
    },
    figures: (f) => [f.facts.tds194cFy]
  }),
  qa({
    id: 'acc.stock-laptop', category: 'accuracy', title: 'Closing value of one item',
    question: 'What is the closing stock value of Laptop 14"?',
    tool: 'stock_summary', args: () => ({ asOn: TODAY }),
    answer: (r, c) => {
      const row = rowOf<{ closingQty: string; closingValue: string }>(r.rows, 'itemId', c.f.items.laptop)
      return `Laptop 14": ${row?.closingQty} in stock, valued at ${row?.closingValue}.`
    },
    figures: (f) => [f.facts.stockValue.laptop]
  }),
  qa({
    id: 'acc.rent-fy', category: 'accuracy', title: 'An expense over the year',
    question: 'How much rent did we pay this year?',
    tool: 'ledger_statement', args: (f) => ({ ledgerId: f.ids.rent, ...FY }),
    answer: (r) => `Shop Rent was debited ${r.totalDebit} over ${r.vouchers} entries this year.`,
    figures: (f) => [f.facts.rentFyDebit]
  }),
  qa({
    id: 'acc.devanagari-party', category: 'accuracy', title: 'A non-Latin party name',
    question: 'How much does शर्मा ट्रेडर्स owe us?',
    tool: 'outstandings', args: () => ({ side: 'receivable', asOn: TODAY }),
    answer: (r, c) => {
      const row = rowOf<{ party: string; pending: string }>(r.rows, 'ledgerId', c.f.ids.sharmaTraders)
      return `${row?.party} owes ${row?.pending}.`
    },
    figures: (f) => [f.facts.receivablePending.sharmaTraders!],
    includes: () => ['शर्मा ट्रेडर्स']
  })
]
