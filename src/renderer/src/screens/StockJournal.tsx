// Stock journal / godown transfer (WP 2.3). Two modes for NEW stock journals:
//  - Transfer: rows of item · from godown · to godown · qty · batch (· serials). Each row posts an
//    out/in pair of the same item; the inward leg carries exactly the engine cost of the outward
//    leg (stock:costAsOf at the voucher's position), so a transfer never changes the item's value.
//  - Adjustment: free-form in/out rows with rate (the generic stock-lines editor).
//  - Send to job worker (WP 2.4): the transfer form with a job worker's godown fixed on one side —
//    "Send" moves material from our godowns to the job worker, "Return" brings unprocessed
//    material back — plus the ITC-04 facts (nature of processing, goods type, their challan).
//    Saved through jobWork:saveChallan; the receipt of finished goods is Manufacture's
//    "Receive from job worker" mode.
// Voucher entry's Stock Journal tab embeds this (plus a link back to the BOM manufacture form);
// the sidebar's "Stock journal" screen hosts it on its own. A saved transfer re-opens here
// (planVoucherEdit → 'transfer' / 'jobWorkSend'); anything else falls back to the stock-lines editor.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Voucher } from '@shared/domain'
import { formatPaise } from '@shared/money'
import { formatMilli } from '../lib/table'
import {
  blankTransferRow, buildJobWorkChallan, buildTransferPayload, emptyJobWorkChallan, emptyTransferState, frozenTransferCost,
  transferCostQuery, transferQtyMilli, transferRowsToPost, withJobWorker, type JobWorkChallanState, type TransferFormState,
  type TransferRowState
} from '@shared/voucherEdit'
import { toDisplayDate } from '@shared/dates'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Banner, Button, DateInput, DrawerSection, Field, isAnyModalOpen, Money, Page, PageHeader, Panel, Segmented, Select, SkeletonRows, TextInput, inputCls } from '../components/ui'
import { ItemPicker, useStockItems } from '../components/pickers'
import { BatchPicker, GodownPicker, SerialsInput, useGodowns } from '../components/stockPickers'
import { useLedgers } from '../components/pickers'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { useFeatures } from '../lib/useFeatures'
import { nextLineKey, NUMBER_LOADING, useAlterationDirty, useLeaveAfterSave, useVoucherNumberField } from './voucher/hooks'
import { StockLinesEntry } from './voucher/StockLinesEntry'
import { LineDetailOption } from './voucher/LineStockDetail'

interface TransferRow extends TransferRowState {
  key: number
}
const blankRow = (): TransferRow => ({ ...blankTransferRow(), key: nextLineKey() })

export type StockJournalMode = 'transfer' | 'adjust' | 'jobWork'

/** The godown transfer form (new, or altering a saved transfer). With `jobWork` it is the
 *  "Send to job worker" form (WP 2.4): the challan header fixes the job worker's godown on one
 *  side of every row. */
