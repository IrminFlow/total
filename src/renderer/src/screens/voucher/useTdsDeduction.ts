import { useCallback, useEffect, useRef, useState } from 'react'
import type { TdsDeductionState } from '@shared/voucherEdit'
import { api, type TcsSuggestion, type TcsSuggestRequest, type TdsSuggestion } from '../../lib/client'

/** What the suggestion is computed on: the deductee, the base, and (optionally) the expense /
 *  purchase ledger debited, whose default section applies when the party has none. */
export interface TdsCandidate {
  partyLedgerId: number
  base: number
  expenseLedgerId?: number | null
}

/** The suggestion shape the banner reads (TCS adds its basis fields). */
type AnySuggestion = TdsSuggestion | TcsSuggestion

export interface WithholdingFlow<S extends AnySuggestion = TdsSuggestion> {
  /** Latest read-only suggestion for the current candidate (null = nothing applies). */
  suggestion: S | null
  /** The banner is hidden (dismissed, or just applied). */
  dismissed: boolean
  dismiss: () => void
  /** Commit the suggestion: returns the new entry (also passed to onChange) or null when there
   *  is nothing to apply (no suggestion, a stale one, or ₹0). Never creates a ledger — a missing
   *  payable ledger makes the entry `pending`, and saveVoucher creates the ledger inside the save
   *  transaction (autoPayable). */
  apply: () => TdsDeductionState | null
  /** Commit a typed amount instead of the rate table's (stored is_manual). Same rules as apply. */
  applyManual: (paise: number) => TdsDeductionState | null
  /** The section the user picked in the banner (null = the server's default). */
  chosenSectionId: number | null
  chooseSection: (sectionId: number | null) => void
  /** "Not applicable" reason to record on save, or null. */
  notApplicable: string | null
  /** Mark (reason) / clear (null) "Not applicable" — hides the banner while set. */
  setNotApplicable: (reason: string | null) => void
  /** The saved voucher's existing "Not applicable" mark (alterations), if any. */
  savedExemption: string | null
  /** Call after a successful save with the voucher id: writes / clears the exemption. */
  afterSave: (voucherId: number) => Promise<void>
  /** Forget the suggestion and the entry (after saving a new voucher). */
  reset: () => void
}
export type TdsDeduction = WithholdingFlow<TdsSuggestion>
export type TcsCollection = WithholdingFlow<TcsSuggestion>

/**
 * The suggestion / apply / "not applicable" flow both kinds share (WP 3.2, generalised in
 * WP 3.3). Controlled: the entry form owns the applied entry (`value` / `onChange`) because its
 * candidate can depend on it. Fetches debounced whenever the candidate (`candidateKey`), date or
 * chosen section changes; each entry mode decides what Apply does to its own lines.
 */
