// Document capture (WP 5.4): drop / pick bill photos and PDFs (or drop them in the company's
// capture-inbox folder), see what sending them costs, then process the queue — one file at a
// time, in main. Each bill becomes a purchase DRAFT the user reviews and saves in the voucher
// editor (the file becomes the voucher's attachment); questions (which supplier, which item, or
// a ledger line) are answered here without another provider call. Viewers see the queue only.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import type { CaptureEstimate, CaptureItemDto, CaptureMapping, CaptureStatus } from '@shared/capture/types'
import { captureApi, fileToBase64, usd } from '../lib/captureClient'
import { useCanEditMasters } from '../lib/drill'
import { useNav, useToasts } from '../state/stores'
import { DataTable, defineColumns } from '../components/table'
import { Badge, Banner, Button, Modal, Page, PageHeader, Panel, StatGrid, StatTile } from '../components/ui'
import { MenuButton } from '../components/kit'
import { ItemPicker, LedgerPicker } from '../components/pickers'
import { VoucherLink } from '../components/links'

const STATUS: Record<CaptureStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  queued: { label: 'Queued — not sent', tone: 'neutral' },
  pending: { label: 'Waiting to send', tone: 'info' },
  processing: { label: 'Reading…', tone: 'info' },
  needs_review: { label: 'Needs your answer', tone: 'warning' },
  drafted: { label: 'Draft ready', tone: 'success' },
  duplicate: { label: 'Duplicate — refused', tone: 'danger' },
  saved: { label: 'Saved', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' }
}
const STATUS_OPTIONS = (Object.keys(STATUS) as CaptureStatus[]).map((s) => ({ value: s, label: STATUS[s].label }))

function columns(openDraft: (id: number) => void) {
  return defineColumns<CaptureItemDto>([
    {
      id: 'file', header: 'File', kind: 'text', value: (i) => i.fileName, hideable: false, minWidth: 200,
      cell: (i) => (
        <span className="flex flex-col">
          <span className="truncate">{i.fileName}</span>
          <span className="text-hint text-muted">
            {i.pages} {i.pages === 1 ? 'page' : 'pages'} · {i.mime === 'application/pdf' ? (i.textLayer ? 'PDF with text' : 'PDF (scanned)') : 'photo'} · {i.origin === 'folder' ? 'inbox folder' : i.origin}
          </span>
        </span>
      )
    },
    { id: 'added', header: 'Added', kind: 'date', value: (i) => i.createdAt.slice(0, 10), width: 104, className: 'text-muted', defaultHidden: true },
    {
      id: 'status', header: 'Status', kind: 'enum', value: (i) => i.status, options: STATUS_OPTIONS, width: 180,
      cell: (i) => (
        <span className="flex flex-col gap-0.5" data-testid="cell-capture-status" data-status={i.status}>
          <Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge>
          {i.error && <span className="line-clamp-2 text-hint text-muted" title={i.error}>{i.error}</span>}
        </span>
      )
    },
    { id: 'supplier', header: 'Supplier', kind: 'text', value: (i) => i.supplierName ?? '', minWidth: 150 },
    { id: 'invoice', header: 'Invoice', kind: 'text', value: (i) => i.invoiceNo ?? '', width: 170, className: 'num' },
    { id: 'date', header: 'Bill date', kind: 'date', value: (i) => i.invoiceDate ?? '', width: 104 },
    { id: 'total', header: 'Total', kind: 'money', value: (i) => i.total, width: 130 },
    {
      id: 'duplicate', header: 'Duplicate?', kind: 'enum', width: 140,
      value: (i) => i.duplicateKind ?? 'none',
      options: [{ value: 'none', label: 'No' }, { value: 'same_invoice', label: 'Same invoice' }, { value: 'same_amount', label: 'Same amount' }],
      cell: (i) =>
        i.duplicateKind ? (
          <span className="flex flex-col gap-0.5" data-testid="cell-capture-duplicate">
            <Badge tone={i.duplicateKind === 'same_invoice' ? 'danger' : 'warning'}>{i.duplicateKind === 'same_invoice' ? 'Same invoice' : 'Same amount?'}</Badge>
            {i.duplicateVoucherId && <VoucherLink voucherId={i.duplicateVoucherId} label="Open the voucher" className="text-hint" />}
          </span>
        ) : (
          <span className="text-hint text-muted">—</span>
        )
    },
    {
      id: 'draft', header: 'Draft', kind: 'text', width: 120, value: (i) => (i.voucherId ? 'saved' : i.draftId ? 'draft' : ''),
      cell: (i) =>
        i.voucherId ? (
          <VoucherLink voucherId={i.voucherId} label="Saved voucher" className="text-small" />
        ) : i.draftId && i.status === 'drafted' ? (
          <button type="button" className="text-small text-blue hover:underline" data-testid="btn-capture-open-draft" onClick={(e) => { e.stopPropagation(); openDraft(i.draftId!) }}>
            Review draft
          </button>
        ) : null
    },
    { id: 'cost', header: 'Cost', kind: 'text', value: (i) => usd(i.costMicroUsd), width: 90, defaultHidden: true, className: 'num text-muted' }
  ])
}

