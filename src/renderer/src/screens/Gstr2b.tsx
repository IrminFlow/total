import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useToasts, nextDraftId } from '../state/stores'
import { Button, EmptyState, Modal, Money, Panel, SectionTitle } from '../components/ui'
import { DataTable, defineColumns, type TableColumn } from '../components/table'
import type { Recon2bBucket, Recon2bPair } from '@shared/gst/recon2b'
import { MonthBar, NoMonths, useMonth } from './GstReturns'
import { LedgerLink, VoucherLink } from '../components/links'

const BUCKETS: { key: Recon2bBucket; label: string }[] = [
  { key: 'matched', label: 'Matched' },
  { key: 'amountMismatch', label: 'Amount mismatch' },
  { key: 'taxMismatch', label: 'Tax mismatch' },
  { key: 'missingInBooks', label: 'Missing in books' },
  { key: 'missingInPortal', label: 'Missing in portal' }
]

interface Imported {
  jsonText: string
  fileName?: string
}

function PasteModal({ onClose, onApply }: { onClose: () => void; onApply: (jsonText: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <Modal title="Paste GSTR-2B JSON" onClose={onClose}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        autoFocus
        data-testid="input-2b-paste"
        placeholder="Paste the contents of the downloaded GSTR-2B JSON here…"
        className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-caption"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="btn-2b-paste-apply"
          disabled={text.trim().length < 2}
          onClick={() => {
            onApply(text)
            onClose()
          }}
        >
          Reconcile
        </Button>
      </div>
    </Modal>
  )
}

function taxTotal(t: { igst: number; cgst: number; sgst: number; cess: number }): number {
  return t.igst + t.cgst + t.sgst + t.cess
}

const dash = <span className="text-muted">—</span>

const BOOK_KIND_LABEL: Record<NonNullable<Recon2bPair['book']>['kind'], string> = {
  purchase: 'Purchase',
  debit_note: 'Debit note'
}

/** Columns of one reconciliation pair: the portal side, then the books side, then the diff.
 *  "Portal" / "Books" header bands (`group`) name the side, so the labels stay short; exports
 *  read "Portal · Invoice no.". */
export function pairColumns(onCreatePurchase: (portal: NonNullable<Recon2bPair['portal']>) => void): TableColumn<Recon2bPair>[] {
  return defineColumns<Recon2bPair>([
    {
      id: 'portalNo',
      header: 'Invoice no.',
      group: 'Portal',
      kind: 'text',
      value: (p) => p.portal?.number,
      cell: (p) => p.portal?.number ?? dash,
      hideable: false,
      groupable: false,
      minWidth: 120
    },
    { id: 'portalDate', header: 'Date', group: 'Portal', kind: 'date', value: (p) => p.portal?.date, className: 'text-muted' },
    {
      id: 'supplierGstin',
      header: 'Supplier GSTIN',
      group: 'Portal',
      kind: 'text',
      value: (p) => p.portal?.gstin ?? p.book?.partyGstin,
      className: 'num text-muted',
      width: 160,
      defaultHidden: true
    },
    { id: 'portalValue', header: 'Value', group: 'Portal', kind: 'money', value: (p) => p.portal?.value, width: 124, aggregate: 'sum' },
    {
      id: 'portalTax',
      header: 'Tax',
      group: 'Portal',
      kind: 'money',
      value: (p) => (p.portal ? taxTotal(p.portal) : null),
      width: 112,
      aggregate: 'sum'
    },
    {
      id: 'bookNo',
      header: 'Supplier ref',
      group: 'Books',
      kind: 'text',
      value: (p) => (p.book ? (p.book.supplierRef ?? p.book.number) : null),
      groupable: false,
      minWidth: 132,
      cell: (p) =>
        p.book ? (
          <VoucherLink voucherId={p.book.voucherId} label={p.book.supplierRef ?? p.book.number} />
        ) : p.bucket === 'missingInBooks' && p.portal ? (
          <button
            className="text-small text-blue hover:underline"
            data-testid="btn-2b-create-purchase"
            onClick={(e) => {
              e.stopPropagation()
              onCreatePurchase(p.portal!)
            }}
          >
            Create purchase
          </button>
        ) : (
          dash
        )
    },
    {
      id: 'party',
      header: 'Party',
      group: 'Books',
      kind: 'text',
      value: (p) => p.book?.partyName,
      minWidth: 140,
      defaultHidden: true,
      cell: (p) => (p.book?.partyName ? <LedgerLink ledgerId={p.book.partyLedgerId} name={p.book.partyName} /> : null)
    },
    {
      id: 'bookKind',
      header: 'Type',
      group: 'Books',
      kind: 'enum',
      value: (p) => p.book?.kind,
      options: [
        { value: 'purchase', label: BOOK_KIND_LABEL.purchase },
        { value: 'debit_note', label: BOOK_KIND_LABEL.debit_note }
      ],
      defaultHidden: true
    },
    { id: 'bookDate', header: 'Date', group: 'Books', kind: 'date', value: (p) => p.book?.date, className: 'text-muted' },
    { id: 'bookValue', header: 'Value', group: 'Books', kind: 'money', value: (p) => p.book?.invoiceValue, width: 124, aggregate: 'sum' },
    {
      id: 'bookTax',
      header: 'Tax',
      group: 'Books',
      kind: 'money',
      value: (p) => (p.book ? taxTotal(p.book) : null),
      width: 112,
      aggregate: 'sum'
    },
    {
      id: 'valueDiff',
      header: 'Value diff',
      kind: 'money',
      signed: true,
      value: (p) => p.valueDiffPaise,
      width: 132,
      aggregate: 'sum'
    }
  ])
}

const BUCKET_LABEL = (b: Recon2bBucket): string => BUCKETS.find((x) => x.key === b)?.label ?? b

export function Gstr2bScreen(): React.JSX.Element {
  const { months, month, monthKey, setMonthKey } = useMonth()
  const nav = useNav()
  const toast = useToasts()
  const [imported, setImported] = useState<Imported | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [bucket, setBucket] = useState<Recon2bBucket>('matched')

  const { data, isFetching } = useQuery({
    queryKey: ['gstr2b', month?.key, imported?.jsonText],
    queryFn: () => api.gst.recon2b(imported!.jsonText, month!.from, month!.to),
    enabled: !!imported && !!month
  })

  // Toast only once per newly-imported JSON — react-query gives back a fresh `data` object on
  // every refetch (e.g. month change, window refocus) even when the underlying import hasn't
  // changed, so gate on a ref of the last jsonText we've already toasted for.
  const lastToastedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!data || !imported) return
    if (lastToastedRef.current === imported.jsonText) return
    lastToastedRef.current = imported.jsonText
    if (data.errors.length) {
      toast.push('warning', `${data.errors.length} entr${data.errors.length > 1 ? 'ies' : 'y'} in the 2B JSON could not be parsed and were skipped`)
    }
    if (month && data.period && data.period !== month.period) {
      toast.push('warning', `The JSON is for period ${data.period}, but ${month.label} is selected — showing figures for the selected month`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, imported])

  const doPick = async (): Promise<void> => {
    try {
      const r = await api.gst.recon2bPickFile()
      if (!r) return
      setImported(r)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const openVoucher = (voucherId: number): void => nav.go({ name: 'voucher-entry', voucherId })

  // Party can't be guessed from the portal's GSTIN alone (no ledger lookup by GSTIN yet) — leave
  // it to the user, just hand over what the portal already told us.
  const createPurchase = (portal: NonNullable<Recon2bPair['portal']>): void => {
    nav.go({
      name: 'voucher-entry',
      kindHint: 'purchase',
      draftId: nextDraftId(),
      draft: {
        date: portal.date,
        narration: `2B ${portal.number} ${portal.gstin}`
      }
    })
  }

  const result = data?.result
  const pairs = useMemo(() => result?.pairs.filter((p) => p.bucket === bucket) ?? [], [result, bucket])
  // createPurchase only reads nav — keep the column set stable across renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => pairColumns(createPurchase), [])

  if (!month) {
    return (
      <div className="mx-auto max-w-6xl">
        <SectionTitle>GSTR-2B · Reconciliation</SectionTitle>
        <NoMonths />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <MonthBar months={months} value={monthKey} onChange={setMonthKey} />
            <Button data-testid="btn-2b-pick" onClick={() => void doPick()}>Pick 2B JSON…</Button>
            <Button variant="ghost" data-testid="btn-2b-paste" onClick={() => setPasteOpen(true)}>
              Paste JSON…
            </Button>
          </div>
        }
      >
        GSTR-2B · Reconciliation
      </SectionTitle>

      {pasteOpen && (
        <PasteModal
          onClose={() => setPasteOpen(false)}
          onApply={(jsonText) => setImported({ jsonText, fileName: 'Pasted 2B JSON' })}
        />
      )}

      {!imported ? (
        <Panel>
          <EmptyState
            title="Import a GSTR-2B JSON to reconcile ITC against your books"
            hint="On the GST portal: Returns → GSTR-2B → Download JSON for the period, then pick the file here."
          />
        </Panel>
      ) : isFetching && !result ? (
        <Panel>
          <EmptyState title="Reconciling…" />
        </Panel>
      ) : result ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {BUCKETS.map((b) => {
              const t = result.buckets[b.key]
              return (
                <button
                  key={b.key}
                  data-testid={`btn-2b-bucket-${b.key}`}
                  onClick={() => setBucket(b.key)}
                  className={`rounded-md border px-3 py-1.5 text-body-sm ${
                    bucket === b.key ? 'border-amber/60 bg-amberbar/15 text-amber' : 'border-line text-muted hover:bg-panel2 hover:text-ink'
                  }`}
                >
                  {b.label} <span className="num">{t.count}</span> · <Money paise={taxTotal(t)} />
                </button>
              )
            })}
          </div>

          {imported.fileName && (
            <p className="mb-2 text-small text-muted">
              {imported.fileName}
              {result.pairs.length > 0 && ` · ${result.pairs.length} document${result.pairs.length > 1 ? 's' : ''} compared`}
            </p>
          )}

          <Panel>
            <DataTable
              viewId="gstr2b-pairs"
              testId="2b-pairs"
              ariaLabel={`GSTR-2B ${BUCKET_LABEL(bucket)}`}
              columns={columns}
              rows={pairs}
              rowKey={(p, i) => `${p.portal?.gstin ?? ''}|${p.portal?.number ?? ''}|${p.book?.voucherId ?? ''}|${i}`}
              rowAttrs={(p) => ({ 'data-row-id': p.book?.voucherId })}
              isRowActivatable={(p) => !!p.book}
              onRowActivate={(p) => {
                if (p.book) openVoucher(p.book.voucherId)
              }}
              maxHeight="calc(100vh - 300px)"
              exportOptions={{
                title: `GSTR-2B reconciliation — ${BUCKET_LABEL(bucket)}`,
                periodLabel: month.label,
                filename: `gstr2b-${bucket}-${month.period}`
              }}
              empty={{ title: 'Nothing in this bucket' }}
            />
          </Panel>
        </>
      ) : null}
    </div>
  )
}
