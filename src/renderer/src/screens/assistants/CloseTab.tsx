// Assistants → Month-end close: the checklist for a month as a DataTable (status, check, what was
// found, amount, due date, who marked it), each row opening onto the rows behind it, with the
// screen that fixes it, "Mark done" / "Not applicable" (accountant) and a progress bar.
import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CheckRow, CloseCheck, CloseChecklist } from '@shared/closeChecklist'
import { ASSISTANT_SOURCES } from '@shared/assistantSources'
import { assistantsApi } from '../../lib/assistantsClient'
import { useAiScreenContext } from '../../lib/aiContext'
import { promptDialog } from '../../lib/dialogs'
import { useNav, useToasts, type Screen } from '../../state/stores'
import { Button, EmptyState, Panel, SkeletonRows } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { MonthBar, NoMonths, useMonth } from '../GstReturns'
import { RowLink, RunWithAi, STATUS_OPTIONS, StatusBadge, runWithAi, useCanAct } from './common'

const AREAS = ['Banking', 'Parties', 'GST', 'TDS / TCS', 'Stock', 'Books', 'Assets'].map((a) => ({ value: a, label: a }))

const ROW_COLUMNS = defineColumns<CheckRow>([
  { id: 'label', header: 'Item', kind: 'text', value: (r) => r.label, hideable: false, cell: (r) => <RowLink label={r.label} voucherId={r.voucherId} ledgerId={r.ledgerId} itemId={r.itemId} /> },
  { id: 'detail', header: 'Detail', kind: 'text', value: (r) => r.detail, className: 'text-muted' },
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date ?? null, className: 'text-muted' },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount ?? null, aggregate: 'sum' }
])

function CheckRows({ check, period }: { check: CloseCheck; period: string }): React.JSX.Element {
  const nav = useNav()
  if (!check.rows.length) return <p className="px-panel py-2 text-hint text-muted">{check.help}</p>
  return (
    <div className="px-2 py-2">
      <p className="mb-1.5 px-1 text-hint text-muted">{check.help}</p>
      <DataTable
        viewId={`assistants-close-${check.key}`}
        testId={`assistants-close-${check.key}`}
        ariaLabel={check.title}
        columns={ROW_COLUMNS}
        rows={check.rows}
        rowKey={(r, i) => `${r.voucherId ?? ''}|${r.ledgerId ?? ''}|${r.itemId ?? ''}|${r.draftId ?? ''}|${i}`}
        rowAttrs={(r) => ({ 'data-row-id': r.voucherId ?? r.ledgerId ?? r.itemId })}
        isRowActivatable={(r) => !!(r.voucherId || r.ledgerId || r.draftId)}
        onRowActivate={(r) => {
          if (r.draftId) nav.go({ name: 'voucher-entry', aiDraftId: r.draftId })
          else if (r.voucherId) nav.go({ name: 'voucher-entry', voucherId: r.voucherId })
          else if (r.ledgerId) nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })
        }}
        maxHeight="40vh"
        exportOptions={{ title: `Close checklist — ${check.title}`, periodLabel: period, filename: `close-${period}-${check.key}` }}
      />
      {check.more > 0 && <p className="px-1 pt-1 text-hint text-muted">Showing the first {check.rows.length} of {check.rows.length + check.more}.</p>}
    </div>
  )
}

function fixScreen(c: CloseCheck): Screen {
  return { name: c.fix.screen, ...(c.fix.params ?? {}) } as Screen
}