export function CaptureScreen(): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const qc = useQueryClient()
  const canWrite = useCanEditMasters()
  const [dragging, setDragging] = useState(false)
  const [estimate, setEstimate] = useState<CaptureEstimate | null>(null)
  const [review, setReview] = useState<CaptureItemDto | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['captureQueue'],
    queryFn: () => captureApi.list(),
    // Poll fast while something is being sent; slowly otherwise (files dropped in the inbox folder).
    refetchInterval: (q) => (q.state.data?.items.some((i) => i.status === 'pending' || i.status === 'processing') ? 1000 : 4000)
  })
  const items = data?.items ?? []
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['captureQueue'] })
  const openDraft = (id: number): void => nav.go({ name: 'voucher-entry', aiDraftId: id })
  const cols = useMemo(() => columns(openDraft), []) // eslint-disable-line react-hooks/exhaustive-deps

  const report = (r: { added: number[]; refused: string[] }): void => {
    if (r.added.length) toast.push('success', `${r.added.length} ${r.added.length === 1 ? 'file' : 'files'} queued — nothing is sent until you process the queue`)
    for (const x of r.refused.slice(0, 3)) toast.push('error', x)
  }
  const onDrop = async (files: FileList | File[]): Promise<void> => {
    try {
      const list = await Promise.all([...files].slice(0, 50).map(async (f) => ({ name: f.name, base64: await fileToBase64(f) })))
      if (list.length) report(await captureApi.addFiles(list))
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const act = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn()
      if (ok) toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      await refresh()
    }
  }
  const queued = items.filter((i) => i.status === 'queued').length
  const busy = items.some((i) => i.status === 'pending' || i.status === 'processing')

  return (
    <Page width="full">
      <PageHeader
        title="Document capture"
        subtitle="Bills → purchase drafts you review"
        secondary={
          <>
            <Button data-testid="btn-capture-inbox" onClick={() => void act(() => captureApi.revealInbox())}>Open inbox folder</Button>
            {busy && canWrite && <Button data-testid="btn-capture-stop" onClick={() => void act(() => captureApi.stop(), 'Stopped — the files are back in the queue')}>Stop</Button>}
          </>
        }
        actions={
          canWrite ? (
            <Button
              variant="primary"
              data-testid="btn-capture-process"
              disabled={queued === 0}
              onClick={() => void captureApi.estimate().then(setEstimate).catch((e: Error) => toast.push('error', e.message))}
            >
              Process {queued || ''} queued
            </Button>
          ) : undefined
        }
      />
      {data?.blocker && (
        <Banner tone="warning" className="mb-3" testId="banner-capture-blocked" title="Nothing is sent right now">
          {data.blocker}. Files wait in the queue (offline, on this computer) until the assistant is on.
        </Banner>
      )}
      {canWrite && (
        <div
          data-testid="capture-dropzone"
          className={`mb-3 flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed px-4 py-5 ${dragging ? 'border-amber bg-amber/5' : 'border-line bg-panel'}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void onDrop(e.dataTransfer.files)
          }}
        >
          <span className="text-body">Drop bill photos or PDFs here</span>
          <Button size="sm" data-testid="btn-capture-pick" onClick={() => void act(async () => report(await captureApi.pick()))}>Choose files…</Button>
          <span className="text-hint text-muted">
            PDF, JPEG, PNG, WEBP, HEIC up to 20 MB · or drop them in <span className="num">{data?.inboxPath ?? 'capture-inbox'}</span>
          </span>
        </div>
      )}
      <StatGrid className="mb-3">
        <StatTile label="Queued (not sent)" value={String(queued)} />
        <StatTile label="Need your answer" value={String(items.filter((i) => i.status === 'needs_review').length)} />
        <StatTile label="Drafts to review" value={String(items.filter((i) => i.status === 'drafted').length)} />
        <StatTile label="Duplicates refused" value={String(items.filter((i) => i.status === 'duplicate').length)} />
      </StatGrid>
      <Panel>
        <DataTable
          viewId="capture-queue"
          testId="capture-queue"
          ariaLabel="Capture queue"
          columns={cols}
          rows={items}
          rowKey={(i) => i.id}
          rowAttrs={(i) => ({ 'data-row-id': i.id, 'data-status': i.status })}
          loading={isLoading}
          maxHeight="60vh"
          empty={{ title: 'No files captured yet', hint: 'Drop bills above, choose files, or put them in the capture inbox folder' }}
          trailingWidth={56}
          trailing={(i) =>
            canWrite ? (
              <MenuButton
                label={`Actions for ${i.fileName}`}
                testId={`capture-actions-${i.id}`}
                className="px-1.5 text-muted hover:text-ink"
                items={[
                  ...(i.status === 'needs_review' ? [{ label: 'Answer the questions…', onSelect: () => setReview(i), testId: 'capture-review' }] : []),
                  ...(i.status === 'drafted' && i.draftId ? [{ label: 'Review draft', onSelect: () => openDraft(i.draftId!), testId: 'capture-open-draft' }] : []),
                  ...(['failed', 'cancelled', 'duplicate', 'needs_review'].includes(i.status) ? [{ label: 'Send again', onSelect: () => void act(() => captureApi.retry(i.id), 'Queued to send again'), testId: 'capture-retry' }] : []),
                  ...(['queued', 'pending', 'processing', 'needs_review', 'failed'].includes(i.status) ? [{ label: 'Cancel', onSelect: () => void act(() => captureApi.cancel(i.id)), testId: 'capture-cancel' }] : []),
                  ...(i.status !== 'processing' ? [{ label: 'Remove from the queue', danger: true, onSelect: () => void act(() => captureApi.remove(i.id)), testId: 'capture-remove' }] : [])
                ]}
              >
                ⋯
              </MenuButton>
            ) : null
          }
          exportOptions={{ title: 'Capture queue', periodLabel: toDisplayDate(new Date().toISOString().slice(0, 10)), filename: 'capture-queue' }}
        />
      </Panel>
      <p className="mt-2 text-hint text-muted">
        The app reads every amount itself and recomputes the bill — GST comes from your item masters, never from the reading. A bill already booked (same supplier and
        invoice number this year) is refused. Nothing reaches the books until you save the draft.
      </p>
      {estimate && (
        <EstimateModal
          estimate={estimate}
          onClose={() => setEstimate(null)}
          onConfirm={() => {
            setEstimate(null)
            void act(() => captureApi.process(), 'Sending the queue — one file at a time')
          }}
        />
      )}
      {review && <ReviewModal item={review} onClose={() => setReview(null)} onDone={() => { setReview(null); void refresh() }} />}
    </Page>
  )
}

function EstimateModal({ estimate, onClose, onConfirm }: { estimate: CaptureEstimate; onClose: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    <Modal title="Send the queued files?" onClose={onClose}>
      <div className="space-y-3 p-4" data-testid="capture-estimate">
        <p className="text-body">
          {estimate.items} {estimate.items === 1 ? 'file' : 'files'}, {estimate.pages} {estimate.pages === 1 ? 'page' : 'pages'}, to {estimate.model}.
        </p>
        <p className="text-body">
          Estimated cost: <span className={estimate.costMicroUsd == null ? 'text-muted' : 'num font-semibold'} data-testid="text-capture-cost">{estimate.costMicroUsd == null ? 'not priced (set the model’s price in Settings → AI)' : `≈ ${usd(estimate.costMicroUsd)}`}</span>{' '}
          <span className="text-hint text-muted">(~{estimate.inputTokens.toLocaleString('en-IN')} input + {estimate.outputTokens.toLocaleString('en-IN')} output tokens)</span>
        </p>
        {estimate.unmaskable > 0 && (
          <Banner tone="warning">
            {estimate.unmaskable} {estimate.unmaskable === 1 ? 'file is' : 'files are'} sent as images: GSTINs, PANs and account numbers printed on them cannot be masked. PDFs with a text layer are sent as masked text.
          </Banner>
        )}
        {estimate.blocker && <Banner tone="danger">{estimate.blocker}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!estimate.blocker} data-testid="btn-capture-confirm" onClick={onConfirm}>Send {estimate.items}</Button>
        </div>
      </div>
    </Modal>
  )
}

function ReviewModal({ item, onClose, onDone }: { item: CaptureItemDto; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const [mapping, setMapping] = useState<CaptureMapping>(item.mapping ?? {})
  const [mode, setMode] = useState<Record<string, 'item' | 'ledger'>>({})
  const qs = item.review?.questions ?? []
  const totals = item.review?.totals
  const save = async (): Promise<void> => {
    try {
      const r = await captureApi.resolve(item.id, mapping)
      toast.push(r.status === 'drafted' ? 'success' : 'warning', r.status === 'drafted' ? 'Draft ready to review' : `Still ${r.status.replace('_', ' ')}${r.error ? `: ${r.error}` : ''}`)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`Answer for ${item.fileName}`} onClose={onClose} wide>
      <div className="space-y-4 p-4" data-testid="capture-review-modal">
        {totals && (
          <p className="text-small text-muted">
            Read from the bill: {item.supplierName ?? 'no supplier'} · {item.invoiceNo ?? 'no invoice no.'} · taxable {formatPaise(totals.taxable, { symbol: true })} · tax{' '}
            {formatPaise(totals.tax, { symbol: true })} · total {totals.printedTotal != null ? formatPaise(totals.printedTotal, { symbol: true }) : '—'}
          </p>
        )}
        {qs.map((q) => {
          const line = q.field.startsWith('line:') ? q.field.slice(5) : null
          const m = line ? (mode[line] ?? 'item') : null
          return (
            <div key={q.field} className="rounded border border-line p-3" data-testid={`capture-question-${q.field}`}>
              <p className="mb-2 text-body">{q.question}</p>
              {q.field === 'supplier' && (
                <div className="flex flex-wrap items-center gap-2">
                  <LedgerPicker value={mapping.supplierLedgerId ?? null} onPick={(id) => setMapping((x) => ({ ...x, supplierLedgerId: id ?? undefined }))} placeholder="Supplier" testId="picker-capture-supplier" />
                  {item.review?.suggestedParty && (
                    <Button size="sm" data-testid="btn-capture-create-party" onClick={() => nav.go({ name: 'masters', tab: 'ledgers' })}>
                      Create “{item.review.suggestedParty.name}”{item.review.suggestedParty.gstin ? ` (${item.review.suggestedParty.gstin})` : ''} in Masters…
                    </Button>
                  )}
                </div>
              )}
              {line != null && (
                <div className="flex flex-wrap items-center gap-2">
                  {q.ledgerOption && (
                    <select className="rounded border border-line bg-panel px-2 py-1 text-small" value={m!} onChange={(e) => setMode((x) => ({ ...x, [line]: e.target.value as 'item' | 'ledger' }))} aria-label="Book as">
                      <option value="item">Stock item</option>
                      <option value="ledger">Ledger line (service / expense)</option>
                    </select>
                  )}
                  {m === 'item' ? (
                    <ItemPicker value={mapping.lines?.[line]?.itemId ?? null} onPick={(id) => setMapping((x) => ({ ...x, lines: { ...(x.lines ?? {}), [line]: id ? { itemId: id } : {} } }))} testId={`picker-capture-item-${line}`} />
                  ) : (
                    <LedgerPicker value={mapping.lines?.[line]?.ledgerId ?? null} onPick={(id) => setMapping((x) => ({ ...x, lines: { ...(x.lines ?? {}), [line]: id ? { ledgerId: id } : {} } }))} placeholder="Expense / purchase ledger" testId={`picker-capture-ledger-${line}`} />
                  )}
                  {q.candidates.length > 0 && <span className="text-hint text-muted">Close: {q.candidates.slice(0, 4).map((c) => c.name).join(', ')}</span>}
                </div>
              )}
              {q.field === 'account' && (
                <LedgerPicker value={mapping.accountLedgerId ?? null} onPick={(id) => setMapping((x) => ({ ...x, accountLedgerId: id ?? undefined }))} placeholder="Purchase ledger" testId="picker-capture-account" />
              )}
            </div>
          )
        })}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-capture-resolve" onClick={() => void save()}>Make the draft</Button>
        </div>
      </div>
    </Modal>
  )
}
