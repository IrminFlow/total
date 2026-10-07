// Fixed-asset reports (WP 3.6): the asset schedule (Schedule III note — gross block, depreciation,
// net block) with its reconciliation to the ledgers, and the income-tax depreciation statement
// by block of assets (a computation, never posted).
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyFromStartYear, fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { formatBp, type ItStatementBlockRow, type ScheduleAssetRow, type ScheduleGroupRow, type ScheduleReconRow } from '@shared/fixedAssets'
import { faApi } from '../../lib/fixedAssetsClient'
import { useSession, useToasts } from '../../state/stores'
import { AmountInput, Banner, Button, Field, Modal, Money, Panel, SectionTitle, Segmented, Select } from '../../components/ui'
import { DataTable, defineColumns, type TableColumn } from '../../components/table'
import { LedgerLink } from '../../components/links'
import { openLedgerStatement } from '../../lib/drill'
import { useRefreshFixedAssets } from './common'

type ScheduleRow = (ScheduleGroupRow | ScheduleAssetRow) & { key: string; label: string }

const money = (id: keyof ScheduleGroupRow, header: string, group: string, hidden = false): TableColumn<ScheduleRow> => ({
  id, header, group, kind: 'money', value: (r) => r[id as keyof ScheduleRow] as number, aggregate: 'sum', width: 112, defaultHidden: hidden
})

export const SCHEDULE_COLUMNS = defineColumns<ScheduleRow>([
  { id: 'label', header: 'Particulars', kind: 'text', value: (r) => r.label, hideable: false, groupable: false, minWidth: 150 },
  money('grossOpening', 'Opening', 'Gross block'),
  money('grossAdditions', 'Additions', 'Gross block'),
  money('grossDisposals', 'Disposals', 'Gross block'),
  money('grossClosing', 'Closing', 'Gross block'),
  money('accOpening', 'Opening', 'Depreciation'),
  money('accCharge', 'For the period', 'Depreciation'),
  money('accDisposals', 'On disposals', 'Depreciation'),
  money('accClosing', 'Closing', 'Depreciation'),
  money('netOpening', 'Opening', 'Net block', true),
  money('netClosing', 'Closing', 'Net block')
])

const ROLE_OPTIONS = [
  { value: 'asset', label: 'Asset (gross block)' },
  { value: 'accumulated_depreciation', label: 'Accumulated depreciation' }
]

export const RECON_COLUMNS = defineColumns<ScheduleReconRow>([
  {
    id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName, hideable: false, groupable: false, minWidth: 200,
    cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} />
  },
  { id: 'role', header: 'Holds', kind: 'enum', value: (r) => r.role, options: ROLE_OPTIONS, width: 200 },
  { id: 'register', header: 'Register', kind: 'money', value: (r) => r.register, width: 140 },
  { id: 'ledgerBal', header: 'Ledger balance', kind: 'money', value: (r) => r.ledger, width: 150 },
  {
    id: 'difference', header: 'Difference', kind: 'money', value: (r) => r.difference, width: 140,
    cell: (r) => (r.difference === 0 ? <span className="text-success">Agrees</span> : <Money paise={r.difference} className="text-danger font-medium" />)
  }
])

