import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CostCentre } from '@shared/domain'
import { api, type CcReportRow } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, Field, Modal, Money, Panel, SectionTitle, Select, Skeleton, TextInput } from '../components/ui'
import { DataTable, defineColumns, type RowKey } from '../components/table'
import { toDisplayDate } from '@shared/dates'
import { confirmDialog } from '../lib/dialogs'
import { LedgerLink, VoucherLink } from '../components/links'

/** A centre plus its resolved parent name (the master list shows the name, sorts/groups by it). */
interface CentreRow extends CostCentre {
  parentName: string
}

const ACTIVE_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' }
]

const CENTRE_COLUMNS = defineColumns<CentreRow>([
  { id: 'name', header: 'Name', kind: 'text', value: (r) => r.name, hideable: false, groupable: false, minWidth: 160 },
  { id: 'parent', header: 'Parent', kind: 'text', value: (r) => r.parentName, className: 'text-muted' },
  { id: 'active', header: 'Active', kind: 'enum', value: (r) => (r.active ? 'yes' : 'no'), options: ACTIVE_OPTIONS, width: 112, className: 'text-muted' }
])

// Income / expense / net are per-centre period figures, so their totals are meaningful. Net keeps
// today's signed (Dr/Cr) presentation.
export const CC_REPORT_COLUMNS = defineColumns<CcReportRow>([
  { id: 'name', header: 'Cost centre', kind: 'text', value: (r) => r.name, hideable: false, groupable: false, minWidth: 160 },
  { id: 'income', header: 'Income', kind: 'money', value: (r) => r.income, aggregate: 'sum', width: 150 },
  { id: 'expense', header: 'Expense', kind: 'money', value: (r) => r.expense, aggregate: 'sum', width: 150 },
  { id: 'net', header: 'Net', kind: 'money', value: (r) => r.net, signed: true, aggregate: 'sum', width: 160, className: 'font-medium' }
])

