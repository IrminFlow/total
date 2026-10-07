import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useToasts, nextDraftId } from '../state/stores'
import { AmountInput, Button, Checkbox, DrawerSection, EmptyState, Field, Modal, Money, Page, PageHeader, Panel, SkeletonRows, TabBar, TextInput } from '../components/ui'
import { OptionChoice, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns, type TableColumn } from '../components/table'
import { normalizeGstin, type Recon2bBucket, type Recon2bMatchedBy, type Recon2bPair, type Recon2bTolerances } from '@shared/gst/recon2b'
import { useLedgers } from '../components/pickers'
import { ImsTab } from './gst/ImsTab'
import { MonthBar, NoMonths, OPEN_ON_CHOICES, useMonth, type OpenOn } from './GstReturns'
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
    },
    {
      id: 'matchedBy',
      header: 'Matched on',
      kind: 'enum',
      value: (p) => p.matchedBy,
      options: Object.entries(MATCHED_BY_LABEL).map(([value, label]) => ({ value, label })),
      width: 124,
      className: 'text-muted'
    }
  ])
}

const MATCHED_BY_LABEL: Record<Recon2bMatchedBy, string> = {
  number: 'Number',
  numberCore: 'Number (fuzzy)',
  serial: 'Serial + date',
  valueDate: 'Value + date'
}

/** Matcher tolerances (WP 3.4) — stored per company, used by every reconciliation. */
function ToleranceOptions(): React.JSX.Element {
  const qc = useQueryClient()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['recon2bTolerances'], queryFn: api.gst.recon2bTolerances })
  const [draft, setDraft] = useState<Recon2bTolerances | null>(null)
  const t = draft ?? data
  if (!t) return <DrawerSection title="Matching tolerances"><SkeletonRows rows={2} /></DrawerSection>
  const save = async (): Promise<void> => {
    try {
      await api.gst.setRecon2bTolerances(t)
      setDraft(null)
      await qc.invalidateQueries({ queryKey: ['recon2bTolerances'] })
      await qc.invalidateQueries({ queryKey: ['gstr2b'] })
      toast.push('success', 'Tolerances saved — reconciliation re-run')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <DrawerSection title="Matching tolerances" testId="options-2b-tolerances">
      <Field label="Amount tolerance (₹)">
        <AmountInput paise={t.amountPaise} onPaise={(p) => setDraft({ ...t, amountPaise: Math.max(0, p ?? 0) })} testId="input-2b-tol-amount" ariaLabel="Amount tolerance" />
      </Field>
      <Field label="…or percent of the value (the larger applies)">
        <TextInput type="number" min={0} max={10} step={0.1} value={t.amountPct} onChange={(e) => setDraft({ ...t, amountPct: Math.max(0, Number(e.target.value) || 0) })} data-testid="input-2b-tol-pct" />
      </Field>
      <Field label="Date tolerance (± days)">
        <TextInput type="number" min={0} max={90} value={t.dateDays} onChange={(e) => setDraft({ ...t, dateDays: Math.max(0, Math.round(Number(e.target.value) || 0)) })} data-testid="input-2b-tol-days" />
      </Field>
      <Checkbox label="Fuzzy invoice numbers (ignore case, separators, leading zeros, FY tokens and series prefixes)" checked={t.fuzzyNumbers} onChange={(v) => setDraft({ ...t, fuzzyNumbers: v })} testId="chk-2b-fuzzy" />
      <p className="text-hint text-muted">GSTIN always matches exactly.</p>
      <div>
        <Button size="sm" variant="primary" data-testid="btn-2b-tol-save" disabled={!draft} onClick={() => void save()}>
          Save tolerances
        </Button>
      </div>
    </DrawerSection>
  )
}

const BUCKET_LABEL = (b: Recon2bBucket): string => BUCKETS.find((x) => x.key === b)?.label ?? b

