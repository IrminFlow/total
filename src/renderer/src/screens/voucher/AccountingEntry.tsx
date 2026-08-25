import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger, VoucherBillRef, VoucherKind } from '@shared/domain'
import type { OutstandingBill } from '@shared/reports'
import type { VoucherInputParsed } from '@shared/schemas'
import { formatPaise } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api, type TdsSuggestion } from '../../lib/client'
import { useNav, useSession, useToasts, type VoucherDraft } from '../../state/stores'
import { matchByName, parseAcctPaste } from '@shared/gridPaste'
import { roundOffLine } from '@shared/roundOff'
import { describeAge, useVoucherDraft } from '../../lib/voucherDraft'
import { useScreenAccels } from '../../lib/screenAccels'
import { useVoucherCustomFields } from './CustomFields'
import {
  AmountInput,
  Button,
  DateInput,
  Field,
  LineTableScroller,
  Money,
  Panel,
  RowAction,
  Select,
  TextInput
} from '../../components/ui'
import { useKeyLayer } from '../../lib/keyboard'
import { useFieldChain } from '../../lib/useFieldChain'
import { LedgerPicker, useGroups, useLedgers, useTaxLedgers } from '../../components/pickers'
import { LedgerFormModal } from '../../components/LedgerFormModal'
import { useFeatures } from '../../lib/useFeatures'
import { confirmDialog } from '../../lib/dialogs'
import { suggestNarration } from '@shared/autoNarration'
import { useUnsavedGuard } from '../../lib/useUnsavedGuard'
import { isBankLedger, isCashOrBankLedger, isPartyLedger, nextLineKey, NUMBER_LOADING, TRADING_KINDS, useVoucherNumberField } from './hooks'
import { CostAllocModal, QuickLedgerModal, SaveAsRecurringModal, SaveAsTemplateModal, TemplatePickerModal } from './modals'
import { TransportModal } from './TransportModal'

// ---------- accounting mode (payment / receipt / contra / journal + alteration) ----------

interface AcctRow {
  /** Stable React key — survives applyTds splicing a payable line in mid-list (never an index). */
  key: number
  drCr: 'dr' | 'cr'
  ledgerId: number | null
  amount: number | null
  costAllocations: { costCentreId: number; amount: number }[]
  /** Account name from a pasted spreadsheet row that matched no ledger. Kept so the amount is not
   *  thrown away with the name: the row stays, unresolved, with the name offered for creation. */
  pastedName?: string
}

const blankAcctRow = (drCr: 'dr' | 'cr'): AcctRow => ({ key: nextLineKey(), drCr, ledgerId: null, amount: null, costAllocations: [] })

/** Everything about a half-entered accounting voucher that is worth surviving a crash. React keys
 *  are deliberately absent — they are regenerated on restore, and a stale one would collide. */
interface AcctDraftState {
  date: string
  number: string
  narration: string
  instrumentNo: string
  rows: { drCr: 'dr' | 'cr'; ledgerId: number | null; amount: number | null; pastedName?: string }[]
}

