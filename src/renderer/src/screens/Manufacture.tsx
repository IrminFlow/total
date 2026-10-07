import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Voucher } from '@shared/domain'
import { formatPaise } from '@shared/money'
import { autoManufactureNarration, bomFromRows, needsLossConfirmation, rowsFromBom, RAW_ROWS_VISIBLE } from '@shared/manufacture'
import {
  blankManufactureRow, emptyManufactureState, evaluateManufactureForm, manufactureFormKey, parseQtyMilli, qtyText,
  type ManufactureFormState, type ManufactureRowState
} from '@shared/voucherEdit'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  AmountInput, Button, Checkbox, DateInput, DrawerSection, Field, isAnyModalOpen, Kbd, Money, Page, PageHeader, Panel,
  Select, SkeletonRows, TextInput, inputCls
} from '../components/ui'
import { ItemPicker, LedgerPicker, useStockItems } from '../components/pickers'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { nextLineKey, NUMBER_LOADING, useLeaveAfterSave, useVoucherNumberField } from './voucher/hooks'

// ---------- Manufacture voucher (WP 2.2) ----------
// Left "Sale Item": one row — Item · Quantity · Average price · Amount. Right "Raw Material":
// ten rows from the start — Raw Material · Quantity · Average cost (engine, as of the voucher
// date, read-only) · Amount; then Labour, Production cost and Profit (= sale amount − production
// cost, live). Finished goods enter stock at production cost; sale price and profit are margin
// facts only. Form state ⇄ save input: @shared/voucherEdit/manufacture; rules: @shared/manufacture.

interface Row extends ManufactureRowState {
  key: number
}

const withKey = (r: ManufactureRowState): Row => ({ ...r, key: nextLineKey() })
const keyed = (rows: ManufactureRowState[]): Row[] => rows.map(withKey)
const padRows = (rows: Row[]): Row[] => {
  const out = [...rows]
  while (out.length < RAW_ROWS_VISIBLE) out.push(withKey(blankManufactureRow()))
  return out
}
const isBlank = (r: ManufactureRowState): boolean => r.itemId == null && r.qtyText.trim() === ''

/** Enter moves to the next field of the form (pickers keep Enter for picking). */
function focusNextField(from: HTMLElement): void {
  const form = from.closest('[data-manufacture-form]')
  if (!form) return
  const fields = [...form.querySelectorAll<HTMLElement>('[data-mfg-nav]')].filter((el) => !(el as HTMLInputElement).disabled)
  const i = fields.indexOf(from)
  fields[i + 1]?.focus()
}
const enterNext = (e: React.KeyboardEvent<HTMLElement>): void => {
  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    focusNextField(e.currentTarget)
  }
}

/** The Manufacture screen (sidebar → Manufacture, Alt+F7): a new manufacture voucher. Saved ones
 *  open through voucher entry, which renders the same form. */
export function ManufactureScreen(): React.JSX.Element {
  const nav = useNav()
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const sj = types?.find((t) => t.kind === 'stock_journal')
  return (
    <Page width="wide">
      <PageHeader
        title="Manufacture"
        subtitle="Finished goods enter stock at production cost"
        secondary={
          <Button variant="ghost" data-testid="btn-manufacture-register" onClick={() => nav.go({ name: 'manufacture-register' })}>
            Manufacture register
          </Button>
        }
        options={{
          content: (
            <>
              <DrawerSection title="Reports">
                <Button data-testid="btn-manufacture-open-register" onClick={() => nav.go({ name: 'manufacture-register' })}>
                  Manufacture register — margins by voucher
                </Button>
              </DrawerSection>
              <DrawerSection title="Keyboard">
                <ul className="flex flex-col gap-1 text-detail text-ink">
                  <li><Kbd>Alt</Kbd>+<Kbd>F7</Kbd> open Manufacture (Gateway, voucher entry)</li>
                  <li><Kbd>↵</Kbd> next field · <Kbd>Tab</Kbd> through rows</li>
                  <li><Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back</li>
                </ul>
              </DrawerSection>
            </>
          )
        }}
      />
      {types && !sj && <p className="text-body-sm text-danger">No stock journal voucher type — add one in Masters → Voucher types.</p>}
      {!types ? (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      ) : (
        sj && <ManufactureForm typeId={sj.id} />
      )}
    </Page>
  )
}

