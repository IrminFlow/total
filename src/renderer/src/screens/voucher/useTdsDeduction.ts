import { useCallback, useEffect, useRef, useState } from 'react'
import type { TdsDeductionState } from '@shared/voucherEdit'
import { api, type TdsSuggestion } from '../../lib/client'

/** What the suggestion is computed on: the deductee, the base, and (optionally) the expense /
 *  purchase ledger debited, whose default section applies when the party has none. */
export interface TdsCandidate {
  partyLedgerId: number
  base: number
  expenseLedgerId?: number | null
}

export interface TdsDeduction {
  /** Latest read-only suggestion for the current candidate (null = nothing applies). */
  suggestion: TdsSuggestion | null
  /** The banner is hidden (dismissed, or just applied). */
  dismissed: boolean
  dismiss: () => void
  /** Commit the suggestion: returns the new deduction (also passed to onChange) or null when
   *  there is nothing to apply (no suggestion, a stale one, or ₹0). Never creates a ledger — a
   *  missing payable ledger makes the deduction `pending`, and saveVoucher creates the ledger
   *  inside the save transaction (tds.autoPayable). */
  apply: () => TdsDeductionState | null
  /** Commit a typed amount instead of the rate table's (stored is_manual). Same rules as apply. */
  applyManual: (tdsPaise: number) => TdsDeductionState | null
  /** The section the user picked in the banner (null = the server's default). */
  chosenSectionId: number | null
  chooseSection: (sectionId: number | null) => void
  /** "Not applicable" reason to record on save (tds:exempt), or null. */
  notApplicable: string | null
  /** Mark (reason) / clear (null) "Not applicable" — hides the banner while set. */
  setNotApplicable: (reason: string | null) => void
  /** The saved voucher's existing "Not applicable" mark (alterations), if any. */
  savedExemption: string | null
  /** Call after a successful save with the voucher id: writes / clears the exemption. */
  afterSave: (voucherId: number) => Promise<void>
  /** Forget the suggestion and the deduction (after saving a new voucher). */
  reset: () => void
}

/**
 * Shared TDS suggestion/apply flow for both entry modes (AccountingEntry: payment/journal to a
 * flagged party; InvoiceEntry: purchase invoices). Controlled: the entry form owns the applied
 * deduction (`tds` / `onChange`) because its candidate base can depend on it (a journal's vendor
 * credit is reconstructed to gross from the applied amount). Fetches tds:suggest debounced
 * whenever the candidate, date or chosen section changes; each mode decides what Apply does to
 * its own lines. On a payment (`voucherKind: 'payment'`) the server suggests only on the bills
 * not deducted when booked plus any advance (first-of-credit-or-payment).
 */
