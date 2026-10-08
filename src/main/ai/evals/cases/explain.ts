// "Explain this" and screen questions: explain_figure is called with the figure's own source (ids
// and period from the screen context), current_screen_data for "this screen", and the answer's
// figures equal the services' figures.
import type { EvalCase } from '../types'
import { FY, TODAY, qa } from './util'

export const EXPLAIN_CASES: EvalCase[] = [
  qa({
    id: 'exp.expense-ledger', category: 'explain', title: 'Explain an expense ledger (P&L amount)',
    question: 'Explain this figure',
    context: (f) => ({ screen: 'profit-loss', label: 'Profit & loss', ...FY, explain: { label: 'Shop Rent', value: '₹1,00,000.00', ledgerId: f.ids.rent, ...FY } }),
    tool: 'explain_figure', args: (f) => ({ ledgerId: f.ids.rent, ...FY }),
    scoreTool: { args: (f) => ({ ledgerId: f.ids.rent }) },
    answer: (r) => `${r.ledger} comes to ${r.periodAmount} for the year over ${r.vouchers} vouchers; previous period ${r.previousPeriod?.periodAmount}.`,
    figures: (f) => [f.facts.rentFyDebit]
  }),
  qa({
    id: 'exp.group', category: 'explain', title: 'Explain a group line (Sales Accounts)',
    question: 'Explain this figure',
    context: () => ({ screen: 'profit-loss', label: 'Profit & loss', ...FY, explain: { label: 'Sales Accounts', value: '', groupName: 'Sales Accounts', ...FY } }),
    tool: 'explain_figure', args: () => ({ groupName: 'Sales Accounts', ...FY }),
    scoreTool: { args: () => ({ groupName: 'Sales Accounts' }) },
    answer: (r) => `${r.group} is ${r.amount} on the ${r.basis}, made up of ${(r.madeUpOf as { name: string; amount: string }[] | undefined)?.map((k) => `${k.name} ${k.amount}`).join(', ')}.`,
    figures: (f) => [Math.abs(f.facts.closing.sales)]
  }),
  qa({
    id: 'exp.voucher', category: 'explain', title: 'Explain a voucher total',
    question: 'Explain this figure',
    context: (f) => ({ screen: 'daybook', label: 'Day book', ...FY, explain: { label: 'Sales EV/S/0003', value: '₹1,84,080.00', voucherId: f.vouchers.s2!.id } }),
    tool: 'explain_figure', args: (f) => ({ voucherId: f.vouchers.s2!.id }),
    scoreTool: {},
    answer: (r) => `${r.type} ${r.number} dated ${r.date} totals ${r.total}: ${(r.lines as { ledger: string; side: string; amount: string }[]).map((l) => `${l.ledger} ${l.side} ${l.amount}`).join(', ')}.`,
    figures: (f) => [f.vouchers.s2!.total]
  }),
  qa({
    id: 'exp.item', category: 'explain', title: 'Explain a stock item value',
    question: 'Explain this figure',
    context: (f) => ({ screen: 'stock-summary', label: 'Stock summary', ...FY, explain: { label: 'Laptop 14"', value: '', itemId: f.items.laptop, from: FY.from, to: TODAY } }),
    tool: 'explain_figure', args: (f) => ({ itemId: f.items.laptop, from: FY.from, to: TODAY }),
    scoreTool: { args: (f) => ({ itemId: f.items.laptop }) },
    answer: (r) => `${r.item}: opening ${r.opening?.value}, inward ${r.inward?.value}, outward ${r.outward?.value}, closing ${r.closing?.value} (${r.closing?.qty}).`,
    figures: (f) => [f.facts.stockValue.laptop]
  }),
  qa({
    id: 'exp.cash', category: 'explain', title: 'Explain a balance (cash)',
    question: 'Explain this figure',
    context: (f) => ({ screen: 'trial-balance', label: 'Trial balance', ...FY, explain: { label: 'Cash', value: '', ledgerId: f.ids.cash, asOn: TODAY } }),
    tool: 'explain_figure', args: (f) => ({ ledgerId: f.ids.cash, asOn: TODAY }),
    scoreTool: { args: (f) => ({ ledgerId: f.ids.cash }) },
    answer: (r) => `${r.ledger} closed at ${r.closing} (opening ${r.opening}, debits ${r.totalDebit}, credits ${r.totalCredit}).`,
    figures: (f) => [f.facts.closing.cash]
  }),
  qa({
    id: 'exp.screen-tb', category: 'explain', title: '"What is on this screen" — trial balance',
    question: 'What is on this screen?',
    context: () => ({ screen: 'trial-balance', label: 'Trial balance', ...FY }),
    tool: 'current_screen_data', args: () => ({}),
    scoreTool: {},
    answer: (r) => `The trial balance as on ${r.asOn} totals ${r.totalDebit} debit and ${r.totalCredit} credit.`,
    figures: (f) => [f.facts.tbTotalDebit]
  }),
  qa({
    id: 'exp.screen-pnl', category: 'explain', title: '"Why is this a loss?" — the P&L on screen',
    question: 'Why is this report showing a loss?',
    context: () => ({ screen: 'profit-loss', label: 'Profit & loss', ...FY }),
    tool: 'current_screen_data', args: () => ({}),
    scoreTool: { allowExtra: ['profit_and_loss', 'explain_figure'] },
    answer: (r) => `Gross profit is ${r.grossProfit}, but indirect expenses bring the net result to ${r.netProfit}.`,
    figures: (f) => [f.facts.netProfitFy, f.facts.grossProfitFy]
  })
]
