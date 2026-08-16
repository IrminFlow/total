import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type AuditRow } from '../../lib/client'
import { useSession } from '../../state/stores'
import { Button, DateInput, EmptyState, Panel, Select, SectionTitle } from '../../components/ui'
import { diffJson } from '@shared/diff'

const PAGE_SIZE = 100

// Distinct `entity` values ever written to audit_log (see writeAudit call sites across
// src/main/services/*.ts and ipc.ts).
const ENTITIES = [
  'voucher', 'ledger', 'group', 'voucherType', 'stockItem', 'stockGroup', 'unit', 'godown',
  'currency', 'bom', 'company', 'employee', 'payroll_run', 'voucher_line', 'user', 'nic_credentials'
]

export function AuditSection(): React.JSX.Element {
  const { from: sessionFrom, to: sessionTo } = useSession()
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState(sessionFrom)
  const [to, setTo] = useState(sessionTo)
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)

  const filters = { entity: entity || undefined, from, to, page }
  const { data } = useQuery({ queryKey: ['audit', filters], queryFn: () => api.audit.list(filters) })
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div>
      <SectionTitle>Audit trail</SectionTitle>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Entity</span>
          <Select
            value={entity}
            onChange={(e) => {
              setEntity(e.target.value)
              setPage(0)
            }}
          >
            <option value="">All</option>
            {ENTITIES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">From</span>
          <DateInput
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
            value={to}
            context={to}
            onChange={(v) => {
              setTo(v)
              setPage(0)
            }}
          />
        </div>
      </div>
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="No audit entries in this range" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-40">At</th>
                <th className="w-28">User</th>
                <th>Entity</th>
                <th className="w-20">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                    <td className="num text-muted">{new Date(r.at).toLocaleString()}</td>
                    <td>{r.userName ?? '—'}</td>
                    <td className="num">
                      {r.entity} #{r.entityId}
                    </td>
                    <td className="capitalize">{r.action}</td>
                  </tr>
                  {expanded === r.id && (
                    <tr>
                      <td colSpan={4} className="bg-panel2 px-3 py-2.5 text-[12px]">
                        <AuditDiff row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11.5px] text-muted">{total} entries</p>
        <div className="flex items-center gap-2">
          <Button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <span className="px-2 text-[12px] text-muted">
            Page {page + 1} of {pageCount}
          </span>
          <Button disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
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
