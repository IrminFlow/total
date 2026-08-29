import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  type JobWorkChallan,
  type JobWorkChallanInput,
  type JobWorkClockRow,
  type JobWorkReturnInput,
  type JobWorkReturnRow
} from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  RowAction,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../components/ui'
import { useStickyTab } from '../lib/useStickyTab'
import { fyOf, toDisplayDate, todayISO } from '@shared/dates'
import { parseMilli } from '@shared/money'
import { confirmDialog } from '../lib/dialogs'
import type { JobWorkDisposition, JobWorkGoodsType } from '@shared/gst/itc04'

/**
 * Job work — goods out on challan, the section 143 clock, and ITC-04 (roadmap D-89).
 *
 * WHY THIS IS ITS OWN SIDEBAR SCREEN rather than a tab on a returns screen.
 *
 * Two of the three things here are not a return at all. A job-work challan is a document the
 * storekeeper raises on the day the goods leave — the sibling of the delivery challan on
 * `SalesChain.tsx` — and the clock over it is a liability that has to be visible on an ordinary
 * Tuesday, not only in the week a form is due. Filing ITC-04 half-yearly and hiding the register
 * behind that filing would mean a challan can go a year past its date without anybody opening the
 * screen that would have said so, and by then the tax is backdated with a year of interest on it.
 * So: its own screen, in the GST section because the form lives there, with the register first
 * and the form second. The GST returns screen stays what it is — a screen about returns.
 *
 * Nothing on this screen posts. Sending goods for job work is not a supply.
 *
 * The official-source audit is dated in `src/shared/gst/itc04.ts` and repeated in the interface.
 * This is a working paper; it does not generate or claim a portal-ready file.
 */

type Tab = 'challans' | 'itc04'

const GOODS_LABEL: Record<JobWorkGoodsType, string> = {
  input: 'Inputs',
  capital_goods: 'Capital goods'
}

const DISPOSITIONS: { value: JobWorkDisposition; label: string; hint: string }[] = [
  { value: 'returned', label: 'Came back to us', hint: 'The ordinary case — the goods are back on our floor' },
  {
    value: 'sent_to_other_job_worker',
    label: 'Moved on to another job worker',
    hint: 'Straight from his premises to the next one, without touching ours'
  },
  {
    value: 'supplied_from_job_worker_premises',
    label: 'Sold from his premises',
    hint: 'Section 143(1)(b) — this IS a supply by us, and is invoiced separately'
  },
  { value: 'waste_and_scrap', label: 'Waste and scrap', hint: 'Section 143(5) — losses and wastes in the process' }
]

const qty = (milli: number): string => String(milli / 1000)

