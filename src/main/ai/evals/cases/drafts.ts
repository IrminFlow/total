// Draft validity: the right draft tool makes ONE draft of the right kind, with the right party /
// ledgers / amount / date / bills (the tool already rehearsed the real save — a draft exists only
// when it would save), nothing is posted, and the draft is not flagged unrequested. A request into
// a locked period is refused with the reason and makes no draft.
import type { RouteCtx } from '../types'
import type { EvalCase } from '../types'
import { TODAY, call, say, step } from './util'

/** The answer to a draft result: quote its summary (amounts come from the tool). */
const quoteDraft = (tool: string) => (c: RouteCtx): string => {
  const r = c.last(tool)
  const err = c.results.find((x) => x.name === tool && !x.ok)?.error
  if (err) return `I could not prepare it: ${err}`
  return `Draft ready for review: ${r?.summary}. Nothing is in the books until you open it in the editor and save.`
}

const gst = (taxable: number, rate: number): number => taxable + Math.round((taxable * rate) / 100)

export const DRAFT_CASES: EvalCase[] = [
  {
    kind: 'chat', id: 'draft.pay-bill-full', category: 'draft', title: 'Payment settling one bill in full',
    turns: [{
      question: 'Pay Sharma Steel against bill SS/1001 from HDFC Bank.',
      route: [step(call('draft_voucher', { kind: 'payment', party: 'Sharma Steel', account: 'HDFC Bank', bills: [{ bill: 'SS/1001' }] })), say(quoteDraft('draft_voucher'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_voucher', args: { kind: 'payment' } }], allowExtra: ['list_ledgers', 'search_books', 'outstandings'] },
      drafts: (f) => [{
        voucherKind: 'payment', partyLedgerId: f.ids.sharmaSteel, date: TODAY, total: f.facts.billPending['SS/1001']!,
        bills: [{ name: 'SS/1001', amount: f.facts.billPending['SS/1001']! }],
        lines: [{ ledgerId: f.ids.hdfc, drCr: 'cr', amount: f.facts.billPending['SS/1001']! }]
      }]
    }
  },
  {
    kind: 'chat', id: 'draft.receipt-partial', category: 'draft', title: 'Part receipt against one bill',
    turns: [{
      question: 'Record a receipt of ₹50,000 from Krishna Enterprises into HDFC Bank against invoice EV/S/0003.',
      route: [step(call('draft_voucher', { kind: 'receipt', party: 'Krishna Enterprises', account: 'HDFC Bank', amount: '₹50,000', bills: [{ bill: 'EV/S/0003', amount: '50,000' }] })), say(quoteDraft('draft_voucher'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_voucher', args: { kind: 'receipt' } }], allowExtra: ['list_ledgers', 'search_books', 'outstandings'] },
      drafts: (f) => [{ voucherKind: 'receipt', partyLedgerId: f.ids.krishna, total: 5_000_000, bills: [{ name: 'EV/S/0003', amount: 5_000_000 }], lines: [{ ledgerId: f.ids.hdfc, drCr: 'dr', amount: 5_000_000 }] }]
    }
  },
  {
    kind: 'chat', id: 'draft.sales-invoice', category: 'draft', title: 'Sales invoice, intra-state GST',
    turns: [{
      question: 'Record a sales invoice to Umbrella Retail for 2 Laptop 14" at 58,000.',
      route: [step(call('draft_invoice', { kind: 'sales', party: 'Umbrella Retail', items: [{ item: 'Laptop 14"', qty: '2', rate: '58,000' }] })), say(quoteDraft('draft_invoice'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_invoice', args: { kind: 'sales' } }], allowExtra: ['list_ledgers', 'search_books', 'stock_summary'] },
      drafts: (f) => [{
        voucherKind: 'sales', form: 'invoice', partyLedgerId: f.ids.umbrella, total: gst(11_600_000, 18),
        lines: [{ ledgerId: f.ids.cgst, drCr: 'cr', amount: 1_044_000 }, { ledgerId: f.ids.sgst, drCr: 'cr', amount: 1_044_000 }, { ledgerId: f.ids.sales, drCr: 'cr', amount: 11_600_000 }]
      }]
    }
  },
  {
    kind: 'chat', id: 'draft.sales-igst', category: 'draft', title: 'Sales invoice to another state (IGST)',
    turns: [{
      question: 'Create a sales invoice to Krishna Enterprises for 2 Office Chair at 3,500.',
      route: [step(call('draft_invoice', { kind: 'sales', party: 'Krishna Enterprises', items: [{ item: 'Office Chair', qty: '2', rate: '3,500' }] })), say(quoteDraft('draft_invoice'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_invoice', args: { kind: 'sales' } }], allowExtra: ['list_ledgers', 'search_books', 'stock_summary'] },
      drafts: (f) => [{ voucherKind: 'sales', partyLedgerId: f.ids.krishna, total: gst(700_000, 18), lines: [{ ledgerId: f.ids.igst, drCr: 'cr', amount: 126_000 }] }]
    }
  },
  {
    kind: 'chat', id: 'draft.purchase', category: 'draft', title: "Purchase bill with the supplier's number",
    turns: [{
      question: 'Enter purchase bill SSL/90 from Sharma Steels for 50 Wireless Mouse at 480.',
      route: [step(call('draft_invoice', { kind: 'purchase', party: 'Sharma Steels', billNo: 'SSL/90', items: [{ item: 'Wireless Mouse', qty: '50', rate: '480' }] })), say(quoteDraft('draft_invoice'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_invoice', args: { kind: 'purchase' } }], allowExtra: ['list_ledgers', 'search_books'] },
      drafts: (f) => [{ voucherKind: 'purchase', partyLedgerId: f.ids.sharmaSteels, total: gst(2_400_000, 18), lines: [{ ledgerId: f.ids.purchase, drCr: 'dr', amount: 2_400_000 }] }]
    }
  },
  {
    kind: 'chat', id: 'draft.journal', category: 'draft', title: 'Journal with named ledgers',
    turns: [{
      question: 'Record a journal debiting Freight Inward and crediting Sharma Steel for 1,200.',
      route: [step(call('draft_voucher', { kind: 'journal', lines: [{ ledger: 'Freight Inward', drCr: 'dr', amount: '1,200' }, { ledger: 'Sharma Steel', drCr: 'cr', amount: '1,200' }] })), say(quoteDraft('draft_voucher'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_voucher', args: { kind: 'journal' } }], allowExtra: ['list_ledgers', 'search_books'] },
      drafts: (f) => [{ voucherKind: 'journal', lines: [{ ledgerId: f.ids.freight, drCr: 'dr', amount: 120_000 }, { ledgerId: f.ids.sharmaSteel, drCr: 'cr', amount: 120_000 }] }]
    }
  },
  {
    kind: 'chat', id: 'draft.contra', category: 'draft', title: 'Cash deposited into the bank (contra)',
    turns: [{
      question: 'Deposit 10,000 cash into HDFC Bank.',
      route: [step(call('draft_voucher', { kind: 'contra', lines: [{ ledger: 'HDFC Bank', drCr: 'dr', amount: '10,000' }, { ledger: 'Cash', drCr: 'cr', amount: '10,000' }] })), say(quoteDraft('draft_voucher'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_voucher', args: { kind: 'contra' } }], allowExtra: ['list_ledgers'] },
      drafts: (f) => [{ voucherKind: 'contra', lines: [{ ledgerId: f.ids.hdfc, drCr: 'dr', amount: 1_000_000 }, { ledgerId: f.ids.cash, drCr: 'cr', amount: 1_000_000 }] }]
    }
  },
  {
    kind: 'chat', id: 'draft.credit-note', category: 'draft', title: 'Credit note against an invoice',
    turns: [{
      question: 'Record a credit note to Umbrella Retail against invoice EV/S/0006 for 1 Laptop 14" returned.',
      route: [step(call('draft_invoice', { kind: 'credit_note', party: 'Umbrella Retail', againstInvoice: 'EV/S/0006', items: [{ item: 'Laptop 14"', qty: '1' }] })), say(quoteDraft('draft_invoice'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_invoice', args: { kind: 'credit_note', againstInvoice: 'EV/S/0006' } }], allowExtra: ['list_ledgers', 'search_books', 'outstandings'] },
      drafts: (f) => [{ voucherKind: 'credit_note', partyLedgerId: f.ids.umbrella, total: gst(6_000_000, 18), bills: [{ name: 'EV/S/0006' }] }]
    }
  },
  {
    kind: 'chat', id: 'draft.challan', category: 'draft', title: 'Delivery challan to a non-Latin-named party',
    turns: [{
      question: 'Create a delivery challan to शर्मा ट्रेडर्स for 3 Wireless Mouse.',
      route: [step(call('draft_stock_note', { kind: 'delivery_note', party: 'शर्मा ट्रेडर्स', items: [{ item: 'Wireless Mouse', qty: '3' }] })), say(quoteDraft('draft_stock_note'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_stock_note', args: { kind: 'delivery_note' } }], allowExtra: ['list_ledgers', 'search_books'] },
      drafts: (f) => [{ voucherKind: 'delivery_note', partyLedgerId: f.ids.sharmaTraders }]
    }
  },
  {
    kind: 'chat', id: 'draft.manufacture', category: 'draft', title: 'Manufacture from the bill of materials',
    turns: [{
      question: 'Manufacture 2 Office Chair.',
      route: [step(call('draft_manufacture', { item: 'Office Chair', qty: '2' })), say(quoteDraft('draft_manufacture'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_manufacture' }], allowExtra: ['search_books', 'stock_summary'] },
      drafts: () => [{ voucherKind: 'stock_journal', form: 'manufacture' }]
    }
  },
  {
    kind: 'chat', id: 'draft.quotation', category: 'draft', title: 'Quotation (trade document)',
    turns: [{
      question: 'Prepare a quotation for Krishna Enterprises for 5 Laptop 14" at 56,000.',
      route: [step(call('draft_trade_doc', { kind: 'quotation', party: 'Krishna Enterprises', items: [{ item: 'Laptop 14"', qty: '5', rate: '56,000' }] })), say(quoteDraft('draft_trade_doc'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_trade_doc', args: { kind: 'quotation' } }], allowExtra: ['list_ledgers', 'search_books'] },
      drafts: (f) => [{ voucherKind: 'quotation', form: 'tradeDoc', partyLedgerId: f.ids.krishna, total: gst(28_000_000, 18) }]
    }
  },
  {
    kind: 'chat', id: 'draft.relative-date', category: 'draft', title: 'Relative date against the working date',
    turns: [{
      question: 'Pay 2,000 for electricity in cash yesterday.',
      context: () => ({ workingDate: '2026-03-20' }),
      route: [step(call('draft_voucher', { kind: 'payment', date: 'yesterday', lines: [{ ledger: 'Electricity Charges', drCr: 'dr', amount: '2,000' }, { ledger: 'Cash', drCr: 'cr', amount: '2,000' }] })), say(quoteDraft('draft_voucher'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_voucher', args: { kind: 'payment' } }], allowExtra: ['list_ledgers'] },
      drafts: (f) => [{ voucherKind: 'payment', date: '2026-03-19', lines: [{ ledgerId: f.ids.power, drCr: 'dr', amount: 200_000 }, { ledgerId: f.ids.cash, drCr: 'cr', amount: 200_000 }] }]
    }
  },
  {
    kind: 'chat', id: 'draft.locked-month', category: 'draft', title: 'A draft into the locked month is refused',
    turns: [{
      question: 'Record a payment of 5,000 for shop rent from cash on 15 April 2025.',
      route: [step(call('draft_voucher', { kind: 'payment', date: '15 April 2025', lines: [{ ledger: 'Shop Rent', drCr: 'dr', amount: '5,000' }, { ledger: 'Cash', drCr: 'cr', amount: '5,000' }] })), say(quoteDraft('draft_voucher'))]
    }],
    expect: {
      tools: { calls: () => [{ name: 'draft_voucher' }], allowExtra: ['list_ledgers', 'get_company_info'] },
      drafts: () => [],
      draftRefused: /lock/i
    }
  }
]