export function ManufactureForm({
  typeId,
  voucherId,
  voucher,
  initial
}: {
  typeId: number
  voucherId?: number
  voucher?: Voucher
  /** Alteration: the form reconstructed from the voucher + its manufacture_details row. */
  initial?: ManufactureFormState
}): React.JSX.Element {
  const isEdit = voucherId != null
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const itemName = useCallback((id: number): string => items.find((i) => i.id === id)?.name ?? '', [items])
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const { data: godowns } = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list })
  const unitOf = (itemId: number | null): string => {
    const item = items.find((i) => i.id === itemId)
    return units?.find((u) => u.id === item?.unitId)?.symbol ?? ''
  }

  const [base] = useState(() => initial ?? emptyManufactureState(workingDate))
  const [date, setDate] = useState(base.date)
  const [alterNumber, setAlterNumber] = useState(base.number)
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  /** Bumped on reset-after-save to remount the amount inputs (each owns its text). */
  const [formRev, setFormRev] = useState(0)
  const [godownId, setGodownId] = useState<number | null>(base.godownId)
  const [narration, setNarration] = useState(base.narration)
  const [finishedItemId, setFinishedItemId] = useState<number | null>(base.finishedItemId)
  const [qty, setQty] = useState(base.qtyText)
  const [saleRate, setSaleRate] = useState<number | null>(base.saleRatePaise)
  /** Bumped to remount the sale-rate AmountInput (it owns its text) after a prefill. */
  const [saleRateRev, setSaleRateRev] = useState(0)
  const saleRateTouched = useRef(isEdit)
  const [labour, setLabour] = useState<number | null>(base.labourPaise)
  const [labourPosted, setLabourPosted] = useState(base.labourPosted)
  const [creditId, setCreditId] = useState<number | null>(base.labourCreditLedgerId)
  const [rows, setRows] = useState<Row[]>(() => padRows(keyed(base.rows)))
  /** Rows came from the BOM and haven't been edited: a quantity change rescales them. */
  const bomRows = useRef(false)
  const [saving, setSaving] = useState(false)
  const { saved, leave } = useLeaveAfterSave()

  const state: ManufactureFormState = useMemo(
    () => ({
      date,
      number: isEdit ? alterNumber : numberField.forPayload,
      godownId,
      narration,
      finishedItemId,
      qtyText: qty,
      saleRatePaise: saleRate,
      labourPaise: labour,
      labourPosted,
      labourCreditLedgerId: labourPosted ? creditId : null,
      rows: rows.map(({ key: _k, ...r }) => r)
    }),
    [date, isEdit, alterNumber, numberField.forPayload, godownId, narration, finishedItemId, qty, saleRate, labour, labourPosted, creditId, rows]
  )

  // ---------- engine prices as of the voucher date ----------
  const previewLines = useMemo(
    () => state.rows.filter((r) => r.itemId != null).map((r) => ({ itemId: r.itemId!, qtyMilli: Math.max(0, parseQtyMilli(r.qtyText) ?? 0) })),
    [state.rows]
  )
  const previewKey = JSON.stringify(previewLines)
  const preview = useQuery({
    queryKey: ['manufacturePreview', date, voucherId ?? null, finishedItemId, previewKey],
    queryFn: () => api.manufacture.costPreview({ date, voucherId, finishedItemId, lines: previewLines }),
    placeholderData: keepPreviousData
  })
  // Only figures for exactly these rows count (placeholder data from the last keystroke doesn't).
  const fresh = !preview.isPlaceholderData && preview.data ? preview.data : null
  const priced = useMemo(() => {
    const out = new Map<number, { costPaise: number; unitCostPaise: number; onHandQtyMilli: number }>()
    const src = fresh ?? preview.data
    for (const l of src?.lines ?? []) out.set(l.itemId, l)
    return out
  }, [fresh, preview.data])
  const materialPaise = fresh ? fresh.totalPaise : previewLines.length === 0 ? 0 : undefined

  // Average price prefill: the finished item's average selling rate (FY sales → price list).
  useEffect(() => {
    if (saleRateTouched.current || !fresh || finishedItemId == null) return
    const suggested = fresh.saleRate.ratePaise
    if (suggested != null && suggested !== saleRate) {
      setSaleRate(suggested)
      setSaleRateRev((n) => n + 1)
    }
  }, [fresh, finishedItemId, saleRate])

  // ---------- BOM prefill ----------
  const { data: bom } = useQuery({
    queryKey: ['bom', finishedItemId],
    queryFn: () => api.bom.get(finishedItemId!),
    enabled: finishedItemId != null
  })
  const qtyMilli = parseQtyMilli(qty) ?? 0
  const scaleFrom = qtyMilli > 0 ? qtyMilli : 1000
  useEffect(() => {
    if (isEdit || !bom || bom.length === 0) return
    setRows((rs) => {
      const allBlank = rs.every(isBlank)
      if (!allBlank && !bomRows.current) return rs
      bomRows.current = true
      return padRows(keyed(rowsFromBom(bom, scaleFrom).map((r) => ({ itemId: r.stockItemId, qtyText: qtyText(r.qtyMilli), godownId: null }))))
    })
  }, [bom, scaleFrom, isEdit])

  const setRow = (i: number, patch: Partial<ManufactureRowState>): void => {
    bomRows.current = false
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      if (!isBlank(next[next.length - 1]!) && next.length >= RAW_ROWS_VISIBLE) next.push(withKey(blankManufactureRow()))
      return next
    })
  }
  const addRow = (): void => setRows((rs) => [...rs, withKey(blankManufactureRow())])

  // ---------- evaluation (every keystroke) ----------
  const ev = evaluateManufactureForm(state, { voucherTypeId: typeId, materialPaise, itemName })
  const { totals } = ev
  const issueByRow = new Map(ev.issues.filter((x) => x.row !== undefined).map((x) => [x.row!, x.message]))
  const pending = materialPaise === undefined
  const firstIssue = ev.issues[0]?.message ?? (pending ? 'Pricing raw materials…' : null)
  const canSave = !saving && !pending && ev.issues.length === 0
  // ✓ only for a complete voucher whose sides agree (an empty form isn't a "match").
  const matches = !pending && ev.issues.length === 0 && totals.rightTotal === totals.saleAmount

  // Content-based dirtiness: for a new voucher the suggested number and the date alone aren't
  // "changes" (same as the sibling entry forms); an alteration compares everything.
  const initialKey = useMemo(() => manufactureFormKey(base), [base])
  const numberTyped = !isEdit && numberField.touched
  const dirty =
    numberTyped || manufactureFormKey(isEdit ? state : { ...state, number: '', date: base.date }) !== initialKey
  useUnsavedGuard(!saved && dirty)

  const resetForm = (): void => {
    const fresh0 = emptyManufactureState(date)
    setFinishedItemId(null)
    setQty('')
    setSaleRate(null)
    setSaleRateRev((n) => n + 1)
    saleRateTouched.current = false
    setLabour(null)
    setNarration('')
    setRows(padRows(keyed(fresh0.rows)))
    bomRows.current = false
    numberField.reset()
    setFormRev((n) => n + 1)
  }

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    const current = evaluateManufactureForm(state, { voucherTypeId: typeId, materialPaise, itemName })
    if (materialPaise === undefined) return void toast.push('error', 'Still pricing the raw materials — try again in a moment')
    if (current.issues.length) return void toast.push('error', current.issues[0]!.message)
    let confirmLoss = false
    if (needsLossConfirmation(current.totals.profit)) {
      confirmLoss = await confirmDialog({
        title: 'Save at a loss?',
        message: `Production cost ${formatPaise(current.totals.productionCost, { symbol: true })} is more than the sale amount ${formatPaise(current.totals.saleAmount, { symbol: true })} — a loss of ${formatPaise(-current.totals.profit, { symbol: true })}. Save anyway?`,
        confirmLabel: 'Save at a loss',
        danger: true
      })
      if (!confirmLoss) return
    }
    setSaving(true)
    try {
      const number = current.input.number
      if (number && (await api.vouchers.numberExists(typeId, number, voucherId))) {
        const proceed = await confirmDialog({
          title: 'Duplicate number',
          message: `Voucher number ${number} is already used by another voucher of this type. Save anyway with the same number?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const result = await api.manufacture.save({ ...current.input, ...(confirmLoss ? { confirmLoss: true } : {}) }, voucherId)
      toast.push(
        'success',
        `Manufacture ${result.number} ${isEdit ? 'altered' : 'saved'} — ${formatPaise(result.manufacture.saleAmount - result.manufacture.profitPaise, { symbol: true })} into stock`
      )
      for (const w of result.warnings.negativeStock) {
        toast.push('error', `${w.name} goes negative (${w.closingQtyMilli / 1000} ${w.unitSymbol}) on ${date}`)
      }
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (isEdit) return leave()
      resetForm()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, state, typeId, materialPaise, itemName, toast, voucherId, isEdit, setWorkingDate, date, queryClient, leave])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
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
      message: 'Move this manufacture to the Bin? Its finished goods leave stock and its raw materials return. You can restore it from the bin for 30 days.',
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

  const bomCandidate = finishedItemId != null && ev.issues.length === 0 ? bomFromRows(ev.input.raw, ev.input.qtyMilli) : null
  const saveBom = async (): Promise<void> => {
    if (!bomCandidate || finishedItemId == null) return
    if (bom && bom.length > 0) {
      const ok = await confirmDialog({
        title: 'Replace the BOM?',
        message: `${itemName(finishedItemId)} already has a bill of materials (${bom.length} component${bom.length > 1 ? 's' : ''}). Replace it with these rows, per unit?`,
        confirmLabel: 'Replace BOM'
      })
      if (!ok) return
    }
    try {
      await api.bom.set({ itemId: finishedItemId, lines: bomCandidate })
      toast.push('success', `Saved as the BOM of ${itemName(finishedItemId)} (per unit)`)
      await queryClient.invalidateQueries({ queryKey: ['bom'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const autoNarration = finishedItemId != null && qtyMilli > 0 ? autoManufactureNarration(qtyMilli, itemName(finishedItemId)) : 'Manufactured N × Item'
  const finishedUnit = unitOf(finishedItemId)

  return (
    <div data-manufacture-form="" data-testid="manufacture-form" className="flex flex-col gap-section">
      <Panel className="p-5">
        <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,10rem)_minmax(0,12rem)_minmax(0,1fr)] gap-3">
          <Field label="No." hint={isEdit || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
            <TextInput
              value={isEdit ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value}
              onChange={(e) => (isEdit ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
              placeholder="Auto"
              className="num"
              data-testid="input-manufacture-number"
            />
          </Field>
          <Field label="Date">
            <DateInput value={date} context={workingDate} onChange={setDate} testId="input-manufacture-date" />
          </Field>
          <Field label="Godown">
            <Select
              value={godownId ?? ''}
              onChange={(e) => setGodownId(e.target.value === '' ? null : Number(e.target.value))}
              data-testid="input-manufacture-godown"
            >
              <option value="">— none —</option>
              {(godowns ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Narration">
            <TextInput
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              placeholder={autoNarration}
              data-testid="input-manufacture-narration"
            />
          </Field>
        </div>
      </Panel>

      <div className="grid grid-cols-[minmax(0,9fr)_minmax(0,11fr)] items-start gap-section">
        {/* ---------- LEFT: Sale Item ---------- */}
        <Panel className="p-4">
          <PanelTitle title="Sale Item" hint="What you made, at the price you sell it" />
          <table className="ledger-table" data-testid="manufacture-sale">
            <thead>
              <tr>
                <th>Item</th>
                <th className="r w-24">Quantity</th>
                <th className="r w-32 whitespace-nowrap">Average price</th>
                <th className="r w-28">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <ItemPicker
                    value={finishedItemId}
                    onPick={(id) => {
                      if (id !== finishedItemId) {
                        saleRateTouched.current = isEdit
                        if (!isEdit) {
                          setSaleRate(null)
                          setSaleRateRev((n) => n + 1)
                        }
                      }
                      setFinishedItemId(id)
                    }}
                    testId="picker-manufacture-item"
                  />
                </td>
                <td className="r">
                  <div className="flex items-center gap-1">
                    <input
                      className={`${inputCls} num text-right`}
                      data-testid="input-manufacture-qty"
                      data-mfg-nav=""
                      aria-label="Quantity manufactured"
                      value={qty}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) => setQty(e.target.value)}
                      onKeyDown={enterNext}
                    />
                    {finishedUnit && <span className="w-7 shrink-0 text-caption text-muted">{finishedUnit}</span>}
                  </div>
                </td>
                <td className="r" onKeyDown={enterNext}>
                  <AmountInput
                    key={`${formRev}-${saleRateRev}`}
                    paise={saleRate}
                    onPaise={(p) => {
                      saleRateTouched.current = true
                      setSaleRate(p)
                    }}
                    testId="input-manufacture-sale-rate"
                    ariaLabel="Average price"
                  />
                </td>
                <td className="r">
                  <Money paise={totals.saleAmount} className="text-body" />
                </td>
              </tr>
            </tbody>
          </table>
          {finishedItemId != null && fresh && !saleRateTouched.current && (
            <p className="mt-2 text-hint text-muted" data-testid="manufacture-sale-rate-source">
              {fresh.saleRate.source === 'sales'
                ? 'Average price: your average selling rate this year'
                : fresh.saleRate.source === 'priceList'
                  ? 'Average price: from the price list'
                  : 'No sales or price list for this item yet — enter the price'}
            </p>
          )}
          <dl className="num mt-4 text-detail">
            <SummaryLine label="Sale amount" paise={totals.saleAmount} testId="manufacture-left-total" strong />
          </dl>
          <p className="mt-3 text-hint text-muted">
            The sale price and profit are recorded for the margin register only. The finished goods enter stock at production cost.
          </p>
        </Panel>

        {/* ---------- RIGHT: Raw Material ---------- */}
        <Panel className="p-4">
          <div className="flex items-start justify-between gap-3">
            <PanelTitle title="Raw Material" hint="What it used — costed as of the voucher date" />
            <div className="flex shrink-0 gap-2">
              {bomCandidate && (
                <Button size="sm" variant="ghost" data-testid="btn-manufacture-save-bom" onClick={() => void saveBom()}>
                  Save these rows as the BOM
                </Button>
              )}
            </div>
          </div>
          {bom && bom.length > 0 && !isEdit && (
            <p className="mb-2 text-hint text-muted" data-testid="manufacture-bom-hint">
              Rows filled from the bill of materials{qtyMilli > 0 ? ` for ${qtyMilli / 1000}` : ' (per unit)'} — edit freely.
            </p>
          )}
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-8 text-muted">#</th>
                <th>Raw Material</th>
                <th className="r w-28">Quantity</th>
                <th className="r w-28 whitespace-nowrap">Average cost</th>
                <th className="r w-28">Amount</th>
              </tr>
            </thead>
            <tbody data-testid="rows-manufacture-raw">
              {rows.map((r, i) => {
                const p = r.itemId != null ? priced.get(r.itemId) : undefined
                const rowQty = parseQtyMilli(r.qtyText)
                const issue = issueByRow.get(i)
                return (
                  <tr key={r.key} data-testid="manufacture-raw-row" className={issue ? 'bg-danger-soft/40' : ''} title={issue}>
                    <td className="num text-caption text-muted">{i + 1}</td>
                    <td>
                      <ItemPicker value={r.itemId} onPick={(id) => setRow(i, { itemId: id })} testId={`picker-manufacture-raw-${i}`} />
                    </td>
                    <td className="r">
                      <div className="flex items-center gap-1">
                        <input
                          className={`${inputCls} num text-right ${issue ? 'border-danger/70' : ''}`}
                          data-testid={`input-manufacture-raw-qty-${i}`}
                          data-mfg-nav=""
                          aria-label={`Raw material ${i + 1} quantity`}
                          value={r.qtyText}
                          inputMode="decimal"
                          placeholder="0"
                          onChange={(e) => setRow(i, { qtyText: e.target.value })}
                          onKeyDown={enterNext}
                        />
                        <span className="w-7 shrink-0 text-caption text-muted">{unitOf(r.itemId)}</span>
                      </div>
                    </td>
                    <td className="r num text-body-sm text-muted" data-testid={`manufacture-raw-cost-${i}`}>
                      {p ? formatPaise(p.unitCostPaise) : '–'}
                    </td>
                    <td className="r" data-testid={`manufacture-raw-amount-${i}`}>
                      {p && rowQty ? <Money paise={p.costPaise} className="text-body" /> : <span className="text-muted">–</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="mt-2">
            <Button size="sm" variant="ghost" data-testid="btn-manufacture-add-row" onClick={addRow}>
              + Add row
            </Button>
          </div>

          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,17rem)] gap-6 border-t border-line pt-4">
            <div className="flex flex-col gap-3">
              <Field label="Labour cost">
                <span onKeyDown={enterNext} className="block w-40">
                  <AmountInput key={formRev} paise={labour} onPaise={setLabour} testId="input-manufacture-labour" />
                </span>
              </Field>
              <Checkbox
                label="Labour already booked"
                hint={labourPosted ? 'Off: this voucher posts Dr Labour Charges / Cr the account below.' : 'On: labour is added to the stock value only — no ledger entry here.'}
                checked={!labourPosted}
                onChange={(v) => setLabourPosted(!v)}
                testId="input-manufacture-labour-booked"
              />
              {labourPosted && (
                <Field label="Credit labour to">
                  <LedgerPicker value={creditId} onPick={setCreditId} placeholder="Wages Payable (default)" testId="picker-manufacture-labour-credit" />
                </Field>
              )}
            </div>
            <dl className="num text-detail">
              <SummaryLine label="Materials" paise={totals.materialPaise} testId="manufacture-materials" muted={pending} />
              <SummaryLine label="Labour" paise={totals.labourPaise} />
              <SummaryLine label="Production cost" paise={totals.productionCost} testId="manufacture-production-cost" strong />
              <div
                data-testid="manufacture-profit"
                data-negative={totals.profit < 0 ? 'true' : 'false'}
                className={`mt-1 flex justify-between border-t border-line pt-1.5 text-subtitle font-semibold ${totals.profit < 0 ? 'text-danger' : 'text-ink'}`}
              >
                <span>{totals.profit < 0 ? 'Loss' : 'Profit'}</span>
                <Money paise={totals.profit} />
              </div>
            </dl>
          </div>
        </Panel>
      </div>

      {/* ---------- footer: both sides must match (sticky — Save and the live profit stay in
          view while the ten raw-material rows scroll) ---------- */}
      <div className="sticky bottom-0 z-10 -mx-1 px-1 pb-1">
      <Panel className="px-5 py-3 shadow-elev-2">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="num flex items-center gap-5 text-detail" data-testid="manufacture-match" data-match={matches ? 'true' : 'false'}>
            <span>
              <span className="mr-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Sale Item</span>
              <Money paise={totals.saleAmount} className="text-subtitle font-semibold" />
            </span>
            <span className={matches ? 'text-success' : 'text-muted'} aria-label={matches ? 'Both sides match' : 'Sides do not match yet'}>
              {matches ? '= ✓' : '='}
            </span>
            <span data-testid="manufacture-right-total">
              <span className="mr-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">Raw Material + Profit</span>
              <Money paise={totals.rightTotal} className="text-subtitle font-semibold" />
            </span>
            <span className={`border-l border-line pl-5 ${totals.profit < 0 ? 'text-danger' : ''}`} data-testid="manufacture-footer-profit">
              <span className="mr-2 text-caption font-semibold tracking-[0.08em] text-muted uppercase">{totals.profit < 0 ? 'Loss' : 'Profit'}</span>
              <Money paise={totals.profit} className="text-subtitle font-semibold" />
            </span>
          </div>
          <div className="flex items-center gap-2">
            {firstIssue && (
              <span className="max-w-md truncate text-hint text-muted" data-testid="manufacture-issue" title={firstIssue}>
                {firstIssue}
              </span>
            )}
            {isEdit && (
              <Button variant="danger" data-testid="btn-delete-manufacture" onClick={() => void remove()}>
                Delete
              </Button>
            )}
            <Button onClick={() => nav.back()}>Cancel</Button>
            <Button variant="primary" data-testid="btn-save-manufacture" disabled={!canSave} onClick={() => void save()}>
              {isEdit ? 'Save changes' : 'Save manufacture'} ⌘↵
            </Button>
          </div>
        </div>
      </Panel>
      </div>
    </div>
  )
}

function PanelTitle({ title, hint }: { title: string; hint: string }): React.JSX.Element {
  return (
    <div className="mb-3">
      <h2 className="font-serif text-subtitle font-semibold">{title}</h2>
      <p className="text-hint text-muted">{hint}</p>
    </div>
  )
}

function SummaryLine({
  label,
  paise,
  testId,
  strong,
  muted
}: {
  label: string
  paise: number
  testId?: string
  strong?: boolean
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex justify-between py-0.5 ${strong ? 'font-semibold' : ''} ${muted ? 'text-muted' : ''}`} data-testid={testId}>
      <span>{label}</span>
      <Money paise={paise} />
    </div>
  )
}
