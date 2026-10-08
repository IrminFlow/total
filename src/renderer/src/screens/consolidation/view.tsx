// WP 6.5 — column definitions and pure helpers for the consolidation screens (tested in
// __tests__/consolidation.test.tsx).
import type { ConsolLine, Elimination, GroupRunResult, IcReconRow, LineSection, StatementResult } from '@shared/consolidation/types'
import { AGEING_BUCKETS } from '@shared/consolidation/ageing'
import { sourceOf } from '@shared/consolidation/sources'
import { Badge, Money } from '../../components/ui'
import { defineColumns, type TableColumn } from '../../components/table'
import { LedgerLink } from '../../components/links'
import { isRealId } from '../../lib/drill'

export const SECTION_LABELS: Record<LineSection, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  income: 'Income',
  expense: 'Expenses',
  opening_stock: 'Opening stock',
  trading_expense: 'Trading expenses',
  trading_income: 'Trading income',
  closing_stock: 'Closing stock',
  indirect_expense: 'Indirect expenses',
  indirect_income: 'Indirect income',
  appropriation: 'Appropriation (below net profit)'
}
const SECTION_ORDER = Object.keys(SECTION_LABELS) as LineSection[]
/** Sortable enum value ("03-income") so grouped sections keep statement order. */
export const sectionValue = (s: LineSection): string => `${String(SECTION_ORDER.indexOf(s)).padStart(2, '0')}-${s}`
const SECTION_OPTIONS = SECTION_ORDER.map((s) => ({ value: sectionValue(s), label: SECTION_LABELS[s] }))

export const RULE_LABELS: Record<Elimination['rule'], string> = {
  ic_balance: 'Inter-company balance',
  ic_flow: 'Inter-company trading',
  unrealised_profit: 'Unrealised profit in stock',
  investment: 'Investment vs equity',
  minority_interest: 'Minority interest',
  minority_profit: 'Minority share of profit',
  associate: 'Associate (equity method)'
}

export const KIND_LABELS: Record<IcReconRow['kind'], string> = {
  receivable_payable: 'Receivable / payable',
  sales_purchase: 'Sales / purchases',
  loan: 'Loan / interest',
  other: 'Other'
}

/** Basis points → "80" / "12.5". */
export const bpToPct = (bp: number | null | undefined): string => (bp == null ? '' : String(bp / 100))
/** "80" / "12.5 %" → basis points; null for blank, NaN-safe. */
export function pctToBp(text: string): number | null {
  const t = text.replace('%', '').trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round(n * 100)
}

const signed = (v: number | null | undefined): React.JSX.Element => (v == null ? <span className="text-muted">—</span> : <Money paise={v} signed />)

/** Line, section, one column per member, eliminations, consolidated (+ prior year). */
export function statementColumns(st: StatementResult, prior?: Record<string, number>): TableColumn<ConsolLine>[] {
  return defineColumns<ConsolLine>([
    {
      id: 'name', header: 'Line', kind: 'text', value: (l) => l.name, hideable: false, groupable: false, minWidth: 220,
      cell: (l) => (
        <span className="flex items-center gap-2">
          {l.name}
          {l.special && <Badge tone="amber">elimination</Badge>}
        </span>
      )
    },
    { id: 'section', header: 'Section', kind: 'enum', value: (l) => sectionValue(l.section), options: SECTION_OPTIONS, defaultHidden: true },
    ...st.members.map((m, i) => ({
      id: `m:${m.slug}`, header: m.name, group: 'Members', kind: 'money' as const, signed: true, width: 150,
      value: (l: ConsolLine) => l.perMember[i] ?? 0,
      cell: (l: ConsolLine) => (m.included ? signed(l.perMember[i]) : <span className="text-muted">—</span>),
      aggregate: 'sum' as const
    })),
    { id: 'elimination', header: 'Eliminations', kind: 'money', signed: true, width: 150, value: (l) => l.elimination, aggregate: 'sum' },
    { id: 'consolidated', header: 'Consolidated', kind: 'money', signed: true, width: 160, value: (l) => l.consolidated, aggregate: 'sum' },
    ...(prior
      ? [{ id: 'prior', header: 'Prior year', kind: 'money' as const, signed: true, width: 150, value: (l: ConsolLine) => prior[l.key] ?? null, aggregate: 'sum' as const }]
      : [])
  ])
}

