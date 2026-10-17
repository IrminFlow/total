import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import type { CloseRepairYear } from '@shared/yearEnd'
import { api } from '../lib/client'
import { confirmDialog } from '../lib/dialogs'
import { canWriteOrNoUsers, isOwnerOrNoUsers } from '../lib/roles'
import { useNav, useSession, useToasts } from '../state/stores'
import { Banner, Button, Money, Panel } from '../components/ui'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink } from '../components/links'

/**
 * Guided re-close (the 0.4.0 → 0.5.0 upgrade note). "Check earlier closes" compares every closed
 * year's closing entry with the one today's rule posts (`yearEnd:repairPreview`, writes nothing)
 * and lists what each year left behind in the trial balance's "Profit & Loss A/c (opening)" row.
 * "Repair" (owner, or anyone in a company without users) re-closes the differing years oldest
 * first through `yearEnd:repair` — the old entries go to the bin, the corrected ones are posted on
 * the same 31 March and the lock date is put back where it was.
 */

const YEAR_COLUMNS = defineColumns<CloseRepairYear>([
  { id: 'fy', header: 'Financial year', kind: 'text', value: (r) => `FY ${r.label}`, hideable: false, groupable: false, width: 140 },
  { id: 'entry', header: 'Closing entry', kind: 'text', value: (r) => `${r.voucherNumber} · ${toDisplayDate(r.date)}`, width: 200 },
  // Dr-positive like the "(opening)" row it explains: a loss reads Dr, a profit Cr.
  { id: 'profit', header: 'Year’s profit (Cr) / loss (Dr)', kind: 'money', signed: true, value: (r) => -r.netProfit, width: 200 },
  // Dr-positive: what the year left in income / expense accounts (a credit = profit not carried).
  { id: 'residual', header: 'Left in the opening row', kind: 'money', signed: true, value: (r) => r.residual, width: 190 },
  {
    id: 'status',
    header: 'Status',
    kind: 'text',
    value: (r) => (!r.needsRepair ? 'Matches' : r.blocked ? 'Can’t repair here' : 'Needs repair'),
    width: 160
  }
])

interface LineRow { key: string; ledgerId: number | null; name: string; debit: number | null; credit: number | null }

const LINE_COLUMNS = defineColumns<LineRow>([
  {
    id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.name, hideable: false, groupable: false,
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.name} />
  },
  { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit, width: 140, aggregate: 'sum' },
  { id: 'credit', header: 'Credit', kind: 'money', value: (r) => r.credit, width: 140, aggregate: 'sum' }
])

export function YearEndRecheck(): React.JSX.Element | null {
  const { user } = useSession()
  const [open, setOpen] = useState(false)
  if (!canWriteOrNoUsers(user)) return null
  return (
    <Panel className="mt-section p-4" testId="year-end-recheck">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-body font-medium">Check earlier closes</p>
          <p className="text-body-sm text-muted">
            Years closed with Total 0.4.0 may have left part of a year&apos;s profit in the trial balance as “Profit &amp; Loss A/c (opening)”.
            This compares every closed year with how Total closes a year today. Nothing changes unless you repair.
          </p>
        </div>
        {!open && (
          <Button data-testid="btn-year-end-recheck" onClick={() => setOpen(true)}>
            Check earlier closes
          </Button>
        )}
      </div>
      {open && <RecheckBody />}
    </Panel>
  )
}