export function useTdsDeduction(opts: {
  enabled: boolean
  candidate: TdsCandidate | null
  date: string
  excludeVoucherId?: number
  voucherKind?: 'purchase' | 'journal' | 'payment'
  tds: TdsDeductionState | null
  onChange: (t: TdsDeductionState | null) => void
  /** True when the form opened with a deduction already applied (an alteration): the banner
   *  stays closed until the user changes the amounts. */
  startDismissed?: boolean
  debounceMs?: number
}): TdsDeduction {
  const { enabled, candidate, date, excludeVoucherId, voucherKind, tds, onChange, startDismissed = false, debounceMs = 300 } = opts
  const [suggestion, setSuggestion] = useState<TdsSuggestion | null>(null)
  const [dismissed, setDismissed] = useState(startDismissed)
  const [chosenSectionId, setChosenSectionId] = useState<number | null>(null)
  const [notApplicable, setNotApplicableState] = useState<string | null>(null)
  const [savedExemption, setSavedExemption] = useState<string | null>(null)
  // The base the current suggestion was computed on — Apply refuses a stale suggestion (the
  // user changed amounts and the debounce hasn't refetched yet).
  const suggestedBaseRef = useRef<number | null>(null)
  // An alteration's first candidate is the saved voucher itself: fetch (so Apply can re-apply)
  // but keep the banner closed.
  const keepDismissedRef = useRef(startDismissed)

  const partyLedgerId = candidate?.partyLedgerId ?? null
  const base = candidate?.base ?? null
  const expenseLedgerId = candidate?.expenseLedgerId ?? null

  useEffect(() => {
    if (!enabled || excludeVoucherId == null) return
    let live = true
    api.tds
      .exemption(excludeVoucherId)
      .then((r) => {
        if (!live) return
        setSavedExemption(r.reason)
        setNotApplicableState(r.reason)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [enabled, excludeVoucherId])

  useEffect(() => {
    if (keepDismissedRef.current) keepDismissedRef.current = false
    else setDismissed(false)
    if (!enabled || partyLedgerId == null || base == null || base <= 0) {
      suggestedBaseRef.current = null
      setSuggestion(null)
      return
    }
    let live = true
    const handle = setTimeout(() => {
      api.tds
        .suggest(partyLedgerId, base, date, {
          expenseLedgerId, excludeVoucherId,
          ...(chosenSectionId != null ? { sectionId: chosenSectionId } : {}),
          ...(voucherKind ? { voucherKind } : {})
        })
        .then((s) => {
          if (!live) return
          suggestedBaseRef.current = base
          setSuggestion(s)
        })
        .catch(() => {
          if (live) setSuggestion(null)
        })
    }, debounceMs)
    return () => {
      live = false
      clearTimeout(handle)
    }
  }, [enabled, partyLedgerId, base, expenseLedgerId, date, excludeVoucherId, debounceMs, chosenSectionId, voucherKind])

  const commit = useCallback(
    (tdsAmount: number, isManual: boolean): TdsDeductionState | null => {
      if (!suggestion || base == null || suggestedBaseRef.current !== base || tdsAmount <= 0) return null
      // A payable credit already on the form (loaded voucher / earlier apply) keeps its ledger.
      const payableLedgerId = suggestion.payableLedgerId ?? (tds && !tds.pending ? tds.payableLedgerId : null)
      const next: TdsDeductionState = {
        sectionId: suggestion.sectionId,
        baseAmount: suggestion.basePaise != null && suggestion.basePaise > 0 ? suggestion.basePaise : base,
        tdsAmount,
        isManual,
        payableLedgerId,
        pending: payableLedgerId == null
      }
      onChange(next)
      setNotApplicableState(null)
      setDismissed(true)
      return next
    },
    [suggestion, base, tds, onChange]
  )

  const apply = useCallback((): TdsDeductionState | null => (suggestion ? commit(suggestion.tdsPaise, false) : null), [suggestion, commit])
  const applyManual = useCallback((tdsPaise: number): TdsDeductionState | null => commit(tdsPaise, true), [commit])

  const setNotApplicable = useCallback((reason: string | null): void => {
    setNotApplicableState(reason)
    if (reason != null) setDismissed(true)
  }, [])

  const afterSave = useCallback(
    async (voucherId: number): Promise<void> => {
      if (tds) return // saveVoucher clears any exemption on a voucher that now carries TDS
      if (notApplicable && notApplicable !== savedExemption) await api.tds.exempt(voucherId, notApplicable)
      else if (!notApplicable && savedExemption) await api.tds.unexempt(voucherId)
    },
    [tds, notApplicable, savedExemption]
  )

  const reset = useCallback((): void => {
    onChange(null)
    suggestedBaseRef.current = null
    setSuggestion(null)
    setDismissed(false)
    setChosenSectionId(null)
    setNotApplicableState(null)
  }, [onChange])

  return {
    suggestion, dismissed, dismiss: useCallback(() => setDismissed(true), []), apply, applyManual,
    chosenSectionId, chooseSection: setChosenSectionId, notApplicable, setNotApplicable, savedExemption, afterSave, reset
  }
}