export function JobWorkScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<Tab>('jobwork-tab', ['challans', 'itc04'], 'challans')

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex gap-1" role="group" aria-label="Job work view">
            {(
              [
                { id: 'challans', label: 'Out on challan' },
                { id: 'itc04', label: 'ITC-04' }
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`tab-jobwork-${t.id}`}
                aria-pressed={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md px-2.5 py-1 text-body ${
                  tab === t.id ? 'bg-accentbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        Job work & ITC-04
      </SectionTitle>

      {tab === 'challans' ? <Register /> : <Itc04Tab />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The register: what is still out, and what the clock has already run out on
// ---------------------------------------------------------------------------------------------

function Register(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<JobWorkChallan | 'new' | null>(null)
  const [receiving, setReceiving] = useState<JobWorkChallan | null>(null)
  const asOn = todayISO()

  const { data: challans, isLoading } = useQuery({
    queryKey: ['jobWorkChallans'],
    queryFn: () => api.jobWork.list()
  })
  const { data: clock } = useQuery({ queryKey: ['jobWorkClock', asOn], queryFn: () => api.jobWork.clock(asOn) })

  const rows = challans ?? []
  const byId = new Map<number, JobWorkClockRow>((clock?.rows ?? []).map((r) => [r.challanId, r]))
  const table = useTableNav(rows, { rowId: (c) => c.id, onEnter: (c) => setEditing(c) })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['jobWorkChallans'] })
    await queryClient.invalidateQueries({ queryKey: ['jobWorkClock'] })
    await queryClient.invalidateQueries({ queryKey: ['jobWorkItc04'] })
  }

  const remove = async (c: JobWorkChallan): Promise<void> => {
    const ok = await confirmDialog({
      title: `Delete ${c.number}`,
      message: 'The goods movement is removed from the register and from ITC-04.',
      confirmLabel: 'Delete'
    })
    if (!ok) return
    try {
      await api.jobWork.remove(c.id)
      await refresh()
      toast.push('success', `${c.number} deleted`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      {clock && clock.overdue.length > 0 && (
        <div className="callout-warn mb-3 rounded-md p-3" data-testid="panel-jobwork-overdue">
          <div className="text-lead font-semibold">
            {clock.overdue.length === 1
              ? '1 challan is past the day the goods had to be back.'
              : `${clock.overdue.length} challans are past the day the goods had to be back.`}
          </div>
          <p className="mt-1 text-body">
            This is not a reminder. Section 143(3)/(4) treats goods that did not come back in time as{' '}
            <strong>sold to the job worker on the day they were sent out</strong> — not on the day the
            year ran out. Tax of <Money paise={clock.totalDeemedTaxPaise} /> is payable on{' '}
            <Money paise={clock.totalDeemedValuePaise} /> of goods, in the return for the month each
            challan was raised, and interest under section 50(1) has been running from that return&rsquo;s
            due date ever since. Getting the goods back now does not undo it.
          </p>
          <ul className="mt-2 space-y-0.5 text-body" data-testid="list-jobwork-overdue">
            {clock.overdue.map((r) => (
              <li key={r.challanNumber}>
                <span className="num">{r.challanNumber}</span> — {qty(r.balanceMilli)} {r.uqc} of{' '}
                {r.description} still with {r.jobWorkerName ?? 'the job worker'}, due back{' '}
                {toDisplayDate(r.dueBackBy as string)}, {r.daysOverdue} days ago. Deemed supplied on{' '}
                <span className="num">{toDisplayDate(r.deemedSupplyDate as string)}</span> at{' '}
                <Money paise={r.deemedValuePaise} /> plus <Money paise={r.deemedTaxPaise} /> tax.
              </li>
            ))}
          </ul>
          <p className="mt-2 text-micro text-muted">
            The day the goods are due back is read as the anniversary itself being still in time — goods
            sent on 10 April are within the year up to and including 10 April next year, and late on the
            11th. Section 9 of the General Clauses Act excludes the first day and includes the last when
            computing a period from an event.
          </p>
        </div>
      )}

      <div className="mb-3 flex justify-end gap-2">
        <Button variant="primary" data-testid="btn-jobwork-add" onClick={() => setEditing('new')}>
          Send goods out
        </Button>
      </div>

      <Panel scroll={{ maxH: '58vh' }} data-testid="panel-jobwork-challans">
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing is out with a job worker"
            hint="A job-work challan carries goods out without a supply — and starts a clock the law is counting."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-24">Challan</th>
                <th scope="col" className="w-24">Sent</th>
                <th scope="col">Job worker</th>
                <th scope="col">Goods</th>
                <th scope="col" className="r w-20">Out</th>
                <th scope="col" className="r w-20">Back</th>
                <th scope="col" className="r w-20">Balance</th>
                <th scope="col" className="w-64">Due back</th>
                <th scope="col" className="r w-48" />
              </tr>
            </thead>
            <tbody data-testid="rows-jobwork-challans">
              {rows.map((c, i) => {
                const r = byId.get(c.id)
                return (
                  <tr key={c.id} {...table.rowProps(i, c)} data-overdue={r?.overdue ? 'true' : 'false'}>
                    <td className="num">{c.number}</td>
                    <td className="num text-muted">{toDisplayDate(c.date)}</td>
                    <td>
                      {c.jobWorkerName ?? 'Not a ledger'}
                      {!c.jobWorkerGstin && (
                        <span className="ml-2 rounded-full bg-panel2 px-2 py-0.5 text-micro text-muted">
                          unregistered · state {c.jobWorkerStateCode}
                        </span>
                      )}
                    </td>
                    <td>
                      {c.description}
                      <span className="ml-2 text-micro text-muted">{GOODS_LABEL[c.goodsType]}</span>
                      {c.mouldsDiesJigsTools && (
                        <span className="ml-2 rounded-full bg-panel2 px-2 py-0.5 text-micro text-muted">
                          mould / die / jig / tool
                        </span>
                      )}
                    </td>
                    <td className="r num">{qty(c.qtyMilli)}</td>
                    <td className="r num text-muted">{qty(c.accountedMilli)}</td>
                    <td className="r num">{qty(c.balanceMilli)}</td>
                    <td className={`whitespace-normal ${r?.overdue ? 'text-cr' : 'text-muted'}`}>
                      {r?.exemptFromClock
                        ? 'No clock — s.143(4) excludes moulds, dies, jigs, fixtures and tools'
                        : c.balanceMilli === 0
                          ? 'All accounted for'
                          : r?.overdue
                            ? `Overdue by ${r.daysOverdue} days — deemed sold on ${toDisplayDate(
                                r.deemedSupplyDate as string
                              )}, tax payable with interest`
                            : `${r?.dueBackBy ? toDisplayDate(r.dueBackBy) : '–'}${r?.extended ? ' (extended)' : ''}`}
                    </td>
                    <td onClick={(e) => e.stopPropagation()} className="r whitespace-nowrap">
                      {c.balanceMilli > 0 && (
                        <RowAction
                          data-testid={`btn-jobwork-receive-${c.id}`}
                          onClick={() => setReceiving(c)}
                        >
                          Record what came back
                        </RowAction>
                      )}
                      <RowAction onClick={() => setEditing(c)}>
                        Open
                      </RowAction>
                      {c.returns.length === 0 && (
                        <RowAction tone="danger" onClick={() => void remove(c)}>
                          Delete
                        </RowAction>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="mt-2 text-micro text-muted">
        Nothing on this screen is an accounting entry. Sending goods for job work is not a supply, so no
        voucher is posted and no credit is reversed — until the clock runs out, at which point the law
        supplies them for you, backdated.
      </p>

      {editing && (
        <ChallanModal
          challan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {receiving && <ReceiptModal challan={receiving} onClose={() => setReceiving(null)} onSaved={refresh} />}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// The challan out
// ---------------------------------------------------------------------------------------------

function ChallanModal({
  challan,
  onClose,
  onSaved
}: {
  challan: JobWorkChallan | null
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const toast = useToasts()
  const { info } = useSession()
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const { data: items } = useQuery({ queryKey: ['stockItems'], queryFn: api.stockItems.list })
  const { data: godowns } = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list })
  const [date, setDate] = useState(challan?.date ?? todayISO())
  const [jobWorkerLedgerId, setJobWorkerLedgerId] = useState<number | ''>(challan?.jobWorkerLedgerId ?? '')
  const [jobWorkerGstin, setJobWorkerGstin] = useState(challan?.jobWorkerGstin ?? '')
  const [jobWorkerStateCode, setJobWorkerStateCode] = useState(challan?.jobWorkerStateCode ?? info?.stateCode ?? '')
  const [jobWorkerIsSez, setJobWorkerIsSez] = useState(challan?.jobWorkerIsSez ?? false)
  const [goodsType, setGoodsType] = useState<JobWorkGoodsType>(challan?.goodsType ?? 'input')
  const [stockItemId, setStockItemId] = useState<number | ''>(challan?.stockItemId ?? '')
  const [description, setDescription] = useState(challan?.description ?? '')
  const [hsn, setHsn] = useState(challan?.hsn ?? '')
  const [qtyMilli, setQtyMilli] = useState(challan?.qtyMilli ?? 1000)
  const [uqc, setUqc] = useState(challan?.uqc ?? 'NOS')
  const [taxablePaise, setTaxablePaise] = useState(challan?.taxablePaise ?? 0)
  const [gstRate, setGstRate] = useState(challan?.gstRate ?? 18)
  const [cessPaise, setCessPaise] = useState(challan?.cessPaise ?? 0)
  const [mould, setMould] = useState(challan?.mouldsDiesJigsTools ?? false)
  const [receivedOn, setReceivedOn] = useState(challan?.receivedByJobWorkerOn ?? '')
  const [extended, setExtended] = useState(challan?.extendedDueBackBy ?? '')
  const [notes, setNotes] = useState(challan?.notes ?? '')
  const [fromGodownId, setFromGodownId] = useState<number | ''>(challan?.fromGodownId ?? '')

  const submit = async (): Promise<void> => {
    const payload: JobWorkChallanInput = {
      date,
      jobWorkerLedgerId: jobWorkerLedgerId === '' ? null : jobWorkerLedgerId,
      jobWorkerGstin: jobWorkerGstin.trim() || null,
      jobWorkerStateCode: jobWorkerStateCode.trim() || null,
      jobWorkerIsSez,
      goodsType,
      stockItemId: stockItemId === '' ? null : stockItemId,
      description: description.trim(),
      hsn: hsn.trim() || null,
      qtyMilli,
      uqc: uqc.trim() || 'NOS',
      taxablePaise,
      gstRate,
      cessPaise,
      mouldsDiesJigsTools: mould,
      receivedByJobWorkerOn: receivedOn || null,
      extendedDueBackBy: extended || null,
      notes: notes.trim() || null,
      fromGodownId: fromGodownId === '' ? null : fromGodownId
    }
    try {
      const saved = await api.jobWork.save(payload, challan?.id)
      await onSaved()
      toast.push('success', `${saved.number} saved`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={challan ? challan.number : 'Goods out to a job worker'} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Date sent" hint="The clock starts here — and so does the deemed supply, if it comes to that">
          <TextInput
            type="date"
            data-testid="input-jobwork-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="Job worker" hint="Leave blank if he is not in the books — the form takes the state instead">
          <Select
            data-testid="select-jobwork-worker"
            value={jobWorkerLedgerId}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : ''
              setJobWorkerLedgerId(id)
              const ledger = (ledgers ?? []).find((l) => l.id === id)
              if (ledger) {
                setJobWorkerGstin(ledger.gstin ?? '')
                setJobWorkerStateCode(ledger.stateCode ?? ledger.gstin?.slice(0, 2) ?? info?.stateCode ?? '')
              }
            }}
          >
            <option value="">Unregistered / not a ledger</option>
            {(ledgers ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What kind of goods" hint="Inputs get a year, capital goods three">
          <Select
            data-testid="select-jobwork-goodstype"
            value={goodsType}
            onChange={(e) => setGoodsType(e.target.value as JobWorkGoodsType)}
          >
            <option value="input">Inputs</option>
            <option value="capital_goods">Capital goods</option>
          </Select>
        </Field>
        <Field label="Stock item" hint="Optional — a challan can describe something not in the item master">
          <Select
            data-testid="select-jobwork-item"
            value={stockItemId}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : ''
              setStockItemId(id)
              const item = (items ?? []).find((x) => x.id === id)
              if (item) {
                setDescription(item.name)
                if (item.hsn) setHsn(item.hsn)
                if (item.gstRate != null) setGstRate(item.gstRate)
              }
            }}
          >
            <option value="">Not an item in the master</option>
            {(items ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-3">
        <Field label="Job worker GSTIN" hint="Blank for an unregistered job worker">
          <TextInput
            data-testid="input-jobwork-worker-gstin"
            value={jobWorkerGstin}
            onChange={(e) => {
              const value = e.target.value.toUpperCase()
              setJobWorkerGstin(value)
              if (value.length >= 2) setJobWorkerStateCode(value.slice(0, 2))
            }}
          />
        </Field>
        <Field label="Job worker state" hint="Required when GSTIN is blank">
          <TextInput
            data-testid="input-jobwork-worker-state"
            value={jobWorkerStateCode}
            maxLength={2}
            onChange={(e) => setJobWorkerStateCode(e.target.value.replace(/\D/g, '').slice(0, 2))}
          />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-body">
          <input
            type="checkbox"
            data-testid="check-jobwork-worker-sez"
            checked={jobWorkerIsSez}
            onChange={(e) => setJobWorkerIsSez(e.target.checked)}
          />
          SEZ job worker
        </label>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-3">
        <div className="col-span-2">
          <Field label="Description">
            <TextInput
              data-testid="input-jobwork-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <Field label="HSN">
          <TextInput data-testid="input-jobwork-hsn" value={hsn} onChange={(e) => setHsn(e.target.value)} />
        </Field>
        <Field label="Quantity">
          <TextInput
            data-testid="input-jobwork-qty"
            className="num text-right"
            value={qty(qtyMilli)}
            onChange={(e) => setQtyMilli(parseMilli(e.target.value) ?? 0)}
          />
        </Field>
        <Field label="Unit" hint="A portal UQC — NOS, KGS, PCS…">
          <TextInput data-testid="input-jobwork-uqc" value={uqc} onChange={(e) => setUqc(e.target.value.toUpperCase())} />
        </Field>
      </div>

      {/*
        Only the SOURCE is a choice. Where the goods go is not: they go to a godown named for the
        job worker, made on first use, so that a stock report can answer "what is lying with whom"
        without the user having to invent and remember a godown per job worker.
      */}
      <div className="mt-3 grid grid-cols-5 gap-3">
        <div className="col-span-2">
          <Field
            label="Sent from"
            hint={
              stockItemId === ''
                ? 'Pick a stock item above and the goods will move as well as be recorded'
                : 'Where the goods are standing now'
            }
          >
            <Select
              data-testid="select-jobwork-from-godown"
              value={fromGodownId}
              disabled={stockItemId === ''}
              onChange={(e) => setFromGodownId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">Unallocated stock</option>
              {(godowns ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="col-span-3 self-end pb-1 text-micro text-muted">
          {stockItemId === '' ? (
            <>
              This challan records paperwork only — no stock moves. Name a stock item to have the
              goods move to the job worker&rsquo;s godown as well, where they stay in your closing
              stock because they are still yours.
            </>
          ) : (
            <>
              Saving this moves the goods to a godown named for the job worker, with a stock
              journal that touches no ledger — sending goods for job work is not a supply
              (section 143), so nothing is posted to the books.
            </>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-3">
        <Field label="Value of the goods" hint="What is at stake if they do not come back">
          <AmountInput testId="input-jobwork-value" paise={taxablePaise} onPaise={(p) => setTaxablePaise(p ?? 0)} />
        </Field>
        <Field label="GST rate %" hint="Not charged now — this is the rate the deemed supply would bear">
          <TextInput
            data-testid="input-jobwork-rate"
            className="num text-right"
            value={String(gstRate)}
            onChange={(e) => setGstRate(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="Cess" hint="Compensation cess shown on Table 4">
          <AmountInput testId="input-jobwork-cess" paise={cessPaise} onPaise={(p) => setCessPaise(p ?? 0)} />
        </Field>
        <Field
          label="Received by him on"
          hint="Only when the supplier delivered straight to him — then the clock starts there"
        >
          <TextInput
            type="date"
            data-testid="input-jobwork-received"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
        </Field>
        <Field label="Extended due date" hint="Only with the Commissioner’s extension under the proviso to s.143(1)">
          <TextInput
            type="date"
            data-testid="input-jobwork-extended"
            value={extended}
            onChange={(e) => setExtended(e.target.value)}
          />
        </Field>
      </div>

      {goodsType === 'capital_goods' && (
        <label className="mt-3 flex items-center gap-2 text-body">
          <input
            type="checkbox"
            data-testid="check-jobwork-mould"
            checked={mould}
            onChange={(e) => setMould(e.target.checked)}
          />
          <span>
            These are moulds and dies, jigs and fixtures, or tools — section 143(4) excludes them from the
            three-year clock entirely, so they are never a deemed supply however long they stay out.
          </span>
        </label>
      )}

      <div className="mt-3">
        <Field label="Nature of the job work" hint="Printed on the challan, and asked for on the form">
          <TextInput data-testid="input-jobwork-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-jobwork-save" onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// What came back
// ---------------------------------------------------------------------------------------------

function ReceiptModal({
  challan,
  onClose,
  onSaved
}: {
  challan: JobWorkChallan
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(todayISO())
  const [number, setNumber] = useState('')
  const [qtyMilli, setQtyMilli] = useState(challan.balanceMilli)
  const [disposition, setDisposition] = useState<JobWorkDisposition>('returned')
  const [notes, setNotes] = useState('')
  const [toGodownId, setToGodownId] = useState<number | ''>('')
  const [sourceLedgerId, setSourceLedgerId] = useState<number | ''>(challan.jobWorkerLedgerId ?? '')
  const [sourceGstin, setSourceGstin] = useState(challan.jobWorkerGstin ?? '')
  const [sourceState, setSourceState] = useState(challan.jobWorkerStateCode)
  const [sourceIsSez, setSourceIsSez] = useState(challan.jobWorkerIsSez)
  const [destinationLedgerId, setDestinationLedgerId] = useState<number | ''>('')
  const [destinationGstin, setDestinationGstin] = useState('')
  const [destinationState, setDestinationState] = useState('')
  const [destinationIsSez, setDestinationIsSez] = useState(false)
  const [provenance, setProvenance] = useState<'endorsed_original' | 'fresh'>('endorsed_original')
  const [lossWasteQtyMilli, setLossWasteQtyMilli] = useState(0)
  const [lossWasteUqc, setLossWasteUqc] = useState(challan.uqc)
  const [invoiceVoucherId, setInvoiceVoucherId] = useState<number | ''>('')
  const { data: godowns } = useQuery({ queryKey: ['godowns'], queryFn: api.godowns.list })
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const { data: vouchers } = useQuery({
    queryKey: ['jobWorkSalesInvoices', challan.date],
    queryFn: () => api.vouchers.list(challan.date, todayISO())
  })
  const salesInvoices = (vouchers ?? []).filter((v) => v.kind === 'sales')
  const chosen = DISPOSITIONS.find((d) => d.value === disposition) as (typeof DISPOSITIONS)[number]
  const returnsToPrincipal = disposition === 'returned' || disposition === 'supplied_from_job_worker_premises'

  const applyWorker = (
    id: number | '',
    setters: {
      ledger: (value: number | '') => void
      gstin: (value: string) => void
      state: (value: string) => void
    }
  ): void => {
    setters.ledger(id)
    const ledger = (ledgers ?? []).find((l) => l.id === id)
    if (ledger) {
      setters.gstin(ledger.gstin ?? '')
      setters.state(ledger.stateCode ?? ledger.gstin?.slice(0, 2) ?? '')
    }
  }

  const submit = async (): Promise<void> => {
    const payload: JobWorkReturnInput = {
      challanId: challan.id,
      date,
      number: number.trim() || null,
      qtyMilli,
      disposition,
      invoiceVoucherId: invoiceVoucherId === '' ? null : invoiceVoucherId,
      notes: notes.trim() || null,
      toGodownId: returnsToPrincipal && toGodownId !== '' ? toGodownId : null,
      sourceJobWorkerLedgerId: sourceLedgerId === '' ? null : sourceLedgerId,
      sourceJobWorkerGstin: sourceGstin.trim() || null,
      sourceJobWorkerStateCode: sourceState.trim() || null,
      sourceJobWorkerIsSez: sourceIsSez,
      destinationJobWorkerLedgerId: destinationLedgerId === '' ? null : destinationLedgerId,
      destinationJobWorkerGstin: destinationGstin.trim() || null,
      destinationJobWorkerStateCode: destinationState.trim() || null,
      destinationJobWorkerIsSez: destinationIsSez,
      onwardChallanProvenance: disposition === 'sent_to_other_job_worker' ? provenance : null,
      lossWasteUqc: lossWasteQtyMilli > 0 ? lossWasteUqc.trim().toUpperCase() : null,
      lossWasteQtyMilli
    }
    try {
      await api.jobWork.saveReturn(payload)
      await onSaved()
      toast.push(
        'success',
        disposition === 'sent_to_other_job_worker'
          ? `${qty(qtyMilli)} ${challan.uqc} moved onward; ${challan.number}'s statutory clock is still running`
          : `${qty(qtyMilli)} ${challan.uqc} accounted for against ${challan.number}`
      )
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (r: JobWorkReturnRow): Promise<void> => {
    try {
      await api.jobWork.removeReturn(r.id)
      await onSaved()
      toast.push('success', 'Receipt deleted — the quantity is out on challan again')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`Against ${challan.number}`} onClose={onClose} wide>
      <p className="text-body text-muted">
        {challan.description} — {qty(challan.qtyMilli)} {challan.uqc} went out on{' '}
        {toDisplayDate(challan.date)}, {qty(challan.accountedMilli)} is accounted for, and{' '}
        <span className="num text-ink">{qty(challan.balanceMilli)}</span> is still out.
      </p>

      <div className="mt-3 grid grid-cols-4 gap-3">
        <Field label="Date">
          <TextInput
            type="date"
            data-testid="input-jwreturn-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label={disposition === 'sent_to_other_job_worker' ? 'Onward challan number' : 'Worker challan number'}>
          <TextInput data-testid="input-jwreturn-number" value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
        <Field label="Quantity" hint={`At most ${qty(challan.balanceMilli)}`}>
          <TextInput
            data-testid="input-jwreturn-qty"
            className="num text-right"
            value={qty(qtyMilli)}
            onChange={(e) => setQtyMilli(parseMilli(e.target.value) ?? 0)}
          />
        </Field>
        <Field label="What happened to them" hint={chosen.hint}>
          <Select
            data-testid="select-jwreturn-disposition"
            value={disposition}
            onChange={(e) => setDisposition(e.target.value as JobWorkDisposition)}
          >
            {DISPOSITIONS.filter((d) => d.value !== 'waste_and_scrap').map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-3">
        <Field label="Returning / source worker">
          <Select
            data-testid="select-jwreturn-source-worker"
            value={sourceLedgerId}
            onChange={(e) => applyWorker(e.target.value ? Number(e.target.value) : '', {
              ledger: setSourceLedgerId, gstin: setSourceGstin, state: setSourceState
            })}
          >
            <option value="">Unregistered / not a ledger</option>
            {(ledgers ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Source GSTIN" hint="Blank when unregistered">
          <TextInput
            data-testid="input-jwreturn-source-gstin"
            value={sourceGstin}
            onChange={(e) => {
              const value = e.target.value.toUpperCase()
              setSourceGstin(value)
              if (value.length >= 2) setSourceState(value.slice(0, 2))
            }}
          />
        </Field>
        <Field label="Source state">
          <TextInput
            data-testid="input-jwreturn-source-state"
            value={sourceState}
            maxLength={2}
            onChange={(e) => setSourceState(e.target.value.replace(/\D/g, '').slice(0, 2))}
          />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-body">
          <input type="checkbox" data-testid="check-jwreturn-source-sez" checked={sourceIsSez} onChange={(e) => setSourceIsSez(e.target.checked)} />
          Source is SEZ
        </label>
      </div>

      {disposition === 'sent_to_other_job_worker' && (
        <div className="mt-3 grid grid-cols-5 gap-3 rounded-md border border-line p-3">
          <Field label="Destination worker">
            <Select
              data-testid="select-jwreturn-destination-worker"
              value={destinationLedgerId}
              onChange={(e) => applyWorker(e.target.value ? Number(e.target.value) : '', {
                ledger: setDestinationLedgerId, gstin: setDestinationGstin, state: setDestinationState
              })}
            >
              <option value="">Unregistered / not a ledger</option>
              {(ledgers ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Destination GSTIN">
            <TextInput
              data-testid="input-jwreturn-destination-gstin"
              value={destinationGstin}
              onChange={(e) => {
                const value = e.target.value.toUpperCase()
                setDestinationGstin(value)
                if (value.length >= 2) setDestinationState(value.slice(0, 2))
              }}
            />
          </Field>
          <Field label="Destination state">
            <TextInput
              data-testid="input-jwreturn-destination-state"
              value={destinationState}
              maxLength={2}
              onChange={(e) => setDestinationState(e.target.value.replace(/\D/g, '').slice(0, 2))}
            />
          </Field>
          <Field label="Challan used">
            <Select data-testid="select-jwreturn-provenance" value={provenance} onChange={(e) => setProvenance(e.target.value as typeof provenance)}>
              <option value="endorsed_original">Endorsed original</option>
              <option value="fresh">Fresh challan</option>
            </Select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-body">
            <input type="checkbox" data-testid="check-jwreturn-destination-sez" checked={destinationIsSez} onChange={(e) => setDestinationIsSez(e.target.checked)} />
            Destination is SEZ
          </label>
        </div>
      )}

      <div className="mt-3 grid grid-cols-4 gap-3">
        {disposition !== 'sent_to_other_job_worker' && (
          <>
            <Field label="Loss / waste quantity" hint="Reported on the same 5A/5B/5C row">
              <TextInput
                data-testid="input-jwreturn-loss-qty"
                className="num text-right"
                value={qty(lossWasteQtyMilli)}
                onChange={(e) => setLossWasteQtyMilli(parseMilli(e.target.value) ?? 0)}
              />
            </Field>
            <Field label="Loss / waste UQC">
              <TextInput data-testid="input-jwreturn-loss-uqc" value={lossWasteUqc} onChange={(e) => setLossWasteUqc(e.target.value.toUpperCase())} />
            </Field>
          </>
        )}
        {disposition === 'supplied_from_job_worker_premises' && (
          <div className="col-span-2">
            <Field label="Principal sales invoice" hint="Required for exact Table 5C invoice number and date">
              <Select
                data-testid="select-jwreturn-invoice"
                value={invoiceVoucherId}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : ''
                  setInvoiceVoucherId(id)
                  const invoice = salesInvoices.find((v) => v.id === id)
                  if (invoice) setDate(invoice.date)
                }}
              >
                <option value="">Choose a sales invoice</option>
                {salesInvoices.map((v) => <option key={v.id} value={v.id}>{v.number} · {toDisplayDate(v.date)} · {v.account}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Field label="Nature of the job work done">
            <TextInput data-testid="input-jwreturn-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Received into"
          hint={returnsToPrincipal ? 'Where the goods go on your side' : 'An onward movement goes straight to the destination worker'}
        >
          <Select
            data-testid="select-jwreturn-to-godown"
            value={returnsToPrincipal ? toGodownId : ''}
            disabled={!returnsToPrincipal}
            onChange={(e) => setToGodownId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Unallocated stock</option>
            {(godowns ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {disposition === 'sent_to_other_job_worker' && (
        <p className="callout-warn mt-3 rounded-md p-2 text-micro">
          This does not clear or restart the original section 143 clock. The goods move directly into
          the destination worker&rsquo;s holding; a later return by that worker is reported in Table 5B.
        </p>
      )}

      {challan.returns.length > 0 && (
        <table className="ledger-table mt-4">
          <thead>
            <tr>
              <th scope="col" className="w-28">Date</th>
              <th scope="col" className="w-32">Number</th>
              <th scope="col" className="r w-24">Quantity</th>
              <th scope="col">Worker / outcome</th>
              <th scope="col" className="r w-20" />
            </tr>
          </thead>
          <tbody data-testid="rows-jwreturns">
            {challan.returns.map((r) => (
              <tr key={r.id}>
                <td className="num text-muted">{toDisplayDate(r.date)}</td>
                <td className="num">{r.number ?? '—'}</td>
                <td className="r num">
                  {qty(r.qtyMilli)}
                  {r.lossWasteQtyMilli > 0 && <span className="block text-micro text-muted">loss {qty(r.lossWasteQtyMilli)} {r.lossWasteUqc}</span>}
                </td>
                <td>
                  <span className="block">{r.sourceJobWorkerName ?? r.sourceJobWorkerGstin ?? `State ${r.sourceJobWorkerStateCode}`}</span>
                  <span className="text-micro text-muted">
                    {DISPOSITIONS.find((d) => d.value === r.disposition)?.label ?? r.disposition}
                    {r.destinationJobWorkerName || r.destinationJobWorkerGstin
                      ? ` → ${r.destinationJobWorkerName ?? r.destinationJobWorkerGstin}` : ''}
                    {r.onwardChallanProvenance ? ` · ${r.onwardChallanProvenance === 'fresh' ? 'fresh challan' : 'endorsed original'}` : ''}
                  </span>
                </td>
                <td className="r">
                  <RowAction tone="danger" onClick={() => void remove(r)}>
                    Delete
                  </RowAction>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" data-testid="btn-jwreturn-save" onClick={() => void submit()}>
          Record it
        </Button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// ITC-04 — the working paper
// ---------------------------------------------------------------------------------------------

function Itc04Tab(): React.JSX.Element {
  const { info } = useSession()
  const currentFy = fyOf(todayISO()).startYear
  const [fyStartYear, setFyStartYear] = useState(currentFy)
  const [periodIndex, setPeriodIndex] = useState(0)

  const { data, isLoading } = useQuery({
    queryKey: ['jobWorkItc04', fyStartYear, periodIndex],
    queryFn: () => api.jobWork.itc04({ fyStartYear, periodIndex })
  })

  const years: number[] = []
  for (let y = info?.booksFrom ?? currentFy; y <= currentFy + 1; y++) years.push(y)

  if (isLoading || !data) return <SkeletonRows rows={8} />

  const { form, obligation, periods } = data

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Financial year">
          <Select
            data-testid="select-itc04-fy"
            value={fyStartYear}
            onChange={(e) => {
              setFyStartYear(Number(e.target.value))
              setPeriodIndex(0)
            }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}-{String((y + 1) % 100).padStart(2, '0')}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Period">
          <Select
            data-testid="select-itc04-period"
            value={Math.min(periodIndex, periods.length - 1)}
            onChange={(e) => setPeriodIndex(Number(e.target.value))}
          >
            {periods.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex-1" />
        <Panel className="p-3" data-testid="panel-itc04-obligation">
          <div className="text-micro tracking-[0.08em] text-muted uppercase">Filed</div>
          <div className="text-lead font-semibold" data-testid="text-itc04-frequency">
            {obligation.frequency}
          </div>
          <div className="text-micro text-muted">
            due {toDisplayDate(form.period.dueDate)} · turnover taken as{' '}
            <Money paise={data.turnoverPaise} />{' '}
            {data.turnoverSource === 'declared-band' ? '(from the declared band)' : '(as given)'}
          </div>
        </Panel>
      </div>

      <p className="text-micro text-muted">{obligation.rule.note}</p>

      <div className="callout-warn mt-3 rounded-md p-3" data-testid="panel-itc04-portal-audit">
        <div className="text-lead font-semibold">Portal JSON is disabled.</div>
        <p className="mt-1 text-body" data-testid="text-itc04-portal-audit">
          Official-source audit {form.portalFile.auditedOn}: GSTN&rsquo;s manual was created{' '}
          {form.portalFile.offlineToolManualCreatedOn}; the current official workbook downloaded{' '}
          {form.portalFile.utilityDownloadedOn} is {form.portalFile.offlineToolVersionShown} (SHA-256{' '}
          <span className="num">{form.portalFile.utilitySha256.slice(0, 12)}…</span>).
        </p>
        <ul className="mt-1 space-y-0.5 text-body" data-testid="list-itc04-portal-blockers">
          {form.portalFile.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
      </div>

      {form.nil && (
        <div className="callout-warn mt-3 rounded-md p-3" data-testid="panel-itc04-nil">
          <div className="text-lead font-semibold">No GSTN-ready table rows for {form.period.label}.</div>
          <p className="mt-1 text-body">
            GSTN&rsquo;s current offline utility says it cannot generate a nil JSON. Check the signed-in
            portal and your actual filing obligation; Total does not create or upload a nil file.
          </p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-5 gap-3">
        {(
          [
            ['Challans', String(form.totals.challanCount)],
            ['Sent out', qty(form.totals.sentQtyMilli)],
            ['Received back', qty(form.totals.receivedBackQtyMilli)],
            ['Supplied from his premises', qty(form.totals.suppliedOutQtyMilli)],
            ['Waste and scrap', qty(form.totals.wasteQtyMilli)]
          ] as const
        ).map(([label, value]) => (
          <Panel key={label} className="p-3">
            <div className="text-micro tracking-[0.08em] text-muted uppercase">{label}</div>
            <div className="num text-figure font-semibold">{value}</div>
          </Panel>
        ))}
      </div>

      <Itc04SentTable rows={form.table4} />
      <Itc04ReceivedTable
        title="Table 5A — received back, and losses and wastes"
        testId="itc04-5a"
        rows={form.table5A}
      />
      <Itc04ReceivedTable
        title="Table 5B — received back from a different job worker"
        testId="itc04-5b"
        rows={form.table5B}
      />
      <Itc04ReceivedTable
        title="Table 5C — supplied straight from the job worker’s premises"
        testId="itc04-5c"
        rows={form.table5C}
      />

      {form.deemed.overdue.length > 0 && (
        <Panel className="mt-4 p-3" data-testid="panel-itc04-deemed">
          <div className="text-lead font-semibold">
            As at {toDisplayDate(form.deemed.asOn)}, {form.deemed.overdue.length} challan(s) had run out of time.
          </div>
          <p className="mt-1 text-body">
            <Money paise={form.deemed.totalDeemedValuePaise} /> of goods is deemed supplied, carrying{' '}
            <Money paise={form.deemed.totalDeemedTaxPaise} /> of tax — each dated the day its challan was
            raised, so it belongs in that month&rsquo;s GSTR-1 and GSTR-3B, with interest under section 50(1)
            from that return&rsquo;s due date. It is not reported on ITC-04 itself.
          </p>
        </Panel>
      )}

      {form.issues.length > 0 && (
        <div className="callout-warn mt-4 rounded-md p-3" data-testid="panel-itc04-issues">
          <div className="text-lead font-semibold">Resolve these statutory-data issues before preparing the form.</div>
          <ul className="mt-1 space-y-0.5 text-body">
            {form.issues.map((i, n) => (
              <li key={`${i.code}-${i.challanNumber}-${n}`}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function Itc04SentTable({ rows }: { rows: Itc04Working['form']['table4'] }): React.JSX.Element {
  return (
    <div className="mt-4">
      <div className="mb-1 text-lead font-semibold">Table 4 — inputs and capital goods sent for job work</div>
      <Panel data-testid="panel-itc04-4">
        {rows.length === 0 ? (
          <EmptyState title="Nothing went out in this period" hint="Table 4 takes challans dated in the period." />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-40">Job worker</th>
                <th scope="col" className="w-24">Challan</th>
                <th scope="col" className="w-24">Date</th>
                <th scope="col">Goods</th>
                <th scope="col" className="w-20">HSN</th>
                <th scope="col" className="r w-20">Qty</th>
                <th scope="col" className="w-16">UQC</th>
                <th scope="col" className="r w-28">Value</th>
                <th scope="col" className="r w-16">Rate</th>
                <th scope="col" className="r w-24">Cess</th>
              </tr>
            </thead>
            <tbody data-testid="rows-itc04-4">
              {rows.map((r) => (
                <tr key={r.challanNumber}>
                  <td>
                    {r.unregisteredJobWorker ? (
                      <span>
                        Unregistered
                        <span className="ml-2 rounded-full bg-panel2 px-2 py-0.5 text-micro text-muted">
                          state {r.jobWorkerStateCode}
                        </span>
                      </span>
                    ) : (
                      <span className="num">{r.jobWorkerGstin}</span>
                    )}
                    {r.jobWorkerIsSez && (
                      <span className="ml-2 rounded-full bg-panel2 px-2 py-0.5 text-micro text-muted">SEZ</span>
                    )}
                  </td>
                  <td className="num">{r.challanNumber}</td>
                  <td className="num text-muted">{toDisplayDate(r.challanDate)}</td>
                  <td>
                    {r.description}
                    <span className="ml-2 text-micro text-muted">{GOODS_LABEL[r.goodsType]}</span>
                  </td>
                  <td className="num">{r.hsn || '—'}</td>
                  <td className="r num">{qty(r.qtyMilli)}</td>
                  <td>{r.uqc}</td>
                  <td className="r"><Money paise={r.taxableValuePaise} /></td>
                  <td className="r num">{r.gstRate}%</td>
                  <td className="r"><Money paise={r.cessPaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-1 text-micro text-muted">
        No tax is payable on any of this — sending goods for job work is not a supply. The rate is stated
        because the form asks for it, and because it is what the deemed supply would cost.
      </p>
    </div>
  )
}

function Itc04ReceivedTable({
  title,
  testId,
  rows
}: {
  title: string
  testId: string
  rows: Itc04Working['form']['table5A']
}): React.JSX.Element {
  return (
    <div className="mt-4">
      <div className="mb-1 text-lead font-semibold">{title}</div>
      <Panel data-testid={`panel-${testId}`} className={rows.length === 0 ? 'p-3' : ''}>
        {rows.length === 0 ? (
          // A one-liner rather than a full empty state: three of these stack up on a quiet period,
          // and a working paper is easier to read when the empty tables stay out of the way.
          <div className="text-body text-muted">
            Nothing in this table. Receipts are taken by their own date, not the challan’s.
          </div>
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-24">Original</th>
                <th scope="col" className="w-24">Dated</th>
                <th scope="col" className="w-28">Return / invoice</th>
                <th scope="col" className="w-24">Dated</th>
                <th scope="col" className="w-40">Actual worker</th>
                <th scope="col">Goods</th>
                <th scope="col">Nature of work</th>
                <th scope="col" className="r w-20">Qty</th>
                <th scope="col" className="w-16">UQC</th>
                <th scope="col" className="r w-28">Loss / waste</th>
                <th scope="col" className="r w-28">Value</th>
              </tr>
            </thead>
            <tbody data-testid={`rows-${testId}`}>
              {rows.map((r, i) => (
                <tr key={`${r.originalChallanNumber}-${r.receiptChallanNumber}-${i}`}>
                  <td className="num">{r.originalChallanNumber}</td>
                  <td className="num text-muted">{toDisplayDate(r.originalChallanDate)}</td>
                  <td className="num">{r.principalInvoiceNumber ?? r.receiptChallanNumber}</td>
                  <td className="num text-muted">{toDisplayDate(r.receiptChallanDate)}</td>
                  <td>
                    {r.unregisteredJobWorker ? `Unregistered · state ${r.jobWorkerStateCode}` : r.jobWorkerGstin}
                    {r.sourceJobWorkerIsSez && <span className="ml-2 text-micro text-muted">SEZ</span>}
                  </td>
                  <td>
                    {r.description}
                    {r.disposition === 'waste_and_scrap' && (
                      <span className="ml-2 rounded-full bg-panel2 px-2 py-0.5 text-micro text-muted">
                        waste and scrap
                      </span>
                    )}
                  </td>
                  <td>{r.natureOfJobWork || '—'}</td>
                  <td className="r num">{qty(r.qtyMilli)}</td>
                  <td>{r.uqc}</td>
                  <td className="r num">
                    {r.lossWasteQtyMilli > 0 ? `${qty(r.lossWasteQtyMilli)} ${r.lossWasteUqc}` : '—'}
                  </td>
                  <td className="r"><Money paise={r.taxableValuePaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {rows.length > 0 && (
        <p className="mt-1 text-micro text-muted">
          The value column is computed pro rata for this working. GSTN&rsquo;s current 5A/5B/5C sheets do
          not carry it; Total does not export it.
        </p>
      )}
    </div>
  )
}

type Itc04Working = Awaited<ReturnType<typeof api.jobWork.itc04>>
