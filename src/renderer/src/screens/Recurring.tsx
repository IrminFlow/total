import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecurringTemplate } from '@shared/domain'
import type { VoucherDraft } from '../state/stores'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, DateInput, EmptyState, Field, Modal, Panel, SectionTitle, Select, TextInput } from '../components/ui'
import { toDisplayDate, todayISO } from '@shared/dates'
import type { VoucherInputParsed } from '@shared/schemas'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function cadenceSummary(t: RecurringTemplate): string {
  if (t.cadence === 'monthly') return `Monthly · day ${t.dayOfMonth}`
  return `Weekly · ${WEEKDAYS[t.weekday ?? 0]}`
}

/** Best-effort draft for "Open in voucher entry" — maps a template's stored lines to the
 *  voucher-entry draft shape so a stale/rejected template can still be posted by hand. */
export function draftFromTemplate(t: RecurringTemplate): VoucherDraft {
  try {
    const parsed = JSON.parse(t.voucherJson) as Partial<VoucherInputParsed>
    return {
      date: todayISO(),
      partyLedgerId: parsed.partyLedgerId ?? undefined,
      narration: parsed.narration ?? undefined,
      lines: (parsed.lines ?? []).map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount }))
    }
  } catch {
    return { date: todayISO() }
  }
}

export function RecurringScreen(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: templates } = useQuery({ queryKey: ['recurring'], queryFn: api.recurring.list })
  const [editing, setEditing] = useState<RecurringTemplate | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const postNow = async (t: RecurringTemplate): Promise<void> => {
    setBusyId(t.id)
    try {
      const saved = await api.recurring.post(t.id, todayISO())
      await queryClient.invalidateQueries()
      toast.push('success', `${saved.number} posted from "${t.name}"`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const skip = async (t: RecurringTemplate): Promise<void> => {
    setBusyId(t.id)
    try {
      await api.recurring.skip(t.id)
      await queryClient.invalidateQueries()
      toast.push('success', `"${t.name}" skipped — next due pushed forward`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (t: RecurringTemplate): Promise<void> => {
    if (!window.confirm(`Delete recurring template "${t.name}"? This does not affect vouchers already posted from it.`)) return
    try {
      await api.recurring.remove(t.id)
      await queryClient.invalidateQueries()
      toast.push('success', 'Recurring template deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle>Recurring vouchers</SectionTitle>

      <Panel>
        {!templates?.length ? (
          <EmptyState
            title="No recurring templates yet"
            hint={'Open a voucher, fill it in, then use "Save as recurring…" in its footer to create one'}
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Cadence</th>
                <th>Next due</th>
                <th>Last posted</th>
                <th className="w-16">Active</th>
                <th className="w-64"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-panel2">
                  <td>{t.name}</td>
                  <td className="text-muted">{cadenceSummary(t)}</td>
                  <td className="num">{toDisplayDate(t.nextDue)}</td>
                  <td className="num text-muted">{t.lastPosted ? toDisplayDate(t.lastPosted) : '—'}</td>
                  <td>
                    <span className={`rounded px-1.5 py-0.5 text-[10.5px] ${t.active ? 'bg-dr/10 text-dr' : 'bg-panel2 text-muted'}`}>
                      {t.active ? 'Active' : 'Paused'}
                    </span>
                  </td>
                  <td className="r">
                    <button
                      disabled={busyId === t.id}
                      className="mr-3 text-[12px] text-blue hover:underline disabled:opacity-40"
                      onClick={() => void postNow(t)}
                    >
                      Post now
                    </button>
                    <button
                      disabled={busyId === t.id}
                      className="mr-3 text-[12px] text-blue hover:underline disabled:opacity-40"
                      onClick={() => void skip(t)}
                    >
                      Skip
                    </button>
                    <button className="mr-3 text-[12px] text-blue hover:underline" onClick={() => setEditing(t)}>
                      Edit
                    </button>
                    <button
                      className="mr-3 text-[12px] text-blue hover:underline"
                      onClick={() => nav.go({ name: 'voucher-entry', draft: draftFromTemplate(t) })}
                    >
                      Open in voucher entry
                    </button>
                    <button className="text-[12px] text-cr hover:underline" onClick={() => void remove(t)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {editing && <RecurringFormModal template={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RecurringFormModal({ template, onClose }: { template: RecurringTemplate; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [name, setName] = useState(template.name)
  const [cadence, setCadence] = useState<'monthly' | 'weekly'>(template.cadence)
  const [dayOfMonth, setDayOfMonth] = useState(template.dayOfMonth ?? 1)
  const [weekday, setWeekday] = useState(template.weekday ?? 1)
  const [nextDue, setNextDue] = useState(template.nextDue)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!name.trim()) return void toast.push('error', 'Name is required')
    setSaving(true)
    try {
      await api.recurring.save(
        {
          name: name.trim(),
          voucherJson: template.voucherJson,
          cadence,
          dayOfMonth: cadence === 'monthly' ? dayOfMonth : undefined,
          weekday: cadence === 'weekly' ? weekday : undefined,
          nextDue
        },
        template.id
      )
      await queryClient.invalidateQueries()
      toast.push('success', 'Recurring template updated')
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Edit "${template.name}"`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cadence">
            <Select value={cadence} onChange={(e) => setCadence(e.target.value as 'monthly' | 'weekly')}>
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </Select>
          </Field>
          {cadence === 'monthly' ? (
            <Field label="Day of month" hint="Clamped to shorter months (31 → last day)">
              <TextInput
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(Math.max(1, Math.min(31, Number(e.target.value) || 1)))}
                className="num"
              />
            </Field>
          ) : (
            <Field label="Weekday">
              <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field label="Next due">
          <DateInput value={nextDue} context={nextDue} onChange={setNextDue} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            Save template
          </Button>
        </div>
      </div>
    </Modal>
  )
}
