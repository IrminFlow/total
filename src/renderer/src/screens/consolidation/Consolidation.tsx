// WP 6.5 — group consolidation: consolidated statements (TB / P&L / BS with member columns, the
// elimination column and the consolidated column, drill-down to member lines), the
// inter-company reconciliation, the elimination statement and the group definition. Everything
// is computed at query time from each member's books (read-only); the quick combined view of
// any companies stays on the "Consolidated reports" screen.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConsolidationGroup, GroupRunResult, StatementKind } from '@shared/consolidation/types'
import { CONSOLIDATION_SOURCES } from '@shared/consolidation/sources'
import { toDisplayDate } from '@shared/dates'
import { consolidationApi } from '../../lib/consolidationClient'
import { useNav, useSession } from '../../state/stores'
import { Badge, Banner, Button, Checkbox, Field, Modal, Page, PageHeader, Panel, Segmented, Select, SkeletonRows, StatGrid, StatTile, TabBar, TextInput } from '../../components/ui'
import { DrawerSection } from '../../components/kit/Drawer'
import { OptionsPeriod } from '../../components/ScreenOptions'
import { DataTable } from '../../components/table'
import { formatPaise } from '@shared/money'
import { EliminationDetail, eliminationColumns, LineDrill, reconColumns, ReconDetail, statementColumns } from './view'
import { GroupSetup, NoGroups } from './Setup'

export type ConsolidationTab = 'statements' | 'intercompany' | 'eliminations' | 'groups'

const STATEMENTS: { value: StatementKind; label: string }[] = [
  { value: 'pnl', label: 'Profit & loss' },
  { value: 'bs', label: 'Balance sheet' },
  { value: 'tb', label: 'Trial balance' }
]
const STATEMENT_TITLES: Record<StatementKind, string> = { pnl: 'Consolidated profit & loss', bs: 'Consolidated balance sheet', tb: 'Consolidated trial balance' }

