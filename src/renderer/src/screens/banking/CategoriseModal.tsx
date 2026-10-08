// Banking → statement → "Categorise unmatched" (WP 5.4): proposals for the open lines no match
// was found for — bank rules, the narrations of earlier matches and party names first, the
// assistant only for what is left (it picks from each line's candidates). The user accepts all,
// some, or edits a row; each accepted row becomes a DRAFT (payment / receipt / contra) that
// reconciles its line when saved in the voucher editor. Nothing is posted here.
import { useEffect, useMemo, useState } from 'react'
import type { CategoriseAcceptResult, StatementCategorisation, StatementCategoryRow } from '@shared/capture/types'
import { captureApi } from '../../lib/captureClient'
import { useNav, useToasts } from '../../state/stores'
import { DataTable, defineColumns } from '../../components/table'
import { Badge, Banner, Button, Modal, SkeletonRows } from '../../components/ui'
import { LedgerPicker } from '../../components/pickers'
import { rupees } from './shared'

const SOURCE_LABEL: Record<StatementCategoryRow['source'], { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' }> = {
  rule: { label: 'Bank rule', tone: 'success' },
  learned: { label: 'Learned', tone: 'success' },
  memory: { label: 'Remembered', tone: 'success' },
  history: { label: 'History', tone: 'success' },
  party: { label: 'Party named', tone: 'info' },
  ai: { label: 'Assistant', tone: 'warning' },
  none: { label: 'No proposal', tone: 'neutral' }
}