export function AccountingEntry({
  typeId,
  kind,
  voucherId,
  draft
}: {
  typeId: number
  kind: VoucherKind
  voucherId?: number
  draft?: VoucherDraft
}): React.JSX.Element {
  const { workingDate, setWorkingDate, from: periodFrom, to: periodTo } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const ledgers = useLedgers()
  const { ensureRoundOff } = useTaxLedgers()
  const groups = useGroups()
  const groupMap = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const [date, setDate] = useState(draft?.date ?? workingDate)
  const [rows, setRows] = useState<AcctRow[]>(
    draft?.lines?.length
      ? [...draft.lines.map((l) => ({ ...l, key: nextLineKey(), costAllocations: [] as AcctRow['costAllocations'] })), blankAcctRow('cr')]
      : [blankAcctRow('dr'), blankAcctRow('cr')]
  )
  const [narration, setNarration] = useState(draft?.narration ?? '')
  const [instrumentNo, setInstrumentNo] = useState('')
  const [quickLedger, setQuickLedger] = useState<{ name: string; row: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showRecurring, setShowRecurring] = useState(false)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showTransport, setShowTransport] = useState(false)
  const [editingParty, setEditingParty] = useState<Ledger | null>(null)
  // Alteration keeps the voucher's own number editable but never auto-suggests a fresh one off
  // voucher:nextNumber (that would rename an existing document to "the next available number"
  // the moment you touch its date) — it's seeded once from the loaded voucher below. New-entry
  // mode uses the touched/refetch hook instead, same as InvoiceEntry.
  const [alterNumber, setAlterNumber] = useState('')
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  const [draftPartyId] = useState(draft?.partyLedgerId ?? null)

  const { data: existing } = useQuery({
    queryKey: ['voucher', voucherId],
    queryFn: () => api.vouchers.get(voucherId!),
    enabled: !!voucherId
  })

  // The company's own fields for this voucher type (roadmap #195). They ride on the save payload,
  // so a value that fails validation refuses the whole voucher rather than half-writing it.
  const customFields = useVoucherCustomFields(typeId, existing)

  // ---------- TDS (payment / journal to a party flagged for TDS) ----------
  const [tds, setTds] = useState<{ sectionId: number; baseAmount: number; tdsAmount: number } | null>(null)
  const [tdsSuggestion, setTdsSuggestion] = useState<TdsSuggestion | null>(null)
  const [tdsDismissed, setTdsDismissed] = useState(false)
  // Set right before WE mutate rows in a way that would otherwise re-trigger the suggestion
  // effect (applying TDS onto the flagged CR row itself, or loading a voucher that already has
  // tds applied) — the effect consumes it once and skips, so the banner doesn't re-fetch/reopen
  // off of our own write. Genuine user edits always leave it false and behave normally.
  const skipNextTdsEffectRef = useRef(false)

  // ---------- bill allocations (receipt/payment checkbox list; trading-kind alteration editor) ----------
  const [billRefs, setBillRefs] = useState<VoucherBillRef[]>([])
  const [billsOpen, setBillsOpen] = useState(true)

  // ---------- GST / book-keeping flags ----------
  // Advance receipt (GSTR-1 11A): the unallocated remainder of the party line goes out as a
  // 'new' bill ref, which is exactly what gst.extractAdvances counts. Optional = memorandum.
  const [advanceReceipt, setAdvanceReceipt] = useState(false)
  const [optionalVoucher, setOptionalVoucher] = useState(false)

  // ---------- per-line cost-centre allocation ----------
  const { data: ccList } = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list })
  const hasCc = features.costCentres && (ccList?.length ?? 0) > 0
  const [ccModalRow, setCcModalRow] = useState<number | null>(null)

  useEffect(() => {
    if (existing && !loaded) {
      setDate(existing.date)
      setAlterNumber(existing.number)
      setNarration(existing.narration ?? '')
      setInstrumentNo(existing.instrumentNo ?? '')
      setRows(existing.lines.map((l) => ({ key: nextLineKey(), drCr: l.drCr, ledgerId: l.ledgerId, amount: l.amount, costAllocations: l.costAllocations })))
      setBillRefs(existing.billRefs)
      setOptionalVoucher(existing.isOptional)
      setTds(existing.tds)
      if (existing.tds) {
        setTdsDismissed(true)
        skipNextTdsEffectRef.current = true
      }
      setLoaded(true)
    }
  }, [existing, loaded])

  const totalDr = rows.reduce((s, r) => s + (r.drCr === 'dr' ? (r.amount ?? 0) : 0), 0)
  const totalCr = rows.reduce((s, r) => s + (r.drCr === 'cr' ? (r.amount ?? 0) : 0), 0)
  const balanced = totalDr === totalCr && totalDr > 0

  /** The paise-sized plug this voucher needs, or null when it balances or is out by real money. */
  const roundOff = roundOffLine(totalDr, totalCr)

  // Unsaved-entry guard for NEW vouchers only (save resets the form). Alterations are exempt:
  // rows are seeded from the stored voucher, so content alone can't distinguish edited from
  // pristine — guarding them would also fire on the programmatic nav.back() after save.
  const dirty = rows.some((r) => r.ledgerId != null || (r.amount ?? 0) !== 0) || narration.trim() !== ''
  useUnsavedGuard(!voucherId && dirty)

  /**
   * Crash recovery for a half-typed voucher.
   *
   * New vouchers only. An alteration's fields are seeded from a voucher that is already on the
   * books, so a "restore" there would offer back an edit the operator may have deliberately
   * abandoned — and the stored voucher, not the draft, is the truth.
   *
   * The state is serialised through a string so the effect fires on a real change rather than on
   * every render's fresh object identity.
   */
  const { slug } = useSession()
  const draftState: AcctDraftState = {
    date,
    number: voucherId ? alterNumber : numberField.forPayload,
    narration,
    instrumentNo,
    rows: rows.map((r) => ({ drCr: r.drCr, ledgerId: r.ledgerId, amount: r.amount, pastedName: r.pastedName }))
  }
  const draftSignature = JSON.stringify(draftState)
  const recovery = useVoucherDraft<AcctDraftState>(slug, `acct-${kind}`, draftState, draftSignature, {
    enabled: !voucherId,
    isEmpty: !dirty
  })
  const restoreDraft = (): void => {
    const d = recovery.offered?.state
    if (!d) return
    setDate(d.date)
    setNarration(d.narration)
    setInstrumentNo(d.instrumentNo)
    if (d.number) numberField.onChange(d.number)
    setRows([
      ...d.rows.map((r) => ({ ...r, key: nextLineKey(), costAllocations: [] as AcctRow['costAllocations'] })),
      blankAcctRow('cr')
    ])
    recovery.dismiss()
  }

  /**
   * Load a saved template's shape into the form (#27).
   *
   * The DATE is deliberately not touched. The template carries the form's current date already
   * (TemplatePickerModal passes it in), and overwriting what the user typed a moment ago with
   * anything else would be the one surprise a template must not spring — a voucher posted into
   * the wrong month is invisible until the month is closed.
   *
   * The number is not touched either: it is allocated against the series for whatever date the
   * voucher ends up carrying, at save time.
   */
  const applyTemplate = (shape: VoucherInputParsed): void => {
    setNarration(shape.narration ?? '')
    setInstrumentNo(shape.instrumentNo ?? '')
    setRows([
      ...shape.lines.map((l) => ({
        key: nextLineKey(),
        drCr: l.drCr,
        ledgerId: l.ledgerId,
        amount: l.amount,
        costAllocations: l.costAllocations ?? []
      })),
      blankAcctRow('cr')
    ])
  }


  const setRow = (i: number, patch: Partial<AcctRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      const last = next[next.length - 1]!
      if (last.ledgerId != null) next.push(blankAcctRow('cr'))
      return next
    })
  }

  // ---------- keyboard editing of the grid (⌥↑/↓, ⌘⌫, ⌥R) ----------

  /**
   * Which line the cursor is in.
   *
   * Read off the DOM rather than tracked in state on purpose: focus already moves between the
   * Dr/Cr button, the ledger picker and the amount field by half a dozen routes (Enter-chaining,
   * Tab, a click, a dropdown closing), and a second copy of "where the cursor is" would be wrong
   * every time one of them changed without telling us.
   */
  const focusedRow = (): number => {
    const el = document.activeElement as HTMLElement | null
    const tr = el?.closest?.('tr[data-line-index]') as HTMLElement | null
    const n = tr ? Number(tr.dataset.lineIndex) : NaN
    return Number.isInteger(n) ? n : -1
  }

  /** Put the cursor back in the same COLUMN of a (possibly moved) row, after React repaints. */
  const refocus = (rowIndex: number, cellIndex: number): void => {
    requestAnimationFrame(() => {
      const tr = formRef.current?.querySelector<HTMLElement>(`tr[data-line-index="${rowIndex}"]`)
      const cell = tr?.children[cellIndex] as HTMLElement | undefined
      cell?.querySelector<HTMLElement>('input, button, select')?.focus()
    })
  }

  /**
   * ⌥↑ / ⌥↓ — move this line up or down.
   *
   * Order is not arithmetic: a voucher reads as a document, and "Dr Expense / Cr Bank" in the
   * wrong order is the same posting printed wrongly. Until now the only way to reorder was to
   * retype both lines.
   */
  const moveRow = (delta: -1 | 1): void => {
    const i = focusedRow()
    const j = i + delta
    const el = document.activeElement as HTMLElement | null
    const cellIndex = el?.closest('td') ? Array.prototype.indexOf.call(el.closest('tr')!.children, el.closest('td')) : 0
    setRows((rs) => {
      if (i < 0 || j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
    if (i >= 0 && j >= 0) refocus(j, cellIndex)
  }

  /**
   * ⌘⌫ — delete this line, offering it straight back.
   *
   * No confirm: the undo IS the confirm, and a dialog for removing one line of a voucher that is
   * not saved yet is friction on the commonest correction there is. Restoring puts the line back
   * where it was rather than at the end — a line that reappears somewhere else has not been
   * undone.
   */
  const deleteRow = (): void => {
    const i = focusedRow()
    const removed = rows[i]
    // The trailing blank is scaffolding, not a line; and a voucher needs somewhere to type.
    if (!removed || rows.length <= 2 || (removed.ledgerId == null && removed.amount == null)) return
    setRows((rs) => rs.filter((_, j) => j !== i))
    const name = ledgers.find((l) => l.id === removed.ledgerId)?.name ?? 'Line'
    toast.push('info', `${name} removed`, {
      label: 'Undo',
      run: () => setRows((rs) => [...rs.slice(0, i), removed, ...rs.slice(i)])
    })
    refocus(Math.max(0, i - 1), 1)
  }

  /**
   * ⌥R — repeat the last filled line.
   *
   * Entering twenty branch expenses against the same ledger, or twenty receipts of the same
   * amount, is the shape of a day's work in a small business. Copying the whole line (side,
   * ledger, amount) rather than just the ledger is deliberate: the amount is the field most
   * likely to be right already, and it is one keystroke to change if it is not.
   */
  const repeatLastLine = (): void => {
    const source = [...rows].reverse().find((r) => r.ledgerId != null)
    if (!source) return
    setRows((rs) => {
      const insertAt = rs[rs.length - 1]!.ledgerId == null ? rs.length - 1 : rs.length
      const copy: AcctRow = { ...source, key: nextLineKey(), costAllocations: [...source.costAllocations] }
      const next = [...rs.slice(0, insertAt), copy, ...rs.slice(insertAt)]
      if (next[next.length - 1]!.ledgerId != null) next.push(blankAcctRow('cr'))
      return next
    })
  }

  /**
   * Paste a block of lines from a spreadsheet.
   *
   * Only intercepted when the clipboard actually holds a TABLE — a tab or a line break. Pasting
   * a single ledger name or an amount into a field has to keep working exactly as it does, and it
   * is by far the commoner paste.
   *
   * Names are matched exactly (see matchByName); anything unmatched keeps its amount and its
   * name, and shows an inline offer to create the ledger. Dropping those rows would be worse
   * than useless: the operator would have to find which of forty lines went missing.
   */
  const onGridPaste = (e: React.ClipboardEvent): void => {
    const text = e.clipboardData.getData('text/plain')
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return
    e.preventDefault()
    const { lines, skipped } = parseAcctPaste(text)
    if (lines.length === 0) {
      return void toast.push('error', skipped.length ? `Nothing to paste — ${skipped[0]!.reason}` : 'Nothing to paste')
    }
    let unmatched = 0
    const pasted: AcctRow[] = lines.map((l) => {
      const ledger = matchByName(l.name, ledgers)
      if (!ledger) unmatched++
      return {
        key: nextLineKey(),
        // A sheet with one money column says nothing about the side; a debit is the safer
        // default to land on because it is what the first line of a voucher usually is.
        drCr: l.drCr ?? 'dr',
        ledgerId: ledger?.id ?? null,
        amount: l.amount,
        costAllocations: [],
        pastedName: ledger ? undefined : l.name
      }
    })
    setRows((rs) => {
      const kept = rs.filter((r) => r.ledgerId != null || (r.amount ?? 0) !== 0)
      return [...kept, ...pasted, blankAcctRow('cr')]
    })
    const parts = [`${pasted.length} line${pasted.length === 1 ? '' : 's'} pasted`]
    if (unmatched) parts.push(`${unmatched} account${unmatched === 1 ? '' : 's'} not found`)
    if (skipped.length) parts.push(`${skipped.length} row${skipped.length === 1 ? '' : 's'} skipped (${skipped[0]!.reason})`)
    toast.push(unmatched || skipped.length ? 'warning' : 'success', parts.join(' · '))
  }

  // A voucher's "party" for TDS/bill-allocation purposes: whichever posted ledger is a Sundry
  // Debtor/Creditor or is flagged for TDS. Falls back to a draft-supplied party (e.g. the GSTR-2B
  // "Create purchase" nudge) when the rows don't yet name one unambiguously.
  const derivedPartyId = useMemo(() => {
    const candidates = new Set<number>()
    for (const r of rows) {
      if (r.ledgerId == null) continue
      const l = ledgers.find((x) => x.id === r.ledgerId)
      if (!l) continue
      if (isPartyLedger(l, groupMap) || l.tdsSectionId != null) candidates.add(l.id)
    }
    if (candidates.size === 1) return [...candidates][0]!
    return draftPartyId
  }, [rows, ledgers, groupMap, draftPartyId])
  // The same content, kept on disk so a crash does not take it (roadmap #250). New vouchers only,
  // for the same reason the guard above skips alterations: an altered voucher is already in the
  // books, and offering to "recover" it later would offer to re-enter something that exists.

  /**
   * A narration written from what the voucher already says.
   *
   * The party is named separately from the rest, so "Paid Office Rent to Landlord" reads the way
   * a person would say it rather than listing the party among the accounts.
   */
  const suggestedNarration = useMemo(() => {
    const party = ledgers.find((l) => l.id === derivedPartyId)
    const accountNames = rows
      .map((r) => ledgers.find((l) => l.id === r.ledgerId))
      .filter((l): l is NonNullable<typeof l> => !!l)
      // Cash and bank are how it was paid, not what it was for; tax ledgers are bookkeeping.
      .filter((l) => l.id !== derivedPartyId && l.taxType == null && !isCashOrBankLedger(l, groupMap))
      .map((l) => l.name)
    return suggestNarration({ kind, partyName: party?.name ?? null, accountNames })
  }, [rows, ledgers, derivedPartyId, groupMap, kind])

  // How much of a prior Apply is already sitting in the TDS payable line — i.e. how much the
  // target line has already been reduced (the cumulative reduction on the target always equals
  // the current payable line's amount; see applyTds). Declared before tdsCandidateRow because
  // the journal vendor-CR shape needs it to reconstruct the pre-deduction gross amount below.
  const existingTdsPayableAmount = useMemo(() => {
    if (!tds || !tdsSuggestion) return 0
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
        // The voucher being edited must not consume its own Rule 28AA headroom: its lines are
        // already in the books, so without excluding it a re-opened voucher deducts more the
        // second time than it did the first.
        .suggest(tdsCandidateRow.ledgerId, tdsCandidateRow.amount, date, existing?.id)
        .then((s) => {
          setTdsSuggestion(s)
          // The suggestion's payable ledger is find-or-created server-side — refresh so it shows
          // up by name the moment Apply inserts it as a line.
          if (s) void queryClient.invalidateQueries({ queryKey: ['ledgers'] })
        })
        .catch(() => setTdsSuggestion(null))
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tdsCandidateRow?.ledgerId, tdsCandidateRow?.amount, date])

  const applyTds = (): void => {
    // tdsTargetIdx === -1 is already implied by tdsApplyBlocked today, but checked explicitly
    // too — mirrors the setRows updater's own guard so a future change to the blocked condition
    // can't set the tds payload without the corresponding line mutation.
    if (!tdsCandidateRow || !tdsSuggestion || tdsApplyBlocked || tdsTargetIdx === -1) return
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
      const existingIdx = tds ? next.findIndex((r) => r.drCr === 'cr' && r.ledgerId === tdsSuggestion.payableLedgerId) : -1
      if (existingIdx !== -1) {
        const delta = tdsAmount - (next[existingIdx]!.amount ?? 0)
        next[existingIdx] = { ...next[existingIdx]!, amount: tdsAmount }
        next[targetIdx] = { ...next[targetIdx]!, amount: (next[targetIdx]!.amount ?? 0) - delta }
        return next
      }

      next[targetIdx] = { ...next[targetIdx]!, amount: (next[targetIdx]!.amount ?? 0) - tdsAmount }
      const insertAt = next.length > 0 && next[next.length - 1]!.ledgerId == null ? next.length - 1 : next.length
      const tdsRow: AcctRow = { key: nextLineKey(), drCr: 'cr', ledgerId: tdsSuggestion.payableLedgerId, amount: tdsAmount, costAllocations: [] }
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

  /**
   * Add the round-off line.
   *
   * Offered, never automatic. A voucher that silently gains a line the operator did not type is
   * a voucher they cannot check, and the whole reason this is safe is that the difference is
   * visibly a few paise — which they can only see if we show it to them first.
   */
  const addRoundOff = async (): Promise<void> => {
    if (!roundOff) return
    try {
      const ledgerId = await ensureRoundOff()
      setRows((rs) => {
        const insertAt = rs[rs.length - 1]!.ledgerId == null ? rs.length - 1 : rs.length
        const line: AcctRow = { key: nextLineKey(), drCr: roundOff.drCr, ledgerId, amount: roundOff.amount, costAllocations: [] }
        const next = [...rs.slice(0, insertAt), line, ...rs.slice(insertAt)]
        if (next[next.length - 1]!.ledgerId != null) next.push(blankAcctRow('cr'))
        return next
      })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  /**
   * The cost centre this party's lines belong to, from the party ledger's own default.
   *
   * Applied at build time rather than written into each row as it is typed: an allocation stored
   * on the row would have to be kept in step with every amount edit, and the first time it fell
   * behind the voucher would post a cost allocation that no longer matched its own line.
   *
   * Excluded: the party line itself (a receivable is not a cost), tax ledgers (bookkeeping), and
   * cash/bank (how it was paid, not what it was for) — the same three exclusions the narration
   * suggestion makes, for the same reason.
   */
  const partyDefaultCc = useMemo(() => {
    if (!features.costCentres || derivedPartyId == null) return null
    const party = ledgers.find((l) => l.id === derivedPartyId)
    const ccId = party?.defaultCostCentreId ?? null
    if (ccId == null || !(ccList ?? []).some((c) => c.id === ccId)) return null
    return { id: ccId, name: (ccList ?? []).find((c) => c.id === ccId)!.name, partyName: party!.name }
  }, [features.costCentres, derivedPartyId, ledgers, ccList])

  const allocationsFor = useCallback(
    (r: AcctRow): AcctRow['costAllocations'] => {
      if (r.costAllocations.length > 0) return r.costAllocations
      if (!partyDefaultCc || r.ledgerId == null || r.ledgerId === derivedPartyId || !r.amount) return r.costAllocations
      const ledger = ledgers.find((l) => l.id === r.ledgerId)
      if (!ledger || ledger.taxType != null || isCashOrBankLedger(ledger, groupMap)) return r.costAllocations
      return [{ costCentreId: partyDefaultCc.id, amount: r.amount }]
    },
    [partyDefaultCc, derivedPartyId, ledgers, groupMap]
  )

  // Builds the exact VoucherInputParsed shape `save` posts — factored out so "Save as
  // recurring…" can serialize the current form state without also saving the voucher itself.
  const buildPayload = useCallback((): VoucherInputParsed | null => {
    const lines = rows
      .filter((r) => r.ledgerId != null && r.amount != null && r.amount > 0)
      .map((r) => ({ ledgerId: r.ledgerId!, drCr: r.drCr, amount: r.amount!, costAllocations: allocationsFor(r) }))
    if (lines.length < 2) return null
    const effectivePartyId = derivedPartyId ?? existing?.partyLedgerId ?? null
    const refs = effectivePartyId != null ? [...billRefs] : []
    if (kind === 'receipt' && advanceReceipt && effectivePartyId != null) {
      const remainder = partyLineTotal - refs.reduce((s, r) => s + r.amount, 0)
      if (remainder > 0) {
        refs.push({
          kind: 'new',
          name: (voucherId ? alterNumber : numberField.forPayload).trim() || 'Advance',
          amount: remainder,
          dueDate: null
        })
      }
    }
    return {
      voucherTypeId: typeId,
      date,
      number: (voucherId ? alterNumber.trim() : numberField.forPayload) || undefined,
      partyLedgerId: effectivePartyId,
      narration: narration.trim() || null,
      reference: null,
      instrumentNo: instrumentNo.trim() || null,
      instrumentDate: instrumentNo.trim() ? date : null,
      transporterId: existing?.transporterId ?? null,
      vehicleNo: existing?.vehicleNo ?? null,
      transportDistanceKm: existing?.transportDistanceKm ?? null,
      // Preserve an existing override on alteration; the edit UI itself is Wave-3 (S4).
      posOverride: existing?.posOverride ?? null,
      gstRegistrationId: existing?.gstRegistrationId ?? null,
      currencyCode: existing?.currencyCode ?? null,
      exchangeRate: existing?.exchangeRate ?? null,
      isOptional: optionalVoucher,
      lines,
      inventory: existing?.inventory.map((l) => ({
        stockItemId: l.stockItemId, godownId: l.godownId, qtyMilli: l.qtyMilli,
        ratePaise: l.ratePaise, amount: l.amount, direction: l.direction
      })) ?? [],
      billRefs: refs,
      tds: tds && effectivePartyId != null ? tds : null,
      customFields: customFields.values
    }
  }, [customFields.values, rows, derivedPartyId, existing, kind, typeId, date, voucherId, alterNumber, numberField.forPayload, narration, instrumentNo, billRefs, advanceReceipt, optionalVoucher, partyLineTotal, tds, allocationsFor])

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
      // Dated outside the working period: it saves correctly, but every report on screen is
      // scoped to that period, so it would look as though the voucher had vanished.
      if (input.date < periodFrom || input.date > periodTo) {
        const proceed = await confirmDialog({
          title: 'Outside the open period',
          message: `${toDisplayDate(input.date)} is outside the working period (${toDisplayDate(periodFrom)} to ${toDisplayDate(periodTo)}). It will save correctly, but will not show in reports until you change the period. Save it?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
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
      // A draft the assistant proposed is joined to its run only now, after a human pressed Save.
      // The link records what a person did, so it cannot be written before they did it.
      if (draft?.aiRunId) {
        try {
          await api.ai.linkVoucher(draft.aiRunId, saved.id)
        } catch {
          // Provenance, not books: failing to record it must not fail the save.
        }
      }
      // In the books now, so the crash-safe copy of it must go — a draft that outlives its entry
      // is a prompt to re-type something already saved (roadmap #45 / #250).
      recovery.clear()
      toast.push('success', `${saved.number} ${voucherId ? 'altered' : 'saved'}`)
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (voucherId) nav.back()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, buildPayload, date, typeId, voucherId, toast, setWorkingDate, queryClient, nav, numberField.reset])

  // ⌘↵ = save now, skipping the Accept bar. A modal pushes an opaque layer above this one, so
  // a dialog's own ⌘↵ can no longer reach the voucher underneath it.
  useKeyLayer('screen', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return false
    e.preventDefault()
    void save()
    return true
  })

  /**
   * The grid's own editing keys, declared through the accelerator registry so the hint bar and
   * the `?` overlay describe exactly what is bound.
   *
   * ⌥ rather than ⌘ for the move keys: ⌘↑/↓ is "top and bottom of the document" everywhere else
   * on macOS, and ⌥↑/↓ is what every editor uses to move a line. ⌘⌫ is the system's delete.
   */
  useScreenAccels('voucher-entry', [
    {
      match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'ArrowUp',
      display: ['⌥↑'],
      hintHidden: true,
      label: 'Move this line up',
      when: () => focusedRow() > 0,
      run: () => moveRow(-1)
    },
    {
      match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && e.key === 'ArrowDown',
      display: ['⌥↓'],
      hintHidden: true,
      label: 'Move this line down',
      when: () => focusedRow() >= 0 && focusedRow() < rows.length - 1,
      run: () => moveRow(1)
    },
    {
      match: (e) => (e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete'),
      display: ['⌘⌫'],
      hintHidden: true,
      label: 'Delete this line',
      run: deleteRow
    },
    {
      // `code`, not `key` — the one place in this app where that is right. Holding Option on
      // macOS makes the browser report ⌥R as `®` and ⌥O as `ø`, so a `key` comparison would
      // never fire on the platform the app is built for. Physical keys are what ⌥ chords mean.
      match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyR',
      display: ['⌥R'],
      hintHidden: true,
      label: 'Repeat the last line',
      when: () => rows.some((r) => r.ledgerId != null),
      run: repeatLastLine
    },
    {
      // See the ⌥R note above: `code` because macOS rewrites the character under Option.
      match: (e) => e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyO',
      display: ['⌥O'],
      hintHidden: true,
      label: 'Add round-off',
      when: () => roundOff != null,
      run: () => void addRoundOff()
    }
  ])

  // Tally Enter-chaining: Enter walks the fields, and Enter past the last one raises the
  // "Accept?" bar rather than saving outright — the operator still confirms, as in Tally.
  const formRef = useRef<HTMLDivElement>(null)
  const [accepting, setAccepting] = useState(false)
  const chain = useFieldChain(formRef, { onAccept: () => setAccepting(true) })

  useKeyLayer(
    'screen',
    (e) => {
      if (!accepting) return false
      if (e.key === 'Enter' || e.key.toLowerCase() === 'y') {
        e.preventDefault()
        setAccepting(false)
        void save()
        return true
      }
      if (e.key === 'Escape' || e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setAccepting(false)
        return true
      }
      return false
    },
    { enabled: accepting }
  )

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
      // The bin has always been able to restore this; it just was not offered at the one moment
      // the user is looking for it. Restoring goes through the same voucher:restore the Bin
      // screen calls, so an undone delete is indistinguishable from one undone there.
      toast.push('success', 'Moved to Bin', {
        label: 'Undo',
        run: async () => {
          try {
            await api.vouchers.restore(voucherId)
            await queryClient.invalidateQueries()
            toast.push('success', 'Voucher restored')
          } catch (err) {
            toast.push('error', `Could not restore: ${(err as Error).message}`)
          }
        }
      })
      await queryClient.invalidateQueries()
      nav.back()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  // ---------- cheque printing + payment advice (saved payment vouchers only) ----------
  const bankCrLine = useMemo(() => {
    if (!voucherId || kind !== 'payment' || !existing) return null
    let best: { ledgerId: number; amount: number } | null = null
    for (const l of existing.lines) {
      if (l.drCr !== 'cr') continue
      const ledger = ledgers.find((x) => x.id === l.ledgerId)
      if (ledger && isBankLedger(ledger, groupMap) && (!best || l.amount > best.amount)) {
        best = { ledgerId: l.ledgerId, amount: l.amount }
      }
    }
    return best
  }, [voucherId, kind, existing, ledgers, groupMap])

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
    <Panel className="p-5" ref={formRef} {...chain.containerProps}>
      <div className="grid grid-cols-4 gap-3">
        <Field label="No." hint={voucherId || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            data-testid="input-voucher-number"
            value={voucherId ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => (voucherId ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className="num"
          />
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end justify-end gap-3">
          <p className={`num text-body-sm ${balanced ? 'text-dr' : 'text-muted'}`}>
            Dr {formatPaise(totalDr)} · Cr {formatPaise(totalCr)}
            {!balanced && totalDr + totalCr > 0 && (
              <span className="text-cr"> · off by {formatPaise(Math.abs(totalDr - totalCr))}</span>
            )}
          </p>
          {roundOff && (
            <Button data-testid="btn-round-off" onClick={() => void addRoundOff()}>
              Round off {formatPaise(roundOff.amount)} ⌥O
            </Button>
          )}
        </div>
      </div>

      {/* Offered above the form, not applied to it: a voucher that fills itself in from a week-old
          draft without asking is indistinguishable, to the person looking at it, from one that
          has invented its own contents. */}
      {recovery.offered && (
        <div
          data-testid="draft-restore-bar"
          className="mt-3 flex items-center justify-between gap-4 rounded-md border border-accent/40 bg-accent/10 px-4 py-2.5"
        >
          <p className="text-body-sm text-ink">
            An unsaved {kind} voucher from {describeAge(recovery.offered.savedAt)} is still here —{' '}
            {recovery.offered.state.rows.filter((r) => r.ledgerId != null).length} line(s).
          </p>
          <span className="flex shrink-0 gap-2">
            <Button data-testid="btn-draft-restore" variant="primary" onClick={restoreDraft}>
              Restore it
            </Button>
            <Button onClick={recovery.clear}>Discard</Button>
          </span>
        </div>
      )}

      {partyDefaultCc && (
        <p className="mt-2 text-hint text-muted" data-testid="hint-party-cc">
          Lines with no allocation of their own go to <b>{partyDefaultCc.name}</b> — {partyDefaultCc.partyName}&rsquo;s
          default cost centre.
        </p>
      )}

      {/* Long journals scroll inside a capped container; short ones stay unwrapped so the
          absolutely-positioned LedgerPicker dropdowns are never clipped. */}
      {/* onPaste on the wrapper, not on each field: the event bubbles from whichever cell has
          focus, and a table paste is about the grid rather than about one input. */}
      <LineTableScroller active={rows.length > 8} className="mt-4" onPaste={onGridPaste}>
      <table className="ledger-table" data-testid="voucher-grid">
        <thead>
          <tr>
            <th scope="col" className="w-20">Dr / Cr</th>
            <th scope="col">Particulars</th>
            <th scope="col" className="r w-44">Amount</th>
            {hasCc && <th scope="col" className="w-16"></th>}
          </tr>
        </thead>
        <tbody data-testid="rows-voucher-lines">
          {rows.map((r, i) => (
            <tr key={r.key} data-line-index={i}>
              <td>
                <button
                  data-chain="drcr"
                  className={`num w-12 rounded-md border border-line px-2 py-1 text-body-sm font-medium ${
                    r.drCr === 'dr' ? 'text-dr' : 'text-cr'
                  }`}
                  onClick={() => setRow(i, { drCr: r.drCr === 'dr' ? 'cr' : 'dr' })}
                  onKeyDown={(e) => {
                    // D and C set the side outright; Space flips it. Enter is left to the chain.
                    const k = e.key.toLowerCase()
                    if (k === 'd' || k === 'c') {
                      e.preventDefault()
                      setRow(i, { drCr: k === 'd' ? 'dr' : 'cr' })
                    } else if (e.key === ' ') {
                      e.preventDefault()
                      setRow(i, { drCr: r.drCr === 'dr' ? 'cr' : 'dr' })
                    }
                  }}
                  title="Toggle Dr/Cr — D or C sets it, Space flips it"
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
                  {r.pastedName && r.ledgerId == null && (
                    <button
                      data-testid="btn-create-pasted-ledger"
                      className="shrink-0 rounded-md border border-accent/50 px-2 py-1 text-caption text-accent"
                      onClick={() => setQuickLedger({ name: r.pastedName!, row: i })}
                      title="Pasted from a spreadsheet — no ledger of this name exists yet"
                    >
                      Create “{r.pastedName}”
                    </button>
                  )}
                  {(() => {
                    const rowLedger = r.ledgerId != null ? ledgers.find((l) => l.id === r.ledgerId) : null
                    return rowLedger && isPartyLedger(rowLedger, groupMap) ? (
                      <RowAction className="shrink-0 px-2 py-1 text-caption" onClick={() => setEditingParty(rowLedger)}>
                        Edit
                      </RowAction>
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
                    <button
                      className={`text-caption hover:underline ${
                        r.costAllocations.length === 0 && allocationsFor(r).length > 0 ? 'text-muted' : 'text-blue'
                      }`}
                      onClick={() => setCcModalRow(i)}
                      title={
                        r.costAllocations.length === 0 && allocationsFor(r).length > 0
                          ? `Inherited from the party — ${partyDefaultCc?.name}`
                          : 'Allocate this line across cost centres'
                      }
                    >
                      CC{r.costAllocations.length ? ` (${r.costAllocations.length})` : allocationsFor(r).length ? ' ·' : ''}
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

      {existing && existing.inventory.length > 0 && (
        <p className="mt-3 text-small text-muted">
          This voucher carries {existing.inventory.length} stock line{existing.inventory.length > 1 ? 's' : ''}; they are kept as-is when you save.
        </p>
      )}

      {features.tds && tdsSuggestion && !tdsDismissed && (
        <div className="mt-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-body-sm text-accent">
          <div className="flex items-center justify-between gap-3">
            <span>
              TDS u/s {tdsSuggestion.code}: deduct <Money paise={tdsSuggestion.tdsPaise} className="text-accent" />
              {!tdsSuggestion.panAvailable && <span className="ml-2 text-cr">PAN missing — 20% rate</span>}
              {!tdsSuggestion.thresholdCrossed && <span className="ml-2 text-muted">(below threshold — applying anyway is your call)</span>}
              {/* A section 197 certificate silently changes the number above; say so, and say when
                  the payment straddles its Rule 28AA ceiling and is therefore deducted at two
                  rates — that is two deductee rows in the quarterly return, not one. */}
              {tdsSuggestion.certificate && (
                <span className="block text-hint text-muted">
                  s.197 certificate {tdsSuggestion.certificate.certificateNumber} at{' '}
                  {tdsSuggestion.certificate.ratePercent}%
                  {tdsSuggestion.ratesApplied.length > 1 &&
                    ` — ₹ split across the ceiling: ${tdsSuggestion.ratesApplied
                      .map((r) => `${r.ratePercent}% on ${formatPaise(r.basePaise, { symbol: true })}`)
                      .join(' + ')}`}
                  {tdsSuggestion.certificateExhausted && ' — ceiling now spent'}
                </span>
              )}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => setTdsDismissed(true)}>Dismiss</Button>
              <Button variant="primary" disabled={tdsApplyBlocked} onClick={applyTds}>
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
            <span className="inline-block w-3 text-label">{billsOpen ? '▾' : '▸'}</span>
            Bill allocation
            <span className="normal-case text-muted/80">
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
            <TextInput
              data-testid="input-narration"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              onFocus={() => {
                // Offered when the field is reached, never over something already typed.
                if (!narration && suggestedNarration) setNarration(suggestedNarration)
              }}
              placeholder={suggestedNarration ?? 'Being amount paid…'}
            />
          </Field>
        </div>
        {(kind === 'payment' || kind === 'receipt') && (
          <Field label="Cheque / UTR no." hint="Shows up in bank reconciliation">
            <TextInput value={instrumentNo} onChange={(e) => setInstrumentNo(e.target.value)} className="num" />
          </Field>
        )}
      </div>

      {/* The company's own fields for this voucher type (roadmap #195). Nothing here is money. */}
      {customFields.node}

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
          <Button data-testid="btn-templates-open" onClick={() => setShowTemplates(true)}>
            Templates…
          </Button>
          {balanced && <Button onClick={() => setShowRecurring(true)}>Save as recurring…</Button>}
          {balanced && (
            <Button data-testid="btn-save-template-open" onClick={() => setShowSaveTemplate(true)}>
              Save as template…
            </Button>
          )}
          <Button onClick={() => nav.back()}>Cancel</Button>
          <Button variant="primary" data-testid="btn-save-voucher" disabled={!balanced || saving} onClick={() => void save()}>
            {voucherId ? 'Save changes' : 'Save voucher'} ⌘↵
          </Button>
        </div>
      </div>

      {/* Tally's "Accept?" prompt, raised by pressing Enter past the last field. Inline rather
          than a Modal on purpose: a modal would push an opaque keyboard layer and break the
          flow the operator is in, and Tally's own accept prompt is inline too. */}
      {accepting && (
        <div
          data-testid="voucher-accept-bar"
          className="mt-3 flex items-center justify-between gap-4 rounded-md border border-accentbar/60 bg-accentbar/15 px-4 py-2.5"
        >
          <span className="text-detail">
            {totalDr + totalCr === 0
              ? 'Nothing entered yet — fill in the lines above.'
              : balanced
                ? `Accept this voucher? ${formatPaise(Math.max(totalDr, totalCr))}`
                : `Not balanced — off by ${formatPaise(Math.abs(totalDr - totalCr))}`}
          </span>
          <span className="flex items-center gap-2">
            <Button
              data-testid="btn-voucher-accept"
              variant="primary"
              disabled={!balanced || saving}
              onClick={() => {
                setAccepting(false)
                void save()
              }}
            >
              Yes ↵
            </Button>
            <Button onClick={() => setAccepting(false)}>No · Esc</Button>
          </span>
        </div>
      )}

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
      {showRecurring && <SaveAsRecurringModal buildPayload={buildPayload} onClose={() => setShowRecurring(false)} />}
      {showSaveTemplate && (
        <SaveAsTemplateModal
          voucherTypeId={typeId}
          buildPayload={buildPayload}
          onClose={() => setShowSaveTemplate(false)}
        />
      )}
      {showTemplates && (
        <TemplatePickerModal
          voucherTypeId={typeId}
          date={date}
          onClose={() => setShowTemplates(false)}
          onPick={applyTemplate}
        />
      )}
      {showTransport && voucherId && (
        <TransportModal voucherId={voucherId} voucherNumber={existing?.number} onClose={() => setShowTransport(false)} />
      )}
      {editingParty && <LedgerFormModal ledger={editingParty} onClose={() => setEditingParty(null)} />}
    </Panel>
  )
}
