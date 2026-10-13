// Tool choice: the expected tool with the expected arguments (a subset), and no tool the
// question did not need (a first lookup — list_ledgers / search_books — is allowed).
import type { EvalCase } from '../types'
import { FY, LOOKUPS, TODAY, call, qa, say, step } from './util'

const list = (rows: unknown, f: (r: Record<string, unknown>) => string, n = 5): string =>
  ((rows as Record<string, unknown>[] | undefined) ?? []).slice(0, n).map((r) => `- ${f(r)}`).join('\n')

export const TOOL_CHOICE_CASES: EvalCase[] = [
  qa({
    id: 'tool.receivables', category: 'tool_choice', title: 'Who owes us → receivable outstandings',
    question: 'Which customers owe us money?',
    tool: 'outstandings', args: () => ({ side: 'receivable', asOn: TODAY }),
    scoreTool: { args: () => ({ side: 'receivable' }) },
    answer: (r) => `Customers with open bills (as on ${r.asOn}):\n${list(r.rows, (x) => `${x.party}: ${x.pending}`)}`
  }),
  qa({
    id: 'tool.payables', category: 'tool_choice', title: 'What we owe → payable outstandings',
    question: 'What do we owe our suppliers?',
    tool: 'outstandings', args: () => ({ side: 'payable', asOn: TODAY }),
    scoreTool: { args: () => ({ side: 'payable' }) },
    answer: (r) => `Open supplier bills:\n${list(r.rows, (x) => `${x.party}: ${x.pending}`)}`
  }),
  qa({
    id: 'tool.daybook-date', category: 'tool_choice', title: 'Vouchers on a day → day book for that day',
    question: 'Show me all vouchers on 5 June 2025.',
    tool: 'day_book', args: () => ({ from: '2025-06-05', to: '2025-06-05' }),
    scoreTool: {},
    answer: (r) => `${r.vouchers} vouchers on 05-06-2025:\n${list(r.rows, (x) => `${x.type} ${x.number} — ${x.account}: ${x.amount}`)}`
  }),
  qa({
    id: 'tool.stock-now', category: 'tool_choice', title: 'What is in stock → stock summary as on today',
    question: 'What do we have in stock right now?',
    tool: 'stock_summary', args: () => ({ asOn: TODAY }),
    scoreTool: {},
    answer: (r) => `Stock as on ${r.asOn}:\n${list(r.rows, (x) => `${x.item}: ${x.closingQty} worth ${x.closingValue}`, 8)}`
  }),
  qa({
    id: 'tool.gst-month', category: 'tool_choice', title: 'GST for a month → gst_summary of that month',
    question: 'What is our GST position for August 2025?',
    tool: 'gst_summary', args: () => ({ period: '2025-08' }),
    scoreTool: {},
    answer: (r) => `GSTR-3B for ${r.period}: outward taxable ${r.outwardTaxable.taxable}; eligible ITC IGST ${r.eligibleItc.igst}, CGST ${r.eligibleItc.cgst}, SGST ${r.eligibleItc.sgst}.`
  }),
  qa({
    id: 'tool.pending-challans', category: 'tool_choice', title: 'Uninvoiced challans → trade_pending challans',
    question: 'Which delivery challans have not been invoiced yet?',
    tool: 'trade_pending', args: () => ({ stage: 'challans' }),
    scoreTool: {},
    answer: (r) => `${r.lines} challan line(s) not invoiced, worth ${r.totalPendingValue}:\n${list(r.rows, (x) => `${x.number} ${x.party}: ${x.pending} ${x.item}`)}`
  }),
  qa({
    id: 'tool.manufacture', category: 'tool_choice', title: 'What we made → manufacture register',
    question: 'What did we manufacture this year?',
    tool: 'manufacture_register', args: () => ({ ...FY }),
    scoreTool: { args: () => ({}) },
    answer: (r) => `${r.vouchers} manufacture voucher(s), production cost ${r.totalProductionCost}:\n${list(r.rows, (x) => `${x.date}: ${x.qty} ${x.item}`)}`
  }),
  qa({
    id: 'tool.balance-sheet', category: 'tool_choice', title: 'Balance sheet → balance_sheet as on the date',
    question: 'Show me the balance sheet as on 31 March 2026.',
    tool: 'balance_sheet', args: () => ({ asOn: TODAY }),
    scoreTool: {},
    answer: (r) => `Balance sheet as on ${r.asOn}: total assets ${r.totalAssets}, total liabilities ${r.totalLiabilities}.`
  }),
  qa({
    id: 'tool.search-invoices', category: 'tool_choice', title: 'Find invoices → search_books',
    question: 'Find the sales invoices we raised to Umbrella Retail.',
    tool: 'search_books', args: () => ({ query: 'type:sales party:"Umbrella Retail"' }),
    scoreTool: { args: () => ({}), allowExtra: ['list_ledgers'] },
    answer: (r) => `Found ${r.vouchers?.total ?? 0} sales invoice(s):\n${list(r.vouchers?.rows, (x) => `${x.type} ${x.number} on ${x.date}: ${x.amount}`)}`
  }),
  qa({
    id: 'tool.item-movements', category: 'tool_choice', title: 'Movements of an item → item_movements with its id',
    question: 'Show the movements of Steel Rod this year.',
    tool: 'item_movements', args: (f) => ({ itemId: f.items.rod, ...FY }),
    scoreTool: { args: (f) => ({ itemId: f.items.rod }), allowExtra: [...LOOKUPS, 'stock_summary'] },
    answer: (r) => `${r.item}: opening ${r.opening.qty}, inward ${r.inward.qty}, outward ${r.outward.qty}, closing ${r.closing.qty} worth ${r.closing.value}.`
  }),
  {
    kind: 'chat',
    id: 'tool.ledger-by-name',
    category: 'tool_choice',
    title: 'A ledger by name → find its id, then its statement',
    turns: [
      {
        question: 'Show me the Shop Rent ledger for this year.',
        route: [
          step(call('list_ledgers', { search: 'Shop Rent' })),
          step(call('ledger_statement', (c) => ({ ledgerId: (c.last('list_ledgers')?.ledgers?.[0]?.id as number) ?? 0, ...FY }))),
          say((c) => {
            const r = c.last('ledger_statement') ?? {}
            return `${r.ledger}: ${r.vouchers} entries, total debit ${r.totalDebit}, closing ${r.closing}.`
          })
        ]
      }
    ],
    expect: {
      tools: { calls: (f) => [{ name: 'list_ledgers' }, { name: 'ledger_statement', args: { ledgerId: f.ids.rent } }], ordered: true, allowExtra: ['search_books'] },
      figures: (f) => [f.facts.rentFyDebit]
    }
  }
]
