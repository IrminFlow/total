import type { RecurringTemplate, VoucherKind } from '@shared/domain'
import { todayISO } from '@shared/dates'
import type { VoucherInputParsed } from '@shared/schemas'
import { nextDraftId, type Screen, type VoucherDraft } from '../state/stores'

/** Trading kinds open in InvoiceEntry, which has no line-draft support. */
const TRADING_KINDS: VoucherKind[] = ['sales', 'purchase', 'credit_note', 'debit_note']

/** Best-effort draft for "Open in voucher entry" — maps a template's stored lines to the
 * voucher-entry draft shape so a stale/rejected template can still be posted by hand. Only
 * AccountingEntry (non-trading kinds) consumes `lines`; InvoiceEntry ignores them. */
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
 * warn that line items get dropped. Kept outside the Recurring screen module so Gateway can use
 * the helper without pulling the whole lazily rendered screen into the entry chunk. */
export function templateOpenTarget(t: RecurringTemplate): { screen: Screen; warnInvoice: boolean } {
  const kindHint = t.voucherKind ?? undefined
  return {
    screen: { name: 'voucher-entry', kindHint, draft: draftFromTemplate(t), draftId: nextDraftId() },
    warnInvoice: !!kindHint && TRADING_KINDS.includes(kindHint)
  }
}
