import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ReportSchedule, type ReportScheduleInput } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Button, DateInput, EmptyState, Field, Modal, Panel, Select, SkeletonRows } from '../../components/ui'
import { confirmDialog } from '../../lib/dialogs'
import { toDisplayDate, todayISO } from '@shared/dates'
import {
  SCHEDULE_FORMATS,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_PERIOD_LABELS,
  SCHEDULE_PERIODS,
  SCHEDULE_REPORT_LABELS,
  SCHEDULE_REPORTS
} from '@shared/reportSchedule'

const EMPTY: ReportScheduleInput = {
  report: 'trialBalance',
  periodKind: 'lastMonth',
  format: 'csv',
  frequency: 'monthly',
  folder: null,
  nextRun: todayISO(),
  active: true
}

/**
 * Scheduled reports.
 *
 * The honesty problem this screen has to solve: there is no daemon. Total runs when someone opens
 * it, so a schedule is written on the next open on or after its due date — never while the laptop
 * is shut. The line under the table says exactly that, because a user who believes a monthly
 * trial balance is landing in a shared folder while they are on holiday has been misled by the
 * word "scheduled", not by anything the code did.
 */
export function SchedulesSection(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['reportSchedules'], queryFn: api.schedules.list })
  const [editing, setEditing] = useState<{ id?: number; draft: ReportScheduleInput } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['reportSchedules'] }).then(() => undefined)

  const save = async (): Promise<void> => {
    if (!editing) return
    try {
      await api.schedules.save(editing.draft, editing.id)
      await refresh()
      setEditing(null)
      toast.push('success', 'Schedule saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (s: ReportSchedule): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete schedule',
      message: `Stop writing ${s.label} on this schedule?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.schedules.remove(s.id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const runNow = async (s: ReportSchedule): Promise<void> => {
    setBusy(s.id)
    try {
      const r = await api.schedules.run(s.id)
      await refresh()
      if (r.error) toast.push('error', r.error)
      else toast.push('success', `Written — ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-body font-medium">Scheduled reports</p>
        <Button variant="primary" data-testid="btn-schedule-new" onClick={() => setEditing({ draft: { ...EMPTY } })}>
          New schedule
        </Button>
      </div>

      <Panel>
        {isLoading ? (
          <SkeletonRows rows={3} />
        ) : !data?.length ? (
          <EmptyState
            title="Nothing is scheduled"
            hint="A schedule writes a report into a folder — the exports folder, or a synced one your accountant can see."
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Report</th>
                <th scope="col">Covers</th>
                <th scope="col">Every</th>
                <th scope="col">Format</th>
                <th scope="col">Next</th>
                <th scope="col">Last written</th>
                <th scope="col" className="r w-56">&nbsp;</th>
              </tr>
            </thead>
            <tbody data-testid="rows-report-schedules">
              {data.map((s) => (
                <tr key={s.id} className={s.active ? '' : 'text-muted'}>
                  <td>
                    {s.label}
                    {!s.active && <span className="ml-2 rounded-md bg-panel2 px-1.5 py-0.5 text-label">paused</span>}
                    {s.lastError && (
                      <span className="ml-2 rounded-md bg-cr/10 px-1.5 py-0.5 text-label text-cr" title={s.lastError}>
                        last run failed
                      </span>
                    )}
                  </td>
                  <td className="text-muted">{SCHEDULE_PERIOD_LABELS[s.periodKind]}</td>
                  <td className="text-muted">{s.frequency}</td>
                  <td className="text-muted uppercase">{s.format}</td>
                  <td className="num">{toDisplayDate(s.nextRun)}</td>
                  <td className="num text-muted" title={s.lastPath ?? undefined}>
                    {s.lastRun ? toDisplayDate(s.lastRun) : '–'}
                  </td>
                  <td className="r">
                    <Button variant="ghost" disabled={busy === s.id} onClick={() => void runNow(s)}>
                      Run now
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing({ id: s.id, draft: toInput(s) })}>
                      Edit
                    </Button>
                    <Button variant="ghost" onClick={() => void remove(s)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <p className="text-hint text-muted">
        Total has no background process — it is an offline app that runs when you open it. A due schedule is written
        the next time these books are opened, and the period it covers is worked out from the day it actually runs.
      </p>

      {editing && (
        <Modal title={editing.id ? 'Edit schedule' : 'New schedule'} onClose={() => setEditing(null)}>
          <div className="flex flex-col gap-3">
            <Field label="Report">
              <Select
                data-testid="select-schedule-report"
                value={editing.draft.report}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, report: e.currentTarget.value as ReportScheduleInput['report'] } })
                }
              >
                {SCHEDULE_REPORTS.map((r) => (
                  <option key={r} value={r}>
                    {SCHEDULE_REPORT_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Covers" hint="Resolved against the day the report is actually written.">
              <Select
                data-testid="select-schedule-period"
                value={editing.draft.periodKind}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, periodKind: e.currentTarget.value as ReportScheduleInput['periodKind'] }
                  })
                }
              >
                {SCHEDULE_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {SCHEDULE_PERIOD_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Every">
              <Select
                data-testid="select-schedule-frequency"
                value={editing.draft.frequency}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, frequency: e.currentTarget.value as ReportScheduleInput['frequency'] }
                  })
                }
              >
                {SCHEDULE_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Format" hint="XLS keeps amounts as numbers a spreadsheet can total; PDF is the printed layout.">
              <Select
                data-testid="select-schedule-format"
                value={editing.draft.format}
                onChange={(e) =>
                  setEditing({ ...editing, draft: { ...editing.draft, format: e.currentTarget.value as ReportScheduleInput['format'] } })
                }
              >
                {SCHEDULE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Next run">
              <DateInput
                value={editing.draft.nextRun}
                context={editing.draft.nextRun}
                onChange={(v) => setEditing({ ...editing, draft: { ...editing.draft, nextRun: v } })}
                testId="input-schedule-next"
              />
            </Field>
            <label className="flex items-center gap-2 text-body-sm">
              <input
                type="checkbox"
                data-testid="check-schedule-active"
                checked={editing.draft.active}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, active: e.currentTarget.checked } })}
              />
              Active
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" data-testid="btn-schedule-save" onClick={() => void save()}>
                Save
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function toInput(s: ReportSchedule): ReportScheduleInput {
  return {
    report: s.report,
    periodKind: s.periodKind,
    format: s.format,
    frequency: s.frequency,
    folder: s.folder,
    nextRun: s.nextRun,
    active: s.active
  }
}