/** Drill-down under a consolidated line: each member row (ledger links only for the open
 *  company — other companies' ids mean nothing in these books) and each elimination posting. */
export function LineDrill({ line, run, st }: { line: ConsolLine; run: GroupRunResult; st: StatementResult }): React.JSX.Element {
  const nameOf = (slug: string | null): string => (slug ? st.members.find((m) => m.slug === slug)?.name ?? run.recon.find((r) => r.memberA === slug)?.memberAName ?? slug : 'Group')
  const elims = st.eliminations.filter((e) => line.eliminationIds.includes(e.id))
  return (
    <div className="grid gap-3 py-2 text-detail md:grid-cols-2" data-testid={`drill-${line.key}`}>
      <div>
        <p className="mb-1 text-caption font-semibold uppercase tracking-[0.08em] text-muted">Member lines</p>
        {line.sources.length === 0 && <p className="text-muted">None — this line comes from eliminations only.</p>}
        <ul className="flex flex-col gap-0.5">
          {line.sources.map((s, i) => (
            <li key={i} className="flex items-baseline justify-between gap-4" data-drill-ledger={`${s.slug}:${s.ledgerId}`}>
              <span>
                <span className="text-muted">{nameOf(s.slug)} · </span>
                {s.slug === run.openSlug && isRealId(s.ledgerId) ? <LedgerLink ledgerId={s.ledgerId} name={s.name} /> : s.name}
                <span className="text-caption text-muted"> ({s.groupName})</span>
              </span>
              <Money paise={s.amount} signed />
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1 text-caption font-semibold uppercase tracking-[0.08em] text-muted">Eliminations</p>
        {elims.length === 0 && <p className="text-muted">None.</p>}
        <ul className="flex flex-col gap-0.5">
          {elims.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-4">
              <span>{e.title}</span>
              <Money paise={e.postings.filter((p) => p.lineKey === line.key).reduce((s, p) => s + p.amount, 0)} signed />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export const eliminationColumns = defineColumns<Elimination>([
  { id: 'rule', header: 'Rule', kind: 'enum', value: (e) => e.rule, options: Object.entries(RULE_LABELS).map(([value, label]) => ({ value, label })), width: 210 },
  { id: 'title', header: 'Elimination', kind: 'text', value: (e) => e.title, hideable: false, minWidth: 240 },
  {
    id: 'status', header: 'Status', kind: 'enum', value: (e) => e.status ?? '', width: 130,
    options: [{ value: 'reconciled', label: 'Reconciled' }, { value: 'unreconciled', label: 'Unreconciled' }],
    cell: (e) => (e.status ? <Badge tone={e.status === 'reconciled' ? 'success' : 'warning'}>{e.status}</Badge> : <span className="text-muted">—</span>)
  },
  {
    id: 'debits', header: 'Debits', kind: 'money', width: 150, aggregate: 'sum',
    value: (e) => e.postings.reduce((s, p) => s + Math.max(0, p.amount), 0)
  },
  {
    id: 'credits', header: 'Credits', kind: 'money', width: 150, aggregate: 'sum',
    value: (e) => e.postings.reduce((s, p) => s + Math.max(0, -p.amount), 0)
  },
  { id: 'source', header: 'Basis', kind: 'text', value: (e) => sourceOf(e.source).short, width: 170, className: 'text-muted' }
])

export function EliminationDetail({ e, run }: { e: Elimination; run: GroupRunResult }): React.JSX.Element {
  const src = sourceOf(e.source)
  return (
    <div className="flex flex-col gap-2 py-2 text-detail">
      <p className="text-muted">{e.detail}</p>
      <table className="w-full max-w-3xl text-detail">
        <tbody>
          {e.postings.map((p, i) => (
            <tr key={i}>
              <td className="py-0.5 pr-4">{p.lineName}</td>
              <td className="py-0.5 pr-4 text-muted">
                {p.slug ?? 'Group'}
                {p.ledgerName ? ' · ' : ''}
                {p.slug === run.openSlug && isRealId(p.ledgerId) ? <LedgerLink ledgerId={p.ledgerId} name={p.ledgerName ?? ''} /> : p.ledgerName}
              </td>
              <td className="py-0.5 text-right"><Money paise={p.amount} signed /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-hint text-muted">
        {src.citation} {!src.verified && <Badge tone="warning">unverified</Badge>}
      </p>
    </div>
  )
}

const sideCell = (ledger: string, company: string): React.JSX.Element => (
  <span className="flex flex-col leading-tight">
    <span>{ledger}</span>
    <span className="text-caption text-muted">in {company}</span>
  </span>
)
const statusBadge = (s: IcReconRow['status']): React.JSX.Element =>
  s === 'n/a' ? <span className="text-muted">—</span> : <Badge tone={s === 'reconciled' ? 'success' : s === 'unreconciled' ? 'warning' : 'neutral'}>{s}</Badge>
const STATUS_OPTIONS = ['reconciled', 'unreconciled', 'skipped', 'n/a'].map((v) => ({ value: v, label: v }))

/** A pair's headline figures: its balances on the date, else its transactions in the period
 *  (a loan pair has both — the transactions show in the detail row). */
export function reconFigures(r: IcReconRow): { basis: 'balance' | 'transactions' | 'none'; a: number | null; b: number | null; difference: number | null; status: IcReconRow['status'] } {
  if (r.status !== 'n/a') return { basis: 'balance', a: r.balanceA, b: r.balanceB, difference: r.difference, status: r.status }
  if (r.flowStatus !== 'n/a') return { basis: 'transactions', a: r.flowA, b: r.flowB, difference: r.flowDifference, status: r.flowStatus }
  return { basis: 'none', a: null, b: null, difference: null, status: 'n/a' }
}

export const reconColumns = defineColumns<IcReconRow>([
  { id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind, options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })), width: 160 },
  { id: 'a', header: 'Side A', kind: 'text', value: (r) => `${r.ledgerAName} in ${r.memberAName}`, cell: (r) => sideCell(r.ledgerAName, r.memberAName), minWidth: 140 },
  { id: 'b', header: 'Side B', kind: 'text', value: (r) => `${r.ledgerBName} in ${r.memberBName}`, cell: (r) => sideCell(r.ledgerBName, r.memberBName), minWidth: 140 },
  {
    id: 'basis', header: 'Compares', kind: 'enum', width: 150, value: (r) => reconFigures(r).basis,
    options: [{ value: 'balance', label: 'Balances on date' }, { value: 'transactions', label: 'Transactions' }, { value: 'none', label: '—' }]
  },
  { id: 'aAmt', header: 'Side A', group: 'Amounts', kind: 'money', signed: true, width: 130, value: (r) => reconFigures(r).a, cell: (r) => signed(reconFigures(r).a) },
  { id: 'bAmt', header: 'Side B', group: 'Amounts', kind: 'money', signed: true, width: 130, value: (r) => reconFigures(r).b, cell: (r) => signed(reconFigures(r).b) },
  { id: 'diff', header: 'Difference', group: 'Amounts', kind: 'money', signed: true, width: 130, value: (r) => reconFigures(r).difference, cell: (r) => signed(reconFigures(r).difference) },
  { id: 'status', header: 'Status', kind: 'enum', width: 120, value: (r) => reconFigures(r).status, options: STATUS_OPTIONS, cell: (r) => statusBadge(reconFigures(r).status) }
])

export function ReconDetail({ r }: { r: IcReconRow }): React.JSX.Element {
  const side = (label: string, ageing: number[]): React.JSX.Element => (
    <div>
      <p className="mb-1 text-caption font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      {ageing.length === 0 ? (
        <p className="text-muted">No ageing (not a balance pair, or the company could not be read).</p>
      ) : (
        <table className="text-detail">
          <tbody>
            {AGEING_BUCKETS.map((b, i) => (
              <tr key={b}>
                <td className="py-0.5 pr-6 text-muted">{b} days</td>
                <td className="py-0.5 text-right"><Money paise={ageing[i] ?? 0} signed /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
  const loan = r.status !== 'n/a' && r.flowStatus !== 'n/a'
  return (
    <div className="flex flex-col gap-2 py-2">
      {r.note && <p className="text-hint text-muted">{r.note}</p>}
      {loan && (
        <p className="text-detail">
          Transactions in the period: <Money paise={r.flowA ?? 0} signed /> against <Money paise={r.flowB ?? 0} signed />, difference{' '}
          <Money paise={r.flowDifference ?? 0} signed /> {statusBadge(r.flowStatus)}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {side(`${r.memberAName} · ${r.ledgerAName}`, r.ageingA)}
        {side(`${r.memberBName} · ${r.ledgerBName}`, r.ageingB)}
      </div>
    </div>
  )
}