export function ScheduleTab(): React.JSX.Element {
  const { from, to } = useSession()
  const [by, setBy] = useState<'group' | 'asset'>('group')
  const { data, isLoading } = useQuery({ queryKey: ['faSchedule', from, to], queryFn: () => faApi.schedule(from, to) })
  const rows = useMemo<ScheduleRow[]>(() => {
    if (!data) return []
    return by === 'group'
      ? data.groups.map((g) => ({ ...g, key: `g${g.groupId}`, label: g.groupName }))
      : data.assets.map((a) => ({ ...a, key: `a${a.assetId}`, label: a.assetName }))
  }, [data, by])
  const label = `${toDisplayDate(from)} – ${toDisplayDate(to)}`
  const mismatches = (data?.reconciliation ?? []).filter((r) => r.difference !== 0)
  return (
    <div className="flex flex-col gap-section">
      <Panel>
        <DataTable
          viewId="fixed-assets-schedule"
          testId="fixed-assets-schedule"
          ariaLabel={`Fixed asset schedule, ${label}`}
          columns={SCHEDULE_COLUMNS}
          rows={rows}
          rowKey={(r) => r.key}
          loading={isLoading}
          maxHeight="50vh"
          totalsLabel="Total"
          toolbarStart={<Segmented size="sm" label="Rows" testId="btn-fixed-assets-schedule-by" value={by} onChange={setBy} options={[{ value: 'group', label: 'By group' }, { value: 'asset', label: 'By asset' }]} />}
          empty={{ title: 'No fixed assets in this period', hint: 'Add assets on the Register tab' }}
          exportOptions={{ title: 'Fixed asset schedule (Schedule III)', periodLabel: label, filename: 'fixed-asset-schedule' }}
        />
      </Panel>
      <div>
        <SectionTitle>Reconciliation to the ledgers on {toDisplayDate(to)}</SectionTitle>
        {mismatches.length > 0 && (
          <Banner tone="warning" className="mb-2" testId="fixed-assets-recon-mismatch">
            {mismatches.length} ledger{mismatches.length > 1 ? 's do' : ' does'} not agree with the register — a purchase not entered as an asset,
            an opening balance, or a manual journal to the ledger.
          </Banner>
        )}
        <Panel>
          <DataTable
            viewId="fixed-assets-recon"
            testId="fixed-assets-recon"
            ariaLabel="Register against ledger balances"
            columns={RECON_COLUMNS}
            rows={data?.reconciliation ?? []}
            rowKey={(r) => `${r.role}:${r.ledgerId}`}
            rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
            onRowActivate={(r) => openLedgerStatement(r.ledgerId)}
            maxHeight="36vh"
            empty={{ title: 'No ledgers to reconcile yet' }}
            exportOptions={{ title: 'Fixed assets — reconciliation to ledgers', periodLabel: `as on ${toDisplayDate(to)}`, filename: 'fixed-asset-reconciliation' }}
          />
        </Panel>
      </div>
    </div>
  )
}

const itMoney = (id: keyof ItStatementBlockRow, header: string, group?: string, hidden = false): TableColumn<ItStatementBlockRow> => ({
  id, header, group, kind: 'money', value: (r) => r[id] as number, aggregate: 'sum', width: 112, defaultHidden: hidden
})

export const IT_COLUMNS = defineColumns<ItStatementBlockRow>([
  { id: 'block', header: 'Block of assets', kind: 'text', value: (r) => r.blockName, hideable: false, groupable: false, minWidth: 200 },
  {
    id: 'rate', header: 'Rate', kind: 'number', value: (r) => r.rateBp, text: (r) => formatBp(r.rateBp), width: 84,
    cell: (r) => <span title={`${r.act ? `${r.act} Act — ` : ''}${r.sectionRef}\n${r.rateSource}`}>{formatBp(r.rateBp)}</span>
  },
  { id: 'act', header: 'Act', kind: 'text', value: (r) => (r.act ? `${r.act} Act` : '—'), width: 90, className: 'text-muted', defaultHidden: true },
  itMoney('openingWdv', 'Opening WDV'),
  itMoney('additionsFullRate', '≥ 180 days', 'Additions'),
  itMoney('additionsHalfRate', '< 180 days', 'Additions'),
  itMoney('saleProceeds', 'Sold for'),
  itMoney('wdvBeforeDepreciation', 'Before dep.', undefined, true),
  itMoney('depreciationFullRate', 'Full rate', 'Depreciation', true),
  itMoney('depreciationHalfRate', 'Half rate', 'Depreciation', true),
  itMoney('additionalDepreciation', 'Additional', 'Depreciation'),
  itMoney('totalDepreciation', 'Total', 'Depreciation'),
  itMoney('closingWdv', 'Closing WDV'),
  itMoney('shortTermCapitalGain', 'STCG', 'Capital gains', true),
  itMoney('shortTermCapitalLoss', 'STCL', 'Capital gains', true),
  itMoney('additionalCarriedForward', 'Additional c/f', undefined, true)
])