export function CloseTab({ initialPeriod }: { initialPeriod?: string }): React.JSX.Element {
  const { months, month, monthKey, setMonthKey } = useMonth('previous')
  useEffect(() => {
    if (initialPeriod && months.some((m) => m.key === initialPeriod)) setMonthKey(initialPeriod)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeriod])
  const period = month?.key ?? monthKey
  useAiScreenContext('assistants', { tab: 'close', period })
  const qc = useQueryClient()
  const toast = useToasts()
  const nav = useNav()
  const canAct = useCanAct()
  const { data, isLoading, error } = useQuery({ queryKey: ['assistClose', period], queryFn: () => assistantsApi.close(period), enabled: !!month })

  const mark = async (c: CloseCheck, status: 'done' | 'na' | null): Promise<void> => {
    try {
      let note: string | undefined
      if (status) {
        const n = await promptDialog({
          title: status === 'done' ? `Mark “${c.title}” done` : `Mark “${c.title}” not applicable`,
          message: 'Add a note for the audit trail (optional).',
          initial: '',
          placeholder: status === 'done' ? 'e.g. reviewed with the bank statement' : 'e.g. depreciation is posted yearly',
          confirmLabel: status === 'done' ? 'Mark done' : 'Not applicable'
        })
        if (n === null) return
        note = n.trim() || undefined
      }
      const next = await assistantsApi.markClose(period, c.key, status, note)
      qc.setQueryData(['assistClose', period], next)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const columns = useMemo(
    () =>
      defineColumns<CloseCheck>([
        { id: 'status', header: 'Status', kind: 'enum', value: (c) => c.effective, options: STATUS_OPTIONS, width: 96, cell: (c) => <StatusBadge status={c.effective} testId={`close-status-${c.key}`} /> },
        { id: 'title', header: 'Check', kind: 'text', value: (c) => c.title, hideable: false, minWidth: 220, cell: (c) => <span className="font-medium">{c.title}</span> },
        { id: 'summary', header: 'Found', kind: 'text', value: (c) => c.summary, minWidth: 280, className: 'text-muted' },
        { id: 'area', header: 'Area', kind: 'enum', value: (c) => c.area, options: AREAS, width: 104, defaultHidden: true },
        { id: 'count', header: 'Items', kind: 'number', value: (c) => c.count + c.more, width: 72 },
        { id: 'amount', header: 'Amount', kind: 'money', value: (c) => c.amount, width: 132, explainable: false },
        { id: 'due', header: 'Due', kind: 'date', value: (c) => c.dueDate, width: 104, className: 'text-muted' },
        { id: 'mark', header: 'Marked', kind: 'text', value: (c) => (c.mark ? `${c.mark.by ?? '—'}${c.mark.note ? `: ${c.mark.note}` : ''}` : ''), defaultHidden: false, className: 'text-muted', width: 160 }
      ]),
    []
  )

  if (!month) return <NoMonths />
  const list: CloseChecklist | undefined = data
  const p = list?.progress
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <MonthBar months={months} value={period} onChange={setMonthKey} testId="input-assistants-close-month" />
        {p && (
          <div className="flex min-w-[260px] flex-1 items-center gap-3" data-testid="close-progress" data-pct={p.pct}>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.pct} aria-label="Checks cleared">
              <div className={`h-full rounded-full ${p.fail ? 'bg-danger' : p.warn ? 'bg-warning' : 'bg-success'}`} style={{ width: `${p.pct}%` }} />
            </div>
            <span className="num text-small text-muted">
              {p.cleared} of {p.total} cleared · {p.fail} to fix · {p.warn} to review
            </span>
          </div>
        )}
        <RunWithAi
          testId="btn-assistants-close-ai"
          onRun={() => runWithAi(`Walk me through the month-end close for ${month.label}: what is still open and what should I do first?`, { tool: 'close_checklist', input: { period } }, 'close', { period })}
        />
      </div>
      {error ? (
        <Panel>
          <EmptyState title="The checklist could not be computed" hint={(error as Error).message} />
        </Panel>
      ) : isLoading || !list ? (
        <Panel>
          <SkeletonRows rows={8} />
        </Panel>
      ) : (
        <Panel>
          <DataTable
            viewId="assistants-close"
            testId="assistants-close"
            ariaLabel={`Close checklist ${list.label}`}
            columns={columns}
            rows={list.checks}
            rowKey={(c) => c.key}
            rowAttrs={(c) => ({ 'data-row-id': c.key, 'data-status': c.effective })}
            renderDetail={(c) => <CheckRows check={c} period={list.label} />}
            isRowExpandable={() => true}
            onRowActivate={(c) => nav.go(fixScreen(c))}
            trailing={(c) => (
              <span className="flex justify-end gap-1 whitespace-nowrap">
                <Button size="sm" variant="ghost" data-testid={`btn-assistants-close-fix-${c.key}`} onClick={() => nav.go(fixScreen(c))}>
                  {c.fix.label}
                </Button>
                {canAct &&
                  (c.mark ? (
                    <Button size="sm" variant="ghost" data-testid={`btn-assistants-close-clear-${c.key}`} onClick={() => void mark(c, null)}>
                      Undo mark
                    </Button>
                  ) : c.status !== 'ok' && c.status !== 'na' ? (
                    <>
                      <Button size="sm" data-testid={`btn-assistants-close-done-${c.key}`} onClick={() => void mark(c, 'done')}>
                        Mark done
                      </Button>
                      <Button size="sm" variant="ghost" data-testid={`btn-assistants-close-na-${c.key}`} onClick={() => void mark(c, 'na')}>
                        N/A
                      </Button>
                    </>
                  ) : null)}
              </span>
            )}
            maxHeight="calc(100vh - 290px)"
            exportOptions={{ title: `Month-end close checklist — ${list.label}`, periodLabel: list.label, filename: `close-checklist-${period}` }}
            empty={{ title: 'No checks' }}
          />
          <p className="border-t border-line px-panel py-2 text-hint text-muted">
            A return counts as prepared once its JSON is exported. Due dates: GSTR-1 on the 11th, GSTR-3B on the 20th (monthly filers), TDS / TCS by the 7th — see{' '}
            <span title={ASSISTANT_SOURCES.rule61.url}>rule 61</span>, <span title={ASSISTANT_SOURCES.s37_1.url}>s.37(1)</span>; the GSTR-1 11th and quarterly (QRMP) dates are not verified here.
          </p>
        </Panel>
      )}
    </>
  )
}
