import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Budget } from '@shared/domain'
import type { BudgetLineInput } from '@shared/schemas'
import { fyFromStartYear, fyOf, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { api } from '../lib/client'
import { useToasts } from '../state/stores'
import { AmountInput, Button, EmptyState, Field, Modal, Money, Panel, ScrollList, SectionTitle, Select, TextInput, SkeletonRows } from '../components/ui'
import { LedgerPicker, useGroups } from '../components/pickers'
import { confirmDialog } from '../lib/dialogs'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The 12 'YYYY-MM' months of a financial year, April through March. */
function fyMonths(fyStartYear: number): string[] {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fyStartYear}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fyStartYear + 1}-${String(m).padStart(2, '0')}`)
  return out
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/** One editable row in the budget line editor — local, pre-save shape (mirrors BudgetLineInput
 *  but keeps the ledger/group toggle as an explicit targetType so the picker can switch cleanly). */
interface EditRow {
  key: number
  targetType: 'ledger' | 'group'
  ledgerId: number | null
  groupId: number | null
  month: string | null
  amount: number | null
}

let rowKeySeq = 0
const newRow = (): EditRow => ({ key: rowKeySeq++, targetType: 'ledger', ledgerId: null, groupId: null, month: null, amount: null })

export function BudgetsScreen(): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const groups = useGroups()
  const { data: budgetList, isLoading: budgetsLoading } = useQuery({ queryKey: ['budgets'], queryFn: api.budget.list })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [rows, setRows] = useState<EditRow[]>([])
  // Editor dirtiness — flipped by any line edit, cleared on save / budget switch.
  const [editorDirty, setEditorDirty] = useState(false)
  useUnsavedGuard(editorDirty)
  const [lineErrors, setLineErrors] = useState<string[]>([])
  const [upToMonth, setUpToMonth] = useState(todayISO().slice(0, 7))

  const budgets = budgetList ?? []
  const selected = budgets.find((b) => b.id === selectedId) ?? null

  useEffect(() => {
    if (!selectedId && budgets.length > 0) setSelectedId(budgets[0]!.id)
  }, [budgets, selectedId])

  // Reset the editor rows (and the default variance month) whenever the selected budget changes.
  useEffect(() => {
    if (!selected) {
      setRows([])
      return
    }
    setRows(
      selected.lines.length > 0
        ? selected.lines.map((l) => ({
            key: rowKeySeq++,
            targetType: l.ledgerId != null ? 'ledger' : 'group',
            ledgerId: l.ledgerId,
            groupId: l.groupId,
            month: l.month,
            amount: l.amount
          }))
        : [newRow()]
    )
    setEditorDirty(false)
    setLineErrors([])
    const months = fyMonths(selected.fyStartYear)
    const currentMonth = todayISO().slice(0, 7)
    setUpToMonth(months.includes(currentMonth) ? currentMonth : months[months.length - 1]!)
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: variance, isLoading: varianceLoading } = useQuery({
    queryKey: ['budgetVariance', selected?.id, upToMonth],
    queryFn: () => api.budget.variance(selected!.id, upToMonth),
    enabled: !!selected
  })

  const months = selected ? fyMonths(selected.fyStartYear) : []
  const groupMap = new Map(groups.map((g) => [g.id, g]))

  const updateRow = (key: number, patch: Partial<EditRow>): void => {
    setEditorDirty(true)
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }
  const removeRow = (key: number): void => {
    setEditorDirty(true)
    setRows((prev) => prev.filter((r) => r.key !== key))
  }

  const save = async (): Promise<void> => {
    if (!selected) return
    const lines: BudgetLineInput[] = []
    const errors: string[] = []
    rows.forEach((r, i) => {
      const targetId = r.targetType === 'ledger' ? r.ledgerId : r.groupId
      // A completely blank row (fresh "+ Add line", nothing filled) is ignored, not an error.
      if (targetId == null && r.amount == null) return
      if (targetId == null) {
        errors.push(`Line ${i + 1}: pick a ${r.targetType === 'ledger' ? 'ledger' : 'group'}`)
        return
      }
      if (r.amount == null || r.amount <= 0) {
        errors.push(`Line ${i + 1}: enter an amount above zero`)
        return
      }
      lines.push({
        ledgerId: r.targetType === 'ledger' ? targetId : null,
        groupId: r.targetType === 'group' ? targetId : null,
        month: r.month,
        amount: r.amount
      })
    })
    setLineErrors(errors)
    if (errors.length > 0) return
    try {
      await api.budget.save({ name: selected.name, fyStartYear: selected.fyStartYear, lines }, selected.id)
      setEditorDirty(false)
      await queryClient.invalidateQueries({ queryKey: ['budgets'] })
      await queryClient.invalidateQueries({ queryKey: ['budgetVariance'] })
      toast.push('success', 'Budget saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const remove = async (b: Budget): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete budget',
      message: `Delete budget “${b.name}”?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.budget.remove(b.id)
      setSelectedId(null)
      await queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.push('success', 'Budget deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            New budget
          </Button>
        }
      >
        Budgets
      </SectionTitle>

      <Panel className="mb-6 p-4">
        {budgetsLoading ? (
          <SkeletonRows rows={2} />
        ) : budgets.length === 0 ? (
          <EmptyState title="No budgets yet" hint="Set targets by ledger or group and track actuals against them" />
        ) : (
          <div className="flex items-center gap-3">
            <Select
              className="max-w-xs"
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
            >
              {budgets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} · FY {fyFromStartYear(b.fyStartYear).label}
                </option>
              ))}
            </Select>
            {selected && (
              <button className="text-small text-cr hover:underline" onClick={() => void remove(selected)}>
                Delete budget
              </button>
            )}
          </div>
        )}
      </Panel>

      {selected && (
        <>
          <Panel className="mb-6">
            <ScrollList maxH="50vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th className="w-20">Target</th>
                  <th>Ledger / group</th>
                  <th className="w-36">Month</th>
                  <th className="r w-32">Amount</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <Select
                        value={r.targetType}
                        onChange={(e) =>
                          updateRow(r.key, { targetType: e.target.value as 'ledger' | 'group', ledgerId: null, groupId: null })
                        }
                      >
                        <option value="ledger">Ledger</option>
                        <option value="group">Group</option>
                      </Select>
                    </td>
                    <td>
                      {r.targetType === 'ledger' ? (
                        <LedgerPicker value={r.ledgerId} onPick={(id) => updateRow(r.key, { ledgerId: id })} />
                      ) : (
                        <Select
                          value={r.groupId ?? ''}
                          onChange={(e) => updateRow(r.key, { groupId: e.target.value ? Number(e.target.value) : null })}
                        >
                          <option value="">Choose a group…</option>
                          {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </td>
                    <td>
                      <Select value={r.month ?? ''} onChange={(e) => updateRow(r.key, { month: e.target.value || null })}>
                        <option value="">All year</option>
                        {months.map((m) => (
                          <option key={m} value={m}>
                            {monthLabel(m)}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <AmountInput paise={r.amount} onPaise={(paise) => updateRow(r.key, { amount: paise })} />
                    </td>
                    <td className="r">
                      <button className="text-small text-muted hover:text-cr" onClick={() => removeRow(r.key)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </ScrollList>
            {lineErrors.length > 0 && (
              <div data-testid="budgets-line-errors" className="border-t border-line bg-cr/10 px-3 py-2 text-body-sm text-cr">
                <p className="font-medium">Fix these lines before saving:</p>
                {lineErrors.map((e, i) => (
                  <p key={i}>{e}</p>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-line p-3">
              <button
                data-testid="btn-budgets-add-line"
                className="text-body-sm text-blue hover:underline"
                onClick={() => {
                  setEditorDirty(true)
                  setRows((prev) => [...prev, newRow()])
                }}
              >
                + Add line
              </button>
              <Button data-testid="btn-budgets-save" variant="primary" onClick={() => void save()}>
                Save budget
              </Button>
            </div>
          </Panel>

          <SectionTitle
            right={
              <Select className="max-w-[10rem]" value={upToMonth} onChange={(e) => setUpToMonth(e.target.value)}>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </Select>
            }
          >
            Variance · through {monthLabel(upToMonth)}
          </SectionTitle>
          <Panel>
            {varianceLoading ? (
              <SkeletonRows rows={4} />
            ) : !variance?.length ? (
              <EmptyState title="No budget lines to compare yet" hint="Add a line above and save the budget" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th className="w-24">Month</th>
                    <th className="r w-32">Budget</th>
                    <th className="r w-32">Actual</th>
                    <th className="r w-32">Variance</th>
                    <th className="r w-20">%</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.map((v, i) => (
                    <tr key={i}>
                      <td>{v.targetName}</td>
                      <td className="text-muted">{v.month ? monthLabel(v.month) : 'Year'}</td>
                      <td className="r"><Money paise={v.budget} /></td>
                      <td className="r"><Money paise={v.actual} /></td>
                      <td className="r">
                        {v.variance === 0 ? (
                          <span className="num text-muted">–</span>
                        ) : (
                          <span className={`num ${v.variance > 0 ? 'text-cr' : 'text-dr'}`}>
                            {v.variance > 0 ? '+' : '-'}
                            {formatPaise(Math.abs(v.variance))}
                            <span className="ml-1 text-muted">{v.variance > 0 ? 'over' : 'under'}</span>
                          </span>
                        )}
                      </td>
                      <td className="r text-muted">{v.pct == null ? '—' : `${v.pct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}

      {newOpen && (
        <NewBudgetModal
          onClose={() => setNewOpen(false)}
          onCreated={(b) => {
            setSelectedId(b.id)
            setNewOpen(false)
          }}
        />
      )}
    </div>
  )
}

function NewBudgetModal({ onClose, onCreated }: { onClose: () => void; onCreated: (b: Budget) => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const currentFy = fyOf(todayISO())
  const [name, setName] = useState('')
  const [fyStartYear, setFyStartYear] = useState(currentFy.startYear)

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    try {
      const created = await api.budget.save({ name: name.trim(), fyStartYear, lines: [] })
      await queryClient.invalidateQueries({ queryKey: ['budgets'] })
      toast.push('success', 'Budget created')
      onCreated(created)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title="New budget" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Operating Budget" />
        </Field>
        <Field label="Financial year">
          <Select
            data-testid="select-budgets-fy"
            value={fyStartYear}
            onChange={(e) => setFyStartYear(Number(e.target.value))}
          >
            {Array.from({ length: 7 }, (_, i) => currentFy.startYear + 1 - i).map((y) => (
              <option key={y} value={y}>
                FY {fyFromStartYear(y).label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()}>
            Create budget
          </Button>
        </div>
      </div>
    </Modal>
  )
}
