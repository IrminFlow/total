import type { RecurringTemplate, VoucherKind } from '@shared/domain'
import type { VoucherInputParsed } from '@shared/schemas'
import { todayISO } from '@shared/dates'
import { nextDraftId, type Screen, type VoucherDraft } from '../state/stores'

/** Trading kinds open in InvoiceEntry, which has no line-draft support (see draftFromTemplate) —
 *  opening one of these drops the stored lines and the caller should say so. */
const TRADING_KINDS: VoucherKind[] = ['sales', 'purchase', 'credit_note', 'debit_note']

/** Best-effort draft for "Open in voucher entry" — maps a template's stored lines to the
 *  voucher-entry draft shape so a stale/rejected template can still be posted by hand. Only
 *  AccountingEntry (non-trading kinds) actually consumes `lines`; InvoiceEntry ignores them. */
export function draftFromTemplate(t: RecurringTemplate): VoucherDraft {
  try {
    const parsed = JSON.parse(t.voucherJson) as Partial<VoucherInputParsed>
    return {
      date: todayISO(),
      partyLedgerId: parsed.partyLedgerId ?? undefined,
      narration: parsed.narration ?? undefined,
      lines: (parsed.lines ?? []).map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount }))
    }
  } catch {
    return { date: todayISO() }
  }
}

/** Where "Open in voucher entry" should navigate for a template, plus whether the caller should
 *  warn that line items get dropped (trading kinds — InvoiceEntry can only prefill date/party/
 *  narration, not lines). `voucherKind` is null only if the underlying voucher type was deleted;
 *  that falls through to VoucherEntry's own default (Journal) same as omitting kindHint. */
export function templateOpenTarget(t: RecurringTemplate): { screen: Screen; warnInvoice: boolean } {
  const kindHint = t.voucherKind ?? undefined
  return {
    // draftId forces VoucherEntry to remount when the previous screen is already a fresh
    // voucher-entry (same 'new' key otherwise) — see Banking/Gstr2b's draft entry points.
    screen: { name: 'voucher-entry', kindHint, draft: draftFromTemplate(t), draftId: nextDraftId() },
    warnInvoice: !!kindHint && TRADING_KINDS.includes(kindHint)
  }
}