export function ConsolidationScreen({ tab: initialTab, groupId: initialGroup }: { tab?: ConsolidationTab; groupId?: number }): React.JSX.Element {
  const { from, to, slug: openSlug } = useSession()
  const nav = useNav()
  const qc = useQueryClient()
  const [tab, setTab] = useState<ConsolidationTab>(initialTab ?? 'statements')
  const [kind, setKind] = useState<StatementKind>('pnl')
  const [comparePrior, setComparePrior] = useState(false)
  const [creating, setCreating] = useState(false)
  const { data: groups, isLoading: groupsLoading } = useQuery({ queryKey: ['consolGroups'], queryFn: consolidationApi.listGroups })
  const [groupId, setGroupId] = useState<number | null>(initialGroup ?? null)
  useEffect(() => {
    if (groups && groups.length && (groupId == null || !groups.some((g) => g.id === groupId))) setGroupId(groups[0]!.id)
  }, [groups, groupId])
  const group: ConsolidationGroup | null = groups?.find((g) => g.id === groupId) ?? null

  // Review follow-up (PR #132's payload): passphrases of locked members, given through "Unlock
  // <member> for this run". Held in memory only while this screen shows this group (a ref — never
  // in the query cache / key, never in localStorage); main uses each for the run and forgets it.
  const passphrases = useRef<Record<string, string>>({})
  const [unlocked, setUnlocked] = useState<string[]>([])
  const [unlocking, setUnlocking] = useState<{ slug: string; name: string } | null>(null)
  useEffect(() => {
    passphrases.current = {}
    setUnlocked([])
    setUnlocking(null)
  }, [groupId])
  useEffect(() => () => { passphrases.current = {} }, [])
  const withPassphrases = (): Record<string, string> | undefined => (Object.keys(passphrases.current).length ? { ...passphrases.current } : undefined)
  const runKey = ['consolRun', groupId, from, to, comparePrior, unlocked] as const
  const runQ = useQuery({
    queryKey: runKey,
    queryFn: () => consolidationApi.run(groupId!, from, to, comparePrior, withPassphrases()),
    enabled: groupId != null && !creating && tab !== 'groups'
  })
  const unlockMember = async (slug: string, passphrase: string): Promise<void> => {
    const tried = { ...passphrases.current, [slug]: passphrase }
    const result = await consolidationApi.run(groupId!, from, to, comparePrior, tried) // throws on a wrong passphrase
    passphrases.current = tried
    const next = [...unlocked, slug].sort()
    qc.setQueryData(['consolRun', groupId, from, to, comparePrior, next], result)
    setUnlocked(next)
    setUnlocking(null)
  }
  const run = runQ.data
  const st = run?.[kind]
  const columns = useMemo(() => (st ? statementColumns(st, comparePrior ? run?.prior?.[kind] : undefined) : []), [st, run, kind, comparePrior])
  const periodLabel = kind === 'pnl' ? `${toDisplayDate(from)} to ${toDisplayDate(to)}` : `as on ${toDisplayDate(to)}`
  const unreconciled = run?.recon.filter((r) => r.status === 'unreconciled' || r.flowStatus === 'unreconciled').length ?? 0

  const showSetup = creating || tab === 'groups'
  const noGroups = !groupsLoading && (groups?.length ?? 0) === 0 && !creating

  return (
    <Page width="wide">
      <PageHeader
        title="Group consolidation"
        period={`${toDisplayDate(from)} → ${toDisplayDate(to)}`}
        tabs={
          <TabBar
            screen="consolidation"
            label="View"
            tabs={[
              { id: 'statements', label: 'Statements' },
              { id: 'intercompany', label: 'Inter-company', ...(unreconciled ? { count: unreconciled } : {}) },
              { id: 'eliminations', label: 'Eliminations' },
              { id: 'groups', label: 'Groups' }
            ]}
            active={tab}
            onSelect={(t) => { setCreating(false); setTab(t) }}
          />
        }
        controls={
          groups && groups.length > 0 && !creating ? (
            <Select aria-label="Group" data-testid="select-consol-group" className="w-56" value={groupId ?? ''} onChange={(e) => setGroupId(Number(e.target.value))}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          ) : undefined
        }
        secondary={
          <Button size="sm" variant="ghost" data-testid="btn-consol-quick" onClick={() => nav.go({ name: 'consolidated' })}>Quick combined view</Button>
        }
        actions={
          <Button data-testid="btn-consol-new" onClick={() => { setCreating(true); setTab('groups') }}>New group</Button>
        }
        options={{
          content: (
            <>
              <OptionsPeriod />
              <DrawerSection title="Comparatives">
                <Checkbox testId="input-consol-compare" label="Show the prior year" hint="The same group for the period one year earlier" checked={comparePrior} onChange={setComparePrior} />
              </DrawerSection>
              <DrawerSection title="Rules and sources">
                <ul className="flex flex-col gap-2 text-hint">
                  {CONSOLIDATION_SOURCES.map((s) => (
                    <li key={s.id}>
                      <span className="text-ink">{s.rule}</span> {!s.verified && <Badge tone="warning">unverified</Badge>}
                      <br />
                      <span className="text-muted">{s.citation}</span>
                    </li>
                  ))}
                </ul>
              </DrawerSection>
            </>
          ),
          onReset: () => setComparePrior(false)
        }}
      />

      {noGroups && !showSetup && <NoGroups onNew={() => { setCreating(true); setTab('groups') }} />}

      {showSetup && (
        <GroupSetup
          group={creating ? null : group}
          openSlug={openSlug}
          onSaved={(g) => {
            setCreating(false)
            setGroupId(g.id)
            void qc.invalidateQueries({ queryKey: ['consolGroups'] })
            void qc.invalidateQueries({ queryKey: ['consolCharts'] })
            void qc.invalidateQueries({ queryKey: ['consolRun'] })
          }}
          onDeleted={() => {
            setGroupId(null)
            void qc.invalidateQueries({ queryKey: ['consolGroups'] })
          }}
        />
      )}

      {!showSetup && group && (
        <>
          {runQ.error && <Banner tone="danger" className="mb-4">Couldn’t consolidate: {runQ.error.message}</Banner>}
          {run && run.warnings.length > 0 && (
            <Banner tone="warning" className="mb-4">
              <div data-testid="consol-warnings">{run.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>
            </Banner>
          )}
          {run?.lockedMembers && run.lockedMembers.length > 0 && (
            <Banner tone="info" className="mb-4">
              <div data-testid="consol-locked" className="flex flex-wrap items-center gap-2">
                <span>Locked with a passphrase, so left out of this run:</span>
                {run.lockedMembers.map((m) => (
                  <Button key={m.slug} size="sm" variant="ghost" data-testid={`btn-consol-unlock-${m.slug}`} onClick={() => setUnlocking(m)}>
                    Unlock {m.name} for this run
                  </Button>
                ))}
              </div>
            </Banner>
          )}
          {unlocking && (
            <MemberUnlockPrompt name={unlocking.name} onCancel={() => setUnlocking(null)} onSubmit={(pass) => unlockMember(unlocking.slug, pass)} />
          )}
          {runQ.isLoading && <Panel><SkeletonRows /></Panel>}

          {run && st && tab === 'statements' && (
            <>
              {unreconciled > 0 && (
                <Banner tone="warning" className="mb-4">
                  {unreconciled} inter-company pair{unreconciled === 1 ? '' : 's'} do not agree — the differences are shown as “Unreconciled inter-company”, not eliminated.{' '}
                  <button type="button" className="underline" onClick={() => setTab('intercompany')}>Reconcile</button>
                </Banner>
              )}
              <StatementSummary run={run} kind={kind} comparePrior={comparePrior} />
              <Panel>
                <DataTable
                  viewId={`consol-${kind}`}
                  testId="consol-statement"
                  ariaLabel={STATEMENT_TITLES[kind]}
                  columns={columns}
                  rows={st.lines}
                  rowKey={(l) => l.key}
                  rowAttrs={(l) => ({ 'data-line': l.key })}
                  viewDefaults={{ groupBy: 'section' }}
                  renderDetail={(l) => <LineDrill line={l} run={run} st={st} />}
                  isRowExpandable={(l) => l.sources.length > 0 || l.eliminationIds.length > 0}
                  toolbarStart={<Segmented size="sm" label="Statement" testId="consol-kind" options={STATEMENTS} value={kind} onChange={setKind} />}
                  totalsLabel={kind === 'pnl' ? 'Profit after minority interest (Cr = profit)' : 'Total (nets to zero)'}
                  empty={{ title: 'Nothing to consolidate', hint: 'No member has balances for this period' }}
                  exportOptions={{
                    title: `${STATEMENT_TITLES[kind]} — ${run.group.name}`,
                    periodLabel,
                    filename: `consolidated-${kind}`,
                    footNote: 'Eliminations per AS 21 (see Options → Rules and sources). Amounts signed, debit positive.',
                    csvMoneyFormat: 'plain'
                  }}
                />
              </Panel>
            </>
          )}

          {run && tab === 'intercompany' && (
            <Panel>
              <DataTable
                viewId="consol-recon"
                testId="consol-recon"
                ariaLabel="Inter-company reconciliation"
                columns={reconColumns}
                rows={run.recon}
                rowKey={(r) => r.pairId}
                rowAttrs={(r) => ({ 'data-status': r.status, 'data-flow-status': r.flowStatus, 'data-pair-kind': r.kind })}
                renderDetail={(r) => <ReconDetail r={r} />}
                empty={{ title: 'No inter-company pairs', hint: 'Add pairs under Groups (Suggest pairs matches GSTIN / PAN)', action: <Button onClick={() => setTab('groups')}>Groups</Button> }}
                exportOptions={{ title: `Inter-company reconciliation — ${run.group.name}`, periodLabel: `as on ${toDisplayDate(to)}`, filename: 'intercompany-reconciliation', csvMoneyFormat: 'plain' }}
              />
            </Panel>
          )}

          {run && st && tab === 'eliminations' && (
            <Panel>
              <DataTable
                viewId={`consol-elims-${kind}`}
                testId="consol-elims"
                ariaLabel="Elimination statement"
                columns={eliminationColumns}
                rows={st.eliminations}
                rowKey={(e) => e.id}
                renderDetail={(e) => <EliminationDetail e={e} run={run} />}
                defaultExpanded={st.eliminations.slice(0, 1).map((e) => e.id)}
                toolbarStart={<Segmented size="sm" label="Statement" testId="consol-elim-kind" options={STATEMENTS} value={kind} onChange={setKind} />}
                empty={{ title: 'No eliminations', hint: 'Nothing inter-company in this statement' }}
                exportOptions={{ title: `Eliminations (${STATEMENT_TITLES[kind].toLowerCase()}) — ${run.group.name}`, periodLabel, filename: `consolidation-eliminations-${kind}`, csvMoneyFormat: 'plain' }}
              />
            </Panel>
          )}
        </>
      )}
    </Page>
  )
}

function StatementSummary({ run, kind, comparePrior }: { run: GroupRunResult; kind: StatementKind; comparePrior: boolean }): React.JSX.Element | null {
  const prior = comparePrior ? run.prior : undefined
  if (kind === 'pnl' && run.pnl.profit) {
    const p = run.pnl.profit
    return (
      <StatGrid className="mb-4">
        <StatTile label="Consolidated net profit" value={<span data-testid="consol-net-profit">{formatPaise(p.netProfit)}</span>} {...(prior ? { hint: `Prior year ${formatPaise(prior.netProfit)}` } : {})} />
        <StatTile label="Minority interest" value={<span data-testid="consol-minority">{formatPaise(p.minorityInterest)}</span>} />
        <StatTile label="Attributable to the parent" value={<span data-testid="consol-owners">{formatPaise(p.ownersProfit)}</span>} {...(prior ? { hint: `Prior year ${formatPaise(prior.ownersProfit)}` } : {})} />
        <StatTile label="Eliminated" value={formatPaise(run.pnl.eliminations.filter((e) => e.rule === 'ic_flow').reduce((s, e) => s + e.postings.reduce((t, x) => t + Math.max(0, x.amount), 0), 0))} hint="Inter-company transactions" />
      </StatGrid>
    )
  }
  if (kind === 'bs' && run.bs.balance) {
    const b = run.bs.balance
    return (
      <StatGrid className="mb-4">
        <StatTile label="Total assets" value={<span data-testid="consol-assets">{formatPaise(b.assets)}</span>} />
        <StatTile label="Total liabilities" value={<span data-testid="consol-liabilities">{formatPaise(b.liabilities)}</span>} />
        <StatTile label="Difference" value={formatPaise(b.assets - b.liabilities)} tone={b.assets === b.liabilities ? undefined : 'cr'} />
        <StatTile label="Eliminations" value={String(run.bs.eliminations.length)} />
      </StatGrid>
    )
  }
  return null
}

/** Asks for a locked member's passphrase for this run. The passphrase is cleared from the field
 *  after a refusal; the service's own words are shown (accountant screen). */
function MemberUnlockPrompt({ name, onSubmit, onCancel }: { name: string; onSubmit: (passphrase: string) => Promise<void>; onCancel: () => void }): React.JSX.Element {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (!pass || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(pass)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPass('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`Unlock ${name} for this run`} onClose={onCancel}>
      <div data-testid="consol-unlock-prompt">
        <p className="text-detail text-ink">
          {name} is locked with a passphrase. It is used to read its books for this consolidation only — it is not saved, and the business stays locked.
        </p>
        <div className="mt-3">
          <Field label="Passphrase" error={error ?? undefined}>
            <TextInput
              autoFocus
              type="password"
              autoComplete="off"
              value={pass}
              onChange={(e) => { setPass(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
              data-testid="input-consol-passphrase"
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={busy || !pass} onClick={() => void submit()} data-testid="btn-consol-unlock-run">
            {busy ? 'Unlocking…' : 'Unlock and run'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
