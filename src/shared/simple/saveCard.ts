// Save card (WP 8.5, plan 2026-10-13 §1.6): "Bill ₹1,180 saved. Received ₹500 by UPI. Ramesh
// still owes ₹680." Every figure comes from main (`voucher:saveSummary` — the saved vouchers and
// the outstandings allocation, at query time); this module only turns them into sentences with
// t() and money.ts. Pure.

import type { VoucherKind } from '../domain'
import type { Translate } from '../i18n'
import { formatPaise } from '../money'

/** Whether Undo is still offered for a group of just-saved vouchers. */
export interface UndoState {
  undoable: boolean
  /** Why not: changed since the save ("Edit instead"), already in the bin, inside the lock,
   *  the year was closed after it, or it is a closing entry. */
  reason: 'edited' | 'binned' | 'locked' | 'closed_year' | 'closing_entry' | null
}

export interface SaveCardEntry {
  voucherId: number
  kind: VoucherKind
  number: string
  date: string
  /** Voucher total (its debit side), paise. */
  amount: number
  /** Receipts / payments: the cash or bank account the money went through. */
  money: { name: string; isCash: boolean; amount: number } | null
}

export interface SaveCardParty {
  ledgerId: number
  name: string
  side: 'customer' | 'supplier'
  /** What is still open after the save, paise: > 0 the customer owes / you owe the supplier;
   *  < 0 paid in advance. From the outstandings allocation (open bills − unapplied credit). */
  balance: number
}

export interface SaveSummary {
  entries: SaveCardEntry[]
  party: SaveCardParty | null
  undo: UndoState
}

const ENTRY_KIND: Partial<Record<VoucherKind, string>> = {
  sales: 'sales',
  purchase: 'purchase',
  receipt: 'receipt',
  payment: 'payment',
  credit_note: 'creditNote',
  debit_note: 'debitNote'
}

const money = (paise: number): string => formatPaise(paise, { symbol: true })

/** The card's sentences, in order: what was saved, the money that moved, where the party stands. */
export function saveCardSentences(summary: SaveSummary, t: Translate): string[] {
  const out: string[] = []
  const [first, ...rest] = summary.entries
  if (!first) return out
  // The bill (or the only entry) leads; a receipt / payment saved with it is told as money moving.
  const moneyOnly = rest.filter((e) => e.money)
  const others = rest.filter((e) => !e.money)
  out.push(t('simple.saveCard.entry', { kind: ENTRY_KIND[first.kind] ?? 'other', amount: money(first.amount) }))
  if (others.length) out.push(t('simple.saveCard.entryMore', { n: others.length }))
  for (const e of moneyOnly) {
    const m = e.money!
    const received = e.kind === 'receipt'
    out.push(
      m.isCash
        ? t(received ? 'simple.saveCard.receivedCash' : 'simple.saveCard.paidCash', { amount: money(m.amount) })
        : t(received ? 'simple.saveCard.receivedInto' : 'simple.saveCard.paidFrom', { amount: money(m.amount), account: m.name })
    )
  }
  const p = summary.party
  if (p) {
    const vars = { name: p.name, amount: money(Math.abs(p.balance)) }
    if (p.side === 'customer') {
      out.push(t(p.balance > 0 ? 'simple.saveCard.customerOwes' : p.balance < 0 ? 'simple.saveCard.customerAhead' : 'simple.saveCard.customerSettled', vars))
    } else {
      out.push(t(p.balance > 0 ? 'simple.saveCard.supplierOwed' : p.balance < 0 ? 'simple.saveCard.supplierAhead' : 'simple.saveCard.supplierSettled', vars))
    }
  }
  return out
}
