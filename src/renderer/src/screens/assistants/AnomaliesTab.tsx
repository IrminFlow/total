// Assistants → Anomalies: possible duplicates and unusual entries in the working period, each with
// its reason, severity and the voucher (or item) behind it. Dismiss hides one finding for good
// (audited); "Show dismissed" brings them back with who dismissed them. Settings: weekly offs,
// holidays and thresholds.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ANOMALY_LABELS, type AnomalyKind } from '@shared/anomalies'
import type { AnomalyRow, AssistantSettings } from '@shared/assistants'
import { formatPaise, parseRupees } from '@shared/money'
import { toDisplayDate } from '@shared/dates'
import { assistantsApi } from '../../lib/assistantsClient'
import { useAiScreenContext } from '../../lib/aiContext'
import { promptDialog } from '../../lib/dialogs'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Button, EmptyState, Field, Modal, Panel, SkeletonRows, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { RowLink, RunWithAi, SeverityBadge, runWithAi, useCanAct } from './common'

const KIND_OPTIONS = (Object.keys(ANOMALY_LABELS) as AnomalyKind[]).map((k) => ({ value: k, label: ANOMALY_LABELS[k] }))
const SEVERITY_OPTIONS = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
]
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function SettingsModal({ settings, onClose, onSave }: { settings: AssistantSettings; onClose: () => void; onSave: (s: Partial<AssistantSettings>) => void }): React.JSX.Element {
  const [weekend, setWeekend] = useState(settings.weekendDays)
  const [holidays, setHolidays] = useState(settings.holidays.join('\n'))
  const [window, setWindow] = useState(String(settings.duplicateWindowDays))
  const [late, setLate] = useState(String(settings.backdatedDays))
  const [round, setRound] = useState(formatPaise(settings.roundMinPaise))
  const [sigma, setSigma] = useState(`${settings.zThresholdMilli / 1000}`)
  const badDates = holidays.split(/\s+/).filter((d) => d && !/^\d{4}-\d{2}-\d{2}$/.test(d))
  const save = (): void => {
    const roundPaise = parseRupees(round)
    const sigmaMilli = Math.round(Number(sigma) * 1000)
    onSave({
      weekendDays: weekend,
      holidays: holidays.split(/\s+/).filter(Boolean),
      duplicateWindowDays: Number(window) || 0,
      backdatedDays: Number(late) || 30,
      ...(roundPaise ? { roundMinPaise: roundPaise } : {}),
      ...(Number.isFinite(sigmaMilli) && sigmaMilli >= 1000 ? { zThresholdMilli: sigmaMilli } : {})
    })
  }
  return (
    <Modal title="Anomaly settings" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Weekly off days">
          <div className="flex gap-2">
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1 text-small">
                <input type="checkbox" checked={weekend.includes(i)} onChange={(e) => setWeekend(e.target.checked ? [...weekend, i] : weekend.filter((x) => x !== i))} data-testid={`input-anomaly-weekend-${i}`} />
                {d}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Holidays (one date per line, YYYY-MM-DD)" hint={badDates.length ? `Not a date: ${badDates.join(', ')}` : undefined}>
          <textarea value={holidays} onChange={(e) => setHolidays(e.target.value)} rows={4} className="num w-full rounded-md border border-line bg-panel2 px-2.5 py-1.5 text-caption" data-testid="input-anomaly-holidays" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Duplicate window (days)">
            <TextInput value={window} onChange={(e) => setWindow(e.target.value)} data-testid="input-anomaly-window" />
          </Field>
          <Field label="Back-dated after (days)">
            <TextInput value={late} onChange={(e) => setLate(e.target.value)} data-testid="input-anomaly-late" />
          </Field>
          <Field label="Round amounts from (₹)">
            <TextInput value={round} onChange={(e) => setRound(e.target.value)} data-testid="input-anomaly-round" />
          </Field>
          <Field label="Outlier at (standard deviations)">
            <TextInput value={sigma} onChange={(e) => setSigma(e.target.value)} data-testid="input-anomaly-sigma" />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={badDates.length > 0} onClick={save} data-testid="btn-anomaly-settings-save">
          Save
        </Button>
      </div>
    </Modal>
  )
}

