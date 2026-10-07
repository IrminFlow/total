import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger, Voucher, VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import { buildAccountingPayload, derivePartyId, type AccountingFormState, type AccountingRowState } from '@shared/voucherEdit'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api, type TdsSuggestion } from '../../lib/client'
import { useNav, useSession, useToasts, type VoucherDraft } from '../../state/stores'
import { AmountInput, Button, DateInput, Field, isAnyModalOpen, LineTableScroller, Money, Panel, Select, TextInput } from '../../components/ui'
import { LedgerPicker, useGroups, useLedgers } from '../../components/pickers'
import { LedgerFormModal } from '../../components/LedgerFormModal'
import { useFeatures } from '../../lib/useFeatures'
import { confirmDialog } from '../../lib/dialogs'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import {
  isBankLedger, isCashOrBankLedger, isPartyLedger, nextLineKey, NUMBER_LOADING, TRADING_KINDS,
  useAlterationDirty, useLeaveAfterSave, useVoucherNumberField
} from './hooks'
import { CostAllocModal, QuickLedgerModal } from './modals'
import { TransportModal } from './TransportModal'

// ---------- accounting mode (payment / receipt / contra / journal, and the lossless fallback
// for alterations the specialised modes can't show — see planVoucherEdit) ----------

interface AcctRow extends AccountingRowState {
  /** Stable React key — survives applyTds splicing a payable line in mid-list (never an index). */
  key: number
}

const blankAcctRow = (drCr: 'dr' | 'cr'): AcctRow => ({ key: nextLineKey(), drCr, ledgerId: null, amount: null, costAllocations: [] })

