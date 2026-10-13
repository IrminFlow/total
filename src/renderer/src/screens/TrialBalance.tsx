import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession } from '../state/stores'
import { Page, PageHeader, Panel } from '../components/ui'
import { OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { toDisplayDate } from '@shared/dates'
import type { TrialBalanceRow } from '@shared/reports'
import { LedgerLink } from '../components/links'

/** Old useReportConfig('trial-balance') toggle keys → column ids (one "movement" toggle drove two). */
const LEGACY_IDS = { movement: ['movementDr', 'movementCr'] }

export const TRIAL_BALANCE_COLUMNS = defineColumns<TrialBalanceRow>([
  {
    id: 'ledger',
    header: 'Ledger',
    kind: 'text',
    value: (r) => r.ledgerName,
    hideable: false,
    groupable: false,
    minWidth: 160,
    // Name → edit window; the rest of the row → statement (synthetic rows stay plain text).
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} />
  },
  { id: 'group', header: 'Group', kind: 'text', value: (r) => r.groupName, className: 'text-muted', width: 200 },
  // Signed dr-positive opening; the sum is the net opening (Dr − Cr), shown Dr/Cr like the rows.
  { id: 'opening', header: 'Opening', kind: 'money', signed: true, value: (r) => r.opening, aggregate: 'sum', defaultHidden: true, width: 160 },
  { id: 'movementDr', header: 'Movement Dr', kind: 'money', value: (r) => r.movementDebit, aggregate: 'sum', defaultHidden: true, width: 150 },
  { id: 'movementCr', header: 'Movement Cr', kind: 'money', value: (r) => r.movementCredit, aggregate: 'sum', defaultHidden: true, width: 150 },
  { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit, aggregate: 'sum', width: 160 },
  { id: 'credit', header: 'Credit', kind: 'money', value: (r) => r.credit, aggregate: 'sum', width: 160 }
])

/** Synthetic rows (e.g. the computed "Profit & Loss A/c (opening)") carry ledgerId <= 0 — no statement to open. */
const isLedgerRow = (r: TrialBalanceRow): boolean => r.ledgerId > 0

/** `asOn` / `ledgerIds` (WP 8.6): opened from the simple Home's Cash and bank tile — the balances
 *  of those accounts as on that date (the tile's figures); without them, the usual screen. */
export function TrialBalanceScreen({ asOn, ledgerIds }: { asOn?: string; ledgerIds?: number[] } = {}): React.JSX.Element {
  const { to: periodTo } = useSession()
  const to = asOn ?? periodTo
  const only = ledgerIds ? new Set(ledgerIds) : null
  const nav = useNav()
  const { data, isLoading } = useQuery({ queryKey: ['trialBalance', to], queryFn: () => api.reports.trialBalance(to) })
  const opts = useScreenOptions('trial-balance', { hideZeroClosing: false })
  // The service already drops ledgers with no balance and no movement; this also hides ledgers
  // that moved in the period but closed at zero. Totals are unaffected (those rows add 0).
  const rows = (data?.rows ?? []).filter((r) => (!only || only.has(r.ledgerId)) && (!opts.options.hideZeroClosing || r.debit !== 0 || r.credit !== 0))
  const matched = only != null || !data || data.totalDebit === data.totalCredit
  const periodLabel = `as on ${toDisplayDate(to)}`

  return (
    <Page>
      <PageHeader
        title={only ? 'Trial balance · cash and bank' : 'Trial balance'}
        period={periodLabel}
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod asOn />
              <OptionToggle
                label="Hide ledgers that closed at zero"
                hint="Ledgers with entries in the period but no closing balance."
                checked={opts.options.hideZeroClosing}
                onChange={(v) => opts.set('hideZeroClosing', v)}
                testId="input-trial-balance-hide-zero"
              />
              <div className="mt-5">
                <OptionsTable area="trial-balance" />
              </div>
            </>
          )
        }}
      />
      <Panel>
        <DataTable
          viewId="trial-balance"
          legacyReportKey="trial-balance"
          legacyIdMap={LEGACY_IDS}
          testId="trial-balance"
          ariaLabel="Trial balance"
          columns={TRIAL_BALANCE_COLUMNS}
          rows={rows}
          rowKey={(r) => r.ledgerId}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
          loading={isLoading}
          empty={{ title: 'No balances yet', hint: 'Enter a voucher or set opening balances' }}
          isRowActivatable={isLedgerRow}
          onRowActivate={(r) => nav.go({ name: 'ledger-statement', ledgerId: r.ledgerId })}
          totalsLabel={matched ? 'Total' : 'Total — debits and credits differ; check opening balances'}
          exportOptions={{ title: 'Trial balance', periodLabel, filename: 'trial-balance' }}
        />
      </Panel>
    </Page>
  )
}