function useWithholding<S extends AnySuggestion>(opts: {
  enabled: boolean
  /** Base the suggestion is for (Apply refuses a suggestion fetched for another base); null =
   *  no candidate. */
  base: number | null
  /** Changes whenever the request would (party, amounts, ledgers, items). */
  candidateKey: string
  fetch: (chosenSectionId: number | null) => Promise<S | null>
  exemptionApi: { exemption: (id: number) => Promise<{ reason: string | null }>; exempt: (id: number, r: string) => Promise<unknown>; unexempt: (id: number) => Promise<unknown> }
  date: string
  excludeVoucherId?: number
  value: TdsDeductionState | null
  onChange: (t: TdsDeductionState | null) => void
  startDismissed?: boolean
  debounceMs?: number
}): WithholdingFlow<S> {
  const { enabled, base, candidateKey, date, excludeVoucherId, value, onChange, startDismissed = false, debounceMs = 300, exemptionApi } = opts
  const fetchRef = useRef(opts.fetch)
  fetchRef.current = opts.fetch
  const [suggestion, setSuggestion] = useState<S | null>(null)
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
  const exemptionRef = useRef(exemptionApi)
  exemptionRef.current = exemptionApi

  useEffect(() => {
    if (!enabled || excludeVoucherId == null) return
    let live = true
    exemptionRef.current
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
    if (!enabled || base == null || base <= 0) {
      suggestedBaseRef.current = null
      setSuggestion(null)
      return
    }
    let live = true
    const handle = setTimeout(() => {
      fetchRef.current(chosenSectionId)
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
  }, [enabled, base, candidateKey, date, excludeVoucherId, debounceMs, chosenSectionId])

  const commit = useCallback(
    (amount: number, isManual: boolean): TdsDeductionState | null => {
      if (!suggestion || base == null || suggestedBaseRef.current !== base || amount <= 0) return null
      // A payable credit already on the form (loaded voucher / earlier apply) keeps its ledger.
      const payableLedgerId = suggestion.payableLedgerId ?? (value && !value.pending ? value.payableLedgerId : null)
      const next: TdsDeductionState = {
        sectionId: suggestion.sectionId,
        baseAmount: suggestion.basePaise != null && suggestion.basePaise > 0 ? suggestion.basePaise : base,
        tdsAmount: amount,
        isManual,
        payableLedgerId,
        pending: payableLedgerId == null
      }
      onChange(next)
      setNotApplicableState(null)
      setDismissed(true)
      return next
    },
    [suggestion, base, value, onChange]
  )

  const apply = useCallback((): TdsDeductionState | null => (suggestion ? commit(suggestion.tdsPaise, false) : null), [suggestion, commit])
  const applyManual = useCallback((paise: number): TdsDeductionState | null => commit(paise, true), [commit])

  const setNotApplicable = useCallback((reason: string | null): void => {
    setNotApplicableState(reason)
    if (reason != null) setDismissed(true)
  }, [])

  const afterSave = useCallback(
    async (voucherId: number): Promise<void> => {
      if (value) return // saveVoucher clears any exemption on a voucher that now carries the entry
      if (notApplicable && notApplicable !== savedExemption) await exemptionRef.current.exempt(voucherId, notApplicable)
      else if (!notApplicable && savedExemption) await exemptionRef.current.unexempt(voucherId)
    },
    [value, notApplicable, savedExemption]
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

/**
 * Shared TDS suggestion/apply flow for both entry modes (AccountingEntry: payment/journal to a
 * flagged party; InvoiceEntry: purchase invoices). On a payment (`voucherKind: 'payment'`) the
 * server suggests only on the bills not deducted when booked plus any advance
 * (first-of-credit-or-payment).
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
  const { candidate, date, excludeVoucherId, voucherKind } = opts
  const partyLedgerId = candidate?.partyLedgerId ?? null
  const base = candidate?.base ?? null
  const expenseLedgerId = candidate?.expenseLedgerId ?? null
  return useWithholding<TdsSuggestion>({
    enabled: opts.enabled,
    base,
    candidateKey: `${partyLedgerId}|${expenseLedgerId}|${voucherKind ?? ''}`,
    fetch: (chosenSectionId) =>
      api.tds.suggest(partyLedgerId!, base!, date, {
        expenseLedgerId, excludeVoucherId,
        ...(chosenSectionId != null ? { sectionId: chosenSectionId } : {}),
        ...(voucherKind ? { voucherKind } : {})
      }),
    exemptionApi: api.tds,
    date,
    excludeVoucherId,
    value: opts.tds,
    onChange: opts.onChange,
    startDismissed: opts.startDismissed,
    debounceMs: opts.debounceMs
  })
}

/** The TCS candidate: a sale's buyer, taxable value, GST, sales ledger and items — or a
 *  receipt's buyer and the amount received. */
export type TcsCandidate = Omit<TcsSuggestRequest, 'date' | 'excludeVoucherId' | 'sectionId'>

/**
 * TCS on sales (WP 3.3): the same flow over tcs:suggest — InvoiceEntry (sales invoices: TCS is
 * added on top of the invoice total) and AccountingEntry (receipts: on sales not collected on
 * when invoiced, plus advances). Apply never creates a ledger; saveVoucher does (autoPayable).
 */
export function useTcsCollection(opts: {
  enabled: boolean
  candidate: TcsCandidate | null
  date: string
  excludeVoucherId?: number
  tcs: TdsDeductionState | null
  onChange: (t: TdsDeductionState | null) => void
  startDismissed?: boolean
  debounceMs?: number
}): TcsCollection {
  const { candidate, date, excludeVoucherId } = opts
  const base = candidate ? candidate.taxablePaise + (candidate.gstPaise ?? 0) : null
  const candidateKey = candidate ? JSON.stringify(candidate) : ''
  return useWithholding<TcsSuggestion>({
    enabled: opts.enabled,
    base,
    candidateKey,
    fetch: (chosenSectionId) =>
      api.tcs.suggest({ ...candidate!, date, ...(excludeVoucherId != null ? { excludeVoucherId } : {}), ...(chosenSectionId != null ? { sectionId: chosenSectionId } : {}) }),
    exemptionApi: api.tcs,
    date,
    excludeVoucherId,
    value: opts.tcs,
    onChange: opts.onChange,
    startDismissed: opts.startDismissed,
    debounceMs: opts.debounceMs
  })
}
