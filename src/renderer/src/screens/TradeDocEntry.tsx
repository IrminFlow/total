// Quotation / sales order / purchase order entry (WP 2.5c, design §5.2). Header: party, date,
// validity (quotation) or expected date (orders), reference, terms; the shared item grid
// (qty, rate, discount, GST % — no stock detail: orders move no goods); totals with GST through
// the invoice's own computation; narration. A sales order can draw lines from quotations
// ("Add from quotations…", ⌥A); a converted draft arrives with its lines already linked.
// State ⇄ payload lives in @shared/tradeCycle/edit; the document's status is derived server-side.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TradeDocKind } from '@shared/domain'
import type { TradeDoc, TradeDocDraft } from '@shared/tradeCycle/types'
import {
  buildTradeDocPayload, computeTradeDoc, emptyTradeDocState, TRADE_DOC_TITLES, tradeDocIsSales, tradeDocStateFromDoc,
  tradeDocStateFromDraft, tradeDocToPayload, type TradeDocContext, type TradeDocFormState
} from '@shared/tradeCycle/edit'
import { amountInWords, formatPaise, formatQtyMilli } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { api } from '../lib/client'
import { useCanEditMasters } from '../lib/drill'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  Banner, Button, DateInput, Field, isAnyModalOpen, Kbd, Money, Page, PageHeader, Panel, Select, SkeletonRows, Textarea, TextInput
} from '../components/ui'
import { MenuButton } from '../components/kit/Menu'
import { LedgerPicker, useLedgers, useStockItems } from '../components/pickers'
import { LinkedDocsButton } from '../components/LinkedDocs'
import { DocLink } from '../components/links'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import { useFeatures } from '../lib/useFeatures'
import { nextLineKey } from './voucher/hooks'
import { blankItemRow, ItemLineGrid, type ItemRow } from './voucher/ItemLineGrid'
import { QuickItemModal, QuickLedgerModal } from './voucher/modals'
import { AddFromDrawer } from './voucher/AddFromDrawer'
import { useAddFrom } from './voucher/useAddFrom'
import { LIST_SCREEN, TradeStatusBadge, useTradeDocActions } from './trade/tradeDocShared'

export function TradeDocEntry({ kind, id, draft }: { kind: TradeDocKind; id?: number; draft?: TradeDocDraft }): React.JSX.Element {
  const { data: doc, isLoading } = useQuery({
    queryKey: ['tradeDoc', id],
    queryFn: () => api.tradeDocs.get(id!),
    enabled: id != null
  })
  const { data: types } = useQuery({ queryKey: ['tradeDocTypes'], queryFn: api.tradeDocTypes.list })
  if ((id != null && (isLoading || !doc)) || !types) {
    return (
      <Page>
        <PageHeader title={id != null ? `${TRADE_DOC_TITLES[kind]}` : `New ${TRADE_DOC_TITLES[kind].toLowerCase()}`} />
        <Panel>{id != null && !isLoading && !doc ? <p className="p-4 text-muted">Document not found.</p> : <SkeletonRows rows={6} />}</Panel>
      </Page>
    )
  }
  // One form instance per loaded document version (a reopen / restore refetches it).
  return <TradeDocForm key={doc ? `${doc.id}-${doc.updatedAt}-${doc.manualStatus}-${doc.deletedAt ?? ''}` : 'new'} kind={doc?.kind ?? kind} doc={doc ?? undefined} draft={draft} types={types} />
}

