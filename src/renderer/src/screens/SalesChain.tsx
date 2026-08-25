import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type SalesDoc, type SalesDocInput, type Side, type Stage } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import {
  AmountInput,
  Button,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../components/ui'
import { useStickyTab } from '../lib/useStickyTab'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise, parseMilli } from '@shared/money'
import { FULFILMENT_LABEL, MATCH_LABEL } from '@shared/fulfilment'
import { confirmDialog } from '../lib/dialogs'

/**
 * Quotation → order → challan → invoice, outward and inward (roadmap #378, #188, #189).
 *
 * The sale does not start at the invoice and the purchase does not start at the bill. None of the
 * stages before the last is an accounting entry, so this screen posts nothing: it carries
 * quantities and prices forward, and hands the last step to voucher entry as a draft.
 *
 * The inward half is the same three stages read the other way, and the column that matters on it
 * is not the value — it is what is still owed. An order that reports itself as open or closed and
 * nothing in between is the failure this screen exists to prevent.
 */
const TABS: Record<Side, { stage: Stage; label: string; sub: string }[]> = {
  sales: [
    { stage: 'quotation', label: 'Quotations', sub: 'What was offered, and until when' },
    { stage: 'order', label: 'Orders', sub: 'What was agreed, and what is still to go out' },
    { stage: 'challan', label: 'Challans', sub: 'What was delivered, and what is still to bill' }
  ],
  purchase: [
    { stage: 'order', label: 'Purchase orders', sub: 'What was ordered, and what has arrived against it' },
    { stage: 'challan', label: 'Receipt notes', sub: 'What actually arrived, and whether anybody ordered it' }
  ]
}

const SIDES: { side: Side; label: string }[] = [
  { side: 'sales', label: 'Outward' },
  { side: 'purchase', label: 'Inward' }
]

