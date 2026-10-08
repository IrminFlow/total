// Assistants → GST 2B mismatches: the stored GSTR-2B JSON for a month against the purchase
// register, categorised (missing in books / in 2B, amount, period, GSTIN differs) with a
// suggested action per row. Actions that change the books are DRAFTS (an ai_drafts row opened in
// the voucher editor); nothing is posted here. "Ask AI" explains one mismatch.
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { VoucherKind } from '@shared/domain'
import { MISMATCH_LABELS, type Mismatch, type MismatchCategory } from '@shared/gst/mismatch2b'
import { ASSISTANT_UNVERIFIED } from '@shared/assistantSources'
import { api } from '../../lib/client'
import { assistantsApi } from '../../lib/assistantsClient'
import { useAiScreenContext } from '../../lib/aiContext'
import { useAiAffordances } from '../../lib/explain'
import { useNav, useToasts } from '../../state/stores'
import { Banner, Button, EmptyState, Modal, Money, Panel, SkeletonRows } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { MonthBar, NoMonths, useMonth } from '../GstReturns'
import { RunWithAi, runWithAi, useCanAct } from './common'

const CATEGORIES = Object.keys(MISMATCH_LABELS) as MismatchCategory[]
const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ value: c, label: MISMATCH_LABELS[c] }))
const taxOf = (t: { igst: number; cgst: number; sgst: number; cess: number } | null | undefined): number | null => (t ? t.igst + t.cgst + t.sgst + t.cess : null)
const dash = <span className="text-muted">—</span>

