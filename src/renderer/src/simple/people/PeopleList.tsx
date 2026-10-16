import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import type { MessageKey } from '@shared/i18n'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { isPartyLedger } from '@shared/chartOfAccounts'
import { matchesFilter, PEOPLE_FILTERS, type PeopleFilter, type PersonRow } from '@shared/simple/people'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { Button, Page, Segmented, TabBar } from '../../components/ui'
import { useAccountantView } from '../../lib/handoff'
import { AccountantViewButton } from '../AccountantViewButton'
import { EmptyTeach } from '../help/EmptyTeach'
import { DataTable, defineColumns } from '../../components/table'
import { useGroups } from '../../components/pickers'
import { NewAccountDialog } from '../NewAccountDialog'
import { BillsToPay } from './BillsToPay'
import { Pill } from './Pill'

type Tab = 'people' | 'bills'
const SCREEN = 'simple-people' // i18n-technical: registry name (tab testids)
const FILTER_TEXT: Record<PeopleFilter, MessageKey> = {
  all: 'simple.people.filter.all',
  customers: 'simple.people.filter.customers',
  suppliers: 'simple.people.filter.suppliers',
  owesYou: 'simple.people.filter.owesYou',
  youOwe: 'simple.people.filter.youOwe',
  late: 'simple.people.filter.late'
}
const KIND_TEXT: Record<PersonRow['side'], MessageKey> = { customer: 'simple.people.kind.customer', supplier: 'simple.people.kind.supplier' }
const personScreen = (id: number): { name: 'simple-person'; id: number } => ({ name: 'simple-person', id }) // i18n-technical
const SALES = 'sales' as const // i18n-technical
const PURCHASE = 'purchase' as const // i18n-technical
const PARTY = 'party' as const // i18n-technical

/**
 * WP 9.8 — People (plan §2): every customer and supplier with their phone, what they owe you /
 * you owe them as on today (the Outstandings allocation, simple:people:list), what is late, what
 * was paid ahead and their days to pay. Filters (everyone / customers / suppliers / owe you /
 * you owe / late to pay) and the table's search; "+ New person" is the plain new-account dialog
 * on Customer (Supplier while suppliers are shown). A row opens the person's page. The second
 * tab is "Bills to pay" (BillsToPay.tsx).
 */
export function PeopleList({ tab = 'people', filter: startFilter = 'all' }: { tab?: Tab; filter?: PeopleFilter }): React.JSX.Element { // i18n-technical: defaults
  const t = useT()
  const nav = useNav()
  const workingDate = useSession((s) => s.workingDate)
  const openFull = useAccountantView({ name: 'simple-people', tab }) // i18n-technical: screen name
  const tabs: { id: Tab; label: string }[] = [
    { id: 'people', label: t('simple.people.tab.people') }, // i18n-technical: tab id
    { id: 'bills', label: t('simple.people.billsToPay') } // i18n-technical: tab id
  ]
  return (
    <Page data-testid="simple-people" data-tab={tab}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.people.title')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.people.asOn', { date: toPlainDate(workingDate, t.lang) })}</p>
        </div>
        {/* WP 9.10: the party masters — or, on Bills to pay, the payables Outstandings. */}
        <AccountantViewButton testId="btn-people-accountant-view" title={t('simple.shell.accountantViewHint')} onOpen={(always) => void openFull({ intent: null, always })} />
      </div>
      <TabBar
        screen={SCREEN}
        label={t('simple.people.title')}
        className="mb-4"
        tabs={tabs}
        active={tab}
        onSelect={(id) => nav.replace({ name: 'simple-people', tab: id })} // i18n-technical
      />
      {tab === 'bills' ? <BillsToPay /> : <People startFilter={startFilter} />}
    </Page>
  )
}