export function AnomaliesTab(): React.JSX.Element {
  const { from, to } = useSession()
  useAiScreenContext('assistants', { tab: 'anomalies' })
  const qc = useQueryClient()
  const toast = useToasts()
  const nav = useNav()
  const canAct = useCanAct()
  const [showDismissed, setShowDismissed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { data, isLoading, error } = useQuery({ queryKey: ['assistAnomalies', from, to, showDismissed], queryFn: () => assistantsApi.anomalies(from, to, showDismissed) })
  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: ['assistAnomalies'] })

  const dismiss = async (a: AnomalyRow, dismissed: boolean): Promise<void> => {
    try {
      let note: string | undefined
      if (dismissed) {
        const n = await promptDialog({ title: 'Dismiss this finding', message: 'Why is it fine? The note goes to the audit trail (optional).', initial: '', placeholder: 'e.g. two separate deliveries', confirmLabel: 'Dismiss' })
        if (n === null) return
        note = n.trim() || undefined
      }
      await assistantsApi.dismissAnomaly(a.key, dismissed, note)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const saveSettings = async (patch: Partial<AssistantSettings>): Promise<void> => {
    try {
      await assistantsApi.setSettings(patch)
      setSettingsOpen(false)
      await refresh()
      toast.push('success', 'Anomaly settings saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const columns = useMemo(
    () =>
      defineColumns<AnomalyRow>([
        { id: 'severity', header: 'Severity', kind: 'enum', value: (a) => a.severity, options: SEVERITY_OPTIONS, width: 96, cell: (a) => <SeverityBadge severity={a.severity} /> },
        { id: 'kind', header: 'Finding', kind: 'enum', value: (a) => a.kind, options: KIND_OPTIONS, width: 230 },
        { id: 'label', header: 'Voucher / item', kind: 'text', value: (a) => a.label, hideable: false, width: 150, cell: (a) => <RowLink label={a.label} voucherId={a.voucherId} itemId={a.itemId} /> },
        { id: 'date', header: 'Date', kind: 'date', value: (a) => a.date, className: 'text-muted' },
        { id: 'party', header: 'Party', kind: 'text', value: (a) => a.partyName ?? '', minWidth: 140, cell: (a) => (a.partyLedgerId ? <RowLink label={a.partyName ?? ''} ledgerId={a.partyLedgerId} /> : <>{a.partyName}</>) },
        { id: 'amount', header: 'Amount', kind: 'money', value: (a) => a.amount, width: 132 },
        { id: 'detail', header: 'Why', kind: 'text', value: (a) => a.detail, minWidth: 340, className: 'text-muted whitespace-normal' },
        { id: 'dismissed', header: 'Dismissed', kind: 'text', value: (a) => (a.dismissed ? `${a.dismissed.by ?? '—'}${a.dismissed.note ? `: ${a.dismissed.note}` : ''}` : ''), defaultHidden: !showDismissed, className: 'text-muted' }
      ]),
    [showDismissed]
  )

  const c = data?.counts
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-small text-muted" data-testid="assistants-anomaly-counts">
          {toDisplayDate(from)} → {toDisplayDate(to)}
          {c ? ` · ${c.high} high · ${c.medium} medium · ${c.low} low${c.dismissed ? ` · ${c.dismissed} dismissed` : ''}` : ''}
          {data ? ` · baselines from ${toDisplayDate(data.historyFrom)}` : ''}
        </span>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-small text-muted">
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} data-testid="input-assistants-anomaly-dismissed" />
          Show dismissed
        </label>
        {canAct && data && (
          <Button variant="ghost" data-testid="btn-assistants-anomaly-settings" onClick={() => setSettingsOpen(true)}>
            Settings…
          </Button>
        )}
        <RunWithAi testId="btn-assistants-anomaly-ai" onRun={() => runWithAi('Which of the unusual entries in this period should I look at first, and why?', { tool: 'find_anomalies', input: { from, to } }, 'anomalies')} />
      </div>
      {settingsOpen && data && <SettingsModal settings={data.settings} onClose={() => setSettingsOpen(false)} onSave={(s) => void saveSettings(s)} />}
      {error ? (
        <Panel>
          <EmptyState title="The anomalies could not be computed" hint={(error as Error).message} />
        </Panel>
      ) : isLoading || !data ? (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      ) : (
        <Panel>
          <DataTable
            viewId="assistants-anomalies"
            testId="assistants-anomalies"
            ariaLabel="Anomalies"
            columns={columns}
            rows={data.rows}
            rowKey={(a) => a.key}
            rowAttrs={(a) => ({ 'data-row-id': a.key, 'data-kind': a.kind })}
            isRowActivatable={(a) => !!a.voucherId}
            onRowActivate={(a) => a.voucherId && nav.go({ name: 'voucher-entry', voucherId: a.voucherId })}
            trailing={(a) =>
              canAct ? (
                a.dismissed ? (
                  <Button size="sm" variant="ghost" onClick={() => void dismiss(a, false)} data-testid="btn-assistants-anomaly-restore">
                    Restore
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void dismiss(a, true)} data-testid="btn-assistants-anomaly-dismiss">
                    Dismiss
                  </Button>
                )
              ) : null
            }
            maxHeight="calc(100vh - 290px)"
            exportOptions={{ title: 'Anomalies', periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`, filename: 'anomalies' }}
            empty={{ title: 'Nothing unusual in this period', hint: 'Duplicates, outliers, odd dates and GST rate differences show up here.' }}
          />
        </Panel>
      )}
    </>
  )
}
