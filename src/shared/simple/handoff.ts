// WP 9.10 — the Accountant-view hand-off of an UNSAVED simple form (plan 2026-10-13 §0.1: "Every
// simple screen has an Accountant view that opens the full editor … with the same state").
//
// `simple:intentForm` maps the screen's current answers with the SAME pure mapping `simple:post`
// and `simple:preview` use (mapIntent over the IntentContext main loads), inside a rehearsal that
// is always rolled back, and returns the editors' own form state per entry. The renderer opens the
// first entry in its editor (the `initial` state the editors already take for AI drafts and
// alterations); the editor saves through voucher:save as always. Nothing here writes the books.
//
// A rehearsal may create what the editor itself creates on first use (the walk-in customer, a
// GST / round-off ledger, the labour accounts) — those rows are rolled back, so the state must not
// point at them: `sanitiseHandoffEntry` (pure) clears every reference to a ledger that does not
// exist after the rollback and names it, so the editor shows an empty pick instead of a dangling id.
import type { VoucherKind } from '../domain'
import type { AccountingFormState, InvoiceFormState, ManufactureFormState, PhysicalFormState } from '../voucherEdit'
import type { IntentRole, SimpleIntentKind } from './intents'

export type HandoffEntry =
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'invoice'; state: InvoiceFormState; amount: number }
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'accounting'; state: AccountingFormState; amount: number }
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'physical'; state: PhysicalFormState; amount: number }
  | { role: IntentRole; kind: VoucherKind; voucherTypeId: number; form: 'manufacture'; state: ManufactureFormState; amount: number }

export interface IntentFormResult {
  kind: SimpleIntentKind
  /** In the order simple:post would save them (the bill / note first, then its payment / refund). */
  entries: HandoffEntry[]
  /** Accounts the answers need that do not exist yet (created on first use by simple:post / the
   *  editor) — the editor shows them as empty picks. */
  missing: string[]
}

/** What the full editor is opened with (a nav param — nothing stored). */
export interface SimpleHandoff {
  /** The simple screen it came from (registry name) — "Back to simple" returns there. */
  from: string
  kind: SimpleIntentKind
  entry: HandoffEntry
  /** The other parts of the same answers (a payment made now, a refund), not in this editor. */
  others: { role: IntentRole; kind: VoucherKind; amount: number }[]
  missing: string[]
}

/** simple:handoffTarget — the facts "Back to simple" needs from main (services/simpleHandoff.ts). */
export interface HandoffFacts {
  /** Absent when the voucher is not in the books (binned, optional, post-dated) or not found. */
  voucher?: { id: number; kind: VoucherKind; originalId: number | null }
  ledger?: { id: number; isParty: boolean }
}

/** Clear every reference to a ledger that does not exist (after the rehearsal's rollback). The
 *  bill name follows the voucher number again when it was only the number (the editor numbers a
 *  new entry itself, so a number taken meanwhile never sticks to the bill). */
export function sanitiseHandoffEntry(
  entry: HandoffEntry,
  exists: (ledgerId: number) => boolean,
  nameOf: (ledgerId: number) => string | null
): { entry: HandoffEntry; missing: string[] } {
  const missing: string[] = []
  const keep = (id: number | null): number | null => {
    if (id == null || exists(id)) return id
    const name = nameOf(id)
    if (name && !missing.includes(name)) missing.push(name)
    return null
  }
  switch (entry.form) {
    case 'invoice': {
      const s = entry.state
      const billName = s.billName && s.billName === s.number ? '' : s.billName
      return { entry: { ...entry, state: { ...s, number: '', billName, partyId: keep(s.partyId), accountId: keep(s.accountId) } }, missing }
    }
    case 'accounting': {
      const s = entry.state
      return { entry: { ...entry, state: { ...s, number: '', rows: s.rows.map((r) => ({ ...r, ledgerId: keep(r.ledgerId) })) } }, missing }
    }
    case 'physical':
      return { entry: { ...entry, state: { ...entry.state, number: '' } }, missing }
    case 'manufacture': {
      const s = entry.state
      // null = Wages Payable — what the editor creates on first use anyway.
      const credit = s.labourCreditLedgerId != null && !exists(s.labourCreditLedgerId) ? null : s.labourCreditLedgerId
      return { entry: { ...entry, state: { ...s, number: '', labourCreditLedgerId: credit } }, missing }
    }
  }
}

/** The simple screen an intent is filled in on (where "Back to simple" returns for an unsaved
 *  hand-off). */
export const INTENT_SCREEN: Record<SimpleIntentKind, string> = {
  sale: 'simple-sell',
  purchase: 'simple-buy',
  money_in: 'simple-money-in',
  money_out: 'simple-money-out',
  move_money: 'simple-move-money',
  return_sale: 'simple-return-sale',
  return_purchase: 'simple-return-purchase',
  stock_count: 'simple-stock-count',
  make_goods: 'simple-made-goods'
}