function People({ startFilter }: { startFilter: PeopleFilter }): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const nav = useNav()
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const canEdit = useSession((s) => s.user == null || s.user.role !== 'viewer') // i18n-technical
  const [filter, setFilter] = useState<PeopleFilter>(startFilter)
  const [creating, setCreating] = useState(false)
  const groups = useGroups()
  const { data, isLoading } = useQuery({ queryKey: ['simplePeople', workingDate], queryFn: () => api.simplePeople.list(workingDate) }) // i18n-technical
  const money = (p: number): string => formatPaise(p, { symbol: true })
  const rows = useMemo(() => (data?.people ?? []).filter((p) => matchesFilter(p, filter)), [data, filter])
  const name = (r: PersonRow): string => (r.walkIn ? t('simple.sales.cashCustomer') : r.name)

  const columns = useMemo(
    () =>
      defineColumns<PersonRow>([
        { id: 'name', header: t('simple.people.col.name'), kind: 'text', hideable: false, groupable: false, value: name }, // i18n-technical
        {
          id: 'kind', header: t('simple.people.col.kind'), kind: 'text', width: 110, // i18n-technical
          value: (r) => lbl(KIND_TEXT[r.side])
        },
        { id: 'phone', header: t('simple.people.phone'), kind: 'text', width: 140, groupable: false, value: (r) => r.phone ?? r.whatsapp ?? '' }, // i18n-technical
        { id: 'owesYou', header: t('simple.people.col.owesYou'), kind: 'money', value: (r) => (r.side === 'customer' ? r.open : 0), aggregate: 'sum', explainable: false }, // i18n-technical
        { id: 'youOwe', header: t('simple.people.col.youOwe'), kind: 'money', value: (r) => (r.side === 'supplier' ? r.open : 0), aggregate: 'sum', explainable: false }, // i18n-technical
        {
          id: 'status', header: t('simple.people.col.status'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (r) => [r.late > 0 ? t('simple.people.chip.late', { amount: money(r.late) }) : '', r.ahead > 0 ? t('simple.people.chip.ahead', { amount: money(r.ahead) }) : '', r.onHold ? t('simple.people.chip.hold') : ''].filter(Boolean).join(', '),
          cell: (r) => (
            <span>
              {r.late > 0 && (
                <Pill tone="danger" testId="person-chip-late" data={String(r.late)}>
                  {t('simple.people.chip.late', { amount: money(r.late) })} · {t('simple.people.days', { days: r.maxLateDays })}
                </Pill>
              )}
              {r.ahead > 0 && (
                <Pill tone="success" testId="person-chip-ahead" data={String(r.ahead)}>
                  {t('simple.people.chip.ahead', { amount: money(r.ahead) })}
                </Pill>
              )}
              {r.onHold && (
                <Pill tone="amber" testId="person-chip-hold">
                  {t('simple.people.chip.hold')}
                </Pill>
              )}
              {r.open === 0 && r.ahead === 0 && <span className="text-small text-muted">{t('simple.people.settled')}</span>}
            </span>
          )
        },
        {
          id: 'creditDays', header: t('simple.people.col.creditDays'), kind: 'text', width: 110, groupable: false, // i18n-technical
          value: (r) => (r.creditDays != null ? t('simple.people.days', { days: r.creditDays }) : '')
        }
      ]),
    [t] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const totals = data?.totals
  const empty = !isLoading && data != null && data.people.length === 0
  return (
    <>
      {empty && (
        <EmptyTeach
          testId="simple-people-empty"
          purpose={t('simple.empty.people')}
          action={canEdit ? { label: t('simple.people.new'), testId: 'btn-people-empty-new', onClick: () => setCreating(true) } : undefined} // i18n-technical
          help="people-and-reminders" // i18n-technical
        />
      )}
      {!empty && totals && (
        <p className="mb-3 text-body text-ink" data-testid="people-totals" data-owes-you={totals.owesYou} data-you-owe={totals.youOwe}>
          {t('simple.people.totals.owesYou', { amount: money(totals.owesYou) })} · {t('simple.people.totals.youOwe', { amount: money(totals.youOwe) })}
        </p>
      )}
      {!empty && <section className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="simple-people"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.ledgerId}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId, 'data-side': r.side, 'data-open': r.open, 'data-ahead': r.ahead, 'data-late': r.late })}
          loading={isLoading}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          toolbarStart={
            <Segmented
              label={t('simple.people.filterLabel')}
              size="sm"
              testId="people-filter"
              options={PEOPLE_FILTERS.map((f) => ({ value: f, label: lbl(FILTER_TEXT[f]) }))}
              value={filter}
              onChange={setFilter}
            />
          }
          toolbarEnd={
            canEdit ? (
              <Button variant="primary" size="sm" data-testid="btn-people-new" onClick={() => setCreating(true)}>
                {t('simple.people.new')}
              </Button>
            ) : null
          }
          empty={{ title: t('simple.people.emptyFilter') }}
          totalsLabel={t('simple.sales.col.total')}
          onRowActivate={(r) => nav.go(personScreen(r.ledgerId))}
        />
      </section>}
      {creating && (
        <NewAccountDialog
          name=""
          context={{ field: PARTY, side: filter === 'suppliers' || filter === 'youOwe' ? PURCHASE : SALES }}
          onClose={() => setCreating(false)}
          onCreated={(l: Ledger) => {
            setCreating(false)
            void queryClient.invalidateQueries({ queryKey: ['simplePeople'] }) // i18n-technical
            // The dialog can also make another kind of account ("Other…"): only a person opens.
            if (isPartyLedger(l, groups)) nav.go(personScreen(l.id))
          }}
        />
      )}
    </>
  )
}