export function Gstr2bScreen(): React.JSX.Element {
  const opts = useScreenOptions('gstr2b', { openOn: 'current' as OpenOn }, { openOn: ['current', 'previous'] })
  const { months, month, monthKey, setMonthKey } = useMonth(opts.options.openOn)
  const nav = useNav()
  const toast = useToasts()
  const [imported, setImported] = useState<Imported | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [bucket, setBucket] = useState<Recon2bBucket>('matched')
  const [tab, setTab] = useState<'recon' | 'ims'>('recon')
  const ledgers = useLedgers()

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

  // The party is the ledger carrying the portal's GSTIN (exact), when there is exactly one —
  // otherwise left to the user. Nothing is posted: the purchase opens as a draft to review.
  const createPurchase = (portal: NonNullable<Recon2bPair['portal']>): void => {
    const matches = ledgers.filter((l) => l.gstin && normalizeGstin(l.gstin) === normalizeGstin(portal.gstin))
    nav.go({
      name: 'voucher-entry',
      kindHint: 'purchase',
      draftId: nextDraftId(),
      draft: {
        date: portal.date,
        ...(matches.length === 1 ? { partyLedgerId: matches[0]!.id } : {}),
        narration: `2B ${portal.number} ${portal.gstin}`
      }
    })
  }

  const result = data?.result
  const pairs = useMemo(() => result?.pairs.filter((p) => p.bucket === bucket) ?? [], [result, bucket])
  // createPurchase reads nav + the ledger list — rebuild the columns only when ledgers load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => pairColumns(createPurchase), [ledgers])

  if (!month) {
    return (
      <Page width="wide">
        <PageHeader title="GSTR-2B · Reconciliation" />
        <NoMonths />
      </Page>
    )
  }

  return (
    <Page width="wide">
      <PageHeader
        title="GSTR-2B · Reconciliation"
        subtitle={imported?.fileName}
        tabs={
          result ? (
            <TabBar
              screen="gstr2b"
              label="GSTR-2B views"
              tabs={[
                { id: 'recon', label: 'Reconciliation' },
                { id: 'ims', label: 'IMS actions', count: result.pairs.filter((p) => p.portal).length || undefined }
              ]}
              active={tab}
              onSelect={(t) => setTab(t as 'recon' | 'ims')}
            />
          ) : undefined
        }
        controls={<MonthBar months={months} value={monthKey} onChange={setMonthKey} testId="input-gstr2b-month" />}
        secondary={
          <Button variant="ghost" data-testid="btn-2b-paste" onClick={() => setPasteOpen(true)}>
            Paste JSON…
          </Button>
        }
        actions={
          <Button variant="primary" data-testid="btn-2b-pick" onClick={() => void doPick()}>
            Pick 2B JSON…
          </Button>
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <DrawerSection title="Return period">
                <OptionChoice label="Open on" value={opts.options.openOn} options={OPEN_ON_CHOICES} onChange={(v) => opts.set('openOn', v)} testId="input-return-open-on" />
              </DrawerSection>
              <ToleranceOptions />
              {result ? (
                <OptionsTable area="2b-pairs" label="Documents table" />
              ) : (
                <DrawerSection title="Documents table">
                  <p className="text-hint text-muted">Import a 2B JSON to choose columns or export.</p>
                </DrawerSection>
              )}
            </>
          )
        }}
      />

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
          <SkeletonRows />
        </Panel>
      ) : result && tab === 'ims' ? (
        <Panel>
          <ImsTab period={data?.period ?? month.period} periodLabel={month.label} pairs={result.pairs} />
        </Panel>
      ) : result ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {BUCKETS.map((b) => {
              const t = result.buckets[b.key]
              return (
                <button
                  key={b.key}
                  type="button"
                  data-testid={`btn-2b-bucket-${b.key}`}
                  aria-pressed={bucket === b.key}
                  onClick={() => setBucket(b.key)}
                  className={`rounded-md border px-3 py-1.5 text-body-sm ${
                    bucket === b.key ? 'border-amber/60 bg-amberbar/15 font-medium text-amber' : 'border-line text-muted hover:bg-panel2 hover:text-ink'
                  }`}
                >
                  {b.label} <span className="num">{t.count}</span> · <Money paise={taxTotal(t)} />
                </button>
              )
            })}
          </div>

          {result.pairs.length > 0 && (
            <p className="mb-2 text-small text-muted">
              {result.pairs.length} document{result.pairs.length > 1 ? 's' : ''} compared
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
    </Page>
  )
}