function RecheckBody(): React.JSX.Element {
  const { user } = useSession()
  const toast = useToasts()
  const nav = useNav()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data, isLoading, error } = useQuery({ queryKey: ['yearEndRepairPreview'], queryFn: () => api.yearEnd.repairPreview() })
  const years = data?.years ?? []
  // What one Repair runs: the years that differ, oldest first, up to the first that can't be
  // repaired here (the service walks them in the same order and stops there too).
  const differing = years.filter((y) => y.needsRepair)
  const firstBlocked = differing.findIndex((y) => y.blocked)
  const todo = firstBlocked === -1 ? differing : differing.slice(0, firstBlocked)
  const blocked = differing.filter((y) => y.blocked)
  const canRepair = isOwnerOrNoUsers(user)

  const lineRows = useMemo(
    () =>
      new Map(
        todo.map((y) => [
          y.fyStartYear,
          y.corrected.map<LineRow>((l, i) => ({
            key: `${l.ledgerId ?? 'new'}-${i}`, ledgerId: l.ledgerId, name: l.name,
            debit: l.drCr === 'dr' ? l.amount : null, credit: l.drCr === 'cr' ? l.amount : null
          }))
        ])
      ),
    [todo]
  )

  const repair = async (): Promise<void> => {
    if (!data || todo.length === 0 || busy) return
    const labels = todo.map((y) => `FY ${y.label}`).join(', ')
    const lock = data.lockDate
    const proceed = await confirmDialog({
      title: 'Repair earlier closes',
      message:
        `Total will move the closing entr${todo.length === 1 ? 'y' : 'ies'} of ${labels} to the Bin and post corrected ones on the same day, oldest year first. ` +
        `Retained Earnings and the “Profit & Loss A/c (opening)” row change; each year’s own profit and this year’s figures do not. ` +
        (lock ? `The books stay locked up to ${toDisplayDate(lock)}. ` : '') +
        'Every step is in the audit log.',
      confirmLabel: 'Repair',
      danger: true
    })
    if (!proceed) return
    setBusy(true)
    try {
      const r = await api.yearEnd.repair(data.fingerprint)
      toast.push('success', r.repaired.length === 0 ? 'Nothing to repair' : `Repaired ${r.repaired.map((x) => `FY ${years.find((y) => y.fyStartYear === x.fyStartYear)?.label ?? x.fyStartYear}`).join(', ')}`)
      await queryClient.invalidateQueries()
    } catch (err) {
      toast.push('error', (err as Error).message)
      await queryClient.invalidateQueries({ queryKey: ['yearEndRepairPreview'] })
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="mt-3 text-body-sm text-cr">{(error as Error).message}</p>
  return (
    <div className="mt-3" data-testid="year-end-recheck-body" data-loading={isLoading ? 'true' : 'false'}>
      <DataTable
        viewId="year-end-recheck"
        testId="year-end-recheck-years"
        ariaLabel="Closed years compared with today’s rule"
        columns={YEAR_COLUMNS}
        rows={years}
        rowKey={(r) => r.fyStartYear}
        rowAttrs={(r) => ({ 'data-row-id': r.fyStartYear, 'data-state': r.needsRepair ? (r.blocked ? 'blocked' : 'repair') : 'ok' })}
        loading={isLoading}
        onRowActivate={(r) => nav.go({ name: 'voucher-entry', voucherId: r.voucherId })}
        empty={{ title: 'No year has been closed yet', hint: 'Nothing to check' }}
      />
      {!isLoading && years.length > 0 && todo.length === 0 && blocked.length === 0 && (
        <p className="mt-3 text-body-sm text-muted" data-testid="year-end-recheck-ok">
          Every closed year matches. Nothing to repair.
        </p>
      )}
      {blocked.map((y) => (
        <Banner key={y.fyStartYear} tone="warning" className="mt-3" title={`FY ${y.label} can’t be repaired here`}>
          {y.blocked}
        </Banner>
      ))}
      {todo.map((y) => (
        <div key={y.fyStartYear} className="mt-4" data-testid={`year-end-recheck-fy-${y.fyStartYear}`}>
          <p className="mb-2 text-body-sm">
            {y.residual === 0 ? (
              <>FY {y.label}: the closing entry moved different accounts than Total moves today.</>
            ) : (
              <>
                FY {y.label}: <Money paise={Math.abs(y.residual)} /> of the year&apos;s {y.residual < 0 ? 'profit' : 'loss'} was not carried to{' '}
                {y.diffs.find((d) => d.transfer)?.name ?? 'Retained Earnings'}.
              </>
            )}{' '}
            The corrected closing entry, dated {toDisplayDate(y.date)}:
          </p>
          <DataTable
            viewId="year-end-recheck-lines"
            testId={`year-end-recheck-lines-${y.fyStartYear}`}
            ariaLabel={`Corrected closing entry for FY ${y.label}`}
            columns={LINE_COLUMNS}
            rows={lineRows.get(y.fyStartYear) ?? []}
            rowKey={(r) => r.key}
            maxHeight="40vh"
          />
        </div>
      ))}
      {todo.length > 0 && (
        <div className="mt-4 flex items-center justify-end gap-3">
          {!canRepair && <span className="text-body-sm text-muted">Only the owner can repair a closed year.</span>}
          <Button variant="primary" data-testid="btn-year-end-repair" disabled={!canRepair || busy} onClick={() => void repair()}>
            {busy ? 'Repairing…' : `Repair ${todo.length === 1 ? `FY ${todo[0]!.label}` : `${todo.length} years`}`}
          </Button>
        </div>
      )}
    </div>
  )
}
