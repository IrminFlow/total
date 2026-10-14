import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { MessageKey } from '@shared/i18n'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import type { MoneyChip, MoneyDirection, MoneyRow } from '@shared/simple/money'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { Button, Page } from '../../components/ui'
import { EmptyTeach } from '../help/EmptyTeach'
import { DataTable, defineColumns } from '../../components/table'

const DIR_TEXT: Record<MoneyDirection, MessageKey> = { in: 'simple.money.dir.in', out: 'simple.money.dir.out', move: 'simple.money.dir.move' }
const DIR_CLS: Record<MoneyDirection, string> = {
  in: 'border-success/50 bg-success-soft text-ink',
  out: 'border-amber/60 bg-amberbar/10 text-ink',
  move: 'border-line bg-panel2 text-ink'
}
const CHIP_TEXT: Record<MoneyChip, MessageKey> = {
  bills: 'simple.money.chip.bills',
  advance: 'simple.money.chip.advance',
  onAccount: 'simple.money.chip.onAccount',
  owner: 'simple.money.chip.owner',
  loan: 'simple.money.chip.loan',
  expense: 'simple.money.chip.expense',
  income: 'simple.money.chip.income',
  refund: 'simple.money.chip.refund'
}
const IN = { name: 'simple-money-in' } as const // i18n-technical
const OUT = { name: 'simple-money-out' } as const // i18n-technical
const MOVE = { name: 'simple-move-money' } as const // i18n-technical
const CHIP_CLS = 'border-line bg-panel2 text-ink' // i18n-technical: class names
const editScreen = (voucherId: number): { name: 'voucher-entry'; voucherId: number } => ({ name: 'voucher-entry', voucherId }) // i18n-technical

function Pill({ text, cls, testId, data }: { text: string; cls: string; testId: string; data?: string }): React.JSX.Element {
  return (
    <span className={`mr-1 inline-block rounded-full border px-2 py-0.5 text-caption ${cls}`} data-testid={testId} data-value={data}>
      {text}
    </span>
  )
}

/**
 * WP 9.4 — Money → Money in and out: every receipt, payment and move between your accounts in
 * the working period (in the books, newest first) — date, who, in / out, cash or which bank, the
 * amount and what it was (paid bills, an advance, the owner, a loan …). A row opens its simple
 * view, with "Edit in the full app".
 */
export function MoneyList({ entryId }: { entryId?: number }): React.JSX.Element {
  if (entryId != null) return <EntryView entryId={entryId} />
  return <MoneyTable />
}

function MoneyTable(): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const nav = useNav()
  const { from, to, workingDate } = useSession()
  const until = workingDate < to ? workingDate : to
  const { data, isLoading } = useQuery({ queryKey: ['simpleMoneyList', from, until], queryFn: () => api.simpleMoney.list(from, until) }) // i18n-technical
  const rows = data ?? []
  const empty = !isLoading && data != null && rows.length === 0
  const columns = useMemo(
    () =>
      defineColumns<MoneyRow>([
        { id: 'date', header: t('simple.money.col.date'), kind: 'date', value: (r) => r.date, text: (r) => toPlainDate(r.date), width: 130, groupable: false }, // i18n-technical
        // A move says where it went from and to; anything else, who paid / was paid.
        { id: 'who', header: t('simple.money.col.who'), kind: 'text', hideable: false, groupable: false, value: (r) => (r.direction === 'move' ? `${r.account} → ${r.who}` : r.who) }, // i18n-technical
        {
          id: 'direction', header: t('simple.money.col.direction'), kind: 'text', width: 110, // i18n-technical
          value: (r) => lbl(DIR_TEXT[r.direction]),
          cell: (r) => <Pill text={lbl(DIR_TEXT[r.direction])} cls={DIR_CLS[r.direction]} testId="money-row-direction" data={r.direction} />
        },
        { id: 'how', header: t('simple.money.col.how'), kind: 'text', value: (r) => r.account }, // i18n-technical
        { id: 'amount', header: t('simple.money.col.amount'), kind: 'money', value: (r) => r.amount, explainable: false }, // i18n-technical
        {
          id: 'what', header: t('simple.money.col.what'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (r) => r.chips.map((c) => lbl(CHIP_TEXT[c])).join(', '),
          cell: (r) => (
            <span>
              {r.chips.map((c) => (
                <Pill key={c} text={lbl(CHIP_TEXT[c])} cls={CHIP_CLS} testId="money-row-chip" data={c} />
              ))}
            </span>
          )
        }
      ]),
    [t] // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <Page data-testid="simple-money">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.money.list.title')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.money.list.period', { from: toPlainDate(from), to: toPlainDate(until) })}</p>
        </div>
        {!empty && <div className="flex flex-wrap gap-2">
          <Button variant="primary" data-testid="btn-money-list-in" onClick={() => nav.go(IN)}>
            {t('simple.money.list.in')}
          </Button>
          <Button data-testid="btn-money-list-out" onClick={() => nav.go(OUT)}>
            {t('simple.money.list.out')}
          </Button>
          <Button data-testid="btn-money-list-move" onClick={() => nav.go(MOVE)}>
            {t('simple.money.list.move')}
          </Button>
        </div>}
      </div>
      {empty ? (
        <EmptyTeach
          testId="simple-money-empty"
          purpose={t('simple.empty.money')}
          action={{ label: t('simple.money.list.in'), testId: 'btn-money-empty-in', onClick: () => nav.go(IN) }} // i18n-technical
          help="money-in-out" // i18n-technical
        />
      ) : (
      <section className="rounded-lg border border-line bg-panel shadow-elev-1">
        <DataTable
          testId="simple-money"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.voucherId}
          rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
          loading={isLoading}
          toolbarFeatures={{ quickFilter: true, columns: false, groupBy: false, density: false, views: false }}
          empty={{ title: t('simple.money.list.empty') }}
          onRowActivate={(r) => nav.go({ name: 'simple-money', entryId: r.voucherId })} // i18n-technical
        />
      </section>
      )}
    </Page>
  )
}

