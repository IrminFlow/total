// Clarification: a name that matches several ledgers / items (Sharma Steel vs Sharma Steels,
// Wireless Mouse vs Wireless Mouse Pro, HDFC Bank vs HDFC Bank OD) makes the draft tool answer
// needs_clarification with the candidates — no draft, no guess — and the user's answer then
// drafts with the chosen one (the intent carries over, so the draft is not "unrequested").
import type { EvalCase, RouteCtx } from '../types'
import { call, say, step } from './util'

const ask = (tool: string) => (c: RouteCtx): string => {
  const r = c.last(tool)
  const q = (r?.questions as { question: string; candidates: { name: string }[] }[] | undefined) ?? []
  if (r?.status !== 'needs_clarification') return `Draft: ${r?.summary ?? 'none'}`
  return q.map((x) => `${x.question} ${x.candidates.map((k) => k.name).join(' or ')}?`).join(' ')
}

export const CLARIFICATION_CASES: EvalCase[] = [
  {
    kind: 'chat', id: 'clar.party', category: 'clarification', title: 'Two suppliers called Sharma',
    turns: [{
      question: 'Pay Sharma 10,000 from HDFC Bank.',
      route: [step(call('draft_voucher', { kind: 'payment', party: 'Sharma', account: 'HDFC Bank', amount: '10,000' })), say(ask('draft_voucher'))]
    }],
    expect: { drafts: () => [], clarification: (f) => ({ candidates: [f.ids.sharmaSteel, f.ids.sharmaSteels] }), answerIncludes: () => ['Sharma Steel', 'Sharma Steels'] }
  },
  {
    kind: 'chat', id: 'clar.party-answered', category: 'clarification', title: 'The answer to the clarification drafts with the chosen party',
    turns: [
      {
        question: 'Pay Sharma 10,000 from HDFC Bank.',
        route: [step(call('draft_voucher', { kind: 'payment', party: 'Sharma', account: 'HDFC Bank', amount: '10,000' })), say(ask('draft_voucher'))]
      },
      {
        question: 'Sharma Steels',
        route: [
          step(call('draft_voucher', { kind: 'payment', party: 'Sharma Steels', account: 'HDFC Bank', amount: '10,000' })),
          say((c) => `Draft ready: ${c.last('draft_voucher')?.summary}.`)
        ]
      }
    ],
    expect: { drafts: (f) => [{ voucherKind: 'payment', partyLedgerId: f.ids.sharmaSteels, total: 1_000_000, unrequested: false }] }
  },
  {
    kind: 'chat', id: 'clar.item', category: 'clarification', title: 'Two items that match "mouse"',
    turns: [{
      question: 'Record a sales invoice to Umbrella Retail for 2 mouse at 900.',
      route: [step(call('draft_invoice', { kind: 'sales', party: 'Umbrella Retail', items: [{ item: 'mouse', qty: '2', rate: '900' }] })), say(ask('draft_invoice'))]
    }],
    expect: { drafts: () => [], clarification: (f) => ({ candidates: [f.items.mouse, f.items.mousePro] }) }
  },
  {
    kind: 'chat', id: 'clar.purchase-party', category: 'clarification', title: 'Ambiguous supplier on a purchase bill',
    turns: [{
      question: 'Enter a purchase bill from Sharma for 10 Steel Rod at 150.',
      route: [step(call('draft_invoice', { kind: 'purchase', party: 'Sharma', items: [{ item: 'Steel Rod', qty: '10', rate: '150' }] })), say(ask('draft_invoice'))]
    }],
    expect: { drafts: () => [], clarification: (f) => ({ candidates: [f.ids.sharmaSteel, f.ids.sharmaSteels] }) }
  },
  {
    kind: 'chat', id: 'clar.bank', category: 'clarification', title: 'Two bank ledgers that match "HDFC"',
    turns: [{
      question: 'Pay 5,000 for shop rent from HDFC.',
      route: [step(call('draft_voucher', { kind: 'payment', lines: [{ ledger: 'Shop Rent', drCr: 'dr', amount: '5,000' }, { ledger: 'HDFC', drCr: 'cr', amount: '5,000' }] })), say(ask('draft_voucher'))]
    }],
    expect: { drafts: () => [], clarification: (f) => ({ candidates: [f.ids.hdfc, f.ids.hdfcOd] }) }
  }
]
