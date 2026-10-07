import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type AuditRow, type ChainVerification } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Badge, Button, DrawerSection, Page, PageHeader, Panel, Select, TextInput } from '../components/ui'
import { OptionsExport, OptionsPeriod } from '../components/ScreenOptions'
import { DataTable, defineColumns, type RowKey } from '../components/table'
import { VoucherLink } from '../components/links'
import { diffJsonDeep } from '@shared/diff'
import { toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'
import {
  AUDIT_ACTIONS, AUDIT_ENTITIES, VOUCHER_ENTITIES, auditActionLabel, auditEntityLabel, auditUserLabel, type AuditEntity
} from '@shared/auditEntities'
import { auditTimestampText, rowStatuses, type AuditRowStatus } from '@shared/auditChain'
import { ChainBanner, useAuditVerification } from './audit/ChainBanner'

const PAGE_SIZES = [50, 100, 250, 500]

const STATUS: Record<AuditRowStatus, { label: string; tone: 'success' | 'danger' | 'warning' }> = {
  verified: { label: 'Verified', tone: 'success' },
  altered: { label: 'Altered', tone: 'danger' },
  link_broken: { label: 'Chain broken', tone: 'danger' },
  unsealed: { label: 'No hash', tone: 'warning' }
}

export interface EditLogRow extends AuditRow {
  status: AuditRowStatus
  changes: number
}

export function withStatus(rows: readonly AuditRow[], v: ChainVerification | undefined): EditLogRow[] {
  const statuses = v ? rowStatuses(v) : new Map<number, AuditRowStatus>()
  return rows.map((r) => ({
    ...r,
    status: statuses.get(r.id) ?? (r.rowHash ? 'verified' : 'unsealed'),
    changes: diffJsonDeep(r.beforeJson, r.afterJson).length
  }))
}

const userText = auditUserLabel

export const EDIT_LOG_COLUMNS = defineColumns<EditLogRow>([
  { id: 'id', header: '#', kind: 'number', value: (r) => r.id, width: 70, className: 'num text-muted' },
  {
    id: 'at',
    header: 'Date / time',
    kind: 'text',
    value: (r) => r.atIso ?? r.at,
    text: (r) => auditTimestampText(r.at, r.atIso),
    cell: (r) => (
      <span className="num" title={r.clockSkewNote ?? undefined}>
        {auditTimestampText(r.at, r.atIso)}
        {r.clockSkewNote && <span className="ml-1 text-warning" aria-label="clock went backwards">⚠</span>}
      </span>
    ),
    width: 236
  },
  { id: 'user', header: 'User', kind: 'text', value: (r) => r.userName ?? '', text: (r) => userText(r.userName), width: 130 },
  {
    id: 'entity',
    header: 'Entity',
    kind: 'enum',
    value: (r) => r.entity,
    options: AUDIT_ENTITIES.map((e) => ({ value: e, label: auditEntityLabel(e) })),
    groupKey: (r) => r.entity,
    width: 150
  },
  {
    id: 'ref',
    header: 'Id / number',
    kind: 'text',
    value: (r) => (r.ref ? `${r.entityId} ${r.ref}` : String(r.entityId)),
    cell: (r) => {
      if (!r.ref && r.entityId === 0) return <span className="text-muted">—</span>
      const label = r.ref ? `${r.ref}` : `#${r.entityId}`
      const isVoucher = VOUCHER_ENTITIES.includes(r.entity as AuditEntity) && r.entityId > 0 && r.action !== 'purge'
      return (
        <span className="num">
          {isVoucher ? <VoucherLink voucherId={r.entityId} label={label} /> : label}
          {r.ref && <span className="ml-1 text-muted">#{r.entityId}</span>}
        </span>
      )
    },
    width: 150
  },
  {
    id: 'action',
    header: 'Action',
    kind: 'enum',
    value: (r) => r.action,
    options: AUDIT_ACTIONS.map((a) => ({ value: a, label: auditActionLabel(a) })),
    width: 110
  },
  {
    id: 'changes',
    header: 'Changes',
    kind: 'number',
    value: (r) => r.changes,
    text: (r) => (r.changes === 0 ? '—' : `${r.changes} field${r.changes === 1 ? '' : 's'}`),
    className: 'text-muted',
    width: 100
  },
  { id: 'version', header: 'App version', kind: 'text', value: (r) => r.appVersion ?? '', width: 100, defaultHidden: true },
  {
    id: 'hash',
    header: 'Hash',
    kind: 'enum',
    value: (r) => r.status,
    options: (Object.keys(STATUS) as AuditRowStatus[]).map((s) => ({ value: s, label: STATUS[s].label })),
    cell: (r) => (
      <Badge tone={STATUS[r.status].tone} testId={`audit-hash-${r.id}`} title={r.rowHash ?? undefined}>
        {STATUS[r.status].label}
      </Badge>
    ),
    width: 120
  }
])

/** Money is stored as integer paise; show the rupee reading next to a paise-valued field. */
const MONEY_KEY = /(amount|paise|openingBalance|total)$/i
export function fieldValue(key: string, v: string): string {
  if (!v) return '—'
  const leaf = key.replace(/\[\d+\]/g, '').split('.').pop() ?? key
  return MONEY_KEY.test(leaf) && /^-?\d+$/.test(v) ? `${v} (₹${formatPaise(Number(v))})` : v
}

export function AuditRowDetail({ row }: { row: EditLogRow }): React.JSX.Element {
  const diffs = diffJsonDeep(row.beforeJson, row.afterJson)
  return (
    <div className="bg-panel2 px-4 py-3 text-small" data-testid={`audit-detail-${row.id}`}>
      {row.beforeJson === null && row.afterJson === null ? (
        <p className="text-muted">No details recorded</p>
      ) : diffs.length === 0 ? (
        <p className="text-muted">No field changes</p>
      ) : (
        <table className="w-full max-w-4xl text-left">
          <thead>
            <tr className="text-caption tracking-[0.08em] text-muted uppercase">
              <th className="py-1 pr-4 font-semibold">Field</th>
              <th className="py-1 pr-4 font-semibold">Before</th>
              <th className="py-1 font-semibold">After</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {diffs.slice(0, 200).map((d) => (
              <tr key={d.key} className="align-top">
                <td className="py-0.5 pr-4 text-muted">{d.key}</td>
                <td className="py-0.5 pr-4 break-all text-cr">{fieldValue(d.key, d.from)}</td>
                <td className="py-0.5 break-all text-dr">{fieldValue(d.key, d.to)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {diffs.length > 200 && <p className="mt-1 text-muted">… {diffs.length - 200} more fields (see the CSV export)</p>}
      <p className="mt-2 text-hint text-muted">
        Recorded {auditTimestampText(row.at, row.atIso)} by {userText(row.userName)}
        {row.userId !== null && ` (user #${row.userId})`} · Total {row.appVersion || '—'} · row hash{' '}
        <span className="num">{row.rowHash ?? 'none'}</span>
      </p>
      {row.clockSkewNote && <p className="mt-1 text-hint text-warning">{row.clockSkewNote}</p>}
    </div>
  )
}

/**
 * Audit trail (edit log) — WP 3.8. Every change the app records, newest first, per working
 * period; filters by entity, action, user and voucher; the chain verification on top; CSV/PDF
 * exports generated in main with the header an auditor needs for rule 11(g). Read-only: there is
 * no way to edit or delete an entry from here.
 */
export function EditLogScreen({ voucherId: initialVoucherId }: { voucherId?: number }): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const [entity, setEntity] = useState('')
  const [action, setAction] = useState('')
  const [user, setUser] = useState('')
  const [voucherText, setVoucherText] = useState(initialVoucherId ? String(initialVoucherId) : '')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [expanded, setExpanded] = useState<ReadonlySet<RowKey>>(() => new Set())
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null)

  const voucherId = /^\d+$/.test(voucherText.trim()) ? Number(voucherText.trim()) : undefined
  const filters = {
    entity: entity || undefined,
    action: action || undefined,
    user: user || undefined,
    voucherId,
    from,
    to
  }
  const { data, isLoading } = useQuery({
    queryKey: ['audit', 'editLog', filters, page, pageSize],
    queryFn: () => api.audit.list({ ...filters, page, pageSize }),
    // Keep the previous page (and its user list) on screen while a new filter loads.
    placeholderData: (prev) => prev
  })
  const verification = useAuditVerification()
  const rows = useMemo(() => withStatus(data?.rows ?? [], verification.data), [data, verification.data])
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  const reset = (fn: () => void) => (): void => {
    fn()
    setPage(0)
  }
  const toggle = (id: number): void =>
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const doExport = async (kind: 'csv' | 'pdf'): Promise<void> => {
    setExporting(kind)
    try {
      const r = kind === 'csv' ? await api.audit.exportCsv(filters) : await api.audit.exportPdf(filters)
      toast.push(r.verification.ok ? 'success' : 'error', `${r.rows} entries saved to exports — ${r.path}${r.verification.ok ? '' : ' (chain BROKEN — see the header)'}`)
      verification.refetch()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setExporting(null)
    }
  }

  const label = (text: string): React.JSX.Element => (
    <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">{text}</span>
  )

  return (
    <Page width="wide">
      <PageHeader
        title="Audit trail (edit log)"
        period={periodLabel}
        secondary={
          <>
            <Button variant="ghost" data-testid="edit-log-csv" onClick={() => void doExport('csv')} disabled={exporting !== null || total === 0}>
              {exporting === 'csv' ? 'Exporting…' : 'CSV'}
            </Button>
            <Button variant="ghost" data-testid="edit-log-pdf" onClick={() => void doExport('pdf')} disabled={exporting !== null || total === 0}>
              {exporting === 'pdf' ? 'Exporting…' : 'PDF'}
            </Button>
          </>
        }
        options={{
          content: (
            <>
              <OptionsPeriod note="Entries are filtered by the date they were recorded (local time)." />
              <OptionsExport>
                <Button size="sm" onClick={() => void doExport('pdf')} disabled={exporting !== null || total === 0}>
                  Export PDF
                </Button>
                <Button size="sm" onClick={() => void doExport('csv')} disabled={exporting !== null || total === 0}>
                  Export CSV
                </Button>
              </OptionsExport>
              <DrawerSection title="Retention and settings">
                <p className="text-hint text-muted">
                  The trail cannot be switched off. Retention and the “audit trail required” flag are in Settings → Audit trail
                  (owner only).
                </p>
                <Button size="sm" data-testid="btn-edit-log-settings" onClick={() => nav.go({ name: 'settings', tab: 'audit' })}>
                  Audit settings
                </Button>
              </DrawerSection>
              <DrawerSection title="About the edit log">
                <p className="text-hint text-muted">
                  Every create, change and delete — vouchers, masters, settings, users, imports, backups — with the full before and
                  after, who did it, when (local time with offset) and the app version, as required by the Companies (Accounts)
                  Rules 2014, rule 3(1). Exports carry the company, period, generation time and the chain check, for the auditor’s
                  rule 11(g) report.
                </p>
                <p className="text-hint text-muted">
                  Each entry is sealed with a SHA-256 hash that includes the previous entry’s hash. Changing or deleting an entry in
                  the company file outside Total breaks the chain from that row; this detects tampering, it cannot prevent it.
                  Restoring a backup restores that backup’s chain.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      <div className="mb-3">
        <ChainBanner verification={verification.data} busy={verification.isFetching} onVerify={verification.refetch} />
      </div>
      <div className="mb-3 flex flex-wrap items-end gap-3" data-testid="edit-log-filters">
        <div>
          {label('Entity')}
          <Select data-testid="input-edit-log-entity" value={entity} onChange={(e) => reset(() => setEntity(e.target.value))()}>
            <option value="">All</option>
            {AUDIT_ENTITIES.map((e) => (
              <option key={e} value={e}>
                {auditEntityLabel(e)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          {label('Action')}
          <Select data-testid="input-edit-log-action" value={action} onChange={(e) => reset(() => setAction(e.target.value))()}>
            <option value="">All</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          {label('User')}
          <Select data-testid="input-edit-log-user" value={user} onChange={(e) => reset(() => setUser(e.target.value))()}>
            <option value="">All</option>
            {(data?.users ?? []).map((u) => (
              <option key={u} value={u}>
                {userText(u)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          {label('Voucher id')}
          <TextInput
            data-testid="input-edit-log-voucher"
            className="w-28"
            inputMode="numeric"
            placeholder="any"
            value={voucherText}
            onChange={(e) => reset(() => setVoucherText(e.target.value))()}
          />
        </div>
        <div>
          {label('Per page')}
          <Select data-testid="input-edit-log-page-size" value={pageSize} onChange={(e) => reset(() => setPageSize(Number(e.target.value)))()}>
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
          viewId="edit-log"
          testId="edit-log"
          ariaLabel="Audit trail (edit log)"
          columns={EDIT_LOG_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id, 'data-entity': r.entity, 'data-action': r.action })}
          loading={isLoading}
          maxHeight="62vh"
          totals={false}
          expanded={expanded}
          onExpandedChange={setExpanded}
          renderDetail={(r) => <AuditRowDetail row={r} />}
          onRowActivate={(r) => toggle(r.id)}
          empty={{ title: 'No audit entries match', hint: 'Widen the period or clear the filters' }}
        />
      </Panel>
      <div className="mt-3 flex items-center justify-between">
        <p className="text-hint text-muted" data-testid="edit-log-total">
          {total} entries · sorting and the quick filter work within this page; the exports cover every matching entry
        </p>
        <div className="flex items-center gap-2">
          <Button data-testid="btn-edit-log-prev" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <span className="px-2 text-small text-muted">
            Page {page + 1} of {pageCount}
          </span>
          <Button data-testid="btn-edit-log-next" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </Page>
  )
}