export function CategoriseModal({ bankLedgerId, onClose, onDone }: { bankLedgerId: number; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const toast = useToasts()
  const nav = useNav()
  const [data, setData] = useState<StatementCategorisation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<number, number | null>>({})
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [result, setResult] = useState<CategoriseAcceptResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    captureApi
      .categorise(bankLedgerId)
      .then((d) => {
        if (!live) return
        setData(d)
        setPicked(new Set(d.rows.filter((r) => r.ledgerId).map((r) => r.lineId)))
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [bankLedgerId])

  const ledgerOf = (r: StatementCategoryRow): number | null => (r.lineId in edits ? edits[r.lineId]! : r.ledgerId)
  const rows = data?.rows ?? []
  const columns = useMemo(
    () =>
      defineColumns<StatementCategoryRow>([
        { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, width: 100, className: 'text-muted' },
        { id: 'narration', header: 'Narration', kind: 'text', value: (r) => r.description, minWidth: 200, hideable: false },
        { id: 'amount', header: 'Amount', kind: 'money', value: (r) => (r.side === 'withdrawal' ? -r.amount : r.amount), width: 120 },
        {
          id: 'ledger', header: 'Ledger', kind: 'text', minWidth: 230, value: (r) => r.ledgerName ?? '',
          cell: (r) => (
            <span onClick={(e) => e.stopPropagation()} className="block" data-testid="cell-categorise-ledger">
              <LedgerPicker
                value={ledgerOf(r)}
                onPick={(id) => {
                  setEdits((x) => ({ ...x, [r.lineId]: id }))
                  setPicked((s) => {
                    const n = new Set(s)
                    if (id) n.add(r.lineId)
                    else n.delete(r.lineId)
                    return n
                  })
                }}
                placeholder={r.candidates.length ? `Pick (e.g. ${r.candidates[0]!.name})` : 'Pick a ledger'}
                testId={`picker-categorise-${r.lineId}`}
              />
            </span>
          )
        },
        { id: 'kind', header: 'Voucher', kind: 'text', value: (r) => r.kind, width: 96, className: 'text-muted' },
        {
          id: 'source', header: 'Why', kind: 'text', minWidth: 260, value: (r) => r.why,
          cell: (r) => (
            <span className="flex flex-col gap-0.5" data-testid="cell-categorise-source" data-source={r.source}>
              <span className="flex items-center gap-1">
                <Badge tone={SOURCE_LABEL[r.source].tone}>{SOURCE_LABEL[r.source].label}</Badge>
                {r.confidence > 0 && <span className="text-hint text-muted">{Math.round(r.confidence * 100)}%</span>}
              </span>
              <span className="text-hint text-muted">{r.why}{r.oldestBillsFirst ? ' · settles oldest bills first' : ''}</span>
            </span>
          )
        }
      ]),
    [edits] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const accept = async (only: StatementCategoryRow[]): Promise<void> => {
    const items = only.flatMap((r) => {
      const ledgerId = ledgerOf(r)
      if (!ledgerId) return []
      const edited = r.lineId in edits && edits[r.lineId] !== r.ledgerId
      return [{ lineId: r.lineId, ledgerId, ...(edited ? {} : { kind: r.kind, oldestBillsFirst: r.oldestBillsFirst }) }]
    })
    if (!items.length) return
    setBusy(true)
    try {
      const res = await captureApi.acceptCategories(bankLedgerId, items)
      setResult(res)
      if (res.drafts.length) toast.push('success', `${res.drafts.length} ${res.drafts.length === 1 ? 'draft' : 'drafts'} made — review and save each; saving reconciles its line`)
      if (res.failed.length) toast.push('error', `${res.failed.length} not drafted: ${res.failed[0]!.error}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const ready = rows.filter((r) => ledgerOf(r))
  const selected = ready.filter((r) => picked.has(r.lineId))

  return (
    <Modal title="Categorise unmatched statement lines" onClose={result ? onDone : onClose} extraWide>
      <div className="space-y-3 p-4" data-testid="categorise-modal">
        {error && <Banner tone="danger">{error}</Banner>}
        {!data && !error && <SkeletonRows rows={4} />}
        {data && (
          <>
            <p className="text-small text-muted" data-testid="text-categorise-note">
              Rules, earlier matches and party names first{data.aiUsed ? '; the assistant suggested the rest from each line’s candidates' : ''}.
              {data.aiNote ? ` ${data.aiNote}.` : ''}
              {data.rejected ? ` ${data.rejected} suggestion${data.rejected === 1 ? '' : 's'} outside the candidates dropped.` : ''}
              {' '}Accepted rows become drafts; nothing is posted until you save them.
            </p>
            {result ? (
              <div className="space-y-2" data-testid="categorise-result">
                {result.drafts.map((d) => (
                  <div key={d.draftId} className="flex items-center justify-between gap-2 rounded border border-line px-3 py-2">
                    <span className="text-small">{d.summary}</span>
                    <Button size="sm" data-testid="btn-categorise-open-draft" onClick={() => { onDone(); nav.go({ name: 'voucher-entry', aiDraftId: d.draftId }) }}>
                      Review draft
                    </Button>
                  </div>
                ))}
                {result.failed.map((f) => (
                  <Banner key={f.lineId} tone="warning">{rows.find((r) => r.lineId === f.lineId)?.description}: {f.error}</Banner>
                ))}
                <div className="flex justify-end">
                  <Button onClick={onDone}>Done</Button>
                </div>
              </div>
            ) : (
              <>
                <DataTable
                  viewId="banking-categorise"
                  testId="categorise-table"
                  ariaLabel="Proposed categories"
                  columns={columns}
                  rows={rows}
                  rowKey={(r) => r.lineId}
                  rowAttrs={(r) => ({ 'data-line-id': r.lineId, 'data-source': r.source })}
                  maxHeight="52vh"
                  selection={{ selected: picked, onChange: (n) => setPicked(new Set([...n].map(Number))), isSelectable: (r) => !!ledgerOf(r), label: (r) => r.description }}
                  empty={{ title: 'No unmatched lines', hint: 'Every open line already has a proposed match' }}
                />
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="mr-auto text-hint text-muted">
                    {rows.length} open {rows.length === 1 ? 'line' : 'lines'} · {ready.length} with a ledger · total {rupees(ready.reduce((s, r) => s + r.amount, 0))}
                  </span>
                  <Button onClick={onClose}>Cancel</Button>
                  <Button disabled={busy || selected.length === 0} data-testid="btn-categorise-accept-selected" onClick={() => void accept(selected)}>
                    Draft {selected.length} selected
                  </Button>
                  <Button variant="primary" disabled={busy || ready.length === 0} data-testid="btn-categorise-accept-all" onClick={() => void accept(ready)}>
                    Accept all ({ready.length})
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
