import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type JobWorkChallanRow } from '../../lib/client'
import { useToasts } from '../../state/stores'
import {
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Panel,
  Select,
  SkeletonRows,
  TextInput
} from '../../components/ui'
import { LedgerPicker, useStockItems } from '../../components/pickers'
import { confirmDialog } from '../../lib/dialogs'
import { toDisplayDate, todayISO } from '@shared/dates'
import { parseMilli, plainMilli } from '@shared/money'
import { JOB_WORK_MONTHS } from '@shared/jobWork'

/**
 * Job work: what is lying with whom, and how long it has left (roadmap E #127).
 *
 * The column that makes this screen worth opening is "due back". Section 143 gives inputs one year
 * and capital goods three from the day they went out, and goods that do not come back are DEEMED
 * to have been supplied on the day they left — a backdated tax liability with interest running
 * from then. So the clock is on every row, and the overdue ones say what date the supply is
 * deemed to have happened rather than merely being red.
 */
export function JobWorkTab(): React.JSX.Element {
  const [state, setState] = useState<'pending' | 'overdue' | 'all'>('pending')
  const [sending, setSending] = useState(false)
  const [receiving, setReceiving] = useState<JobWorkChallanRow | null>(null)
  const toast = useToasts()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({ queryKey: ['jobWork', state], queryFn: () => api.jobWork.list({ state }) })
  const rows = data ?? []

  const remove = async (c: JobWorkChallanRow): Promise<void> => {
    const ok = await confirmDialog({
      title: `Cancel challan ${c.challanNo}?`,
      message: 'The stock journal that moved the goods out goes to the bin with it.',
      confirmLabel: 'Cancel challan'
    })
    if (!ok) return
    try {
      await api.jobWork.remove(c.id)
      await queryClient.invalidateQueries({ queryKey: ['jobWork'] })
      await queryClient.invalidateQueries({ queryKey: ['stockSummary'] })
      toast.push('success', `Challan ${c.challanNo} cancelled`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Select
          data-testid="select-jobwork-state"
          aria-label="Which challans"
          value={state}
          onChange={(e) => setState(e.target.value as 'pending' | 'overdue' | 'all')}
        >
          <option value="pending">Still out</option>
          <option value="overdue">Overdue</option>
          <option value="all">All</option>
        </Select>
        <Button variant="primary" data-testid="btn-jobwork-send" onClick={() => setSending(true)}>
          Send out
        </Button>
      </div>

      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing out with a job worker"
            hint="Sending goods out is not a sale — the stock stays yours and moves to a godown named for the job worker"
          />
        ) : (
          <table className="ledger-table" data-testid="rows-jobwork">
            <thead>
              <tr>
                <th scope="col" className="w-32">Challan</th>
                <th scope="col">Job worker</th>
                <th scope="col" className="w-28">Sent</th>
                <th scope="col" className="w-24">Type</th>
                <th scope="col" className="r w-28">Still out</th>
                <th scope="col" className="w-40">Due back</th>
                <th scope="col" className="w-40" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="num">{c.challanNo}</td>
                  <td>{c.partyName}</td>
                  <td className="num">{toDisplayDate(c.sentOn)}</td>
                  <td className="text-muted">{c.goodsType === 'capital' ? 'Capital' : 'Inputs'}</td>
                  <td className="r num">{plainMilli(c.status.pendingQtyMilli)}</td>
                  {/* The cell, not the row: red here means "this is a tax liability", and a whole
                      red row would make the challan number look wrong too. */}
                  <td className={c.status.state === 'overdue' ? 'text-cr' : c.status.state === 'due-soon' ? 'text-warn' : ''}>
                    {c.status.state === 'closed' ? (
                      <span className="text-muted">All back</span>
                    ) : c.status.state === 'overdue' ? (
                      <span title={`Deemed supplied on ${toDisplayDate(c.status.deemedSupplyOn ?? c.sentOn)} under section 143(3)`}>
                        {toDisplayDate(c.status.dueDate)} — {-c.status.daysLeft} days late
                      </span>
                    ) : (
                      <span className="num">
                        {toDisplayDate(c.status.dueDate)} ({c.status.daysLeft}d)
                      </span>
                    )}
                  </td>
                  <td className="r whitespace-nowrap">
                    {c.status.state !== 'closed' && (
                      <Button
                        variant="ghost"
                        className="row-action"
                        data-testid={`btn-jobwork-receive-${c.id}`}
                        onClick={() => setReceiving(c)}
                      >
                        Receive
                      </Button>
                    )}
                    {c.returns.length === 0 && (
                      <Button
                        variant="ghost"
                        className="row-action"
                        data-testid={`btn-jobwork-cancel-${c.id}`}
                        onClick={() => void remove(c)}
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {sending && <SendModal onClose={() => setSending(false)} />}
      {receiving && <ReceiveModal challan={receiving} onClose={() => setReceiving(null)} />}
    </>
  )
}

/**
 * A plain quantity box in integer thousandths.
 *
 * Not the grid's `QtyInput`: that one carries alternate-unit conversion and an item's display
 * precision, both of which need an item chosen first. A job-work line is a whole-number quantity
 * of something already in stock, and text that does not parse leaves the last good value alone
 * rather than silently becoming zero.
 */
function QtyBox({
  qtyMilli,
  onChange,
  testId
}: {
  qtyMilli: number
  onChange: (qtyMilli: number) => void
  testId: string
}): React.JSX.Element {
  const [text, setText] = useState(qtyMilli ? plainMilli(qtyMilli) : '')
  return (
    <TextInput
      data-testid={testId}
      aria-label="Quantity"
      className="num text-right"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const parsed = parseMilli(e.target.value)
        onChange(parsed ?? 0)
      }}
    />
  )
}

function SendModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const items = useStockItems()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [partyLedgerId, setPartyLedgerId] = useState<number | null>(null)
  const [challanNo, setChallanNo] = useState('')
  const [sentOn, setSentOn] = useState(todayISO())
  const [goodsType, setGoodsType] = useState<'input' | 'capital'>('input')
  const [nature, setNature] = useState('')
  const [lines, setLines] = useState<{ stockItemId: number | null; qtyMilli: number }[]>([
    { stockItemId: null, qtyMilli: 0 }
  ])

  const setLine = (i: number, patch: Partial<{ stockItemId: number | null; qtyMilli: number }>): void =>
    setLines((cur) => cur.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const save = async (): Promise<void> => {
    const filled = lines.filter((l) => l.stockItemId != null && l.qtyMilli > 0)
    if (partyLedgerId == null || !challanNo.trim() || filled.length === 0) return
    try {
      await api.jobWork.send({
        partyLedgerId,
        challanNo: challanNo.trim(),
        sentOn,
        goodsType,
        natureOfProcessing: nature.trim() || null,
        lines: filled.map((l) => ({ stockItemId: l.stockItemId!, qtyMilli: l.qtyMilli }))
      })
      await queryClient.invalidateQueries({ queryKey: ['jobWork'] })
      await queryClient.invalidateQueries({ queryKey: ['stockSummary'] })
      await queryClient.invalidateQueries({ queryKey: ['godowns'] })
      toast.push('success', `Challan ${challanNo.trim()} sent`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="Send goods for job work" onClose={onClose} wide>
      <div className="grid gap-3">
        <Field label="Job worker">
          <LedgerPicker value={partyLedgerId} onPick={setPartyLedgerId} testId="picker-jobwork-party" placeholder="Job worker" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Challan number">
            <TextInput
              data-testid="input-jobwork-challan"
              aria-label="Challan number"
              value={challanNo}
              onChange={(e) => setChallanNo(e.target.value)}
            />
          </Field>
          <Field label="Sent on">
            <DateInput testId="input-jobwork-date" context={sentOn} value={sentOn} onChange={setSentOn} />
          </Field>
          <Field
            label="Goods"
            hint={`Inputs come back within ${JOB_WORK_MONTHS.input / 12} year, capital goods within ${JOB_WORK_MONTHS.capital / 12}.`}
          >
            <Select
              data-testid="select-jobwork-goods"
              value={goodsType}
              onChange={(e) => setGoodsType(e.target.value as 'input' | 'capital')}
            >
              <option value="input">Inputs</option>
              <option value="capital">Capital goods</option>
            </Select>
          </Field>
        </div>
        <Field label="Nature of processing">
          <TextInput
            data-testid="input-jobwork-nature"
            aria-label="Nature of processing"
            value={nature}
            onChange={(e) => setNature(e.target.value)}
            placeholder="Powder coating, zinc plating…"
          />
        </Field>

        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="r w-40">Quantity</th>
              <th scope="col" className="w-16" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <Select
                    data-testid={`select-jobwork-item-${i}`}
                    aria-label="Item"
                    value={l.stockItemId ?? ''}
                    onChange={(e) => setLine(i, { stockItemId: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">Choose an item…</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="r">
                  <QtyBox testId={`input-jobwork-qty-${i}`} qtyMilli={l.qtyMilli} onChange={(q) => setLine(i, { qtyMilli: q })} />
                </td>
                <td className="r">
                  <Button
                    variant="ghost"
                    className="row-action"
                    data-testid={`btn-jobwork-line-remove-${i}`}
                    onClick={() => setLines((cur) => (cur.length === 1 ? cur : cur.filter((_, j) => j !== i)))}
                  >
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-between">
          <Button data-testid="btn-jobwork-line-add" onClick={() => setLines((cur) => [...cur, { stockItemId: null, qtyMilli: 0 }])}>
            Add a line
          </Button>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" data-testid="btn-jobwork-send-save" onClick={() => void save()}>
              Send out
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function ReceiveModal({ challan, onClose }: { challan: JobWorkChallanRow; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [receivedOn, setReceivedOn] = useState(todayISO())
  const pending = challan.lines.filter((l) => l.pendingQtyMilli > 0)
  const [qty, setQty] = useState<Record<number, number>>(
    Object.fromEntries(pending.map((l) => [l.stockItemId, l.pendingQtyMilli]))
  )
  const [waste, setWaste] = useState<Record<number, number>>({})

  const save = async (): Promise<void> => {
    const lines = [
      ...pending
        .filter((l) => (qty[l.stockItemId] ?? 0) > 0)
        .map((l) => ({ stockItemId: l.stockItemId, qtyMilli: qty[l.stockItemId]!, kind: 'goods' as const })),
      ...pending
        .filter((l) => (waste[l.stockItemId] ?? 0) > 0)
        .map((l) => ({ stockItemId: l.stockItemId, qtyMilli: waste[l.stockItemId]!, kind: 'waste' as const }))
    ]
    if (lines.length === 0) return
    try {
      await api.jobWork.receive({ challanId: challan.id, receivedOn, lines })
      await queryClient.invalidateQueries({ queryKey: ['jobWork'] })
      await queryClient.invalidateQueries({ queryKey: ['stockSummary'] })
      toast.push('success', `Received against ${challan.challanNo}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`Receive against ${challan.challanNo}`} onClose={onClose} wide>
      <div className="grid gap-3">
        <Field label="Received on">
          <DateInput testId="input-jobwork-receive-date" context={receivedOn} value={receivedOn} onChange={setReceivedOn} />
        </Field>
        <table className="ledger-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="r w-28">Still out</th>
              <th scope="col" className="r w-40">Coming back</th>
              <th scope="col" className="r w-40">Of which waste</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((l) => (
              <tr key={l.stockItemId}>
                <td>{l.itemName}</td>
                <td className="r num">{plainMilli(l.pendingQtyMilli)} {l.unitSymbol}</td>
                <td className="r">
                  <QtyBox
                    testId={`input-jobwork-back-${l.stockItemId}`}
                    qtyMilli={qty[l.stockItemId] ?? 0}
                    onChange={(q) => setQty((cur) => ({ ...cur, [l.stockItemId]: q }))}
                  />
                </td>
                <td className="r">
                  <QtyBox
                    testId={`input-jobwork-waste-${l.stockItemId}`}
                    qtyMilli={waste[l.stockItemId] ?? 0}
                    onChange={(q) => setWaste((cur) => ({ ...cur, [l.stockItemId]: q }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-hint text-muted">
          Waste leaves the job worker&apos;s godown and does not come back into stock — under section 143(5) the job
          worker may supply it directly, and bringing it back would inflate closing stock by the scrap of every job.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-jobwork-receive-save" onClick={() => void save()}>
            Receive
          </Button>
        </div>
      </div>
    </Modal>
  )
}