export function TransferEntry({
  typeId,
  voucherId,
  voucher,
  initial,
  jobWork: initialChallan
}: {
  typeId: number
  voucherId?: number
  voucher?: Voucher
  initial?: TransferFormState
  jobWork?: JobWorkChallanState
}): React.JSX.Element {
  const [challan, setChallan] = useState<JobWorkChallanState | null>(initialChallan ?? null)
  const isJobWork = challan != null
  const setCh = (patch: Partial<JobWorkChallanState>): void => setChallan((c) => (c ? { ...c, ...patch } : c))
  const godowns = useGodowns()
  const ledgers = useLedgers()
  const worker = challan?.godownId != null ? godowns.find((g) => g.id === challan.godownId) : undefined
  const workerParty = worker?.partyLedgerId != null ? ledgers.find((l) => l.id === worker.partyLedgerId)?.name : undefined
  const isEdit = voucherId != null
  const { workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const items = useStockItems()
  const { data: units } = useQuery({ queryKey: ['units'], queryFn: api.units.list })
  const [base] = useState(() => initial ?? emptyTransferState(workingDate))
  const [date, setDate] = useState(base.date)
  const [rows, setRows] = useState<TransferRow[]>(() =>
    initial ? [...initial.rows.map((r) => ({ ...r, key: nextLineKey() })), blankRow()] : [blankRow()]
  )
  const [narration, setNarration] = useState(base.narration)
  const [saving, setSaving] = useState(false)
  const numberField = useVoucherNumberField(typeId, date, voucherId)
  const [alterNumber, setAlterNumber] = useState(base.number)
  const { saved, leave } = useLeaveAfterSave()
  // Rows default their source godown to the previous row's — a transfer usually moves several
  // items between the same two godowns.
  const setRow = (i: number, patch: Partial<TransferRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      if (next[next.length - 1]!.itemId != null) next.push(blankRow())
      // The trailing blank row picks up the godowns of the row above until it gets its own.
      const n = next.length
      if (n > 1) {
        const prev = next[n - 2]!
        const blank = next[n - 1]!
        next[n - 1] = { ...blank, fromGodownId: blank.fromGodownId ?? prev.fromGodownId, toGodownId: blank.toGodownId ?? prev.toGodownId }
      }
      return next
    })
  }

  const formState: TransferFormState = useMemo(() => {
    const st = { ...base, date, number: isEdit ? alterNumber : numberField.forPayload, narration, rows: rows.map(({ key: _k, ...r }) => r) }
    return challan ? withJobWorker(st, challan) : st
  }, [base, date, isEdit, alterNumber, numberField.forPayload, narration, rows, challan])

  // Engine cost of every row's outward leg, as of this voucher's position (an alteration's own
  // saved lines are left out). Rows with a still-valid frozen value don't need it.
  const query = transferCostQuery(formState)
  const { data: priced, isFetching: pricing } = useQuery({
    queryKey: ['transferCost', date, voucherId ?? null, JSON.stringify(query)],
    queryFn: () => api.stock.costAsOf({ date, voucherId, lines: query }),
    enabled: query.length > 0 && query.every((l) => l.qtyMilli > 0)
  })
  const costs = useMemo(() => priced?.consumption?.lines.map((l) => l.costPaise) ?? [], [priced])
  const posting = transferRowsToPost(formState)
  /** Value of row `i` of `rows`: its frozen value, else the engine cost of its posting slot. */
  const valueOf = (i: number): number | null => {
    const r = rows[i]!
    if (r.itemId == null) return null
    const frozen = frozenTransferCost(r)
    if (frozen != null) return frozen
    const k = rows.slice(0, i).filter((x) => x.itemId != null).length
    return costs.length === posting.length ? (costs[k] ?? null) : null
  }

  // What's in each source godown (as on the date) — a hint, not a block (the save warns/blocks
  // per the negative-stock setting).
  const { data: byGodown } = useQuery({ queryKey: ['stockByGodown', date], queryFn: () => api.stock.byGodown(date) })
  const onHand = (itemId: number | null, godownId: number | null): number | null => {
    if (itemId == null || godownId == null || !byGodown) return null
    return byGodown.find((g) => g.stockItemId === itemId && g.godownId === godownId)?.closingQtyMilli ?? 0
  }

  const build = useCallback(
    () => buildTransferPayload(formState, { voucherTypeId: typeId, costs, itemName: (id) => items.find((i) => i.id === id)?.name ?? '' }),
    [formState, typeId, costs, items]
  )
  const { data: sendChallans } = useQuery({
    queryKey: ['jobWorkSendChallans', challan?.godownId ?? null],
    queryFn: () => api.jobWork.sendChallans(challan!.godownId!),
    enabled: challan?.kind === 'return' && challan.godownId != null
  })
  const alterationDirty = useAlterationDirty(voucher, isEdit ? build() : null)
  const challanDirty = isEdit && JSON.stringify(challan) !== JSON.stringify(initialChallan ?? null)
  useUnsavedGuard(!saved && (isEdit ? alterationDirty || challanDirty : rows.some((r) => r.itemId != null) || narration.trim() !== ''))

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    if (pricing) return void toast.push('error', 'Waiting for the stock cost — try again')
    const built = build()
    if (!built.ok) return void toast.push('error', built.error)
    const jw = challan
      ? buildJobWorkChallan({ transfer: formState, challan }, { voucherTypeId: typeId, costs, itemName: (id) => items.find((i) => i.id === id)?.name ?? '' })
      : null
    if (jw && !jw.ok) return void toast.push('error', jw.error)
    setSaving(true)
    try {
      if (built.payload.number && (await api.vouchers.numberExists(typeId, built.payload.number, voucherId))) {
        const proceed = await confirmDialog({
          title: 'Duplicate number',
          message: `Voucher number ${built.payload.number} is already used by another voucher of this type. Save anyway with the same number?`,
          confirmLabel: 'Save anyway'
        })
        if (!proceed) return
      }
      const result = jw && jw.ok ? await api.jobWork.saveChallan(jw.payload, voucherId) : await api.vouchers.save(built.payload, voucherId)
      toast.push(
        'success',
        `${challan ? (challan.kind === 'send' ? 'Job-work challan' : 'Return from job worker') : 'Transfer'} ${result.number} ${isEdit ? 'altered' : 'saved'}`
      )
      setWorkingDate(date)
      await queryClient.invalidateQueries()
      if (isEdit) leave()
      else {
        setRows([blankRow()])
        setNarration('')
        numberField.reset()
      }
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, pricing, build, toast, typeId, voucherId, isEdit, setWorkingDate, date, queryClient, leave, numberField, challan, formState, costs, items])

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
    const proceed = await confirmDialog({
      title: 'Move to Bin',
      message: 'Move this transfer to the Bin? You can restore it from the bin for 30 days.',
      confirmLabel: 'Move to Bin',
      danger: true
    })
    if (!proceed) return
    try {
      await api.vouchers.remove(voucherId!)
      toast.push('success', 'Moved to Bin')
      await queryClient.invalidateQueries()
      leave()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const total = rows.reduce((s, _r, i) => s + (valueOf(i) ?? 0), 0)
  const unitOf = (itemId: number | null): { symbol: string; decimals: number } => {
    const it = items.find((i) => i.id === itemId)
    const u = units?.find((x) => x.id === it?.unitId)
    return { symbol: u?.symbol ?? '', decimals: u?.decimals ?? 3 }
  }

  return (
    <Panel className="p-5" testId={isJobWork ? 'form-job-work-challan' : 'form-stock-transfer'}>
      <div className="grid grid-cols-4 gap-3">
        <Field label="No." hint={isEdit || numberField.value === NUMBER_LOADING ? undefined : 'Auto — edit to override'}>
          <TextInput
            value={isEdit ? alterNumber : numberField.value === NUMBER_LOADING ? '' : numberField.value}
            onChange={(e) => (isEdit ? setAlterNumber(e.target.value) : numberField.onChange(e.target.value))}
            placeholder="Auto"
            className="num"
          />
        </Field>
        <Field label="Date">
          <DateInput value={date} context={workingDate} onChange={setDate} />
        </Field>
        <div className="col-span-2 flex items-end justify-end">
          <p className="text-hint text-muted">
            {challan
              ? challan.kind === 'send'
                ? 'Each row sends material from your godown to the job worker at its current cost — it stays your stock, held at their premises.'
                : 'Each row brings unprocessed material back from the job worker at its current cost.'
              : <>Each row moves stock out of one godown and into another at its current cost — the item&apos;s value is unchanged.</>}
          </p>
        </div>
      </div>
      {challan && (
        <div className="mt-3 grid grid-cols-[auto_minmax(0,14rem)_minmax(0,1fr)_minmax(0,10rem)] items-end gap-3 border-t border-line pt-3" data-testid="job-work-challan">
          {!isEdit ? (
            <Segmented
              label="Job-work direction"
              size="sm"
              testId="job-work-direction"
              options={[
                { value: 'send', label: 'Send' },
                { value: 'return', label: 'Return' }
              ]}
              value={challan.kind}
              onChange={(k) => setCh({ kind: k, originalChallanVoucherId: null })}
            />
          ) : (
            <span className="text-caption font-semibold text-muted uppercase">{challan.kind === 'send' ? 'Send' : 'Return'}</span>
          )}
          <Field label="Job worker" hint={workerParty ? `Party: ${workerParty}` : 'A godown of kind “Job worker” (Masters → Godowns)'}>
            <GodownPicker kind="job_worker" value={challan.godownId} onPick={(id) => setCh({ godownId: id, originalChallanVoucherId: null })} placeholder="Job worker" testId="picker-job-worker" />
          </Field>
          <Field label="Nature of processing">
            <TextInput value={challan.natureOfProcessing} onChange={(e) => setCh({ natureOfProcessing: e.target.value })} placeholder="e.g. Powder coating" data-testid="input-job-work-nature" />
          </Field>
          <Field label="Goods">
            <Select value={challan.goodsType} onChange={(e) => setCh({ goodsType: e.target.value as JobWorkChallanState['goodsType'] })} data-testid="input-job-work-goods-type">
              <option value="inputs">Inputs</option>
              <option value="capital_goods">Capital goods</option>
            </Select>
          </Field>
          {challan.kind === 'return' && (
            <>
              <span />
              <Field label="Their challan no.">
                <TextInput value={challan.challanNo} onChange={(e) => setCh({ challanNo: e.target.value })} data-testid="input-job-work-challan-no" />
              </Field>
              <Field label="Challan date">
                <DateInput value={challan.challanDate ?? date} context={date} onChange={(d) => setCh({ challanDate: d })} testId="input-job-work-challan-date" />
              </Field>
              <Field label="Against challan">
                <Select
                  value={challan.originalChallanVoucherId ?? ''}
                  onChange={(e) => setCh({ originalChallanVoucherId: e.target.value === '' ? null : Number(e.target.value) })}
                  data-testid="input-job-work-original"
                >
                  <option value="">— optional —</option>
                  {(sendChallans ?? []).map((c) => (
                    <option key={c.voucherId} value={c.voucherId}>
                      {c.number} · {toDisplayDate(c.date)}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
      )}

      <table className="ledger-table mt-4">
        <thead>
          <tr>
            <th>Item</th>
            {(!challan || challan.kind === 'send') && <th className="w-44">From godown</th>}
            {(!challan || challan.kind === 'return') && <th className="w-44">To godown</th>}
            <th className="r w-28">Qty</th>
            <th className="w-56">Batch</th>
            <th className="r w-32">Value</th>
          </tr>
        </thead>
        <tbody data-testid="rows-stock-transfer">
          {rows.map((r, i) => {
            const item = r.itemId != null ? items.find((it) => it.id === r.itemId) : undefined
            const have = onHand(r.itemId, challan?.kind === 'return' ? challan.godownId : r.fromGodownId)
            const qtyMilli = transferQtyMilli(r)
            const value = valueOf(i)
            return (
              <Fragment key={r.key}>
                <tr>
                  <td>
                    <ItemPicker
                      value={r.itemId}
                      onPick={(id) => setRow(i, id === r.itemId ? { itemId: id } : { itemId: id, batchId: null, serials: undefined })}
                      testId="picker-transfer-item"
                    />
                  </td>
                  {(!challan || challan.kind === 'send') && (
                    <td>
                      <GodownPicker
                        value={r.fromGodownId}
                        onPick={(id) => setRow(i, { fromGodownId: id })}
                        testId="picker-transfer-from"
                        placeholder="From"
                        kind={challan ? 'own' : undefined}
                      />
                      {have != null && (
                        <span className={`mt-0.5 block text-hint ${qtyMilli > have ? 'text-cr' : 'text-muted'}`}>
                          {formatMilli(have, unitOf(r.itemId).decimals)} {unitOf(r.itemId).symbol} there
                        </span>
                      )}
                    </td>
                  )}
                  {(!challan || challan.kind === 'return') && (
                    <td>
                      <GodownPicker
                        value={r.toGodownId}
                        onPick={(id) => setRow(i, { toGodownId: id })}
                        testId="picker-transfer-to"
                        placeholder="To"
                        kind={challan ? 'own' : undefined}
                      />
                      {challan && have != null && (
                        <span className={`mt-0.5 block text-hint ${qtyMilli > have ? 'text-cr' : 'text-muted'}`}>
                          {formatMilli(have, unitOf(r.itemId).decimals)} {unitOf(r.itemId).symbol} at the job worker
                        </span>
                      )}
                    </td>
                  )}
                  <td className="r">
                    <input
                      className={`${inputCls} num text-right`}
                      data-testid="input-transfer-qty"
                      aria-label="Quantity"
                      value={r.qtyText}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) => setRow(i, { qtyText: e.target.value })}
                    />
                  </td>
                  <td>{item && <BatchPicker itemId={item.id} value={r.batchId} onPick={(id) => setRow(i, { batchId: id })} allowCreate={false} testId="picker-transfer-batch" />}</td>
                  <td className="r">
                    {value != null ? <Money paise={value} /> : r.itemId != null && qtyMilli > 0 ? <span className="text-hint text-muted">pricing…</span> : null}
                  </td>
                </tr>
                {item?.trackSerials && (
                  <tr data-testid="row-line-detail">
                    <td colSpan={isJobWork ? 5 : 6} className="!pt-0">
                      <div className="flex items-start gap-1.5 pl-1">
                        <span className="pt-1.5 text-caption text-muted">Serials</span>
                        <SerialsInput
                          itemId={item.id}
                          direction="out"
                          qtyMilli={qtyMilli}
                          value={r.serials ?? []}
                          onChange={(serials) => setRow(i, { serials })}
                          voucherId={voucherId}
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          <tr className="font-semibold">
            <td colSpan={isJobWork ? 4 : 5} className="r text-small text-muted">{isJobWork ? (challan!.kind === 'send' ? 'Value sent' : 'Value returned') : 'Value moved'}</td>
            <td className="r" data-testid="transfer-total">
              <span className="num">{formatPaise(total)}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="mt-4">
        <Field label="Narration">
          <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Being stock moved to…" />
        </Field>
      </div>

      <div className="mt-5 flex justify-between">
        <div>{isEdit && <Button variant="danger" onClick={() => void remove()}>Delete voucher</Button>}</div>
        <div className="flex gap-2">
          {isEdit && <Button onClick={() => nav.back()}>Cancel</Button>}
          <Button variant="primary" data-testid="btn-save-transfer" disabled={saving} onClick={() => void save()}>
            {isEdit ? 'Save changes' : challan ? (challan.kind === 'send' ? 'Save challan' : 'Save return') : 'Save transfer'} ⌘↵
          </Button>
        </div>
      </div>
    </Panel>
  )
}

/** New stock journal: transfer / adjustment switch. `extraModes` lets Voucher entry add its
 *  "Manufacture (BOM)" form alongside. */
export function StockJournalEntry({
  typeId,
  extraModes,
  initialMode = 'transfer',
  testId = 'stock-journal-mode'
}: {
  typeId: number
  extraModes?: { value: string; label: string; render: () => React.ReactNode }[]
  /** 'transfer' | 'adjust' | an extra mode's value. */
  initialMode?: string
  testId?: string
}): React.JSX.Element {
  const [mode, setMode] = useState<string>(initialMode)
  const options = [
    { value: 'transfer', label: 'Godown transfer' },
    { value: 'jobWork', label: 'Send to job worker' },
    { value: 'adjust', label: 'Adjustment (in / out)' },
    ...(extraModes ?? []).map((m) => ({ value: m.value, label: m.label }))
  ]
  const extra = extraModes?.find((m) => m.value === mode)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Segmented label="Stock journal kind" options={options} value={mode} onChange={setMode} testId={testId} size="sm" />
        <span className="text-hint text-muted">
          {mode === 'transfer'
            ? 'Move stock between godowns at cost.'
            : mode === 'jobWork'
              ? 'Material out to a job worker (or back unprocessed) on a challan — receive the finished goods in Manufacture.'
              : mode === 'adjust'
                ? 'Free-form lines in or out at a rate — write-offs, samples, corrections.'
                : ''}
        </span>
      </div>
      {mode === 'transfer' ? (
        <TransferEntry key={`t${typeId}`} typeId={typeId} />
      ) : mode === 'jobWork' ? (
        <TransferEntry key={`j${typeId}`} typeId={typeId} jobWork={emptyJobWorkChallan('send')} />
      ) : mode === 'adjust' ? (
        <StockLinesEntry key={`a${typeId}`} typeId={typeId} />
      ) : (
        extra?.render()
      )}
    </div>
  )
}

/** The sidebar screen. `mode` opens one kind directly (Manufacture register → "Send to job worker"). */
export function StockJournalScreen({ mode }: { mode?: StockJournalMode } = {}): React.JSX.Element {
  const { data: types } = useQuery({ queryKey: ['voucherTypes'], queryFn: api.voucherTypes.list })
  const features = useFeatures()
  const type = types?.find((t) => t.kind === 'stock_journal')
  return (
    <Page>
      <PageHeader
        title="Stock journal"
        options={{
          content: (
            <DrawerSection title="Stock lines">
              <LineDetailOption />
            </DrawerSection>
          )
        }}
      />
      {!features.inventory ? (
        <Banner tone="info">Turn on inventory under Settings → Features to use stock journals.</Banner>
      ) : !types ? (
        <Panel>
          <SkeletonRows rows={5} />
        </Panel>
      ) : !type ? (
        <Banner tone="warning">No Stock Journal voucher type — add one under Masters → Voucher types.</Banner>
      ) : (
        <StockJournalEntry typeId={type.id} initialMode={mode} />
      )}
    </Page>
  )
}
