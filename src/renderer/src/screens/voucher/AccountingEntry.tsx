import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger, Voucher, VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import {
  applyTdsToAccountingRows, appliedTdsAmount, buildAccountingPayload, derivePartyId, tdsStateFromSaved,
  type AccountingFormState, type AccountingRowState
} from '@shared/voucherEdit'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../../lib/client'
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
import { useTcsCollection, useTdsDeduction } from './useTdsDeduction'
import { TdsBanner, TdsNotApplicableNote } from './TdsBanner'
import { CarriedStockLines } from './CarriedStockLines'

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
  // The suggestion/apply state lives in the shared useTdsDeduction hook (InvoiceEntry uses the
  // same one); this mode only decides which line gives up the deduction. A deduction whose
  // payable ledger doesn't exist yet stays `pending` — shown as a read-only credit below the
  // rows and created by saveVoucher inside the save (tds.autoPayable), never on Apply.
  const [initialTds] = useState(() =>
    initial?.tds
      ? tdsStateFromSaved(initial.tds, initial.rows, initial.original?.partyLedgerId ?? null, (id) => ledgers.find((l) => l.id === id)?.tdsPayableSectionId)
      : null
  )

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

  // (TDS hook below needs rows/ledgers first; totals include a pending TDS payable credit.)

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

  // The dr-side (payment: "Dr Vendor / Cr Bank") is checked first; journal additionally checks
  // the cr side, since the standard journal shape is "Dr Expense / Cr Vendor(flagged)" — the
  // vendor never appears as a debit there. `rowSide` records which one matched, since it decides
  // both the suggestion's base amount and which line absorbs the deduction on Apply.
  //
  // For the cr shape, `amount` is reconstructed back to the GROSS pre-deduction figure (current
  // row amount + whatever a prior Apply already carved out of it) rather than read live off the
  // row — Apply reduces that same row, so reading it live would drift the suggestion base down
  // to the net amount and silently under-deduct on a re-apply. The payment/dr shape reduces a
  // different (bank) line, so its candidate amount never moves on its own.
  const [tds, setTds] = useState(initialTds)
  const alreadyApplied = appliedTdsAmount(rows, tds)
  // WP 3.2: a payment to any supplier (not only one flagged for a section) asks too — the server
  // offers TDS on its bills that were not deducted when booked (first-of-credit-or-payment) and
  // returns nothing otherwise; a journal crediting a supplier asks with the debited expense
  // ledger, whose default section applies when the party has none.
  const tdsCandidateRow = useMemo(() => {
    if (kind !== 'payment' && kind !== 'journal') return null
    const ledgerOf = (id: number | null): Ledger | undefined => (id == null ? undefined : ledgers.find((x) => x.id === id))
    const deductee = (l: Ledger | undefined, loose: boolean): boolean => !!l && (l.tdsSectionId != null || (loose && isPartyLedger(l, groupMap)))
    const largestExpense = (): number | null => {
      let best: { id: number; amount: number } | null = null
      for (const r of rows) {
        if (r.drCr !== 'dr' || r.ledgerId == null || !r.amount) continue
        const l = ledgerOf(r.ledgerId)
        if (!l || isPartyLedger(l, groupMap) || isCashOrBankLedger(l, groupMap) || l.tdsPayableSectionId != null) continue
        if (!best || r.amount > best.amount) best = { id: r.ledgerId, amount: r.amount }
      }
      return best?.id ?? null
    }
    for (const loose of [false, true]) {
      if (kind === 'journal' && loose) break
      for (const r of rows) {
        if (r.drCr !== 'dr' || r.ledgerId == null || !r.amount) continue
        if (deductee(ledgerOf(r.ledgerId), loose && kind === 'payment')) return { ledgerId: r.ledgerId, amount: r.amount, rowSide: 'dr' as const, expenseLedgerId: null }
      }
    }
    if (kind === 'journal') {
      for (const loose of [false, true]) {
        for (const r of rows) {
          if (r.drCr !== 'cr' || r.ledgerId == null || !r.amount) continue
          if (deductee(ledgerOf(r.ledgerId), loose)) {
            return { ledgerId: r.ledgerId, amount: r.amount + alreadyApplied, rowSide: 'cr' as const, expenseLedgerId: largestExpense() }
          }
        }
      }
    }
    return null
  }, [rows, kind, ledgers, groupMap, alreadyApplied])

  const tdsDeduction = useTdsDeduction({
    enabled: features.tds,
    candidate: tdsCandidateRow
      ? { partyLedgerId: tdsCandidateRow.ledgerId, base: tdsCandidateRow.amount, expenseLedgerId: tdsCandidateRow.expenseLedgerId }
      : null,
    date,
    excludeVoucherId: voucherId,
    voucherKind: kind === 'payment' ? 'payment' : 'journal',
    tds,
    onChange: setTds,
    startDismissed: !!initialTds
  })
  const tdsSuggestion = tdsDeduction.suggestion

  // ---------- TCS (WP 3.3): a receipt from a buyer collects TCS on the sales not collected on when
  // invoiced (and on advances) — the TCS rides ON TOP of the consideration: the bank / cash debit
  // grows by it and the section's TCS payable ledger is credited; the buyer's credit is the
  // consideration received.
  const [tcs, setTcs] = useState(() =>
    initial?.tcs
      ? tdsStateFromSaved(initial.tcs, initial.rows, initial.original?.partyLedgerId ?? null, (id) => ledgers.find((l) => l.id === id)?.tcsPayableSectionId)
      : null
  )
  const [initialHadTcs] = useState(!!initial?.tcs)
  const tcsPartyCredit = useMemo(() => {
    if (kind !== 'receipt' || derivedPartyId == null) return 0
    return rows.filter((r) => r.drCr === 'cr' && r.ledgerId === derivedPartyId).reduce((s, r) => s + (r.amount ?? 0), 0)
  }, [kind, rows, derivedPartyId])
  const tcsCollection = useTcsCollection({
    enabled: features.tcs && kind === 'receipt',
    candidate: derivedPartyId != null && tcsPartyCredit > 0 ? { partyLedgerId: derivedPartyId, voucherKind: 'receipt', taxablePaise: tcsPartyCredit } : null,
    date,
    excludeVoucherId: voucherId,
    tcs,
    onChange: setTcs,
    startDismissed: initialHadTcs
  })
  const tcsSuggestion = tcsCollection.suggestion
  // The largest cash / bank debit takes the TCS on top.
  const tcsTargetIdx = useMemo(() => {
    let idx = -1
    let max = -1
    rows.forEach((r, i) => {
      if (r.drCr !== 'dr' || r.ledgerId == null) return
      const l = ledgers.find((x) => x.id === r.ledgerId)
      if (l && isCashOrBankLedger(l, groupMap) && (r.amount ?? 0) > max) {
        max = r.amount ?? 0
        idx = i
      }
    })
    return idx
  }, [rows, ledgers, groupMap])
  const applyTcs = (manualPaise?: number): void => {
    if (!tcsSuggestion || tcsTargetIdx === -1) return
    const previous = tcs
    const next = manualPaise == null ? tcsCollection.apply() : tcsCollection.applyManual(manualPaise)
    if (!next) return
    setRows((rs) => {
      const out = applyTdsToAccountingRows(rs, {
        targetIdx: tcsTargetIdx,
        tdsAmount: next.tdsAmount,
        payableLedgerId: next.payableLedgerId,
        previous,
        direction: 'increase',
        makeRow: (ledgerId, amount): AcctRow => ({ key: nextLineKey(), drCr: 'cr', ledgerId, amount, costAllocations: [] })
      })
      if (out[out.length - 1]!.ledgerId != null) out.push(blankAcctRow('cr'))
      return out
    })
  }

  const pendingTdsCredit = (tds?.pending ? tds.tdsAmount : 0) + (tcs?.pending ? tcs.tdsAmount : 0)
  const totalDr = rows.reduce((s, r) => s + (r.drCr === 'dr' ? (r.amount ?? 0) : 0), 0)
  const totalCr = rows.reduce((s, r) => s + (r.drCr === 'cr' ? (r.amount ?? 0) : 0), 0) + pendingTdsCredit
  const balanced = totalDr === totalCr && totalDr > 0

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

  // Capacity of the target line = its current amount plus whatever a prior Apply carved out.
  const tdsTargetCapacity = tdsTargetIdx === -1 ? 0 : (rows[tdsTargetIdx]!.amount ?? 0) + alreadyApplied
  const tdsApplyBlocked = !!tdsSuggestion && (tdsTargetIdx === -1 || tdsTargetCapacity < tdsSuggestion.tdsPaise)

  const applyTds = (manualPaise?: number): void => {
    if (!tdsCandidateRow || !tdsSuggestion || tdsTargetIdx === -1) return
    if (manualPaise == null ? tdsApplyBlocked : tdsTargetCapacity <= manualPaise) return
    const previous = tds
    const next = manualPaise == null ? tdsDeduction.apply() : tdsDeduction.applyManual(manualPaise)
    if (!next) return
    setRows((rs) => {
      const out = applyTdsToAccountingRows(rs, {
        targetIdx: tdsTargetIdx,
        tdsAmount: next.tdsAmount,
        payableLedgerId: next.payableLedgerId,
        previous,
        makeRow: (ledgerId, amount): AcctRow => ({ key: nextLineKey(), drCr: 'cr', ledgerId, amount, costAllocations: [] })
      })
      if (out[out.length - 1]!.ledgerId != null) out.push(blankAcctRow('cr'))
      return out
    })
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

  // WP 2.3: the carried stock lines' godown / batch / serials are editable (everything else verbatim).
  const [stockLines, setStockLines] = useState(() => initial?.original?.inventory ?? [])
  const setStockLine = (i: number, patch: Partial<(typeof stockLines)[number]>): void =>
    setStockLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)))

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
      tds: tds
        ? { sectionId: tds.sectionId, baseAmount: tds.baseAmount, tdsAmount: tds.tdsAmount, isManual: tds.isManual, autoPayable: tds.pending }
        : null,
      tcs: tcs
        ? { sectionId: tcs.sectionId, baseAmount: tcs.baseAmount, tdsAmount: tcs.tdsAmount, isManual: tcs.isManual, autoPayable: tcs.pending }
        : null,
      original: initial?.original ? { ...initial.original, inventory: stockLines } : null
    }),
    [date, voucherId, alterNumber, numberField.forPayload, rows, narration, instrumentNo, billRefs, advanceReceipt, optionalVoucher, tds, tcs, initial, stockLines]
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
      const saved = await api.vouchers.save(input, voucherId, voucherId ? undefined : draft?.aiDraftId)
      await tdsDeduction.afterSave(saved.id)
      if (features.tcs && kind === 'receipt') await tcsCollection.afterSave(saved.id)
      toast.push('success', `${saved.number} ${voucherId ? 'altered' : 'saved'}`)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      // An AI draft is used up by its save — go back to where the user came from.
      if (voucherId || draft?.aiDraftId) leave()
      else {
        setRows([blankAcctRow('dr'), blankAcctRow('cr')])
        setNarration('')
        setBillRefs([])
        setAdvanceReceipt(false)
        setOptionalVoucher(false)
        tdsDeduction.reset()
        tcsCollection.reset()
        numberField.reset()
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, buildPayload, date, typeId, voucherId, toast, setWorkingDate, queryClient, leave, numberField.reset, tdsDeduction.reset, tdsDeduction.afterSave, tcsCollection.reset, tcsCollection.afterSave, features.tcs, kind, draft?.aiDraftId])

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
          {tds?.pending && (
            <tr data-testid="row-tds-pending">
              <td>
                <span className="num inline-block w-12 px-2 py-1 text-body-sm font-medium text-cr">Cr</span>
              </td>
              <td className="text-body-sm">
                {tdsSuggestion?.payableLedgerName ?? 'TDS payable'}{' '}
                <span className="text-caption text-muted">— ledger created when you save</span>
              </td>
              <td className="r">
                <Money paise={tds.tdsAmount} />
              </td>
              {hasCc && <td></td>}
            </tr>
          )}
          {tcs?.pending && (
            <tr data-testid="row-tcs-pending">
              <td>
                <span className="num inline-block w-12 px-2 py-1 text-body-sm font-medium text-cr">Cr</span>
              </td>
              <td className="text-body-sm">
                {tcsSuggestion?.payableLedgerName ?? 'TCS payable'}{' '}
                <span className="text-caption text-muted">— ledger created when you save</span>
              </td>
              <td className="r">
                <Money paise={tcs.tdsAmount} />
              </td>
              {hasCc && <td></td>}
            </tr>
          )}
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

      {voucher && stockLines.length > 0 && (
        features.inventory ? (
          <CarriedStockLines lines={stockLines} onChange={setStockLine} voucherId={voucherId} />
        ) : (
          <p className="mt-3 text-small text-muted">
            This voucher carries {stockLines.length} stock line{stockLines.length > 1 ? 's' : ''}; they are kept as-is when you save.
          </p>
        )
      )}

      {features.tcs && kind === 'receipt' && tcsCollection.notApplicable != null && !tcs && (
        <TdsNotApplicableNote kind="tcs" reason={tcsCollection.notApplicable} onUndo={() => tcsCollection.setNotApplicable(null)} />
      )}
      {features.tcs && tcsSuggestion && !tcsCollection.dismissed && tcsCollection.notApplicable == null && (
        <TdsBanner
          kind="tcs"
          suggestion={tcsSuggestion}
          onDismiss={tcsCollection.dismiss}
          onApply={() => applyTcs()}
          onApplyManual={(p) => applyTcs(p)}
          onChooseSection={(id) => tcsCollection.chooseSection(id)}
          onNotApplicable={tcs ? undefined : (r) => tcsCollection.setNotApplicable(r)}
          blockedReason={tcsTargetIdx === -1 ? 'The receipt needs a cash or bank debit to add the TCS to.' : null}
        />
      )}
      {features.tds && tdsDeduction.notApplicable != null && !tds && (
        <TdsNotApplicableNote reason={tdsDeduction.notApplicable} onUndo={() => tdsDeduction.setNotApplicable(null)} />
      )}
      {features.tds && tdsSuggestion && !tdsDeduction.dismissed && tdsDeduction.notApplicable == null && (
        <TdsBanner
          suggestion={tdsSuggestion}
          onDismiss={tdsDeduction.dismiss}
          onApply={() => applyTds()}
          onApplyManual={(p) => applyTds(p)}
          onChooseSection={(id) => tdsDeduction.chooseSection(id)}
          onNotApplicable={tds ? undefined : (r) => tdsDeduction.setNotApplicable(r)}
          blockedReason={
            tdsApplyBlocked
              ? `Apply would unbalance: the ${formatPaise(tdsTargetIdx === -1 ? 0 : (rows[tdsTargetIdx]?.amount ?? 0), { symbol: true })} line can't absorb ${formatPaise(tdsSuggestion.tdsPaise, { symbol: true })} TDS — adjust lines manually.`
              : null
          }
        />
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
