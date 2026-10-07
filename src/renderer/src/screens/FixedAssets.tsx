// Fixed assets (WP 3.6): the register, depreciation runs, the asset schedule, the income-tax
// statement by block, and the groups / Schedule II / IT-rate setup — one screen, five tabs.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatLife, type FixedAssetRow } from '@shared/fixedAssets'
import { faApi } from '../lib/fixedAssetsClient'
import { useSession, type Screen } from '../state/stores'
import { Badge, Button, DrawerSection, Page, PageHeader, Panel, TabBar } from '../components/ui'
import { OptionsPeriod } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink, VoucherLink } from '../components/links'
import { AssetFormModal, blankDraft, draftFromAsset, draftFromCandidate, PurchasePickerModal, type AssetDraft } from './fixedAssets/AssetForm'
import { DisposalWizard } from './fixedAssets/DisposalWizard'
import { DepreciationTab } from './fixedAssets/DepreciationTab'
import { IncomeTaxTab, ScheduleTab } from './fixedAssets/ReportTabs'
import { SetupTab } from './fixedAssets/SetupTab'
import type { FixedAssetsTab } from './fixedAssets/common'

const TABS: { id: FixedAssetsTab; label: string }[] = [
  { id: 'register', label: 'Register' },
  { id: 'depreciation', label: 'Depreciation run' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'income-tax', label: 'Income-tax' },
  { id: 'setup', label: 'Groups & blocks' }
]

const STATUS_OPTIONS = [
  { value: 'active', label: 'In use' },
  { value: 'disposed', label: 'Disposed' }
]

export const REGISTER_COLUMNS = defineColumns<FixedAssetRow>([
  { id: 'name', header: 'Asset', kind: 'text', value: (a) => a.name, hideable: false, groupable: false, minWidth: 160 },
  { id: 'group', header: 'Group', kind: 'text', value: (a) => a.groupName, width: 130 },
  { id: 'identifier', header: 'Identifier', kind: 'text', value: (a) => a.identifier ?? '', width: 120, className: 'num text-muted', defaultHidden: true },
  { id: 'location', header: 'Location', kind: 'text', value: (a) => a.location ?? '', width: 130, defaultHidden: true },
  { id: 'ledger', header: 'Ledger', kind: 'text', value: (a) => a.ledgerName, width: 140, cell: (a) => <LedgerLink ledgerId={a.ledgerId} name={a.ledgerName} /> },
  {
    id: 'purchase', header: 'Purchase', kind: 'date', value: (a) => a.purchaseDate, width: 112,
    cell: (a) => (a.purchaseVoucherId ? <VoucherLink voucherId={a.purchaseVoucherBinned ? null : a.purchaseVoucherId} label={toDisplayDate(a.purchaseDate)} /> : <span className="text-muted">{toDisplayDate(a.purchaseDate)}</span>)
  },
  { id: 'putToUse', header: 'In use from', kind: 'date', value: (a) => a.putToUseDate, width: 110, className: 'text-muted', defaultHidden: true },
  { id: 'method', header: 'Method', kind: 'enum', value: (a) => a.method, options: [{ value: 'slm', label: 'SLM' }, { value: 'wdv', label: 'WDV' }], width: 80 },
  { id: 'life', header: 'Life', kind: 'number', value: (a) => a.lifeMonths, text: (a) => formatLife(a.lifeMonths), width: 110, defaultHidden: true },
  { id: 'cost', header: 'Gross block', kind: 'money', value: (a) => a.grossPaise, aggregate: 'sum', width: 120 },
  { id: 'acc', header: 'Depreciation', kind: 'money', value: (a) => a.accumulatedPaise, aggregate: 'sum', width: 120 },
  { id: 'net', header: 'Net block', kind: 'money', value: (a) => a.carryingPaise, aggregate: 'sum', width: 120 },
  { id: 'through', header: 'Depreciated to', kind: 'date', value: (a) => a.depreciatedThrough, width: 120, className: 'text-muted', defaultHidden: true },
  {
    id: 'status', header: 'Status', kind: 'enum', value: (a) => a.status, options: STATUS_OPTIONS, width: 96,
    cell: (a) =>
      a.status === 'disposed' ? (
        <span title={a.disposalDate ? `Disposed ${toDisplayDate(a.disposalDate)}` : undefined}>
          <VoucherLink voucherId={a.disposalVoucherId} label={<Badge tone="neutral">Disposed</Badge>} />
        </span>
      ) : (
        <Badge tone="success">In use</Badge>
      )
  }
])

