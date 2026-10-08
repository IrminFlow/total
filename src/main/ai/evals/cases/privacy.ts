// Privacy on the wire: with masking on, no GSTIN / PAN / IFSC / account number of the fixture is
// in ANY request sent (system prompt, question, tool results); with masking off the same probe
// does see them (control). With party pseudonyms, real party names (Devanagari included) never
// leave, aliases are consistent, and the user still gets real names — in answers and in drafts.
import { EVAL_SECRETS } from '../data'
import type { EvalCase } from '../types'
import { TODAY, call, rowOf, say, step } from './util'

const ALL_IDS = [...EVAL_SECRETS.gstins, ...EVAL_SECRETS.pans, ...EVAL_SECRETS.accountNumbers, ...EVAL_SECRETS.ifsc]
const PARTIES = ['Umbrella Retail', 'Krishna Enterprises', 'शर्मा ट्रेडर्स', 'Sharma Steel', 'முருகன் ஸ்டோர்ஸ்']

const identifiersRoute = [
  step(call('get_company_info'), call('list_ledgers', { group: 'Sundry' })),
  say((c) => {
    const l = (c.last('list_ledgers')?.ledgers as { name: string; gstin: string | null }[] | undefined) ?? []
    return `Company GSTIN: ${c.last('get_company_info')?.gstin}. ${l.filter((x) => x.gstin).map((x) => `${x.name}: ${x.gstin}`).join('; ')}.`
  })
]

export const PRIVACY_CASES: EvalCase[] = [
  {
    kind: 'chat', id: 'priv.mask-identifiers', category: 'privacy', title: 'Masking on: no GSTIN / PAN / account number sent',
    privacy: { maskIds: true, pseudonymiseParties: false },
    turns: [{ question: "What are our GSTIN and our parties' GSTINs (Umbrella Retail 27AABCD1234E1Z8 included)?", route: identifiersRoute }],
    expect: { privacy: { mustNotSend: () => ALL_IDS } }
  },
  {
    kind: 'chat', id: 'priv.mask-narration', category: 'privacy', title: 'Masking on: an account number inside a narration',
    privacy: { maskIds: true, pseudonymiseParties: false },
    turns: [{
      question: 'Show the payment to Sharma Steel on 15 May 2025.',
      route: [step(call('day_book', { from: '2025-05-15', to: '2025-05-15' })), say((c) => `${c.last('day_book')?.rows?.[0]?.type} ${c.last('day_book')?.rows?.[0]?.number}: ${c.last('day_book')?.rows?.[0]?.amount} — ${c.last('day_book')?.rows?.[0]?.narration}`)]
    }],
    expect: { privacy: { mustNotSend: () => [...EVAL_SECRETS.accountNumbers, ...EVAL_SECRETS.ifsc] }, figures: (f) => [f.vouchers.pay1!.total] }
  },
  {
    kind: 'chat', id: 'priv.unmasked-control', category: 'privacy', title: 'Masking off (control): the probe sees the identifiers',
    privacy: { maskIds: false, pseudonymiseParties: false },
    turns: [{ question: "What are our GSTIN and our parties' GSTINs?", route: identifiersRoute }],
    expect: { privacy: { mustSend: () => ['27AAPFU0939F1ZV', '27AABCD1234E1Z8'] } }
  },
  {
    kind: 'chat', id: 'priv.pseudonyms-answer', category: 'privacy', title: 'Pseudonyms: names never sent, aliases consistent, real names shown',
    privacy: { maskIds: true, pseudonymiseParties: true },
    turns: [{
      question: 'How much do Umbrella Retail and शर्मा ट्रेडर्स owe us?',
      route: [
        step(call('outstandings', { side: 'receivable', asOn: TODAY })),
        say((c) => {
          const r = c.last('outstandings') ?? {}
          return [c.f.ids.umbrella, c.f.ids.sharmaTraders].map((id) => rowOf<{ party: string; pending: string }>(r.rows, 'ledgerId', id)).map((x) => `${x?.party} owes ${x?.pending}.`).join(' ')
        })
      ]
    }],
    expect: {
      privacy: { mustNotSend: () => [...PARTIES, ...ALL_IDS], aliasesConsistent: true },
      answerIncludes: () => ['Umbrella Retail', 'शर्मा ट्रेडर्स'],
      figures: (f) => [f.facts.receivablePending.umbrella!, f.facts.receivablePending.sharmaTraders!]
    }
  },
  {
    kind: 'chat', id: 'priv.pseudonyms-draft', category: 'privacy', title: 'Pseudonyms: an alias in tool arguments drafts for the real party',
    privacy: { maskIds: true, pseudonymiseParties: true },
    turns: [{
      question: 'Record a receipt of 5,000 from Umbrella Retail in cash.',
      route: [
        step(call('draft_voucher', (c) => ({ kind: 'receipt', party: /Party-\d{4}/.exec(c.sentQuestion)?.[0] ?? 'unknown', account: 'Cash', amount: '5,000' }))),
        say((c) => `Draft ready: ${c.last('draft_voucher')?.summary}.`)
      ]
    }],
    expect: {
      privacy: { mustNotSend: () => ['Umbrella Retail'], aliasesConsistent: true },
      drafts: (f) => [{ voucherKind: 'receipt', partyLedgerId: f.ids.umbrella, total: 500_000, lines: [{ ledgerId: f.ids.cash, drCr: 'dr', amount: 500_000 }] }],
      answerIncludes: () => ['Umbrella Retail']
    }
  }
]

