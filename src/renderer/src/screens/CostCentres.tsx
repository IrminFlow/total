import { Fragment, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CostCentre } from '@shared/domain'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  Button,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  RowAction,
  RowLink,
  SectionTitle,
  Select,
  Skeleton,
  SkeletonRows,
  TextInput,
  useTableNav
} from '../components/ui'
import { toDisplayDate } from '@shared/dates'
import { confirmDialog } from '../lib/dialogs'

export function CostCentresScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: centres, isLoading: centresLoading } = useQuery({ queryKey: ['costCentres'], queryFn: api.cc.list })
  const { data: report, isLoading: reportLoading } = useQuery({ queryKey: ['ccReport', from, to], queryFn: () => api.cc.report(from, to) })
  const [editing, setEditing] = useState<CostCentre | 'new' | null>(null)
  const [drillId, setDrillId] = useState<number | null>(null)

  const centreMap = new Map((centres ?? []).map((c) => [c.id, c]))

  // The P&L-by-centre rows drill down on click; ↑↓ selects one, Enter and Space (A17) open and
  // close it. The "Not allocated" line (id -1) is a reconciling total with nothing underneath,
  // so it selects like any other row but folds into nothing.
  const reportRows = report ?? []
  const toggleDrill = (r: { costCentreId: number }): void => {
    if (r.costCentreId === -1) return
    setDrillId((cur) => (cur === r.costCentreId ? null : r.costCentreId))
  }
  const reportTable = useTableNav(reportRows, {
    rowId: (r) => r.costCentreId,
    onEnter: toggleDrill,
    onToggle: toggleDrill
  })

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

  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[1440px]">
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
        {centresLoading ? (
          <SkeletonRows rows={4} />
        ) : !centres?.length ? (
          <EmptyState title="No cost centres yet" hint="Track income and expense by project, department or branch" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Parent</th>
                <th scope="col" className="w-20">Active</th>
                <th scope="col" className="w-32"></th>
              </tr>
            </thead>
            <tbody>
              {centres.map((c) => (
                <tr key={c.id} className="hover:bg-panel2">
                  <td>{c.name}</td>
                  <td className="text-muted">{c.parentId ? (centreMap.get(c.parentId)?.name ?? '') : ''}</td>
                  <td className="text-muted">{c.active ? 'Yes' : 'No'}</td>
                  <td className="r">
                    <RowAction onClick={() => setEditing(c)}>
                      Edit
                    </RowAction>
                    <button className="text-small text-cr hover:underline" onClick={() => void remove(c)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <SectionTitle>
        P&amp;L by centre · {toDisplayDate(from)} → {toDisplayDate(to)}
      </SectionTitle>
      <Panel>
        {reportLoading ? (
          <SkeletonRows rows={4} />
        ) : !report?.length ? (
          <EmptyState title="No cost-centre postings in this period" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Cost centre</th>
                <th scope="col" className="r w-36">Income</th>
                <th scope="col" className="r w-36">Expense</th>
                <th scope="col" className="r w-36">Net</th>
                <th scope="col" className="r w-24">Margin</th>
              </tr>
            </thead>
            <tbody>
              {reportRows.map((r, i) => (
                <Fragment key={r.costCentreId}>
                  {/* The "Not allocated" line (id -1) is a reconciling row, not a cost centre:
                      it has nothing to drill into, and without it the sections would quietly sum
                      to less than the company's own P&L. */}
                  <tr
                    {...reportTable.rowProps(i, r)}
                    className={`${reportTable.rowProps(i, r).className} ${r.costCentreId === -1 ? 'total-row' : ''}`}
                    aria-expanded={r.costCentreId === -1 ? undefined : drillId === r.costCentreId}
                    data-testid={r.costCentreId === -1 ? 'cc-unallocated' : undefined}
                  >
                    <td>
                      {r.costCentreId !== -1 && (
                        <span className="mr-1.5 inline-block w-3 text-label text-muted">{drillId === r.costCentreId ? '▾' : '▸'}</span>
                      )}
                      {r.name}
                    </td>
                    <td className="r"><Money paise={r.income} /></td>
                    <td className="r"><Money paise={r.expense} /></td>
                    <td className="r font-medium"><Money paise={r.net} signed /></td>
                    {/* An em dash, not 0%: a centre carrying only expense has no margin to state. */}
                    <td className="r num text-muted">{r.marginPct === null ? '–' : `${r.marginPct}%`}</td>
                  </tr>
                  {drillId === r.costCentreId && (
                    <DrillRows
                      ccId={r.costCentreId}
                      from={from}
                      to={to}
                      onOpenVoucher={(voucherId) => nav.go({ name: 'voucher-entry', voucherId })}
                    />
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {editing && (
        <CostCentreFormModal cc={editing === 'new' ? null : editing} centres={centres ?? []} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

function DrillRows({
  ccId,
  from,
  to,
  onOpenVoucher
}: {
  ccId: number
  from: string
  to: string
  onOpenVoucher: (voucherId: number) => void
}): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ['ccStatement', ccId, from, to], queryFn: () => api.cc.statement(ccId, from, to) })
  const rows = data ?? []
  if (isLoading) {
    // Loading is not "no postings" — show placeholder rows until the statement arrives.
    return (
      <>
        {[0, 1].map((i) => (
          <tr key={i} className="bg-panel2/50">
            <td colSpan={5} className="pl-9">
              <Skeleton className={`h-3 ${i === 0 ? 'w-56' : 'w-40'}`} />
            </td>
          </tr>
        ))}
      </>
    )
  }
  if (!rows.length) {
    return (
      <tr className="bg-panel2/50">
        <td colSpan={5} className="pl-9 text-muted">
          No postings in this period
        </td>
      </tr>
    )
  }
  return (
    <>
      {rows.map((r, i) => (
        <tr key={i} className="bg-panel2/50">
          <td className="pl-9 text-muted">
            <RowLink onClick={() => onOpenVoucher(r.voucherId)}>
              {r.number}
            </RowLink>
            <span className="ml-3 text-hint">
              <span className="num">{toDisplayDate(r.date)}</span> · {r.ledgerName}
            </span>
          </td>
          <td colSpan={2}></td>
          <td className="r">
            <Money paise={r.drCr === 'dr' ? r.amount : -r.amount} signed />
          </td>
          <td />
        </tr>
      ))}
    </>
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
        <label className="flex items-center gap-2 text-detail text-ink">
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