function TradeDocForm({
  kind,
  doc,
  draft,
  types
}: {
  kind: TradeDocKind
  doc?: TradeDoc
  draft?: TradeDocDraft
  types: { id: number; name: string; kind: TradeDocKind; numbering: 'auto' | 'manual' }[]
}): React.JSX.Element {
  const isEdit = doc != null
  const { info, workingDate, setWorkingDate } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const ledgers = useLedgers()
  const items = useStockItems()
  const features = useFeatures()
  const canWrite = useCanEditMasters()
  const sales = tradeDocIsSales(kind)
  const title = TRADE_DOC_TITLES[kind]
  const readOnly = !canWrite || (isEdit && (doc.manualStatus !== 'open' || doc.deletedAt != null))

  const series = types.filter((t) => t.kind === kind)
  const [start] = useState<TradeDocFormState>(() =>
    doc ? tradeDocStateFromDoc(doc) : draft ? tradeDocStateFromDraft(draft, workingDate) : emptyTradeDocState(kind, workingDate)
  )
  const [docTypeId, setDocTypeId] = useState<number>(doc?.docTypeId ?? series[0]?.id ?? 0)
  const [date, setDate] = useState(start.date)
  const [number, setNumber] = useState(start.number)
  const [partyId, setPartyId] = useState<number | null>(start.partyId)
  const [validUntil, setValidUntil] = useState(start.validUntil)
  const [dueDate, setDueDate] = useState(start.dueDate)
  const [reference, setReference] = useState(start.reference)
  const [terms, setTerms] = useState(start.terms)
  const [narration, setNarration] = useState(start.narration)
  const [rows, setRows] = useState<ItemRow[]>(() => [...start.rows.map((r) => ({ ...r, key: nextLineKey() })), blankItemRow()])
  const [saving, setSaving] = useState(false)
  const [quickLedger, setQuickLedger] = useState<string | null>(null)
  const [quickItem, setQuickItem] = useState<{ name: string; row: number } | null>(null)
  const party = ledgers.find((l) => l.id === partyId) ?? null
  const type = series.find((t) => t.id === docTypeId)

  // The series' next number, shown while the field is blank (saved blank = auto).
  const { data: suggested } = useQuery({
    queryKey: ['tradeDocNextNumber', docTypeId, date],
    queryFn: () => api.tradeDocTypes.nextNumber(docTypeId, date),
    enabled: !isEdit && !!docTypeId && type?.numbering !== 'manual'
  })

  const ctx: TradeDocContext = useMemo(
    () => ({
      kind,
      companyStateCode: info!.stateCode,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode }]))
    }),
    [kind, info, items, ledgers]
  )
  const formState: TradeDocFormState = useMemo(
    () => ({
      ...start, kind, date, number, partyId, validUntil, dueDate, reference, terms, narration,
      rows: rows.map(({ key: _key, ...r }) => r)
    }),
    [start, kind, date, number, partyId, validUntil, dueDate, reference, terms, narration, rows]
  )
  const computed = useMemo(() => computeTradeDoc(formState, ctx), [formState, ctx])

  // Dirty: an alteration once its payload differs from the stored document; a new one once
  // anything meaningful is typed.
  const original = useMemo(() => (doc ? JSON.stringify(tradeDocToPayload(doc)) : null), [doc])
  const built = buildTradeDocPayload(formState, ctx, docTypeId)
  const dirty = isEdit ? !readOnly && (!built.ok || JSON.stringify(built.payload) !== original) : partyId != null || rows.some((r) => r.itemId != null)
  const [saved, setSaved] = useState(false)
  useUnsavedGuard(!saved && dirty)

  // A sales order draws on quotations (rules.ts: quotation → sales_order).
  const addFrom = useAddFrom({
    kind, enabled: !readOnly && features.orders && kind === 'sales_order', partyId, tradeDocId: doc?.id, rows, setRows
  })
  const byUid = useMemo(() => new Map((doc?.lines ?? []).map((l) => [l.lineUid, l])), [doc])
  const rowNote = (r: ItemRow): React.ReactNode => {
    const saved = r.lineUid ? byUid.get(r.lineUid) : undefined
    return (
      <>
        {addFrom.rowNote(r)}
        {saved && saved.doneMilli > 0 && (
          <span className="mt-0.5 ml-1 inline-flex rounded bg-success-soft px-1.5 text-hint text-success" data-testid="chip-line-done">
            {formatQtyMilli(saved.doneMilli)} of {formatQtyMilli(saved.qtyMilli)} {kind === 'quotation' ? 'converted' : sales ? 'delivered' : 'received'}
          </span>
        )}
      </>
    )
  }

  const setRow = (i: number, patch: Partial<ItemRow>): void => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { ...r, ...patch } : r))
      if (next[next.length - 1]!.itemId != null) next.push(blankItemRow())
      return next
    })
  }

  const actions = useTradeDocActions((what) => {
    if (what === 'deleted') nav.replace({ name: LIST_SCREEN[kind] })
  })

  const save = useCallback(async (andPdf = false): Promise<void> => {
    if (saving || readOnly) return
    const r = buildTradeDocPayload(formState, ctx, docTypeId)
    if (!r.ok) return void toast.push('error', r.error)
    setSaving(true)
    try {
      const result = await api.tradeDocs.save(r.payload, doc?.id)
      toast.push('success', `${title} ${result.doc.number} ${isEdit ? 'altered' : 'saved'} — ${formatPaise(result.doc.totals.total, { symbol: true })}`)
      for (const w of result.warnings.linkDates) toast.push('warning', w)
      if (andPdf) await api.tradeDocs.pdf(result.doc.id).catch((err: Error) => toast.push('error', err.message))
      setWorkingDate(date)
      setSaved(true)
      await queryClient.invalidateQueries()
      // Stay on the saved document: its convert / print actions are the next step.
      nav.replace({ name: 'trade-doc', kind, id: result.doc.id })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }, [saving, readOnly, formState, ctx, docTypeId, toast, doc, title, isEdit, setWorkingDate, date, queryClient, nav, kind])

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
    if (!doc) return
    const ok = await confirmDialog({
      title: 'Move to Bin',
      message: `Move ${title.toLowerCase()} ${doc.number} to the bin? It stays restorable from the list.`,
      confirmLabel: 'Move to Bin',
      danger: true
    })
    if (!ok) return
    try {
      await api.tradeDocs.remove(doc.id)
      toast.push('success', `${title} ${doc.number} moved to the bin`)
      setSaved(true)
      await queryClient.invalidateQueries()
      nav.replace({ name: LIST_SCREEN[kind] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const shownNumber = isEdit ? number : number || (type?.numbering === 'manual' ? '' : (suggested ?? ''))
  const actionDoc = doc
    ? { id: doc.id, kind: doc.kind, number: doc.number, partyLedgerId: doc.partyLedgerId, status: doc.status, binned: doc.deletedAt != null }
    : null

  return (
    <Page width="standard">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {isEdit ? `${title} ${doc.number}` : `New ${title.toLowerCase()}`}
            {doc && <TradeStatusBadge kind={doc.kind} status={doc.status} binned={doc.deletedAt != null} />}
          </span>
        }
        secondary={doc ? <LinkedDocsButton target={{ tradeDocId: doc.id }} /> : undefined}
        actions={
          actionDoc ? (
            <MenuButton label="Document actions" testId="trade-doc-actions" items={actions.menu(actionDoc, { canWrite, open: false })}>
              Actions ▾
            </MenuButton>
          ) : undefined
        }
      />
      {doc && readOnly && canWrite && (
        <Banner tone="info" className="mb-section" testId="trade-doc-readonly">
          {doc.deletedAt
            ? 'In the bin — restore it (Actions) to make changes.'
            : doc.manualStatus === 'cancelled'
              ? `Cancelled${doc.closeReason ? ` — ${doc.closeReason}` : ''}. Reopen it (Actions) to make changes.`
              : `${kind === 'quotation' ? 'Closed' : 'Short-closed'}${doc.closeReason ? ` — ${doc.closeReason}` : ''}. Reopen it (Actions) to make changes.`}
        </Banner>
      )}
      {doc && (doc.upstream.length > 0 || doc.downstream.length > 0) && (
        <Banner tone="info" className="mb-section" testId="trade-doc-linked">
          {doc.upstream.length > 0 && (
            <span>
              From{' '}
              {doc.upstream.map((u, i) => (
                <span key={`${u.voucherId}-${u.tradeDocId}`}>
                  {i > 0 && ', '}
                  <DocLink voucherId={u.voucherId} tradeDocId={u.tradeDocId} kind={u.kind} label={u.label} />
                </span>
              ))}
              {doc.downstream.length > 0 && ' · '}
            </span>
          )}
          {doc.downstream.length > 0 && (
            <span>
              {kind === 'quotation' ? 'Converted to' : sales ? 'Delivered / invoiced on' : 'Received / billed on'}{' '}
              {doc.downstream.map((d, i) => (
                <span key={`${d.voucherId}-${d.tradeDocId}`} className={d.live ? '' : 'text-muted line-through'}>
                  {i > 0 && ', '}
                  <DocLink voucherId={d.voucherId} tradeDocId={d.tradeDocId} kind={d.kind} label={d.label} />{' '}
                  <span className="num text-muted">({formatQtyMilli(d.qtyMilli)})</span>
                </span>
              ))}
            </span>
          )}
        </Banner>
      )}
      <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
        <Panel className="p-5" testId={`trade-doc-${kind}`}>
          <div className="grid grid-cols-4 gap-3">
            <Field label="No." hint={isEdit ? undefined : type?.numbering === 'manual' ? 'Numbered by hand' : 'Auto — edit to override'}>
              <TextInput
                value={shownNumber}
                onChange={(e) => setNumber(e.target.value)}
                placeholder={type?.numbering === 'manual' ? 'Number' : 'Auto'}
                className="num"
                data-testid="input-trade-doc-number"
              />
            </Field>
            <Field label="Date">
              <DateInput value={date} context={workingDate} onChange={setDate} />
            </Field>
            <Field label={sales ? 'Customer (party)' : 'Supplier (party)'}>
              <LedgerPicker
                autoFocus={!isEdit && !draft}
                value={partyId}
                onPick={setPartyId}
                placeholder="Party ledger"
                onCreateRequest={(name) => setQuickLedger(name)}
                testId="picker-party"
              />
            </Field>
            {kind === 'quotation' ? (
              <Field label="Valid until" hint={validUntil ? undefined : 'No expiry'}>
                <DateInput value={validUntil} context={date} onChange={setValidUntil} testId="input-trade-doc-valid-until" allowEmpty placeholder="None" />
              </Field>
            ) : (
              <Field label={sales ? 'Expected delivery' : 'Deliver by'}>
                <DateInput value={dueDate} context={date} onChange={setDueDate} testId="input-trade-doc-due" allowEmpty placeholder="None" />
              </Field>
            )}
          </div>

          <div className="mt-3 grid grid-cols-4 gap-3">
            <Field label={sales ? "Customer's ref. (their PO / RFQ)" : "Supplier's quote / ref."}>
              <TextInput value={reference} onChange={(e) => setReference(e.target.value)} data-testid="input-trade-doc-reference" />
            </Field>
            {series.length > 1 && !isEdit && (
              <Field label="Series">
                <Select value={docTypeId} onChange={(e) => setDocTypeId(Number(e.target.value))}>
                  {series.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="col-span-2 flex items-end justify-end gap-3 pb-1" style={{ gridColumnStart: series.length > 1 && !isEdit ? 3 : 2, gridColumnEnd: 5 }}>
              {party && (
                <p className="text-hint text-muted">
                  {party.gstin ? <>GSTIN <span className="num">{party.gstin}</span> · </> : 'Unregistered · '}
                  {computed.supply === 'intra' ? 'Intra-state — CGST + SGST' : 'Inter-state — IGST'}
                </p>
              )}
              {addFrom.addFrom && partyId != null && (
                <Button variant="ghost" className="px-2 py-1 text-caption" data-testid="btn-add-from" onClick={() => addFrom.setOpen(true)} title={`${addFrom.addFrom.label} (⌥A)`}>
                  {addFrom.addFrom.label} <Kbd>⌥A</Kbd>
                </Button>
              )}
            </div>
          </div>

          <ItemLineGrid
            rows={rows}
            setRow={setRow}
            setRows={setRows}
            direction={sales ? 'out' : 'in'}
            priceLevelId={sales ? (party?.priceLevelId ?? null) : null}
            fxActive={false}
            date={date}
            onCreateItem={(name, row) => setQuickItem({ name, row })}
            lockedBySource={addFrom.lockedBySource}
            rowNote={rowNote}
            onRemoveRow={addFrom.removeRow}
            stockDetail={false}
          />

          <div className="mt-4 flex items-start justify-between gap-6">
            <div className="flex-1">
              <Field label={kind === 'quotation' ? 'Terms (payment, delivery, validity) — printed' : 'Terms (payment, delivery) — printed'}>
                <Textarea
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  rows={3}
                  placeholder={sales ? '50% advance, balance before dispatch. Freight extra.' : 'Payment 30 days from receipt. Deliver to our Bhosari works.'}
                  data-testid="input-trade-doc-terms"
                />
              </Field>
              <div className="mt-3">
                <Field label="Narration (internal note, printed as remarks)">
                  <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} data-testid="input-trade-doc-narration" />
                </Field>
              </div>
              {computed.rounded > 0 && <p className="mt-2 text-hint text-muted italic">{amountInWords(computed.rounded)}</p>}
            </div>
            <div className="num w-72 text-detail" data-testid="trade-doc-totals">
              <SummaryRow label="Taxable value" paise={computed.gst.taxable} />
              {computed.gst.cgst > 0 && <SummaryRow label="CGST" paise={computed.gst.cgst} />}
              {computed.gst.sgst > 0 && <SummaryRow label="SGST" paise={computed.gst.sgst} />}
              {computed.gst.igst > 0 && <SummaryRow label="IGST" paise={computed.gst.igst} />}
              {computed.gst.cess > 0 && <SummaryRow label="Cess" paise={computed.gst.cess} />}
              {computed.roundDiff !== 0 && <SummaryRow label="Round off" paise={computed.roundDiff} />}
              <div className="mt-1 flex justify-between border-t border-ink pt-1.5 pb-0.5 text-subtitle font-semibold" style={{ borderBottom: '3px double var(--color-ink)' }}>
                <span>{kind === 'quotation' ? 'Quoted value' : 'Order value'}</span>
                <Money paise={computed.rounded} />
              </div>
              <p className="mt-1 font-sans text-hint text-muted">
                {kind === 'quotation'
                  ? 'Nothing posts to the books — convert it into a sales order or invoice.'
                  : `Nothing posts to the books or moves stock — the ${sales ? 'challan or invoice' : 'GRN or bill'} does.`}
                {doc && doc.pendingValue > 0 && (
                  <>
                    {' '}Still open: <span className="num whitespace-nowrap">{formatPaise(doc.pendingValue, { symbol: true })}</span> (taxable).
                  </>
                )}
              </p>
              {kind === 'quotation' && validUntil && (
                <p className="mt-1 font-sans text-hint text-muted">Valid until <span className="num">{toDisplayDate(validUntil)}</span>.</p>
              )}
            </div>
          </div>

          <div className="mt-5 flex justify-between">
            <div>{isEdit && !readOnly && <Button variant="danger" onClick={() => void remove()}>Delete</Button>}</div>
            <div className="flex gap-2">
              {isEdit && (
                <Button data-testid="btn-trade-doc-pdf" onClick={() => void actions.print(doc.id)} disabled={false}>
                  Print PDF
                </Button>
              )}
              <Button onClick={() => nav.back()}>Cancel</Button>
              {!readOnly && (
                <>
                  <Button disabled={saving} onClick={() => void save(true)} data-testid="btn-trade-doc-save-pdf">
                    Save + PDF
                  </Button>
                  <Button variant="primary" data-testid="btn-trade-doc-save" disabled={saving} onClick={() => void save()}>
                    {isEdit ? 'Save changes' : `Save ${title.toLowerCase()}`} ⌘↵
                  </Button>
                </>
              )}
            </div>
          </div>
        </Panel>
      </fieldset>

      {addFrom.open && addFrom.addFrom && (
        <AddFromDrawer
          title={`${addFrom.addFrom.label.replace('…', '')} — ${party?.name ?? ''}`}
          lines={addFrom.drawerLines}
          loading={addFrom.loading}
          onClose={() => addFrom.setOpen(false)}
          onInsert={addFrom.insert}
        />
      )}
      {quickLedger != null && (
        <QuickLedgerModal
          name={quickLedger}
          suggestParty={sales}
          suggestAccount={null}
          onClose={() => setQuickLedger(null)}
          onCreated={(l) => {
            setPartyId(l.id)
            setQuickLedger(null)
          }}
        />
      )}
      {quickItem && (
        <QuickItemModal
          name={quickItem.name}
          onClose={() => setQuickItem(null)}
          onCreated={(itemId) => {
            setRow(quickItem.row, { itemId })
            setQuickItem(null)
          }}
        />
      )}
      <p className="mt-3 text-hint text-muted">
        <Kbd>⌘↵</Kbd> save · <Kbd>Esc</Kbd> back{kind === 'sales_order' ? <> · <Kbd>⌥A</Kbd> add from quotations</> : null} · dates accept{' '}
        <span className="num">7</span>, <span className="num">7/4</span>, <span className="num">t</span>
      </p>
    </Page>
  )
}

function SummaryRow({ label, paise }: { label: string; paise: number }): React.JSX.Element {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{label}</span>
      <Money paise={paise} />
    </div>
  )
}
