import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type AuditRow } from '../../lib/client'
import { useSession } from '../../state/stores'
import { Button, DateInput, Panel, Select, SectionTitle } from '../../components/ui'
import { DataTable, defineColumns, type RowKey } from '../../components/table'
import { diffJson } from '@shared/diff'
import { toDisplayDate, toDisplayDateTime } from '@shared/dates'
import { AUDIT_ENTITIES } from '@shared/auditEntities'

const PAGE_SIZES = [25, 50, 100, 250]

const ACTIONS: AuditRow['action'][] = ['create', 'update', 'delete', 'login', 'login_failed', 'logout', 'export', 'import']
const actionLabel = (a: string): string => (a.charAt(0).toUpperCase() + a.slice(1)).replace(/_/g, ' ')

/** Server-paged: the table sorts and filters within the current page. */
const AUDIT_COLUMNS = defineColumns<AuditRow>([
  {
    id: 'at',
    header: 'At',
    kind: 'date',
    value: (r) => r.at.slice(0, 10),
    text: (r) => toDisplayDateTime(new Date(r.at)),
    className: 'num text-muted',
    width: 170
  },
  { id: 'user', header: 'User', kind: 'text', value: (r) => r.userName, text: (r) => r.userName ?? '—', width: 140 },
  {
    id: 'entity',
    header: 'Entity',
    kind: 'text',
    value: (r) => `${r.entity} #${r.entityId}`,
    groupKey: (r) => r.entity,
    className: 'num',
    hideable: false
  },
  { id: 'action', header: 'Action', kind: 'enum', value: (r) => r.action, options: ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })), width: 120 }
])

export function AuditSection(): React.JSX.Element {
  const { from: sessionFrom, to: sessionTo } = useSession()
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState(sessionFrom)
  const [to, setTo] = useState(sessionTo)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [expanded, setExpanded] = useState<ReadonlySet<RowKey>>(() => new Set())
  const toggle = (id: number): void =>
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const filters = { entity: entity || undefined, from, to, page, pageSize }
  const { data, isLoading } = useQuery({ queryKey: ['audit', filters], queryFn: () => api.audit.list(filters) })
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div>
      <SectionTitle>Audit trail</SectionTitle>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Entity</span>
          <Select
            data-testid="input-audit-entity"
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value)
              setPage(0)
            }}
          >
            <option value="">All</option>
            {AUDIT_ENTITIES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">From</span>
          <DateInput
            testId="input-audit-from"
            value={from}
            context={from}
            onChange={(v) => {
              setFrom(v)
              setPage(0)
            }}
          />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">To</span>
          <DateInput
            testId="input-audit-to"
            value={to}
            context={to}
            onChange={(v) => {
              setTo(v)
              setPage(0)
            }}
          />
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Per page</span>
          <Select
            data-testid="input-audit-page-size"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(0)
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Panel>
        <DataTable
          viewId="settings-audit"
          testId="settings-audit"
          ariaLabel="Audit trail"
          columns={AUDIT_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id })}
          loading={isLoading}
          maxHeight="60vh"
          expanded={expanded}
          onExpandedChange={setExpanded}
          renderDetail={(r) => (
            <div className="bg-panel2 px-3 py-2.5 text-[12px]">
              <AuditDiff row={r} />
            </div>
          )}
          onRowActivate={(r) => toggle(r.id)}
          empty={{ title: 'No audit entries in this range' }}
          exportOptions={{
            title: 'Audit trail',
            periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}${entity ? ` · ${entity}` : ''} · page ${page + 1} of ${pageCount}`,
            filename: 'audit-trail'
          }}
        />
      </Panel>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11.5px] text-muted">{total} entries</p>
        <div className="flex items-center gap-2">
          <Button data-testid="btn-settings-audit-prev" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <span className="px-2 text-[12px] text-muted">
            Page {page + 1} of {pageCount}
          </span>
          <Button data-testid="btn-settings-audit-next" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}

function AuditDiff({ row }: { row: AuditRow }): React.JSX.Element {
  if (row.beforeJson === null && row.afterJson === null) {
    return <p className="text-muted">No details recorded</p>
  }
  if (row.beforeJson === null) return <p className="text-dr">created</p>
  if (row.afterJson === null) return <p className="text-cr">deleted</p>

  const diffs = diffJson(row.beforeJson, row.afterJson)
  if (diffs.length === 0) return <p className="text-muted">No field changes</p>
  return (
    <div className="flex flex-col gap-0.5 font-mono">
      {diffs.map((d) => (
        <p key={d.key}>
          <span className="text-muted">{d.key}:</span> {d.from || '—'} → {d.to || '—'}
        </p>
      ))}
    </div>
  )
}