export function IncomeTaxTab(): React.JSX.Element {
  const { info, to } = useSession()
  const latest = fyOf(todayISO()).startYear
  const years: number[] = []
  for (let y = latest; y >= Math.min(info?.booksFrom ?? latest, latest) - 1; y--) years.push(y)
  const [fyStartYear, setFyStartYear] = useState(fyOf(to).startYear)
  const [opening, setOpening] = useState<ItStatementBlockRow | null>(null)
  const { data, isLoading } = useQuery({ queryKey: ['faIt', fyStartYear], queryFn: () => faApi.itStatement(fyStartYear) })
  const fy = fyFromStartYear(fyStartYear)
  const gains = (data?.blocks ?? []).filter((b) => b.shortTermCapitalGain > 0 || b.shortTermCapitalLoss > 0)
  return (
    <div className="flex flex-col gap-section">
      <Banner tone="info" title="Income-tax depreciation is a computation, not a posting">
        Blocks of assets under {fyStartYear >= 2026 ? 'the Income-tax Act, 2025 (s.33)' : 'the Income-tax Act, 1961 (s.32)'}: opening WDV +
        additions − sale proceeds, half the rate on additions put to use for less than 180 days. Rates are effective-dated and editable
        on the Setup tab.
      </Banner>
      {(data?.unassignedAssets.length ?? 0) > 0 && (
        <Banner tone="warning" testId="fixed-assets-it-unassigned">
          {data!.unassignedAssets.length} asset{data!.unassignedAssets.length > 1 ? 's have' : ' has'} no IT block and {data!.unassignedAssets.length > 1 ? 'are' : 'is'} left out:{' '}
          {data!.unassignedAssets.slice(0, 5).map((a) => a.name).join(', ')}
        </Banner>
      )}
      {gains.length > 0 && (
        <Banner tone="warning" testId="fixed-assets-it-gains" title="Short-term capital gain / loss (s.50 of the 1961 Act; s.74 of the 2025 Act)">
          {gains.map((b) => (
            <span key={b.blockId} className="mr-4 inline-block">
              {b.blockName}: {b.shortTermCapitalGain > 0 ? 'gain' : 'loss'} <Money paise={b.shortTermCapitalGain || b.shortTermCapitalLoss} />
            </span>
          ))}
        </Banner>
      )}
      <Panel>
        <DataTable
          viewId="fixed-assets-it"
          testId="fixed-assets-it"
          ariaLabel={`Income-tax depreciation by block, FY ${fy.label}`}
          columns={IT_COLUMNS}
          rows={data?.blocks ?? []}
          rowKey={(r) => r.blockId}
          rowAttrs={(r) => ({ 'data-row-id': r.blockId })}
          loading={isLoading}
          maxHeight="55vh"
          totalsLabel="Total"
          onRowActivate={(r) => setOpening(r)}
          toolbarStart={
            <Select value={fyStartYear} onChange={(e) => setFyStartYear(Number(e.target.value))} className="w-36" aria-label="Tax year" data-testid="input-fixed-assets-it-fy">
              {years.map((y) => (
                <option key={y} value={y}>FY {fyFromStartYear(y).label}</option>
              ))}
            </Select>
          }
          empty={{ title: `No block activity in FY ${fy.label}`, hint: 'Assign assets to IT blocks, or enter an opening WDV (Enter on a block)' }}
          exportOptions={{ title: 'Income-tax depreciation by block', periodLabel: `FY ${fy.label}`, filename: `it-depreciation-${fy.label}` }}
        />
      </Panel>
      <p className="text-hint text-muted">Enter on a block (or click it) sets its opening WDV for the year. Later years carry the computed closing WDV forward.</p>
      {opening && <OpeningModal row={opening} fyStartYear={fyStartYear} onClose={() => setOpening(null)} />}
    </div>
  )
}

function OpeningModal({ row, fyStartYear, onClose }: { row: ItStatementBlockRow; fyStartYear: number; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const refresh = useRefreshFixedAssets()
  const [wdv, setWdv] = useState<number | null>(row.openingWdv || null)
  const [addl, setAddl] = useState<number | null>(null)
  const save = async (): Promise<void> => {
    try {
      await faApi.blockOpeningSet({ blockId: row.blockId, fyStartYear, openingWdv: wdv ?? 0, additionalBroughtForward: addl ?? 0 })
      await refresh()
      onClose()
    } catch (e) {
      toast.push('error', (e as Error).message)
    }
  }
  const clear = async (): Promise<void> => {
    await faApi.blockOpeningClear(row.blockId, fyStartYear)
    await refresh()
    onClose()
  }
  return (
    <Modal title={`Opening WDV — ${row.blockName}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-body-sm text-muted">
          FY {fyFromStartYear(fyStartYear).label}. Currently {row.openingSource === 'entered' ? 'entered by hand' : row.openingSource === 'carried' ? 'carried from the previous year' : 'nil'}.
        </p>
        <Field label="Opening written down value"><AmountInput testId="input-fixed-assets-it-opening" paise={wdv} onPaise={setWdv} /></Field>
        <Field label="Additional depreciation brought forward" hint="The unclaimed half from last year"><AmountInput paise={addl} onPaise={setAddl} testId="input-fixed-assets-it-addl" /></Field>
        <div className="flex justify-end gap-2">
          {row.openingSource === 'entered' && <Button onClick={() => void clear()}>Use the carried figure</Button>}
          <Button variant="primary" data-testid="btn-fixed-assets-it-opening-save" onClick={() => void save()}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}