export function FixedAssetsScreen({ tab: initialTab }: { tab?: FixedAssetsTab }): React.JSX.Element {
  const [tab, setTab] = useState<FixedAssetsTab>(initialTab ?? 'register')
  const { from, to } = useSession()
  return (
    <Page width="wide">
      <PageHeader
        title="Fixed assets"
        period={`${toDisplayDate(from)} – ${toDisplayDate(to)}`}
        tabs={<TabBar screen="fixed-assets" label="Fixed assets" tabs={TABS} active={tab} onSelect={setTab} />}
        options={{
          content: (
            <>
              <OptionsPeriod />
              <DrawerSection title="About depreciation">
                <p className="text-hint text-muted">
                  Book depreciation follows Schedule II of the Companies Act, 2013 (SLM or WDV, pro rata by days, residual value) and
                  is posted as one journal per run. Income-tax depreciation is computed by block of assets and never posted.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      {tab === 'register' && <RegisterTab />}
      {tab === 'depreciation' && <DepreciationTab />}
      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'income-tax' && <IncomeTaxTab />}
      {tab === 'setup' && <SetupTab />}
    </Page>
  )
}

function RegisterTab(): React.JSX.Element {
  const { to, workingDate } = useSession()
  const { data: assets = [], isLoading } = useQuery({ queryKey: ['faList', to], queryFn: () => faApi.list(to) })
  const { data: groups = [] } = useQuery({ queryKey: ['faGroups'], queryFn: faApi.groups })
  const [form, setForm] = useState<{ asset: FixedAssetRow | null; draft: AssetDraft } | null>(null)
  const [picking, setPicking] = useState(false)
  const [disposing, setDisposing] = useState<FixedAssetRow | null>(null)
  return (
    <>
      <Panel>
        <DataTable
          viewId="fixed-assets-register"
          testId="fixed-assets-register"
          ariaLabel={`Fixed asset register as on ${toDisplayDate(to)}`}
          columns={REGISTER_COLUMNS}
          rows={assets}
          rowKey={(a) => a.id}
          rowAttrs={(a) => ({ 'data-row-id': a.id, 'data-status': a.status })}
          loading={isLoading}
          maxHeight="calc(100vh - 260px)"
          onRowActivate={(a) => setForm({ asset: a, draft: draftFromAsset(a) })}
          trailingWidth={76}
          trailing={(a) =>
            a.status === 'active' ? (
              <button type="button" data-testid={`btn-fixed-assets-dispose-${a.id}`} className="text-small text-blue hover:underline" onClick={() => setDisposing(a)}>
                Dispose…
              </button>
            ) : null
          }
          toolbarStart={
            <>
              <Button size="sm" variant="primary" data-testid="btn-fixed-assets-new" onClick={() => setForm({ asset: null, draft: blankDraft(workingDate) })}>
                New asset
              </Button>
              <Button size="sm" data-testid="btn-fixed-assets-from-purchase" onClick={() => setPicking(true)}>
                From a purchase…
              </Button>
            </>
          }
          empty={{
            title: 'No fixed assets yet',
            hint: 'Create one from a purchase voucher that debits a Fixed Assets ledger, or add it by hand'
          }}
          exportOptions={{ title: 'Fixed asset register', periodLabel: `as on ${toDisplayDate(to)}`, filename: 'fixed-asset-register' }}
        />
      </Panel>
      {picking && (
        <PurchasePickerModal
          onClose={() => setPicking(false)}
          onPick={(c, line) => {
            setPicking(false)
            setForm({ asset: null, draft: draftFromCandidate(c, line, groups) })
          }}
        />
      )}
      {form && (
        <AssetFormModal
          asset={form.asset ? assets.find((a) => a.id === form.asset!.id) ?? form.asset : null}
          initial={form.draft}
          onClose={() => setForm(null)}
        />
      )}
      {disposing && <DisposalWizard asset={disposing} onClose={() => setDisposing(null)} />}
    </>
  )
}

/** Deep link helper for other screens (e.g. a purchase voucher → "make it an asset"). */
export const fixedAssetsScreen = (tab?: FixedAssetsTab): Screen => ({ name: 'fixed-assets', tab })
