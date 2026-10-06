import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type TallyImportSummary } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, Panel, SectionTitle } from '../components/ui'
import { DataTable, defineColumns } from '../components/table'
import { todayISO, toDisplayDate } from '@shared/dates'
import type { TrialBalanceRow } from '@shared/reports'

type Step =
  | { kind: 'pick' }
  | { kind: 'preview'; filePath: string | null; summary: TallyImportSummary }
  | { kind: 'done'; filePath: string | null; summary: TallyImportSummary }

const COUNT_LABELS: { key: keyof Omit<TallyImportSummary, 'warnings'>; label: string }[] = [
  { key: 'groups', label: 'Groups' },
  { key: 'ledgers', label: 'Ledgers' },
  { key: 'units', label: 'Units' },
  { key: 'items', label: 'Stock items' },
  { key: 'vouchers', label: 'Vouchers' },
  { key: 'skipped', label: 'Skipped' }
]

function CountsGrid({ summary }: { summary: TallyImportSummary }): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {COUNT_LABELS.map(({ key, label }) => (
        <div key={key} className="rounded-md border border-line bg-panel2 px-3 py-2.5 text-center">
          <div className={`num text-[20px] font-semibold ${key === 'skipped' && summary[key] > 0 ? 'text-cr' : ''}`}>
            {summary[key]}
          </div>
          <div className="text-[11px] text-muted uppercase tracking-[0.06em]">{label}</div>
        </div>
      ))}
    </div>
  )
}

const WARNINGS_PREVIEW = 8

/** Closing balances by side — the debit and credit totals must tie, exactly like Tally's TB. */
const TB_COLUMNS = defineColumns<TrialBalanceRow>([
  { id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName, hideable: false, groupable: false, minWidth: 180 },
  { id: 'group', header: 'Group', kind: 'text', value: (r) => r.groupName, className: 'text-muted', minWidth: 140 },
  { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit, width: 160, aggregate: 'sum' },
  { id: 'credit', header: 'Credit', kind: 'money', value: (r) => r.credit, width: 160, aggregate: 'sum' }
])

function WarningsBox({ warnings }: { warnings: string[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (warnings.length === 0) return null
  const shown = expanded ? warnings : warnings.slice(0, WARNINGS_PREVIEW)
  const hidden = warnings.length - shown.length
  return (
    <div className="mt-4 max-h-56 overflow-auto rounded-md border border-amberbar/50 bg-amberbar/10 px-3 py-2">
      <p className="flex items-center gap-2 py-0.5 text-[12.5px] font-medium text-ink">
        <span data-testid="badge-import-tally-warnings" className="rounded bg-amberbar/40 px-1.5 py-0.5 num text-[11px]">
          {warnings.length}
        </span>
        warning{warnings.length > 1 ? 's' : ''}
      </p>
      {shown.map((w, i) => (
        <p key={i} className="py-0.5 text-[12.5px] text-ink">
          {w}
        </p>
      ))}
      {hidden > 0 && (
        <button
          data-testid="btn-import-tally-warnings-more"
          className="py-0.5 text-[12.5px] text-blue hover:underline"
          onClick={() => setExpanded(true)}
        >
          {hidden} more…
        </button>
      )}
    </div>
  )
}

export function ImportTallyScreen(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)

  const pickFile = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.tally.dryRun()
      if (!r) return // dialog canceled
      setStep({ kind: 'preview', filePath: r.filePath, summary: r.summary })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const applyImport = async (filePath: string | null): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.tally.apply(filePath ?? undefined)
      if (!r) return
      setStep({ kind: 'done', filePath: r.filePath, summary: r.summary })
      toast.push('success', `Imported: ${r.summary.groups} groups, ${r.summary.ledgers} ledgers, ${r.summary.units} units, ${r.summary.items} items, ${r.summary.vouchers} vouchers${r.summary.skipped ? ` (${r.summary.skipped} skipped)` : ''}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle>Import from Tally</SectionTitle>
      {step.kind === 'pick' && <PickStep busy={busy} onPick={() => void pickFile()} />}
      {step.kind === 'preview' && (
        <PreviewStep
          summary={step.summary}
          busy={busy}
          onImport={() => void applyImport(step.filePath)}
          onDifferentFile={() => setStep({ kind: 'pick' })}
        />
      )}
      {step.kind === 'done' && <DoneStep summary={step.summary} onGateway={() => nav.home()} />}
    </div>
  )
}

function PickStep({ busy, onPick }: { busy: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <>
      <Panel className="p-6">
        <p className="text-[13.5px] text-muted">
          Export your books from Tally first:
        </p>
        <ol className="mt-3 flex flex-col gap-1.5 text-[13px]">
          <li>
            <b>Masters</b> — Gateway of Tally → Display → List of Accounts → <span className="num">Export</span> → XML
          </li>
          <li>
            <b>Vouchers</b> — Gateway of Tally → Display → Day Book → <span className="num">Export</span> → XML for the period you want
          </li>
        </ol>
        <p className="mt-3 text-[12.5px] text-muted">
          Import the masters export first (groups, ledgers, stock items), then the vouchers export. Nothing is written to
          your books until you confirm on the next screen.
        </p>
        <div className="mt-5 flex justify-center">
          <Button variant="primary" data-testid="btn-import-tally-pick" disabled={busy} onClick={onPick} className="px-8 py-3 text-[14px]">
            {busy ? 'Reading…' : 'Choose Tally XML…'}
          </Button>
        </div>
      </Panel>
    </>
  )
}

function PreviewStep({
  summary,
  busy,
  onImport,
  onDifferentFile
}: {
  summary: TallyImportSummary
  busy: boolean
  onImport: () => void
  onDifferentFile: () => void
}): React.JSX.Element {
  return (
    <Panel className="p-6">
      <p className="mb-3 text-[13px] text-muted">Here&rsquo;s what this file contains — nothing has been imported yet.</p>
      <CountsGrid summary={summary} />
      <WarningsBox warnings={summary.warnings} />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onDifferentFile}>
          Choose different file
        </Button>
        <Button variant="primary" data-testid="btn-import-tally-import" disabled={busy} onClick={onImport}>
          {busy ? 'Importing…' : 'Import now'}
        </Button>
      </div>
    </Panel>
  )
}

function DoneStep({ summary, onGateway }: { summary: TallyImportSummary; onGateway: () => void }): React.JSX.Element {
  const today = todayISO()
  const { data: tb } = useQuery({ queryKey: ['trialBalance', today], queryFn: () => api.reports.trialBalance(today) })
  const rows = tb?.rows ?? []

  return (
    <>
      <Panel className="p-6">
        <p className="mb-3 text-[13px] text-dr font-medium">Import complete.</p>
        <CountsGrid summary={summary} />
        <WarningsBox warnings={summary.warnings} />
      </Panel>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-[12.5px] text-muted">
          Compare with Tally&rsquo;s Trial Balance — should match to the paise.
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={onGateway}>
            Go to Gateway
          </Button>
        </div>
      </div>

      <Panel className="mt-3">
        <DataTable
          viewId="import-tally-tb"
          testId="import-tally-tb"
          ariaLabel="Trial balance after import"
          columns={TB_COLUMNS}
          rows={rows}
          rowKey={(r) => r.ledgerId}
          rowAttrs={(r) => ({ 'data-row-id': r.ledgerId })}
          loading={!tb}
          maxHeight="60vh"
          empty={{ title: 'No balances yet' }}
          exportOptions={{ title: 'Trial balance', periodLabel: `as on ${toDisplayDate(today)}`, filename: 'trial-balance' }}
        />
      </Panel>
    </>
  )
}