export function CostCentresScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: centres, isLoading: centresLoading } = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list })
  const { data: report, isLoading: reportLoading } = useQuery({ queryKey: ['ccReport', from, to], queryFn: () => api.cc.report(from, to) })
  const [editing, setEditing] = useState<CostCentre | 'new' | null>(null)
  // One centre at a time drills into its postings (row click, the chevron, or → / ←).
  const [drill, setDrill] = useState<ReadonlySet<RowKey>>(() => new Set())
  const onDrillChange = useCallback((next: Set<RowKey>) => {
    setDrill((cur) => {
      const added = [...next].filter((k) => !cur.has(k))
      return added.length ? new Set([added[added.length - 1]!]) : next
    })
  }, [])
  const toggleDrill = useCallback((r: CcReportRow) => {
    setDrill((cur) => (cur.has(r.costCentreId) ? new Set() : new Set([r.costCentreId])))
  }, [])

  const centreRows = useMemo<CentreRow[]>(() => {
    const byId = new Map((centres ?? []).map((c) => [c.id, c]))
    return (centres ?? []).map((c) => ({ ...c, parentName: c.parentId ? (byId.get(c.parentId)?.name ?? '') : '' }))
  }, [centres])

  const remove = async (cc: CostCentre): Promise<void> => {
    const proceed = await confirmDialog({
      title: 'Delete cost centre',
      message: `Delete cost centre “${cc.name}”?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!proceed) return
    try {
      await api.cc.remove(cc.id)
      await queryClient.invalidateQueries()
      toast.push('success', 'Cost centre deleted')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const periodLabel = `${toDisplayDate(from)} to ${toDisplayDate(to)}`

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <Button variant="primary" onClick={() => setEditing('new')}>
            New cost centre
          </Button>
        }
      >
        Cost centres
      </SectionTitle>

      <Panel className="mb-6">
        <DataTable
          viewId="cost-centres"
          testId="cost-centres"
          ariaLabel="Cost centres"
          columns={CENTRE_COLUMNS}
          rows={centreRows}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id })}
          loading={centresLoading}
          empty={{ title: 'No cost centres yet', hint: 'Track income and expense by project, department or branch' }}
          maxHeight="40vh"
          trailingWidth={128}
          trailing={(c) => (
            <>
              <button className="mr-3 text-[12px] text-blue hover:underline" onClick={() => setEditing(c)}>
                Edit
              </button>
              <button className="text-[12px] text-cr hover:underline" onClick={() => void remove(c)}>
                Delete
              </button>
            </>
          )}
          exportOptions={{ title: 'Cost centres', periodLabel: '', filename: 'cost-centres' }}
        />
      </Panel>

      <SectionTitle>
        P&amp;L by centre · {toDisplayDate(from)} → {toDisplayDate(to)}
      </SectionTitle>
      <Panel>
        <DataTable
          viewId="cost-centre-pl"
          testId="cost-centre-pl"
          ariaLabel="P&L by cost centre"
          columns={CC_REPORT_COLUMNS}
          rows={report ?? []}
          rowKey={(r) => r.costCentreId}
          rowAttrs={(r) => ({ 'data-row-id': r.costCentreId })}
          loading={reportLoading}
          empty={{ title: 'No cost-centre postings in this period' }}
          onRowActivate={toggleDrill}
          expanded={drill}
          onExpandedChange={onDrillChange}
          renderDetail={(r) => <DrillList ccId={r.costCentreId} from={from} to={to} />}
          detailHeightEstimate={72}
          toolbarFeatures={{ groupBy: false }}
          exportOptions={{ title: 'P&L by cost centre', periodLabel, filename: 'cost-centre-pl' }}
        />
      </Panel>

      {editing && (
        <CostCentreFormModal cc={editing === 'new' ? null : editing} centres={centres ?? []} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

/** Every allocation posted to one centre in the period — the drill-down under its row. */
function DrillList({ ccId, from, to }: { ccId: number; from: string; to: string }): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ['ccStatement', ccId, from, to], queryFn: () => api.cc.statement(ccId, from, to) })
  const rows = data ?? []
  if (isLoading) {
    // Loading is not "no postings" — show placeholder lines until the statement arrives.
    return (
      <div className="flex flex-col gap-2 py-1" data-testid="cc-drill-loading">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-3 w-40" />
      </div>
    )
  }
  if (!rows.length) return <p className="py-1 text-[12.5px] text-muted">No postings in this period</p>
  return (
    <table className="w-full text-[12.5px]" data-testid="cc-drill">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="w-28 py-0.5 pr-3">
              <VoucherLink voucherId={r.voucherId} label={r.number} className="num text-muted hover:text-blue" />
            </td>
            <td className="num w-24 py-0.5 pr-3 text-muted">{toDisplayDate(r.date)}</td>
            <td className="py-0.5 pr-3 text-muted">
              <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} />
            </td>
            <td className="w-40 py-0.5 text-right">
              <Money paise={r.drCr === 'dr' ? r.amount : -r.amount} signed />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CostCentreFormModal({
  cc,
  centres,
  onClose
}: {
  cc: CostCentre | null
  centres: CostCentre[]
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [name, setName] = useState(cc?.name ?? '')
  const [parentId, setParentId] = useState<number | ''>(cc?.parentId ?? '')
  const [active, setActive] = useState(cc?.active ?? true)

  const save = async (): Promise<void> => {
    try {
      await api.cc.save({ name: name.trim(), parentId: parentId === '' ? null : parentId, active }, cc?.id)
      await queryClient.invalidateQueries()
      toast.push('success', `Cost centre ${cc ? 'updated' : 'created'}`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={cc ? `Edit ${cc.name}` : 'New cost centre'} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Parent">
          <Select value={parentId} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">None (top level)</option>
            {centres
              .filter((c) => c.id !== cc?.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save cost centre
          </Button>
        </div>
      </div>
    </Modal>
  )
}