export function AccountingEntry({
  typeId,
  kind,
  voucherId,
  draft,
  voucher,
  initial,
  fallbackReason
}: {
  typeId: number
  kind: VoucherKind
  voucherId?: number
  draft?: VoucherDraft
  /** Alteration: the saved voucher and the form state reconstructed from it (accountingStateFromVoucher). */
  voucher?: Voucher
  initial?: AccountingFormState
  /** Set when a trading voucher opens here because the invoice form can't show it faithfully. */
  fallbackReason?: string | null
}): React.JSX.Element {
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const ledgers = useLedgers()
  const groups = useGroups()
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const [date, setDate] = useState(initial?.date ?? draft?.date ?? workingDate)
  const [rows, setRows] = useState<AcctRow[]>(() =>
    initial
      ? initial.rows.map((r) => ({ ...r, key: nextLineKey() }))
      : draft?.lines?.length
        ? [...draft.lines.map((l) => ({ ...l, key: nextLineKey(), costAllocations: [] as AcctRow['costAllocations'] })), blankAcctRow('cr')]
        : [blankAcctRow('dr'), blankAcctRow('cr')]
  )
  const [narration, setNarration] = useState(initial?.narration ?? draft?.narration ?? '')
  const [instrumentNo, setInstrumentNo] = useState(initial?.instrumentNo ?? '')
  const [quickLedger, setQuickLedger] = useState<{ name: string; row: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [showTransport, setShowTransport] = useState(false)
  const [editingParty, setEditingParty] = useState<Ledger | null>(null)
  // Alteration keeps the voucher's own number editable but never auto-suggests a fresh one off
  // voucher:nextNumber (that would rename an existing document to "the next available number"
  // the moment you touch its date) — it's seeded from the loaded voucher. New-entry mode uses
  // the touched/refetch hook instead, same as InvoiceEntry.
  const [alterNumber, setAlterNumber] = useState(initial?.number ?? '')
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  const [draftPartyId] = useState(draft?.partyLedgerId ?? null)
  const { saved, leave } = useLeaveAfterSave()

  // ---------- TDS (payment / journal to a party flagged for TDS) ----------
  const [tds, setTds] = useState<{ sectionId: number; baseAmount: number; tdsAmount: number } | null>(initial?.tds ?? null)
  const [tdsSuggestion, setTdsSuggestion] = useState<TdsSuggestion | null>(null)
  const [tdsDismissed, setTdsDismissed] = useState(!!initial?.tds)
  // Set right before WE mutate rows in a way that would otherwise re-trigger the suggestion
  // effect (applying TDS onto the flagged CR row itself, or loading a voucher that already has
  // tds applied) — the effect consumes it once and skips, so the banner doesn't re-fetch/reopen
  // off of our own write. Genuine user edits always leave it false and behave normally.
  const skipNextTdsEffectRef = useRef(!!initial?.tds)

  // ---------- bill allocations (receipt/payment checkbox list; trading-kind alteration editor) ----------
  const [billRefs, setBillRefs] = useState<VoucherBillRef[]>(initial?.billRefs ?? [])
  const [billsOpen, setBillsOpen] = useState(true)

  // ---------- GST / book-keeping flags ----------
  // Advance receipt (GSTR-1 11A): the unallocated remainder of the party line goes out as a
  // 'new' bill ref, which is exactly what gst.extractAdvances counts. Optional = memorandum.
  const [advanceReceipt, setAdvanceReceipt] = useState(initial?.advanceReceipt ?? false)
  const [optionalVoucher, setOptionalVoucher] = useState(initial?.optional ?? false)

  // ---------- per-line cost-centre allocation ----------
  const { data: ccList } = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list })
  const hasCc = features.costCentres && (ccList?.length ?? 0) > 0
  const [ccModalRow, setCcModalRow] = useState<number | null>(null)

  const totalDr = rows.reduce((s, r) => s + (r.drCr === 'dr' ? (r.amount ?? 0) : 0), 0)
  const totalCr = rows.reduce((s, r) => s + (r.drCr === 'cr' ? (r.amount ?? 0) : 0), 0)
  const balanced = totalDr === totalCr && totalDr > 0

  const setRow = (i: number, patch: Partial<AcctRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.ledgerId != null) next.push(blankAcctRow('cr'))
      return next
    })
  }

  // A voucher's "party" for TDS/bill-allocation purposes: whichever posted ledger is a Sundry
  // Debtor/Creditor or is flagged for TDS. Falls back to a draft-supplied party (e.g. the GSTR-2B
  // "Create purchase" nudge) when the rows don't yet name one unambiguously.
  const derivedPartyId = useMemo(
    () =>
      derivePartyId(
        rows,
        (id) => {
          const l = ledgers.find((x) => x.id === id)
          return !!l && (isPartyLedger(l, groupMap) || l.tdsSectionId != null)
        },
        draftPartyId
      ),
    [rows, ledgers, groupMap, draftPartyId]
  )

  // How much of a prior Apply is already sitting in the TDS payable line — i.e. how much the
  // target line has already been reduced (the cumulative reduction on the target always equals
  // the current payable line's amount; see applyTds). Declared before tdsCandidateRow because
  // the journal vendor-CR shape needs it to reconstruct the pre-deduction gross amount below.
  const existingTdsPayableAmount = useMemo(() => {
    if (!tds || !tdsSuggestion || tdsSuggestion.payableLedgerId == null) return 0
    return rows.find((r) => r.drCr === 'cr' && r.ledgerId === tdsSuggestion.payableLedgerId)?.amount ?? 0
  }, [rows, tds, tdsSuggestion])

  // The dr-side (payment: "Dr Vendor / Cr Bank") is checked first; journal additionally checks
  // the cr side, since the standard journal shape is "Dr Expense / Cr Vendor(flagged)" — the
  // vendor never appears as a debit there. `rowSide` records which one matched, since it decides
  // both the suggestion's base amount and (in applyTds) which line absorbs the deduction.
  //
  // For the cr shape, `amount` is reconstructed back to the GROSS pre-deduction figure (current
  // row amount + whatever a prior Apply already carved out of it) rather than read live off the
  // row — Apply reduces that same row, so reading it live would drift the suggestion base down
  // to the net amount on any re-trigger (e.g. editing the date) and silently under-deduct on a
  // re-apply. The payment/dr shape doesn't need this: Apply reduces a different (bank) line, so
  // the dr candidate row's amount never moves on its own.
  const tdsCandidateRow = useMemo(() => {
    if (kind !== 'payment' && kind !== 'journal') return null
    for (const r of rows) {
      if (r.drCr !== 'dr' || r.ledgerId == null || !r.amount) continue
      const l = ledgers.find((x) => x.id === r.ledgerId)
      if (l?.tdsSectionId != null) return { ledgerId: r.ledgerId, amount: r.amount, rowSide: 'dr' as const }
    }
    if (kind === 'journal') {
      for (const r of rows) {
        if (r.drCr !== 'cr' || r.ledgerId == null || !r.amount) continue
        const l = ledgers.find((x) => x.id === r.ledgerId)
        if (l?.tdsSectionId != null) {
          return { ledgerId: r.ledgerId, amount: r.amount + existingTdsPayableAmount, rowSide: 'cr' as const }
        }
      }
    }
    return null
  }, [rows, kind, ledgers, existingTdsPayableAmount])

  // Where the TDS amount would come out of: the flagged CR row itself for the journal vendor
  // shape (Dr Expense / Cr Vendor 9000 / Cr TDS 1000 — the textbook entry), or the largest
  // cash/bank credit line for the payment shape.
  const tdsTargetIdx = useMemo(() => {
    if (!tdsCandidateRow) return -1
    if (tdsCandidateRow.rowSide === 'cr') {
      return rows.findIndex((r) => r.drCr === 'cr' && r.ledgerId === tdsCandidateRow.ledgerId)
    }
    let idx = -1
    let max = -1
    rows.forEach((r, i) => {
      if (r.drCr !== 'cr' || r.ledgerId == null) return
      const l = ledgers.find((x) => x.id === r.ledgerId)
      if (l && isCashOrBankLedger(l, groupMap) && (r.amount ?? 0) > max) {
        max = r.amount ?? 0
        idx = i
      }
    })
    return idx
  }, [rows, tdsCandidateRow, ledgers, groupMap])

  // Capacity of the target line = its current (live, un-reconstructed) amount plus whatever a
  // prior Apply already carved out of it.
  const tdsTargetCapacity = tdsTargetIdx === -1 ? 0 : (rows[tdsTargetIdx]!.amount ?? 0) + existingTdsPayableAmount
  const tdsApplyBlocked = !!tdsSuggestion && (tdsTargetIdx === -1 || tdsTargetCapacity < tdsSuggestion.tdsPaise)

  useEffect(() => {
    if (skipNextTdsEffectRef.current) {
      skipNextTdsEffectRef.current = false
      return
    }
    setTdsDismissed(false)
    if (!tdsCandidateRow) {
      setTdsSuggestion(null)
      return
    }
    const handle = setTimeout(() => {
      api.tds
        .suggest(tdsCandidateRow.ledgerId, tdsCandidateRow.amount, date)
        // Read-only: the payable ledger is only created when the user hits Apply (applyTds).
        .then((s) => setTdsSuggestion(s))
        .catch(() => setTdsSuggestion(null))
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tdsCandidateRow?.ledgerId, tdsCandidateRow?.amount, date])

  const applyTds = async (): Promise<void> => {
    // tdsTargetIdx === -1 is already implied by tdsApplyBlocked today, but checked explicitly
    // too — mirrors the setRows updater's own guard so a future change to the blocked condition
    // can't set the tds payload without the corresponding line mutation.
    if (!tdsCandidateRow || !tdsSuggestion || tdsApplyBlocked || tdsTargetIdx === -1) return
    // The suggestion is read-only, so "TDS Payable <code>" may not exist yet. Applying is the
    // explicit action that commits to posting it, so create it now (and refresh ledgers so the
    // new line shows by name) — never while the user is merely typing amounts.
    let payableLedgerId = tdsSuggestion.payableLedgerId
    if (payableLedgerId == null) {
      try {
        payableLedgerId = (await api.tds.ensurePayable(tdsSuggestion.sectionId)).ledgerId
      } catch (err) {
        toast.push('error', (err as Error).message)
        return
      }
      const created = payableLedgerId
      setTdsSuggestion((s) => (s && s.sectionId === tdsSuggestion.sectionId ? { ...s, payableLedgerId: created } : s))
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
    }
    const tdsAmount = tdsSuggestion.tdsPaise
    const isVendorTarget = tdsCandidateRow.rowSide === 'cr'
    // The vendor-CR shape reduces the very row the candidate/suggestion is keyed on — mark it so
    // the debounce effect above doesn't treat our own write as a fresh user edit and re-suggest
    // off the now-smaller amount. The payment shape reduces an unrelated bank line, so the
    // candidate row is untouched and no suppression is needed there.
    if (isVendorTarget) skipNextTdsEffectRef.current = true
    setRows((rs) => {
      let next = rs.map((r) => ({ ...r }))

      let targetIdx = -1
      if (isVendorTarget) {
        targetIdx = next.findIndex((r) => r.drCr === 'cr' && r.ledgerId === tdsCandidateRow.ledgerId)
      } else {
        let max = -1
        next.forEach((r, i) => {
          if (r.drCr !== 'cr' || r.ledgerId == null) return
          const l = ledgers.find((x) => x.id === r.ledgerId)
          if (l && isCashOrBankLedger(l, groupMap) && (r.amount ?? 0) > max) {
            max = r.amount ?? 0
            targetIdx = i
          }
        })
      }
      // Guarded by tdsApplyBlocked above — should always be found, but never mutate blind.
      if (targetIdx === -1) return next

      // Re-applying (e.g. after editing the base amount) adjusts the TDS payable line already on
      // the voucher instead of inserting a duplicate.
      const existingIdx = tds ? next.findIndex((r) => r.drCr === 'cr' && r.ledgerId === payableLedgerId) : -1
      if (existingIdx !== -1) {
        const delta = tdsAmount - (next[existingIdx]!.amount ?? 0)
        next[existingIdx] = { ...next[existingIdx]!, amount: tdsAmount }
        next[targetIdx] = { ...next[targetIdx]!, amount: (next[targetIdx]!.amount ?? 0) - delta }
        return next
      }

      next[targetIdx] = { ...next[targetIdx]!, amount: (next[targetIdx]!.amount ?? 0) - tdsAmount }
      const insertAt = next.length > 0 && next[next.length - 1]!.ledgerId == null ? next.length - 1 : next.length
      const tdsRow: AcctRow = { key: nextLineKey(), drCr: 'cr', ledgerId: payableLedgerId, amount: tdsAmount, costAllocations: [] }
      next = [...next.slice(0, insertAt), tdsRow, ...next.slice(insertAt)]
      if (next[next.length - 1]!.ledgerId != null) next.push(blankAcctRow('cr'))
      return next
    })
    setTds({ sectionId: tdsSuggestion.sectionId, baseAmount: tdsCandidateRow.amount, tdsAmount })
    setTdsDismissed(true)
  }

  const showBillsSection =
    features.billWise && derivedPartyId != null && (kind === 'receipt' || kind === 'payment' || (TRADING_KINDS.includes(kind) && !!voucherId))
  const isCheckboxBills = kind === 'receipt' || kind === 'payment'

  const { data: openBills } = useQuery({
    queryKey: ['billsOpen', derivedPartyId, date],
    queryFn: () => api.bills.open(derivedPartyId!, date),
    enabled: !!derivedPartyId && isCheckboxBills
  })

  const partyLineTotal = derivedPartyId != null ? rows.filter((r) => r.ledgerId === derivedPartyId).reduce((s, r) => s + (r.amount ?? 0), 0) : 0
  const billAllocatedTotal = billRefs.reduce((s, r) => s + r.amount, 0)

  const toggleBill = (bill: OutstandingBill, checked: boolean): void => {
    setBillRefs((refs) => {
      if (checked) {
        const remaining = Math.max(0, partyLineTotal - refs.reduce((s, r) => s + r.amount, 0))
        const amount = Math.min(bill.pending, remaining || bill.pending)
        return [...refs, { kind: 'against', name: bill.number, amount, dueDate: null }]
      }
      return refs.filter((r) => !(r.kind === 'against' && r.name === bill.number))
    })
  }

  const setBillRefAmount = (name: string, amount: number): void => {
    setBillRefs((refs) => refs.map((r) => (r.name === name ? { ...r, amount } : r)))
  }

  const addManualBillRef = (): void => setBillRefs((refs) => [...refs, { kind: 'new', name: '', amount: 0, dueDate: null }])
  const setManualBillRef = (i: number, patch: Partial<VoucherBillRef>): void =>
    setBillRefs((refs) => refs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const removeManualBillRef = (i: number): void => setBillRefs((refs) => refs.filter((_, j) => j !== i))

  // The form as the shared builder sees it. On alteration `original` carries everything this
  // form doesn't edit (stock lines with batch/discount/godown/physical-count flag, reference,
  // transport, POS override, currency, the stored party and cheque date) back verbatim.
  const formState: AccountingFormState = useMemo(
    () => ({
      date,
      number: voucherId ? alterNumber : numberField.forPayload,
      rows: rows.map(({ key: _key, ...r }) => r),
      narration,
      instrumentNo,
      billRefs,
      advanceReceipt,
      optional: optionalVoucher,
      tds,
      original: initial?.original ?? null
    }),
    [date, voucherId, alterNumber, numberField.forPayload, rows, narration, instrumentNo, billRefs, advanceReceipt, optionalVoucher, tds, initial]
  )

  // Builds the exact VoucherInputParsed shape `save` posts.
  const buildPayload = useCallback((): VoucherInputParsed | null => {
    const r = buildAccountingPayload(formState, { kind, voucherTypeId: typeId, derivedPartyId })
    return r.ok ? r.payload : null
  }, [formState, kind, typeId, derivedPartyId])

  // Unsaved-changes guard: a new voucher once anything is typed (save resets the form); an
  // alteration once what it would post differs from the saved voucher.
  const alterationDirty = useAlterationDirty(
    voucher,
    voucherId ? buildAccountingPayload(formState, { kind, voucherTypeId: typeId, derivedPartyId }) : null
  )
  useUnsavedGuard(
    !saved &&
      (voucherId
        ? alterationDirty
        : rows.some((r) => r.ledgerId != null || (r.amount ?? 0) !== 0) || narration.trim() !== '')
  )

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    const input = buildPayload()
    if (!input) return void toast.push('error', 'Enter at least one debit and one credit')
    setSaving(true)
    try {
      // Duplicate-number confirm — a manually typed (or race-lost auto) number that's already
      // on the books gets one explicit "save anyway" before we commit to it.
      if (input.number && (await api.vouchers.numberExists(typeId, input.number, voucherId))) {
        const proceed = await confirmDialog({
          title: 'Duplicate number',
          message: `Voucher number ${input.number} is already used by another voucher of this type. Save anyway with the same number?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      // Anomaly nudge on the largest line — a quiet second look, never a block.
      const largest = [...input.lines].sort((a, b) => b.amount - a.amount)[0]!
      const anomaly = await api.intel.anomaly(largest.ledgerId, largest.amount)
      if (anomaly.unusual && anomaly.typicalAmount != null) {
        const proceed = await confirmDialog({
          title: 'Unusual amount',
          message: `${formatPaise(largest.amount, { symbol: true })} is far above this ledger's usual ${formatPaise(anomaly.typicalAmount, { symbol: true })}. Save anyway?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const saved = await api.vouchers.save(input, voucherId)
      toast.push('success', `${saved.number} ${voucherId ? 'altered' : 'saved'}`)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (voucherId) leave()
      else {
        setRows([blankAcctRow('dr'), blankAcctRow('cr')])
        setNarration('')
        setBillRefs([])
        setAdvanceReceipt(false)
        setOptionalVoucher(false)
        setTds(null)
        setTdsSuggestion(null)
        setTdsDismissed(false)
        numberField.reset()
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, buildPayload, date, typeId, voucherId, toast, setWorkingDate, queryClient, leave, numberField.reset])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        // A modal's own ⌘↵ (or a stray one) must not save the voucher underneath it.
        if (isAnyModalOpen()) return
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const remove = async (): Promise<void> => {
    if (!voucherId) return
    const proceed = await confirmDialog({
      title: 'Move to Bin',
      message: 'Move this voucher to the Bin? You can restore it from the bin for 30 days.',
      confirmLabel: 'Move to Bin',
      danger: true
    })
    if (!proceed) return
    try {
      await api.vouchers.remove(voucherId)
      toast.push('success', 'Moved to Bin')
      await queryClient.invalidateQueries()
      leave()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  // ---------- cheque printing + payment advice (saved payment vouchers only) ----------
  const bankCrLine = useMemo(() => {
    if (!voucherId || kind !== 'payment' || !voucher) return null
    let best: { ledgerId: number; amount: number } | null = null
    for (const l of voucher.lines) {
      if (l.drCr !== 'cr') continue
      const ledger = ledgers.find((x) => x.id === l.ledgerId)
      if (ledger && isBankLedger(ledger, groupMap) && (!best || l.amount > best.amount)) {
        best = { ledgerId: l.ledgerId, amount: l.amount }
      }
    }
    return best
  }, [voucherId, kind, voucher, ledgers, groupMap])

  const printCheque = async (): Promise<void> => {
    if (!voucherId || !bankCrLine) return
    try {
      const r = await api.cheque.pdf(voucherId, bankCrLine.ledgerId)
      toast.push('success', `Cheque PDF: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const printAdvice = async (): Promise<void> => {
    if (!voucherId) return
    try {
      const r = await api.cheque.advice(voucherId)
      toast.push('success', `Payment advice: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="p-5">
      {fallbackReason && (
        <p
          data-testid="banner-accounting-fallback"
          className="mb-4 rounded-md border border-amber/40 bg-amberbar/10 px-3 py-2 text-body-sm text-ink"
          title={fallbackReason}
        >
          Editing in accounting mode — this voucher can&apos;t be shown as an invoice ({fallbackReason}). Its stock
          lines and other details are kept exactly as saved.
        </p>
      )}
      <div className="grid grid-cols-4 gap-3">
        <Field label="No." hint={voucherId || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={voucherId ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => (voucherId ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className="num"
          />
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end justify-end">
          <p className={`num text-body-sm ${balanced ? 'text-dr' : 'text-muted'}`}>
            Dr {formatPaise(totalDr)} · Cr {formatPaise(totalCr)}
            {!balanced && totalDr + totalCr > 0 && (
              <span className="text-cr"> · off by {formatPaise(Math.abs(totalDr - totalCr))}</span>
            )}
          </p>
        </div>
      </div>

      {/* Long journals scroll inside a capped container; short ones stay unwrapped so the
          absolutely-positioned LedgerPicker dropdowns are never clipped. */}
      <LineTableScroller active={rows.length > 8} className="mt-4">
      <table className="ledger-table">
        <thead>
          <tr>
            <th className="w-20">Dr / Cr</th>
            <th>Particulars</th>
            <th className="r w-44">Amount</th>
            {hasCc && <th className="w-16"></th>}
          </tr>
        </thead>
        <tbody data-testid="rows-voucher-lines">
          {rows.map((r, i) => (
            <tr key={r.key}>
              <td>
                <button
                  className={`num w-12 rounded-md border border-line px-2 py-1 text-body-sm font-medium ${
                    r.drCr === 'dr' ? 'text-dr' : 'text-cr'
                  }`}
                  onClick={() => setRow(i, { drCr: r.drCr === 'dr' ? 'cr' : 'dr' })}
                  title="Toggle Dr/Cr"
                >
                  {r.drCr === 'dr' ? 'Dr' : 'Cr'}
                </button>
              </td>
              <td>
                <div className="flex items-center gap-1.5">
                  <LedgerPicker
                    value={r.ledgerId}
                    onPick={(id) => setRow(i, { ledgerId: id })}
                    autoFocus={i === 0 && !voucherId}
                    filter={
                      kind === 'contra'
                        ? (l, groups) => {
                            let g = groups.get(l.groupId)
                            while (g) {
                              if (['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(g.name)) return true
                              g = g.parentId ? groups.get(g.parentId) : undefined
                            }
                            return false
                          }
                        : undefined
                    }
                    onCreateRequest={(name) => setQuickLedger({ name, row: i })}
                    className="flex-1"
                  />
                  {(() => {
                    const rowLedger = r.ledgerId != null ? ledgers.find((l) => l.id === r.ledgerId) : null
                    return rowLedger && isPartyLedger(rowLedger, groupMap) ? (
                      <Button variant="ghost" className="shrink-0 px-2 py-1 text-caption" onClick={() => setEditingParty(rowLedger)}>
                        Edit
                      </Button>
                    ) : null
                  })()}
                </div>
              </td>
              <td className="r">
                <AmountInput
                  paise={r.amount}
                  onPaise={(p) => setRow(i, { amount: p })}
                />
              </td>
              {hasCc && (
                <td className="r">
                  {r.ledgerId != null && (
                    <button className="text-caption text-blue hover:underline" onClick={() => setCcModalRow(i)}>
                      CC{r.costAllocations.length ? ` (${r.costAllocations.length})` : ''}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          <tr className="total-row">
            <td></td>
            <td>Total</td>
            <td className="r">
              <span className="num">{formatPaise(Math.max(totalDr, totalCr))}</span>
            </td>
            {hasCc && <td></td>}
          </tr>
        </tbody>
      </table>
      </LineTableScroller>

      {voucher && voucher.inventory.length > 0 && (
        <p className="mt-3 text-small text-muted">
          This voucher carries {voucher.inventory.length} stock line{voucher.inventory.length > 1 ? 's' : ''}; they are kept as-is when you save.
        </p>
      )}

      {features.tds && tdsSuggestion && !tdsDismissed && (
        <div className="mt-3 rounded-md border border-amber/40 bg-amberbar/10 px-3 py-2 text-body-sm text-amber">
          <div className="flex items-center justify-between gap-3">
            <span>
              TDS u/s {tdsSuggestion.code}: deduct <Money paise={tdsSuggestion.tdsPaise} className="text-amber" />
              {!tdsSuggestion.panAvailable && <span className="ml-2 text-cr">PAN missing — 20% rate</span>}
              {!tdsSuggestion.thresholdCrossed && <span className="ml-2 text-muted">(below threshold — applying anyway is your call)</span>}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => setTdsDismissed(true)}>Dismiss</Button>
              <Button variant="primary" disabled={tdsApplyBlocked} onClick={() => void applyTds()}>
                Apply
              </Button>
            </div>
          </div>
          {tdsApplyBlocked && (
            <p className="mt-1.5 text-cr">
              Apply would unbalance: the {formatPaise(tdsTargetIdx === -1 ? 0 : (rows[tdsTargetIdx]?.amount ?? 0), { symbol: true })} line
              can&apos;t absorb {formatPaise(tdsSuggestion.tdsPaise, { symbol: true })} TDS — adjust lines manually.
            </p>
          )}
        </div>
      )}

      {showBillsSection && (
        <div className="mt-4 border-t border-line pt-3">
          <button
            className="flex items-center gap-1.5 text-caption font-semibold tracking-[0.08em] text-muted uppercase"
            onClick={() => setBillsOpen((v) => !v)}
          >
            <span className="inline-block w-3 text-micro">{billsOpen ? '▾' : '▸'}</span>
            Bill allocation
            <span className="normal-case text-muted">
              {' '}
              · allocated {formatPaise(billAllocatedTotal)} / {formatPaise(partyLineTotal)}
            </span>
          </button>
          {billsOpen && (
            <div className="mt-2">
              {isCheckboxBills ? (
                (openBills ?? []).length === 0 ? (
                  <p className="text-small text-muted">No open bills for this party.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {(openBills ?? []).map((b) => {
                      const ref = billRefs.find((r) => r.kind === 'against' && r.name === b.number)
                      return (
                        <div key={b.number} className="flex items-center gap-3 rounded-md px-1 py-1 text-body-sm hover:bg-panel2">
                          <input type="checkbox" checked={!!ref} onChange={(e) => toggleBill(b, e.target.checked)} />
                          <span className="flex-1">{b.number}</span>
                          <span className="num w-24 text-muted">{toDisplayDate(b.date)}</span>
                          <span className={`num w-24 ${b.overdueDays > 0 ? 'text-cr' : 'text-muted'}`}>
                            {b.dueDate ? toDisplayDate(b.dueDate) : '—'}
                          </span>
                          <Money paise={b.pending} className="w-24 text-right" />
                          {ref && (
                            <AmountInput paise={ref.amount} onPaise={(p) => setBillRefAmount(b.number, p ?? 0)} className="w-28" />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              ) : (
                <div className="flex flex-col gap-1.5">
                  {billRefs.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Select
                        value={r.kind}
                        onChange={(e) => setManualBillRef(i, { kind: e.target.value as 'new' | 'against' })}
                        className="w-32"
                      >
                        <option value="new">New bill</option>
                        <option value="against">Against</option>
                      </Select>
                      <TextInput value={r.name} onChange={(e) => setManualBillRef(i, { name: e.target.value })} placeholder="Bill name" className="flex-1" />
                      <AmountInput paise={r.amount} onPaise={(p) => setManualBillRef(i, { amount: p ?? 0 })} className="w-28" />
                      <DateInput
                        value={r.dueDate ?? date}
                        context={date}
                        onChange={(d) => setManualBillRef(i, { dueDate: d })}
                        className="w-32"
                      />
                      <button className="text-small text-cr" onClick={() => removeManualBillRef(i)}>
                        ×
                      </button>
                    </div>
                  ))}
                  <Button onClick={addManualBillRef} className="self-start">
                    + Add bill ref
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className={`mt-4 ${kind === 'payment' || kind === 'receipt' ? 'grid grid-cols-3 gap-3' : ''}`}>
        <div className={kind === 'payment' || kind === 'receipt' ? 'col-span-2' : ''}>
          <Field label="Narration">
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being amount paid…" />
          </Field>
        </div>
        {(kind === 'payment' || kind === 'receipt') && (
          <Field label="Cheque / UTR no." hint="Shows up in bank reconciliation">
            <TextInput value={instrumentNo} onChange={(e) => setInstrumentNo(e.target.value)} className="num" />
          </Field>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-6 text-body-sm">
        {kind === 'receipt' && (
          <label className={`flex items-center gap-2 ${derivedPartyId == null ? 'text-muted' : ''}`}>
            <input
              type="checkbox"
              data-testid="input-advance-receipt"
              checked={advanceReceipt}
              disabled={derivedPartyId == null}
              onChange={(e) => setAdvanceReceipt(e.target.checked)}
            />
            Advance receipt — unallocated amount is reported under GSTR-1 11A
            {derivedPartyId == null && <span className="text-caption">(needs a party line)</span>}
          </label>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="input-optional-voucher"
            checked={optionalVoucher}
            onChange={(e) => setOptionalVoucher(e.target.checked)}
          />
          Optional (memorandum) voucher — never counts toward the books
        </label>
      </div>

      <div className="mt-5 flex justify-between">
        <div>{voucherId && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          {voucherId && kind === 'payment' && bankCrLine && (
            <>
              <Button onClick={() => void printCheque()}>Print cheque</Button>
              <Button onClick={() => void printAdvice()}>Payment advice</Button>
            </>
          )}
          {voucherId && TRADING_KINDS.includes(kind) && (
            <Button data-testid="btn-voucher-transport" onClick={() => setShowTransport(true)}>
              Transport / e-way details…
            </Button>
          )}
          <Button onClick={() => nav.back()}>Cancel</Button>
          <Button variant="primary" data-testid="btn-save-voucher" disabled={!balanced || saving} onClick={() => void save()}>
            {voucherId ? 'Save changes' : 'Save voucher'} ⌘↵
          </Button>
        </div>
      </div>

      {quickLedger && (
        <QuickLedgerModal
          name={quickLedger.name}
          suggestParty={null}
          suggestAccount={null}
          onClose={() => setQuickLedger(null)}
          onCreated={(l) => {
            setRow(quickLedger.row, { ledgerId: l.id })
            setQuickLedger(null)
          }}
        />
      )}
      {ccModalRow != null && (
        <CostAllocModal
          lineAmount={rows[ccModalRow]?.amount ?? 0}
          centres={ccList ?? []}
          initial={rows[ccModalRow]?.costAllocations ?? []}
          onClose={() => setCcModalRow(null)}
          onSave={(allocations) => setRow(ccModalRow, { costAllocations: allocations })}
        />
      )}
      {showTransport && voucherId && (
        <TransportModal voucherId={voucherId} voucherNumber={voucher?.number} onClose={() => setShowTransport(false)} />
      )}
      {editingParty && <LedgerFormModal ledger={editingParty} onClose={() => setEditingParty(null)} />}
    </Panel>
  )
}
