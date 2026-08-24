import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type SalesDoc, type SalesDocInput, type Stage } from '../lib/client'
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
import { confirmDialog } from '../lib/dialogs'

/**
 * Quotation → order → challan → invoice (roadmap #378).
 *
 * The sale does not start at the invoice. None of the first three stages is an accounting entry,
 * so this screen posts nothing: it carries quantities and prices forward, and hands the last step
 * to voucher entry as a draft.
 */
const STAGES: { stage: Stage; label: string; sub: string }[] = [
  { stage: 'quotation', label: 'Quotations', sub: 'What was offered, and until when' },
  { stage: 'order', label: 'Orders', sub: 'What was agreed, and what is still to go out' },
  { stage: 'challan', label: 'Challans', sub: 'What was delivered, and what is still to bill' }
]

export function SalesChainScreen(): React.JSX.Element {
  const [tab, setTab] = useStickyTab<Stage>('saleschain-tab', ['quotation', 'order', 'challan'], 'quotation')
  const { data: pipeline } = useQuery({ queryKey: ['salesPipeline'], queryFn: api.salesDocs.pipeline })

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <div className="flex gap-1" role="group" aria-label="Sales chain stage">
            {STAGES.map((s) => (
              <button
                key={s.stage}
                type="button"
                data-testid={`tab-saleschain-${s.stage}`}
                aria-pressed={tab === s.stage}
                onClick={() => setTab(s.stage)}
                className={`rounded-md px-2.5 py-1 text-small ${
                  tab === s.stage ? 'bg-amberbar/25 font-medium text-ink' : 'text-muted hover:bg-panel2'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        }
      >
        Quotations, orders & challans
      </SectionTitle>

      {pipeline && (
        <div className="mb-3 flex gap-3" data-testid="panel-salespipeline">
          {pipeline.stages.map((s) => (
            <Panel key={s.stage} className="flex-1 p-3">
              <div className="text-caption tracking-[0.08em] text-muted uppercase">
                {STAGES.find((x) => x.stage === s.stage)!.label}
              </div>
              <div className="num text-h2 font-semibold">{s.open}</div>
              <div className="text-hint text-muted">
                open · <Money paise={s.openValuePaise} /> · {s.converted} converted
                {s.lost > 0 ? ` · ${s.lost} lost` : ''}
              </div>
            </Panel>
          ))}
        </div>
      )}

      <StageTab stage={tab} />
    </div>
  )
}

function StageTab({ stage }: { stage: Stage }): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<SalesDoc | 'new' | null>(null)
  const [converting, setConverting] = useState<SalesDoc | null>(null)
  const { data, isLoading } = useQuery({ queryKey: ['salesDocs', stage], queryFn: () => api.salesDocs.list(stage) })
  const rows = data ?? []
  const table = useTableNav(rows, { rowId: (d) => d.id, onEnter: (d) => setEditing(d) })

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['salesDocs'] })
    await queryClient.invalidateQueries({ queryKey: ['salesPipeline'] })
  }

  const lose = async (doc: SalesDoc): Promise<void> => {
    const ok = await confirmDialog({
      title: `Mark ${doc.number} lost`,
      message: 'It stays in the books as a record of what was quoted and not won.',
      confirmLabel: 'Mark lost'
    })
    if (!ok) return
    try {
      await api.salesDocs.close(doc.id, 'lost', null)
      await refresh()
      toast.push('success', `${doc.number} marked lost`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const toInvoice = async (doc: SalesDoc): Promise<void> => {
    try {
      const draft = await api.salesDocs.invoiceDraft(doc.id)
      nav.go({
        name: 'voucher-entry',
        kindHint: 'sales',
        draft: {
          date: draft.date,
          partyLedgerId: draft.partyLedgerId,
          narration: draft.narration,
          lines: draft.lines.map((l) => ({ ledgerName: l.ledgerName, drCr: l.drCr, amount: l.amount }))
        },
        draftId: Date.now()
      } as never)
      toast.push('info', `${doc.number} drafted as an invoice — save it, and it is billed`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" data-testid={`btn-salesdoc-add-${stage}`} onClick={() => setEditing('new')}>
          New {stage}
        </Button>
      </div>

      <Panel scroll={{ maxH: '58vh' }} data-testid={`panel-salesdocs-${stage}`}>
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={`No ${stage}s yet`}
            hint={STAGES.find((s) => s.stage === stage)!.sub}
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-28">Number</th>
                <th scope="col" className="w-28">Date</th>
                <th scope="col">For</th>
                <th scope="col" className="w-28">Status</th>
                <th scope="col" className="r w-32">Value</th>
                <th scope="col" className="w-56" />
              </tr>
            </thead>
            <tbody data-testid={`rows-salesdocs-${stage}`}>
              {rows.map((d, i) => (
                <tr key={d.id} {...table.rowProps(i, d)}>
                  <td className="num">{d.number}</td>
                  <td className="num text-muted">{toDisplayDate(d.date)}</td>
                  <td>
                    {d.partyName ?? '—'}
                    {d.reference && <span className="ml-2 text-hint text-muted">from {d.reference}</span>}
                  </td>
                  <td className={d.status === 'lost' ? 'text-cr' : d.expired ? 'text-cr' : 'text-muted'}>
                    {d.expired && d.status === 'open' ? 'expired' : d.status}
                  </td>
                  <td className="r"><Money paise={d.totalPaise} /></td>
                  <td onClick={(e) => e.stopPropagation()} className="r whitespace-nowrap">
                    {d.status === 'open' && stage !== 'challan' && (
                      <Button variant="ghost" data-testid={`btn-salesdoc-convert-${d.id}`} onClick={() => setConverting(d)}>
                        {stage === 'quotation' ? 'To order' : 'To challan'}
                      </Button>
                    )}
                    {stage === 'challan' && !d.invoiceVoucherId && (
                      <Button variant="ghost" data-testid={`btn-salesdoc-invoice-${d.id}`} onClick={() => void toInvoice(d)}>
                        Invoice
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setEditing(d)}>
                      Open
                    </Button>
                    {d.status === 'open' && (
                      <button className="ml-2 text-small text-cr hover:underline" onClick={() => void lose(d)}>
                        Lost
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
        Nothing on this screen is an accounting entry. A quotation is a price, an order is a
        promise and a challan is goods that have moved — the books only hear about it when the
        invoice is saved.
      </p>

      {editing && <DocModal stage={stage} doc={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {converting && <ConvertModal doc={converting} onClose={() => setConverting(null)} onDone={refresh} />}
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
  stage,
  doc,
  onClose,
  onSaved
}: {
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

  const setLine = (key: number, patch: Partial<LineDraft>): void =>
    setLines((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)))

  const submit = async (): Promise<void> => {
    const payload: SalesDocInput = {
      stage,
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
    <Modal title={doc ? `${doc.number}` : `New ${stage}`} onClose={onClose} wide>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Date">
          <TextInput type="date" data-testid="input-salesdoc-date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Party" hint={stage === 'quotation' ? 'Or just a name, below' : 'An order needs a ledger'}>
          <Select
            data-testid="select-salesdoc-party"
            value={partyLedgerId}
            onChange={(e) => setPartyLedgerId(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Not a customer yet</option>
            {(ledgers ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Or a name">
          <TextInput data-testid="input-salesdoc-name" value={partyName} onChange={(e) => setPartyName(e.target.value)} />
        </Field>
        {stage === 'quotation' && (
          <Field label="Valid until" hint="A quotation with no end is a price you are still held to">
            <TextInput type="date" data-testid="input-salesdoc-valid" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        )}
      </div>

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
                  <button className="text-small text-cr hover:underline" onClick={() => setLines((x) => x.filter((y) => y.key !== l.key))}>
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
  const next = doc.stage === 'quotation' ? 'order' : 'challan'

  const go = async (): Promise<void> => {
    try {
      const created = await api.salesDocs.convert(doc.id, {
        date,
        quantities: doc.lines.map((l) => ({ lineId: l.id, qtyMilli: quantities[l.id] ?? 0 }))
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
            <th scope="col" className="r w-24">Already out</th>
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
      <p className="mt-2 text-hint text-muted">
        Take less than the whole and the {doc.stage} stays open with the rest still pending. Take
        it all and it closes — a document converts once, and only once.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="btn-convert-go" onClick={() => void go()}>
          Convert
        </Button>
      </div>
    </Modal>
  )
}