function EntryView({ entryId }: { entryId: number }): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const nav = useNav()
  const { data: e, isLoading } = useQuery({ queryKey: ['simpleMoneyEntry', entryId], queryFn: () => api.simpleMoney.entry(entryId) }) // i18n-technical
  const money = (p: number): string => formatPaise(p, { symbol: true })
  const back = (
    <button type="button" className="mb-3 text-detail text-blue hover:underline" data-testid="btn-money-entry-back" onClick={() => nav.back()}>
      {t('simple.money.entry.back')}
    </button>
  )
  if (isLoading) return <Page data-testid="simple-money-entry">{null}</Page>
  if (!e) {
    return (
      <Page data-testid="simple-money-entry">
        {back}
        <p className="text-detail text-muted" data-testid="simple-money-entry-missing">{t('simple.money.entry.missing')}</p>
      </Page>
    )
  }
  const head =
    e.direction === 'move'
      ? t('simple.money.entry.moved', { from: e.account, to: e.who })
      : `${e.direction === 'in' ? t('simple.money.entry.from', { name: e.who }) : t('simple.money.entry.to', { name: e.who })} · ${
          e.direction === 'in' ? t('simple.money.entry.into', { account: e.account }) : t('simple.money.entry.outOf', { account: e.account })
        }`
  const title = e.direction === 'in' ? t('simple.money.in.title') : e.direction === 'out' ? t('simple.money.out.title') : t('simple.money.move.title')
  return (
    <Page data-testid="simple-money-entry" data-entry={e.voucherId}>
      {back}
      <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">
              {title} · <span className="num" data-testid="simple-money-entry-amount" data-paise={e.amount}>{money(e.amount)}</span>
            </h1>
            <p className="mt-1 text-detail text-muted">
              {head} · {t('simple.money.entry.on', { date: toPlainDate(e.date) })}
            </p>
          </div>
          <span>
            {e.chips.map((c) => (
              <Pill key={c} text={lbl(CHIP_TEXT[c])} cls={CHIP_CLS} testId="money-entry-chip" data={c} />
            ))}
          </span>
        </div>
        {e.direction !== 'move' && e.partyId != null && (
          <>
            <h2 className="mt-5 mb-2 text-subtitle font-semibold text-ink">{t('simple.money.entry.bills')}</h2>
            {e.bills.length === 0 ? (
              <p className="text-detail text-muted" data-testid="simple-money-entry-no-bills">{t('simple.money.entry.noBills')}</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="simple-money-entry-bills">
                {e.bills.map((b, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-4 py-1.5 text-body">
                    <span className="text-ink">{b.advance ? t('simple.money.entry.advance') : t('simple.money.entry.bill', { bill: b.name })}</span>
                    <span className="num text-ink">{money(b.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {e.note && <p className="mt-3 text-detail text-ink">{e.note}</p>}
        {e.reference && <p className="mt-1 text-small text-muted">{t('simple.money.entry.reference', { reference: e.reference })}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button data-testid="btn-money-entry-edit" title={t('simple.money.entry.editHint')} onClick={() => nav.go(editScreen(e.voucherId))}>
            {t('simple.money.entry.edit')}
          </Button>
        </div>
      </section>
    </Page>
  )
}
