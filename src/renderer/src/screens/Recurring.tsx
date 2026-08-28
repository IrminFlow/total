import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecurringTemplate } from '@shared/domain'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import {
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Panel,
  RowAction,
  SectionTitle,
  Select,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../components/ui'
import { toDisplayDate, todayISO } from '@shared/dates'
import { nextDueAfter } from '@shared/recurring'
import { confirmDialog } from '../lib/dialogs'
import { templateOpenTarget } from '../lib/recurringDraft'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function cadenceSummary(t: RecurringTemplate): string {
  if (t.cadence === 'monthly') return `Monthly · day ${t.dayOfMonth}`
  return `Weekly · ${WEEKDAYS[t.weekday ?? 0]}`
}

export function RecurringScreen(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: templates, isLoading } = useQuery({ queryKey: ['recurring'], queryFn: api.recurring.list })
  // Enter opens the selected template in voucher entry, the same thing its row button does.
  const table = useTableNav(templates ?? [], {
    rowId: (t) => t.id,
    onEnter: (t) => nav.go(templateOpenTarget(t).screen)
  })
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
    const proceed = await confirmDialog({
      title: 'Delete recurring template',
      message: `Delete recurring template "${t.name}"? This does not affect vouchers already posted from it.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.recurring.remove(t.id)
      await queryClient.invalidateQueries()
      toast.push('success', 'Recurring template deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const openInVoucherEntry = (t: RecurringTemplate): void => {
    const { screen, warnInvoice } = templateOpenTarget(t)
    if (warnInvoice) toast.push('warning', 'Line items must be re-entered for invoice types')
    nav.go(screen)
  }

  const newTemplate = (): void => {
    // Templates carry a full voucher body, so "new" starts in the voucher editor — fill it in
    // and use "Save as recurring…" in its footer (the only way to produce a postable template).
    toast.push('info', 'Fill in the voucher, then choose "Save as recurring…" in its footer')
    nav.go({ name: 'voucher-entry' })
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
      <SectionTitle
        right={
          <Button data-testid="btn-recurring-new" variant="primary" onClick={newTemplate}>
            New template
          </Button>
        }
      >
        Recurring vouchers
      </SectionTitle>

      <Panel>
        {isLoading ? (
          <SkeletonRows />
        ) : !templates?.length ? (
          <EmptyState
            title="No recurring templates yet"
            hint={'Open a voucher, fill it in, then use "Save as recurring…" in its footer to create one'}
          />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Cadence</th>
                <th scope="col">Next due</th>
                <th scope="col">Last posted</th>
                <th scope="col" className="w-16">Active</th>
                <th scope="col" className="w-32"></th>
              </tr>
            </thead>
            <tbody data-testid="rows-recurring">
              {templates.map((t, i) => (
                <tr key={t.id} {...table.rowProps(i, t)}>
                  <td>{t.name}</td>
                  <td className="text-muted">{cadenceSummary(t)}</td>
                  <td className="num">{toDisplayDate(t.nextDue)}</td>
                  <td className="num text-muted">{t.lastPosted ? toDisplayDate(t.lastPosted) : '—'}</td>
                  <td>
                    <span className={`rounded-md px-1.5 py-0.5 text-label ${t.active ? 'bg-dr/10 text-dr' : 'bg-panel2 text-muted'}`}>
                      {t.active ? 'Active' : 'Paused'}
                    </span>
                  </td>
                  <td className="r">
                    <RowAction
                      data-testid={`btn-recurring-post-${t.id}`}
                      disabled={busyId === t.id}
                      onClick={() => void postNow(t)}
                    >
                      Post now
                    </RowAction>
                    <RowMenu
                      testId={`btn-recurring-menu-${t.id}`}
                      disabled={busyId === t.id}
                      actions={[
                        { label: 'Skip this occurrence', onClick: () => void skip(t) },
                        { label: 'Edit template…', onClick: () => setEditing(t) },
                        { label: 'Open in voucher entry', onClick: () => openInVoucherEntry(t) },
                        { label: 'Delete…', danger: true, onClick: () => void remove(t) }
                      ]}
                    />
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

/** Per-row "⋯" actions menu. Positioned `fixed` from the trigger's rect so the Panel's
 *  overflow-hidden can't clip it; closes on outside click, Escape, or any scroll. */
function RowMenu({
  testId,
  disabled = false,
  actions
}: {
  testId: string
  disabled?: boolean
  actions: { label: string; danger?: boolean; onClick: () => void }[]
}): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!pos) return
    const close = (): void => setPos(null)
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [pos])

  const toggle = (): void => {
    if (pos) return setPos(null)
    const r = btnRef.current!.getBoundingClientRect()
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
  }

  return (
    <>
      <button
        ref={btnRef}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={pos != null}
        disabled={disabled}
        title="More actions"
        className="rounded-md px-1.5 py-0.5 text-detail leading-none text-muted hover:bg-panel2 hover:text-ink disabled:opacity-40"
        onClick={toggle}
      >
        ⋯
      </button>
      {pos && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-30 min-w-[12rem] rounded-md border border-line bg-panel py-1 text-left panel-shadow"
          style={{ top: pos.top, right: pos.right }}
        >
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              className={`block w-full px-3 py-1.5 text-left text-body-sm hover:bg-panel2 ${a.danger ? 'text-cr' : 'text-ink'}`}
              onClick={() => {
                setPos(null)
                a.onClick()
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </>
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
  const [active, setActive] = useState(template.active)
  const [saving, setSaving] = useState(false)

  // Mirrors SaveAsRecurringModal.changeCadence in VoucherEntry.tsx — recompute Next due
  // whenever the cadence or its day/weekday changes, anchored on today.
  const changeCadence = (next: 'monthly' | 'weekly'): void => {
    setCadence(next)
    setNextDue(next === 'monthly' ? nextDueAfter('monthly', { dayOfMonth }, todayISO()) : nextDueAfter('weekly', { weekday }, todayISO()))
  }
  const changeDayOfMonth = (d: number): void => {
    setDayOfMonth(d)
    setNextDue(nextDueAfter('monthly', { dayOfMonth: d }, todayISO()))
  }
  const changeWeekday = (w: number): void => {
    setWeekday(w)
    setNextDue(nextDueAfter('weekly', { weekday: w }, todayISO()))
  }

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
          nextDue,
          active
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
            <Select value={cadence} onChange={(e) => changeCadence(e.target.value as 'monthly' | 'weekly')}>
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
                onChange={(e) => changeDayOfMonth(Math.max(1, Math.min(31, Number(e.target.value) || 1)))}
                className="num"
              />
            </Field>
          ) : (
            <Field label="Weekday">
              <Select value={weekday} onChange={(e) => changeWeekday(Number(e.target.value))}>
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
        <label className="flex items-center gap-2 text-detail text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
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