export function SalesChainScreen(): React.JSX.Element {
  const [side, setSide] = useStickyTab<Side>('saleschain-side', ['sales', 'purchase'], 'sales')
  const [salesTab, setSalesTab] = useStickyTab<Stage>('saleschain-tab', ['quotation', 'order', 'challan'], 'quotation')
  const [purchaseTab, setPurchaseTab] = useStickyTab<Stage>('purchasechain-tab', ['order', 'challan'], 'order')
  const tab = side === 'sales' ? salesTab : purchaseTab
  const setTab = side === 'sales' ? setSalesTab : setPurchaseTab
  const { data: pipeline } = useQuery({
    queryKey: ['salesPipeline', side],
    queryFn: () => api.salesDocs.pipeline(side)
  })

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex items-center gap-3">
            <div className="flex gap-1" role="group" aria-label="Direction">
              {SIDES.map((s) => (
                <button
                  key={s.side}
                  type="button"
                  data-testid={`tab-chain-side-${s.side}`}
                  aria-pressed={side === s.side}
                  onClick={() => setSide(s.side)}
                  className={`rounded-md px-2.5 py-1 text-small ${
                    side === s.side ? 'bg-accent/20 font-medium text-accent' : 'text-muted hover:bg-panel2'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="flex gap-1" role="group" aria-label="Stage">
              {TABS[side].map((s) => (
                <button
                  key={s.stage}
                  type="button"
                  data-testid={`tab-saleschain-${side}-${s.stage}`}
                  aria-pressed={tab === s.stage}
                  onClick={() => setTab(s.stage)}
                  className={`rounded-md px-2.5 py-1 text-small ${
                    tab === s.stage ? 'bg-accentbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {side === 'sales' ? 'Quotations, orders & challans' : 'Purchase orders & receipt notes'}
      </SectionTitle>

      {pipeline && (
        <div className="mb-3 flex gap-3" data-testid="panel-salespipeline">
          {pipeline.stages.map((s) => (
            <Panel key={s.stage} className="flex-1 p-3" data-testid={`card-pipeline-${side}-${s.stage}`}>
              <div className="text-caption tracking-[0.08em] text-muted uppercase">{s.label}</div>
              <div className="num text-h2 font-semibold">{s.open}</div>
              <div className="text-hint text-muted">
                open · <Money paise={s.openValuePaise} /> · {s.converted} converted
                {s.lost > 0 ? ` · ${s.lost} lost` : ''}
              </div>
              {/* The count that a two-valued open/closed flag cannot express. */}
              {s.partlyFulfilled > 0 && (
                <div className="text-hint text-muted" data-testid={`pipeline-partial-${s.stage}`}>
                  {s.partlyFulfilled} part {side === 'sales' ? 'delivered' : 'received'}
                </div>
              )}
              {s.overMilli > 0 && (
                <div className="text-hint text-cr" data-testid={`pipeline-over-${s.stage}`}>
                  {s.overMilli / 1000} over-received
                </div>
              )}
            </Panel>
          ))}
        </div>
      )}

      {pipeline && pipeline.unordered.length > 0 && (
        <Panel className="mb-3 p-3" data-testid="panel-unordered">
          <div className="text-caption tracking-[0.08em] text-muted uppercase">Arrived with no order</div>
          <p className="mt-1 text-hint text-muted">
            The goods are in the godown either way, so the receipt note exists. What it cannot do is
            claim an order authorised them:{' '}
            <span className="num">{pipeline.unordered.map((d) => d.number).join(', ')}</span>.
          </p>
        </Panel>
      )}

      <StageTab key={`${side}-${tab}`} side={side} stage={tab} />
    </div>
  )
}

function StageTab({ side, stage }: { side: Side; stage: Stage }): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<SalesDoc | 'new' | null>(null)
  const [converting, setConverting] = useState<SalesDoc | null>(null)
  const [matching, setMatching] = useState<SalesDoc | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['salesDocs', side, stage],
    queryFn: () => api.salesDocs.list(stage, undefined, side)
  })
  const rows = data ?? []
  const table = useTableNav(rows, { rowId: (d) => d.id, onEnter: (d) => setEditing(d) })
  const inward = side === 'purchase'
  const meta = TABS[side].find((s) => s.stage === stage)!

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['salesDocs'] })
    await queryClient.invalidateQueries({ queryKey: ['salesPipeline'] })
  }

  const lose = async (doc: SalesDoc): Promise<void> => {
    const ok = await confirmDialog({
      title: inward ? `Close ${doc.number}` : `Mark ${doc.number} lost`,
      message: inward
        ? 'It stays in the books as a record of what was ordered and never came.'
        : 'It stays in the books as a record of what was quoted and not won.',
      confirmLabel: inward ? 'Close short' : 'Mark lost'
    })
    if (!ok) return
    try {
      await api.salesDocs.close(doc.id, inward ? 'closed' : 'lost', null)
      await refresh()
      toast.push('success', `${doc.number} ${inward ? 'closed' : 'marked lost'}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const toInvoice = async (doc: SalesDoc): Promise<void> => {
    try {
      const draft = await api.salesDocs.invoiceDraft(doc.id)
      nav.go({
        name: 'voucher-entry',
        kindHint: inward ? 'purchase' : 'sales',
        draft: {
          date: draft.date,
          partyLedgerId: draft.partyLedgerId,
          narration: draft.narration,
          lines: draft.lines.map((l) => ({ ledgerName: l.ledgerName, drCr: l.drCr, amount: l.amount }))
        },
        draftId: Date.now()
      } as never)
      toast.push('info', `${doc.number} drafted as a ${inward ? 'purchase' : 'sales'} entry — save it, and it is billed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid={`btn-salesdoc-add-${side}-${stage}`} onClick={() => setEditing('new')}>
          New {meta.label.replace(/s$/, '').toLowerCase()}
        </Button>
      </div>

      <Panel scroll={{ maxH: '58vh' }} data-testid={`panel-salesdocs-${side}-${stage}`}>
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState title={`No ${meta.label.toLowerCase()} yet`} hint={meta.sub} />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Number</th>
                <th scope="col" className="w-28">Date</th>
                <th scope="col">{inward ? 'From' : 'For'}</th>
                <th scope="col" className="w-40">Status</th>
                {stage === 'order' && <th scope="col" className="r w-28">Still owed</th>}
                <th scope="col" className="r w-32">Value</th>
                <th scope="col" className="w-64" />
              </tr>
            </thead>
            <tbody data-testid={`rows-salesdocs-${side}-${stage}`}>
              {rows.map((d, i) => (
                <tr key={d.id} {...table.rowProps(i, d)}>
                  <td className="num">{d.number}</td>
                  <td className="num text-muted">{toDisplayDate(d.date)}</td>
                  <td>
                    {d.partyName ?? '—'}
                    {d.reference && <span className="ml-2 text-hint text-muted">from {d.reference}</span>}
                    {d.unordered && (
                      <span className="ml-2 text-hint text-cr" data-testid={`badge-unordered-${d.id}`}>
                        no order
                      </span>
                    )}
                  </td>
                  <td
                    className={d.status === 'lost' || d.expired || d.fulfilment.overMilli > 0 ? 'text-cr' : 'text-muted'}
                    data-testid={`cell-status-${d.id}`}
                  >
                    {d.expired && d.status === 'open'
                      ? 'expired'
                      : d.status === 'open' && stage === 'order'
                        ? FULFILMENT_LABEL[d.fulfilment.state].toLowerCase()
                        : d.status}
                    {d.fulfilment.overMilli > 0 && stage === 'order' && (
                      <span className="ml-1">(+{d.fulfilment.overMilli / 1000})</span>
                    )}
                  </td>
                  {stage === 'order' && (
                    <td className="r num" data-testid={`cell-pending-${d.id}`}>
                      {d.fulfilment.pendingMilli / 1000}
                    </td>
                  )}
                  <td className="r"><Money paise={d.totalPaise} /></td>
                  <td onClick={(e) => e.stopPropagation()} className="r whitespace-nowrap">
                    {d.status === 'open' && stage !== 'challan' && (
                      <Button variant="ghost" data-testid={`btn-salesdoc-convert-${d.id}`} onClick={() => setConverting(d)}>
                        {inward ? 'Receive' : stage === 'quotation' ? 'To order' : 'To challan'}
                      </Button>
                    )}
                    {stage === 'challan' && !d.invoiceVoucherId && (
                      <Button variant="ghost" data-testid={`btn-salesdoc-invoice-${d.id}`} onClick={() => void toInvoice(d)}>
                        {inward ? 'Bill' : 'Invoice'}
                      </Button>
                    )}
                    {inward && (
                      <Button variant="ghost" data-testid={`btn-salesdoc-match-${d.id}`} onClick={() => setMatching(d)}>
                        Match
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setEditing(d)}>
                      Open
                    </Button>
                    {d.status === 'open' && (
                      <button className="row-action ml-2 text-small text-cr hover:underline" onClick={() => void lose(d)}>
                        {inward ? 'Close' : 'Lost'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="mt-2 text-hint text-muted">
        {inward
          ? 'Nothing on this screen is an accounting entry. An order is a commitment and a receipt note is goods that have arrived — the books only hear about it when the supplier’s bill is saved.'
          : 'Nothing on this screen is an accounting entry. A quotation is a price, an order is a promise and a challan is goods that have moved — the books only hear about it when the invoice is saved.'}
      </p>

      {editing && (
        <DocModal
          side={side}
          stage={stage}
          doc={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {converting && <ConvertModal doc={converting} onClose={() => setConverting(null)} onDone={refresh} />}
      {matching && <MatchModal doc={matching} onClose={() => setMatching(null)} />}
    </>
  )
}

interface LineDraft {
  key: number
  stockItemId: number | null
  description: string
  qtyMilli: number
  ratePaise: number
}

let lineKey = 1

function DocModal({
  side,
  stage,
  doc,
  onClose,
  onSaved
}: {
  side: Side
  stage: Stage
  doc: SalesDoc | null
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const toast = useToasts()
  const { data: ledgers } = useQuery({ queryKey: ['ledgers'], queryFn: api.ledgers.list })
  const { data: items } = useQuery({ queryKey: ['stockItems'], queryFn: api.stockItems.list })
  const [date, setDate] = useState(doc?.date ?? todayISO())
  const [partyLedgerId, setPartyLedgerId] = useState<number | ''>(doc?.partyLedgerId ?? '')
  const [partyName, setPartyName] = useState(doc?.partyName ?? '')
  const [validUntil, setValidUntil] = useState(doc?.validUntil ?? '')
  const [terms, setTerms] = useState(doc?.terms ?? '')
  const [lines, setLines] = useState<LineDraft[]>(
    doc?.lines.map((l) => ({
      key: lineKey++,
      stockItemId: l.stockItemId,
      description: l.description,
      qtyMilli: l.qtyMilli,
      ratePaise: l.ratePaise
    })) ?? [{ key: lineKey++, stockItemId: null, description: '', qtyMilli: 1000, ratePaise: 0 }]
  )
  const readOnly = doc?.status === 'converted'
  const inward = side === 'purchase'

  const setLine = (key: number, patch: Partial<LineDraft>): void =>
    setLines((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  const submit = async (): Promise<void> => {
    const payload: SalesDocInput = {
      stage,
      side,
      date,
      partyLedgerId: partyLedgerId === '' ? null : partyLedgerId,
      partyName: partyName.trim() || null,
      validUntil: validUntil || null,
      terms: terms.trim() || null,
      lines: lines
        .filter((l) => l.description.trim() && l.qtyMilli > 0)
        .map((l) => ({
          stockItemId: l.stockItemId,
          description: l.description.trim(),
          qtyMilli: l.qtyMilli,
          ratePaise: l.ratePaise
        }))
    }
    try {
      await api.salesDocs.save(payload, doc?.id)
      await onSaved()
      toast.push('success', doc ? `${doc.number} saved` : 'Saved')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={doc ? `${doc.number}` : `New ${TABS[side].find((s) => s.stage === stage)!.label.replace(/s$/, '').toLowerCase()}`} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Date">
          <TextInput type="date" data-testid="input-salesdoc-date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field
          label={inward ? 'Supplier' : 'Party'}
          hint={inward ? 'A payable needs a ledger, not a name' : stage === 'quotation' ? 'Or just a name, below' : 'An order needs a ledger'}
        >
          <Select
            data-testid="select-salesdoc-party"
            value={partyLedgerId}
            onChange={(e) => setPartyLedgerId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">{inward ? 'Pick a supplier' : 'Not a customer yet'}</option>
            {(ledgers ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        {!inward && (
          <Field label="Or a name">
            <TextInput data-testid="input-salesdoc-name" value={partyName} onChange={(e) => setPartyName(e.target.value)} />
          </Field>
        )}
        {stage === 'quotation' && (
          <Field label="Valid until" hint="A quotation with no end is a price you are still held to">
            <TextInput type="date" data-testid="input-salesdoc-valid" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        )}
      </div>

      {inward && stage === 'challan' && !doc && (
        <p className="mt-3 text-hint text-muted">
          A receipt note raised here has no order behind it. That is allowed — goods do arrive
          unannounced — and it is recorded as exactly that rather than as an order that was
          fulfilled.
        </p>
      )}

      <table className="ledger-table mt-4">
        <thead>
          <tr>
            <th scope="col" className="w-56">Item</th>
            <th scope="col">Description</th>
            <th scope="col" className="r w-24">Qty</th>
            <th scope="col" className="r w-32">Rate</th>
            <th scope="col" className="r w-32">Amount</th>
            <th scope="col" className="w-8" />
          </tr>
        </thead>
        <tbody data-testid="rows-salesdoc-lines">
          {lines.map((l, i) => (
            <tr key={l.key}>
              <td>
                <Select
                  data-testid={`select-salesdoc-item-${i}`}
                  value={l.stockItemId ?? ''}
                  disabled={readOnly}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null
                    const item = (items ?? []).find((x) => x.id === id)
                    setLine(l.key, { stockItemId: id, description: item?.name ?? l.description })
                  }}
                >
                  <option value="">A service, not an item</option>
                  {(items ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </td>
              <td>
                <TextInput
                  data-testid={`input-salesdoc-desc-${i}`}
                  value={l.description}
                  disabled={readOnly}
                  onChange={(e) => setLine(l.key, { description: e.target.value })}
                />
              </td>
              <td className="r">
                <TextInput
                  data-testid={`input-salesdoc-qty-${i}`}
                  className="num text-right"
                  value={String(l.qtyMilli / 1000)}
                  disabled={readOnly}
                  onChange={(e) => setLine(l.key, { qtyMilli: parseMilli(e.target.value) ?? 0 })}
                />
              </td>
              <td className="r">
                <AmountInput
                  testId={`input-salesdoc-rate-${i}`}
                  paise={l.ratePaise}
                  onPaise={(p) => setLine(l.key, { ratePaise: p ?? 0 })}
                />
              </td>
              <td className="r num">{formatPaise(Math.round((l.qtyMilli * l.ratePaise) / 1000))}</td>
              <td className="r">
                {!readOnly && (
                  <button
                    className="row-action text-small text-cr hover:underline"
                    aria-label="Remove line"
                    onClick={() => setLines((x) => x.filter((y) => y.key !== l.key))}
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <Button
          className="mt-2"
          data-testid="btn-salesdoc-addline"
          onClick={() => setLines((l) => [...l, { key: lineKey++, stockItemId: null, description: '', qtyMilli: 1000, ratePaise: 0 }])}
        >
          Add a line
        </Button>
      )}

      <div className="mt-3">
        <Field label="Terms" hint="Printed under the document">
          <TextInput data-testid="input-salesdoc-terms" value={terms} disabled={readOnly} onChange={(e) => setTerms(e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        {!readOnly && (
          <Button variant="primary" data-testid="btn-salesdoc-save" onClick={() => void submit()}>
            Save
          </Button>
        )}
      </div>
    </Modal>
  )
}

function ConvertModal({
  doc,
  onClose,
  onDone
}: {
  doc: SalesDoc
  onClose: () => void
  onDone: () => Promise<void>
}): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(todayISO())
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(doc.lines.map((l) => [l.id, l.pendingMilli]))
  )
  const inward = doc.side === 'purchase'
  const next = inward ? 'receipt note' : doc.stage === 'quotation' ? 'order' : 'challan'
  // Only ever true inward: our own challan cannot exceed our own order, but the supplier's lorry
  // is not ours to control, and the goods are in the godown either way.
  const excess = doc.lines.some((l) => (quantities[l.id] ?? 0) > l.pendingMilli)

  const go = async (): Promise<void> => {
    try {
      const created = await api.salesDocs.convert(doc.id, {
        date,
        quantities: doc.lines.map((l) => ({ lineId: l.id, qtyMilli: quantities[l.id] ?? 0 })),
        allowOver: inward
      })
      await onDone()
      toast.push('success', `${doc.number} became ${created.number}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`${doc.number} → ${next}`} onClose={onClose} wide>
      <Field label="Dated">
        <TextInput type="date" data-testid="input-convert-date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <table className="ledger-table mt-3">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col" className="r w-24">Ordered</th>
            <th scope="col" className="r w-24">{inward ? 'Already in' : 'Already out'}</th>
            <th scope="col" className="r w-28">Taking now</th>
          </tr>
        </thead>
        <tbody data-testid="rows-convert">
          {doc.lines.map((l, i) => (
            <tr key={l.id}>
              <td>{l.description}</td>
              <td className="r num">{l.qtyMilli / 1000}</td>
              <td className="r num text-muted">{l.fulfilledMilli / 1000}</td>
              <td className="r">
                <TextInput
                  data-testid={`input-convert-qty-${i}`}
                  className="num text-right"
                  value={String((quantities[l.id] ?? 0) / 1000)}
                  onChange={(e) => setQuantities((q) => ({ ...q, [l.id]: parseMilli(e.target.value) ?? 0 }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {excess && inward && (
        <p className="mt-2 text-hint text-cr" data-testid="hint-over-receipt">
          More than was ordered. It is recorded as an over-receipt rather than clipped — the goods
          are physically here, and the stock ledger has to agree with the godown.
        </p>
      )}
      <p className="mt-2 text-hint text-muted">
        {inward
          ? 'Take less than the whole and the order stays open with the rest still pending — an order is a balance, not a switch.'
          : 'Take less than the whole and the ' + doc.stage + ' stays open with the rest still pending. Take it all and it closes — a document converts once, and only once.'}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-convert-go" onClick={() => void go()}>
          {inward ? 'Receive' : 'Convert'}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Ordered, received, billed — side by side (roadmap #189).
 *
 * The three disagree far more often than anybody expects, and a bill for more than arrived is
 * money leaving the business for nothing. Quantities only: what a variance is worth is the
 * invoice's arithmetic, and a second answer to that question is worse than none.
 */
function MatchModal({ doc, onClose }: { doc: SalesDoc; onClose: () => void }): React.JSX.Element {
  const { data, error } = useQuery({ queryKey: ['salesDocMatch', doc.id], queryFn: () => api.salesDocs.match(doc.id) })

  return (
    <Modal title={`${doc.number} — ordered, received, billed`} onClose={onClose} wide>
      {error ? (
        <p className="text-cr">{(error as Error).message}</p>
      ) : !data ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <p className="text-hint text-muted">
            {data.orderNumber ? `Order ${data.orderNumber}` : 'No order behind this receipt'} ·{' '}
            {data.receiptNumbers.length ? `received on ${data.receiptNumbers.join(', ')}` : 'nothing received'} ·{' '}
            {data.invoiceNumbers.length ? `billed on ${data.invoiceNumbers.join(', ')}` : 'not billed yet'}
          </p>
          <table className="ledger-table mt-3">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="r w-24">Ordered</th>
                <th scope="col" className="r w-24">Received</th>
                <th scope="col" className="r w-24">Billed</th>
                <th scope="col" className="w-64">Says</th>
              </tr>
            </thead>
            <tbody data-testid="rows-match">
              {data.rows.map((r) => (
                <tr key={r.key} data-testid={`row-match-${r.key}`}>
                  <td>{r.description}</td>
                  <td className="r num">{r.orderedMilli / 1000}</td>
                  <td className="r num">{r.receivedMilli / 1000}</td>
                  <td className="r num">{r.invoicedMilli / 1000}</td>
                  <td className={r.status === 'matched' ? 'text-muted' : 'text-cr'} data-testid={`match-status-${r.key}`}>
                    {MATCH_LABEL[r.status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-hint text-muted" data-testid="match-verdict">
            {data.clean
              ? 'All three agree.'
              : `${data.exceptions.length} line${data.exceptions.length === 1 ? '' : 's'} disagree — worst first.`}
          </p>
        </>
      )}
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  )
}
