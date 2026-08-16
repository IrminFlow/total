import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, EmptyState, Modal, Money, Panel, SectionTitle } from '../components/ui'
import { toDisplayDate } from '@shared/dates'
import type { Recon2bBucket, Recon2bPair } from '@shared/gst/recon2b'
import { MonthBar, useDefaultMonth, useMonths } from './GstReturns'

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
        placeholder="Paste the contents of the downloaded GSTR-2B JSON here…"
        className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-[11px]"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
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

function PairRow({
  pair,
  onOpenVoucher,
  onCreatePurchase
}: {
  pair: Recon2bPair
  onOpenVoucher: (voucherId: number) => void
  onCreatePurchase: (portal: NonNullable<Recon2bPair['portal']>) => void
}): React.JSX.Element {
  const { portal, book } = pair
  const clickable = !!book
  return (
    <tr
      className={clickable ? 'kbar-row cursor-pointer' : ''}
      onClick={clickable ? () => onOpenVoucher(book!.voucherId) : undefined}
    >
      <td>{portal ? portal.number : <span className="text-muted">—</span>}</td>
      <td className="num text-muted">{portal ? toDisplayDate(portal.date) : '—'}</td>
      <td className="r">{portal ? <Money paise={portal.value} /> : '—'}</td>
      <td className="r">{portal ? <Money paise={taxTotal(portal)} /> : '—'}</td>
      <td>
        {book ? (
          book.supplierRef ?? book.number
        ) : pair.bucket === 'missingInBooks' && portal ? (
          <button
            className="text-[12px] text-blue hover:underline"
            onClick={(e) => {
              e.stopPropagation()
              onCreatePurchase(portal)
            }}
          >
            Create purchase
          </button>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="num text-muted">{book ? toDisplayDate(book.date) : '—'}</td>
      <td className="r">{book ? <Money paise={book.invoiceValue} /> : '—'}</td>
      <td className="r">{book ? <Money paise={taxTotal(book)} /> : '—'}</td>
      <td className="r">{pair.valueDiffPaise != null ? <Money paise={pair.valueDiffPaise} signed /> : '—'}</td>
    </tr>
  )
}

export function Gstr2bScreen(): React.JSX.Element {
  const months = useMonths()
  const [monthKey, setMonthKey] = useDefaultMonth(months)
  const month = months.find((m) => m.key === monthKey)!
  const nav = useNav()
  const toast = useToasts()
  const [imported, setImported] = useState<Imported | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [bucket, setBucket] = useState<Recon2bBucket>('matched')

  const { data, isFetching } = useQuery({
    queryKey: ['gstr2b', month.key, imported?.jsonText],
    queryFn: () => api.gst.recon2b(imported!.jsonText, month.from, month.to),
    enabled: !!imported
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
    if (data.period && data.period !== month.period) {
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
      draftId: Date.now(),
      draft: {
        date: portal.date,
        narration: `2B ${portal.number} ${portal.gstin}`
      }
    })
  }

  const result = data?.result
  const pairs = result?.pairs.filter((p) => p.bucket === bucket) ?? []

  return (
    <div className="mx-auto max-w-6xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <MonthBar months={months} value={monthKey} onChange={setMonthKey} />
            <Button onClick={() => void doPick()}>Pick 2B JSON…</Button>
            <Button variant="ghost" onClick={() => setPasteOpen(true)}>
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
          onApply={(jsonText) => setImported({ jsonText })}
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
                  onClick={() => setBucket(b.key)}
                  className={`rounded-md border px-3 py-1.5 text-[12.5px] ${
                    bucket === b.key ? 'border-amber/60 bg-amber/15 text-amber' : 'border-line text-muted hover:bg-panel2 hover:text-ink'
                  }`}
                >
                  {b.label} <span className="num">{t.count}</span> · <Money paise={taxTotal(t)} />
                </button>
              )
            })}
          </div>

          {imported.fileName && (
            <p className="mb-2 text-[12px] text-muted">
              {imported.fileName}
              {result.pairs.length > 0 && ` · ${result.pairs.length} document${result.pairs.length > 1 ? 's' : ''} compared`}
            </p>
          )}

          <Panel>
            {pairs.length === 0 ? (
              <EmptyState title="Nothing in this bucket" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th colSpan={4}>Portal (GSTR-2B)</th>
                    <th colSpan={4}>Books</th>
                    <th className="w-24">Diff</th>
                  </tr>
                  <tr>
                    <th>No.</th>
                    <th className="w-24">Date</th>
                    <th className="r w-28">Value</th>
                    <th className="r w-28">Tax</th>
                    <th>No. (supplier ref)</th>
                    <th className="w-24">Date</th>
                    <th className="r w-28">Value</th>
                    <th className="r w-28">Tax</th>
                    <th className="r">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((p, i) => (
                    <PairRow key={i} pair={p} onOpenVoucher={openVoucher} onCreatePurchase={createPurchase} />
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  )
}
