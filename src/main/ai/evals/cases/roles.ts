// Role refusals: a viewer is never offered a draft tool and a draft call by one is refused by the
// registry (no draft); reading still works; an accountant is offered the draft tools.
import type { EvalCase } from '../types'
import { FY, TODAY, call, qa, say, step } from './util'

export const ROLE_CASES: EvalCase[] = [
  {
    kind: 'chat', id: 'role.viewer-no-draft-tools', category: 'roles', title: 'A viewer is offered no draft tool',
    role: 'viewer',
    turns: [{
      question: 'Pay Sharma Steel 10,000 from HDFC Bank.',
      route: [say(() => 'You are signed in as a viewer, so I cannot prepare entries. An accountant or the owner can draft this payment.')]
    }],
    expect: { draftToolsOffered: false, drafts: () => [], forbidTools: ['draft_*'] }
  },
  {
    kind: 'chat', id: 'role.viewer-draft-refused', category: 'roles', mockOnly: true, title: 'Defence: a viewer’s draft call is refused by the registry',
    role: 'viewer',
    turns: [{
      question: 'Pay Sharma Steel 10,000 from HDFC Bank.',
      route: [
        step(call('draft_voucher', { kind: 'payment', party: 'Sharma Steel', account: 'HDFC Bank', amount: '10,000' })),
        say((c) => `I could not draft it: ${c.results.find((r) => !r.ok)?.error ?? ''}`)
      ]
    }],
    expect: { drafts: () => [], toolRefused: /may not use draft_voucher/i, draftToolsOffered: false }
  },
  {
    kind: 'chat', id: 'role.accountant-offered', category: 'roles', title: 'An accountant is offered the draft tools',
    turns: [{ question: 'Can you prepare entries for me?', route: [say(() => 'Yes — I can prepare drafts of vouchers, invoices, challans, manufactures and orders for you to review and save.')] }],
    expect: { draftToolsOffered: true, drafts: () => [] }
  },
  qa({
    id: 'role.viewer-reads', category: 'roles', title: 'A viewer can still read the books',
    role: 'viewer',
    question: 'What is our cash balance today?',
    tool: 'ledger_statement', args: (f) => ({ ledgerId: f.ids.cash, from: FY.from, to: TODAY }),
    answer: (r) => `Cash closes at ${r.closing}.`,
    figures: (f) => [f.facts.closing.cash]
  })
]