function PasteModal({ onClose, onApply }: { onClose: () => void; onApply: (text: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <Modal title="Paste GSTR-2B JSON" onClose={onClose}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        autoFocus
        data-testid="input-assistants-2b-paste"
        placeholder="Paste the contents of the downloaded GSTR-2B JSON here…"
        className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-caption"
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="btn-assistants-2b-paste-apply"
          disabled={text.trim().length < 2}
          onClick={() => {
            onApply(text)
            onClose()
          }}
        >
          Import
        </Button>
      </div>
    </Modal>
  )
}

export function Gst2bTab({ initialPeriod }: { initialPeriod?: string }): React.JSX.Element {
  const { months, month, monthKey, setMonthKey } = useMonth('previous')
  useEffect(() => {
    if (initialPeriod && months.some((m) => m.key === initialPeriod)) setMonthKey(initialPeriod)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeriod])
  const period = month?.key ?? monthKey
  useAiScreenContext('assistants', { tab: 'gst2b', period })
  const qc = useQueryClient()
  const toast = useToasts()
  const nav = useNav()
  const canAct = useCanAct()
  const aiReady = useAiAffordances()
  const [category, setCategory] = useState<MismatchCategory | 'all'>('all')
  const [showResolved, setShowResolved] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  // Every row opens onto its suggestion until the user folds one (controlled, so a category
  // switch shows the new rows' suggestions too).
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const { data, isLoading, error } = useQuery({ queryKey: ['assistGst2b', period, showResolved], queryFn: () => assistantsApi.gst2b(period, showResolved), enabled: !!month })
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['assistGst2b'] })

  const store = async (jsonText: string, fileName?: string): Promise<void> => {
    try {
      const st = await assistantsApi.store2b(jsonText, period, fileName)
      toast.push('success', `GSTR-2B ${st.period} imported — ${st.documents} documents`)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const pick = async (): Promise<void> => {
    try {
      const r = await api.gst.recon2bPickFile()
      if (r) await store(r.jsonText, r.fileName)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const draft = async (m: Mismatch): Promise<void> => {
    try {
      const d = await assistantsApi.draft2b(period, m.key)
      toast.push('success', 'Draft ready — review it and save; nothing is in the books yet')
      nav.go({ name: 'voucher-entry', aiDraftId: d.id, kindHint: d.payload.voucherKind as VoucherKind })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const resolve = async (m: Mismatch, status: 'resolved' | 'dismissed' | null): Promise<void> => {
    try {
      await assistantsApi.resolve2b(period, m.key, status)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const columns = useMemo(
    () =>
      defineColumns<Mismatch>([
        { id: 'category', header: 'Category', kind: 'enum', value: (m) => m.category, options: CATEGORY_OPTIONS, width: 128 },
        {
          id: 'supplier',
          header: 'Supplier',
          kind: 'text',
          value: (m) => m.supplier ?? m.portal?.gstin ?? m.book?.partyGstin ?? '',
          minWidth: 130,
          cell: (m) => (m.ledgerId ? <LedgerLink ledgerId={m.ledgerId} name={m.supplier ?? m.portal?.gstin ?? ''} /> : <span className="num">{m.supplier ?? m.portal?.gstin ?? '—'}</span>)
        },
        { id: 'gstin', header: 'GSTIN', kind: 'text', value: (m) => m.portal?.gstin ?? m.book?.partyGstin ?? '', className: 'num text-muted', defaultHidden: true, width: 160 },
        {
          id: 'invoice',
          header: 'Invoice',
          kind: 'text',
          value: (m) => m.portal?.number ?? m.book?.supplierRef ?? m.book?.number ?? '',
          hideable: false,
          width: 112,
          cell: (m) => (m.book ? <VoucherLink voucherId={m.book.voucherId} label={m.portal?.number ?? m.book.supplierRef ?? m.book.number} /> : <>{m.portal?.number}</>)
        },
        { id: 'date', header: 'Date', kind: 'date', value: (m) => m.portal?.date ?? m.book?.date ?? null, className: 'text-muted' },
        { id: 'portalValue', header: 'Value', group: 'GSTR-2B', kind: 'money', value: (m) => m.portal?.value ?? null, width: 112, aggregate: 'sum' },
        { id: 'portalTax', header: 'Tax', group: 'GSTR-2B', kind: 'money', value: (m) => taxOf(m.portal), width: 100, aggregate: 'sum' },
        { id: 'bookValue', header: 'Value', group: 'Books', kind: 'money', value: (m) => m.book?.invoiceValue ?? null, width: 112, aggregate: 'sum' },
        { id: 'bookTax', header: 'Tax', group: 'Books', kind: 'money', value: (m) => taxOf(m.book), width: 100, aggregate: 'sum' },
        { id: 'bookMonth', header: 'Books month', kind: 'text', value: (m) => m.bookMonth ?? '', width: 100, defaultHidden: true },
        { id: 'diff', header: 'Difference', kind: 'money', value: (m) => m.valueDiff, width: 112, defaultHidden: true, cell: (m) => (m.valueDiff ? <Money paise={m.valueDiff} /> : dash) },
        // Exported and filterable; shown in full in the row's detail line.
        { id: 'suggestion', header: 'Suggested action', kind: 'text', value: (m) => m.suggestion, defaultHidden: true }
      ]),
    []
  )

  if (!month) return <NoMonths />
  const rows = (data?.rows ?? []).filter((m) => category === 'all' || m.category === category)
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MonthBar months={months} value={period} onChange={setMonthKey} testId="input-assistants-2b-month" />
        {data?.statement ? (
          <span className="text-small text-muted" data-testid="assistants-2b-statement">
            2B {data.returnPeriod}: {data.statement.documents} documents{data.statement.fileName ? ` from ${data.statement.fileName}` : ''}, imported {data.statement.importedAt.slice(0, 10)} · {data.matched} matched
          </span>
        ) : null}
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-small text-muted">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} data-testid="input-assistants-2b-resolved" />
          Show resolved
        </label>
        {canAct && (
          <>
            <Button variant="ghost" data-testid="btn-assistants-2b-paste" onClick={() => setPasteOpen(true)}>
              Paste JSON…
            </Button>
            <Button data-testid="btn-assistants-2b-pick" onClick={() => void pick()}>
              {data?.statement ? 'Re-import 2B…' : 'Import 2B JSON…'}
            </Button>
          </>
        )}
        {data?.statement && (
          <RunWithAi
            testId="btn-assistants-2b-ai"
            onRun={() => runWithAi(`Go through the GSTR-2B mismatches for ${month.label} and tell me what to fix first.`, { tool: 'gst_2b_mismatches', input: { period } }, 'gst2b', { period })}
          />
        )}
      </div>
      {pasteOpen && <PasteModal onClose={() => setPasteOpen(false)} onApply={(t) => void store(t, 'Pasted 2B JSON')} />}
      {error ? (
        <Panel>
          <EmptyState title="The mismatches could not be computed" hint={(error as Error).message} />
        </Panel>
      ) : isLoading || !data ? (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      ) : !data.statement ? (
        <Panel>
          <EmptyState
            title={`No GSTR-2B imported for ${month.label}`}
            hint="On the GST portal: Returns → GSTR-2B → Download JSON, then import it here (or on the GSTR-2B screen, which keeps a copy for the assistant)."
          />
        </Panel>
      ) : (
        <>
          {data.errors.length > 0 && (
            <Banner tone="warning" className="mb-3">
              {data.errors.length} entr{data.errors.length === 1 ? 'y' : 'ies'} of the JSON could not be read: {data.errors.slice(0, 2).join('; ')}
            </Banner>
          )}
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="btn-assistants-2b-cat-all"
              aria-pressed={category === 'all'}
              onClick={() => setCategory('all')}
              className={`rounded-md border px-3 py-1.5 text-body-sm ${category === 'all' ? 'border-amber/60 bg-amberbar/15 font-medium text-amber' : 'border-line text-muted hover:bg-panel2 hover:text-ink'}`}
            >
              All <span className="num">{data.rows.length}</span>
            </button>
            {data.summary.map((s) => (
              <button
                key={s.category}
                type="button"
                data-testid={`btn-assistants-2b-cat-${s.category}`}
                aria-pressed={category === s.category}
                onClick={() => setCategory(s.category)}
                className={`rounded-md border px-3 py-1.5 text-body-sm ${category === s.category ? 'border-amber/60 bg-amberbar/15 font-medium text-amber' : 'border-line text-muted hover:bg-panel2 hover:text-ink'}`}
              >
                {s.label} <span className="num">{s.count}</span> · <Money paise={s.tax} />
              </button>
            ))}
          </div>
          <Panel>
            <DataTable
              viewId="assistants-2b"
              testId="assistants-2b"
              ariaLabel={`GSTR-2B mismatches ${month.label}`}
              columns={columns}
              rows={rows}
              rowKey={(m) => m.key}
              rowAttrs={(m) => ({ 'data-row-id': m.key, 'data-category': m.category })}
              renderDetail={(m) => (
                <p className="px-2 py-1.5 text-small whitespace-normal text-muted" data-testid="assistants-2b-suggestion">
                  <span className="font-medium text-ink">Suggested: </span>
                  {m.suggestion}
                  {m.resolved ? ` — ${m.resolved.status} by ${m.resolved.by ?? 'a user'}${m.resolved.note ? `: ${m.resolved.note}` : ''}` : ''}
                </p>
              )}
              detailHeightEstimate={44}
              expanded={new Set(rows.map((m) => m.key).filter((k) => !folded.has(k)))}
              onExpandedChange={(next) => setFolded(new Set(rows.map((m) => m.key).filter((k) => !next.has(k))))}
              isRowActivatable={(m) => !!m.book}
              onRowActivate={(m) => m.book && nav.go({ name: 'voucher-entry', voucherId: m.book.voucherId })}
              trailingWidth={aiReady ? 300 : 230}
              trailing={(m) => (
                <span className="flex justify-end gap-1 whitespace-nowrap">
                  {canAct && m.actions.some((a) => a.kind === 'draft') && !m.resolved && (
                    <Button size="sm" data-testid={`btn-assistants-2b-draft-${m.category}`} onClick={() => void draft(m)}>
                      {m.actions.find((a) => a.kind === 'draft')!.label}
                    </Button>
                  )}
                  {aiReady && (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="btn-assistants-2b-ask"
                      onClick={() =>
                        runWithAi(`Explain the GSTR-2B mismatch on ${m.portal?.number ?? m.book?.supplierRef ?? m.book?.number} (${MISMATCH_LABELS[m.category]}) and what I should do.`, { tool: 'gst_2b_mismatches', input: { period, category: m.category } }, 'gst2b', { period })
                      }
                    >
                      Ask AI
                    </Button>
                  )}
                  {canAct &&
                    (m.resolved ? (
                      <Button size="sm" variant="ghost" onClick={() => void resolve(m, null)} data-testid="btn-assistants-2b-reopen">
                        Reopen
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void resolve(m, 'resolved')} data-testid="btn-assistants-2b-resolve">
                        Resolved
                      </Button>
                    ))}
                </span>
              )}
              maxHeight="calc(100vh - 340px)"
              exportOptions={{ title: `GSTR-2B mismatches — ${month.label}`, periodLabel: month.label, filename: `gstr2b-mismatches-${period}` }}
              empty={{ title: data.rows.length ? 'Nothing in this category' : 'No mismatches — every 2B document matches the books' }}
            />
          </Panel>
          <p className="mt-2 text-hint text-muted" data-testid="assistants-2b-unverified">
            ITC needs the document in GSTR-2B (s.16(2)(aa), rule 36(4)). Not verified here: {ASSISTANT_UNVERIFIED.filter((u) => u.id.startsWith('gstr2b') || u.id === '2b-actions').map((u) => u.text).join(' ')}
          </p>
        </>
      )}
    </>
  )
}
