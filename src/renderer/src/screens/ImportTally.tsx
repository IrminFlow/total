import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ImportProgress, type TallyImportDiff, type TallyImportSummary } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, EmptyState, Field, Money, Panel, SectionTitle, TextInput } from '../components/ui'
import { printReport } from '../lib/reportExport'
import { todayISO, toDisplayDate } from '@shared/dates'
import { formatPaise, parseRupees } from '@shared/money'
import { CsvImport } from './CsvImport'
import { OpeningBalances } from './OpeningBalances'

type Step =
  | { kind: 'pick' }
  | { kind: 'preview'; filePath: string | null; summary: TallyImportSummary; diff: TallyImportDiff }
  | { kind: 'running'; filePath: string | null }
  | { kind: 'done'; filePath: string | null; summary: TallyImportSummary }

const COUNT_LABELS: { key: 'groups' | 'ledgers' | 'units' | 'items' | 'vouchers' | 'duplicates' | 'skipped'; label: string }[] = [
  { key: 'groups', label: 'Groups' },
  { key: 'ledgers', label: 'Ledgers' },
  { key: 'units', label: 'Units' },
  { key: 'items', label: 'Stock items' },
  { key: 'vouchers', label: 'Vouchers' },
  { key: 'duplicates', label: 'Already here' },
  { key: 'skipped', label: 'Skipped' }
]

function CountsGrid({ summary }: { summary: TallyImportSummary }): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-7">
      {COUNT_LABELS.map(({ key, label }) => (
        <div key={key} className="rounded-md border border-line bg-panel2 px-3 py-2.5 text-center">
          <div className={`num text-heading font-semibold ${key === 'skipped' && summary[key] > 0 ? 'text-cr' : ''}`}>
            {summary[key]}
          </div>
          <div className="text-caption text-muted uppercase tracking-[0.06em]">{label}</div>
        </div>
      ))}
    </div>
  )
}

const WARNINGS_PREVIEW = 8

function WarningsBox({ warnings }: { warnings: string[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (warnings.length === 0) return null
  const shown = expanded ? warnings : warnings.slice(0, WARNINGS_PREVIEW)
  const hidden = warnings.length - shown.length
  return (
    <div className="mt-4 max-h-56 overflow-auto rounded-md border border-accentbar/50 bg-accentbar/10 px-3 py-2">
      <p className="flex items-center gap-2 py-0.5 text-body-sm font-medium text-ink">
        <span data-testid="badge-import-tally-warnings" className="rounded-md bg-accentbar/40 px-1.5 py-0.5 num text-caption">
          {warnings.length}
        </span>
        warning{warnings.length > 1 ? 's' : ''}
      </p>
      {shown.map((w, i) => (
        <p key={i} className="py-0.5 text-body-sm text-ink">
          {w}
        </p>
      ))}
      {hidden > 0 && (
        <button
          data-testid="btn-import-tally-warnings-more"
          className="py-0.5 text-body-sm text-blue hover:underline"
          onClick={() => setExpanded(true)}
        >
          {hidden} more…
        </button>
      )}
    </div>
  )
}

export function ImportTallyScreen(): React.JSX.Element {
  // Three ways in, because there are three kinds of arriving business: one with a Tally file,
  // one with a spreadsheet, and one — the commonest — with a notebook and no file at all.
  const [source, setSource] = useState<'tally' | 'csv' | 'opening'>('tally')
  return (
    <div className="flex h-full min-h-0 w-full flex-col max-w-[760px]">
      <SectionTitle
        right={
          <div className="flex items-center gap-1">
            {(
              [
                { id: 'tally', label: 'Tally XML' },
                { id: 'csv', label: 'Spreadsheet' },
                { id: 'opening', label: 'Type them in' }
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                data-testid={`tab-import-${t.id}`}
                onClick={() => setSource(t.id)}
                className={`rounded-md px-2.5 py-1 text-small whitespace-nowrap transition-colors ${
                  source === t.id ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-panel2 hover:text-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        {source === 'tally' ? 'Import from Tally' : source === 'csv' ? 'Import a spreadsheet' : 'Opening balances'}
      </SectionTitle>
      {source === 'tally' ? <TallyImport /> : source === 'csv' ? <CsvImport /> : <OpeningBalances />}
    </div>
  )
}

function TallyImport(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const qc = useQueryClient()
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  // A ref rather than state: the Cancel button is disabled off it while the round trip is still
  // in flight, and it must not re-render the progress panel on the way.
  const cancelling = useRef(false)

  useEffect(() => api.tally.onProgress(setProgress), [])

  const pickFile = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.tally.dryRun()
      if (!r) return // dialog canceled
      setStep({ kind: 'preview', filePath: r.filePath, summary: r.summary, diff: r.diff })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const applyImport = async (filePath: string | null): Promise<void> => {
    setBusy(true)
    cancelling.current = false
    setProgress(null)
    setStep({ kind: 'running', filePath })
    try {
      const r = await api.tally.apply(filePath ?? undefined)
      if (!r) {
        setStep({ kind: 'pick' })
        return
      }
      if (r.summary.cancelled) {
        toast.push('success', 'Import cancelled. Nothing was written — your books are exactly as they were.')
        setStep({ kind: 'pick' })
        return
      }
      setStep({ kind: 'done', filePath: r.filePath, summary: r.summary })
      // An import rewrites most of what every screen shows.
      void qc.invalidateQueries()
      const done = r.summary
      toast.push(
        'success',
        `Imported: ${done.groups} groups, ${done.ledgers} ledgers, ${done.units} units, ${done.items} items, ` +
          `${done.vouchers} vouchers${done.duplicates ? ` (${done.duplicates} already here)` : ''}` +
          `${done.skipped ? ` (${done.skipped} skipped)` : ''}`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
      setStep({ kind: 'pick' })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const cancel = async (): Promise<void> => {
    cancelling.current = true
    await api.tally.cancel()
  }

  return (
    <>
      {step.kind === 'pick' && <PickStep busy={busy} onPick={() => void pickFile()} />}
      {step.kind === 'preview' && (
        <PreviewStep
          summary={step.summary}
          diff={step.diff}
          busy={busy}
          onImport={() => void applyImport(step.filePath)}
          onDifferentFile={() => setStep({ kind: 'pick' })}
        />
      )}
      {step.kind === 'running' && (
        <RunningStep progress={progress} cancelling={cancelling.current} onCancel={() => void cancel()} />
      )}
      {step.kind === 'done' && <DoneStep summary={step.summary} onGateway={() => nav.home()} />}
    </>
  )
}

/**
 * Progress, and a way out (roadmap O #300).
 *
 * Three years of Day Book takes a minute, and a frozen button for a minute is indistinguishable
 * from a hang. Cancel rolls the whole thing back rather than stopping where it got to: a
 * half-imported set of books is not a state anybody asked for when they pressed it.
 */
function RunningStep({
  progress,
  cancelling,
  onCancel
}: {
  progress: ImportProgress | null
  cancelling: boolean
  onCancel: () => void
}): React.JSX.Element {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <Panel className="p-6" data-testid="import-running">
      <p className="text-detail font-medium">
        {progress?.phase === 'masters' ? 'Creating groups, ledgers and items…' : 'Importing vouchers…'}
      </p>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-md bg-panel2">
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 num text-body-sm text-muted" data-testid="import-progress-text">
        {progress ? `${progress.done} of ${progress.total}` : 'Reading the file…'}
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" data-testid="btn-import-cancel" disabled={cancelling} onClick={onCancel}>
          {cancelling ? 'Rolling back…' : 'Cancel'}
        </Button>
      </div>
      <p className="mt-2 text-hint text-muted">
        Cancelling undoes everything this import has written so far. Nothing is left half-done.
      </p>
    </Panel>
  )
}

/**
 * The dry-run diff (roadmap O #296).
 *
 * The counts used to be counts of what was in the file, which answers "did it parse" — a question
 * nobody migrating their books is asking. This answers the one they are: how much of this is new,
 * how much do I already have, and what will not come across.
 */
function DiffPanel({ diff }: { diff: TallyImportDiff }): React.JSX.Element {
  const nothingNew = diff.vouchers.create === 0 && diff.masters.every((m) => m.create === 0)
  return (
    <div data-testid="import-diff">
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col" className="r w-32">New</th>
            <th scope="col" className="r w-32">Already here</th>
          </tr>
        </thead>
        <tbody>
          {diff.masters.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="r num" data-testid={`diff-create-${row.label.toLowerCase().replace(/ /g, '-')}`}>
                {row.create}
              </td>
              <td className="r num text-muted">{row.exists}</td>
            </tr>
          ))}
          <tr>
            <td>Vouchers</td>
            <td className="r num" data-testid="diff-create-vouchers">
              {diff.vouchers.create}
            </td>
            <td className="r num text-muted" data-testid="diff-duplicate-vouchers">
              {diff.vouchers.duplicate}
            </td>
          </tr>
        </tbody>
      </table>

      {diff.vouchers.duplicate > 0 && (
        <p className="mt-2 text-body-sm text-muted" data-testid="import-diff-duplicates">
          {diff.vouchers.duplicate} voucher{diff.vouchers.duplicate > 1 ? 's are' : ' is'} already in these books from an
          earlier import. {diff.vouchers.duplicate > 1 ? 'They' : 'It'} will not be entered twice.
        </p>
      )}
      {diff.vouchers.blocked > 0 && (
        <p className="mt-2 text-body-sm text-cr">
          {diff.vouchers.blocked} voucher{diff.vouchers.blocked > 1 ? 's name ledgers' : ' names a ledger'} this file
          never defines, so {diff.vouchers.blocked > 1 ? 'they' : 'it'} cannot come across. Import the masters export
          first.
        </p>
      )}
      {nothingNew && (
        <p className="mt-2 text-body-sm text-muted">
          Nothing in this file is new to these books. Importing it would change nothing.
        </p>
      )}
      {diff.samples.length > 0 && (
        <p className="mt-2 text-body-sm text-muted">
          For example: {diff.samples.slice(0, 6).map((sample) => `${sample.kind} ${sample.label}`).join(', ')}
          {diff.samples.length > 6 ? '…' : ''}
        </p>
      )}
    </div>
  )
}

function PickStep({ busy, onPick }: { busy: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <>
      <Panel className="p-6">
        <p className="text-body text-muted">
          Export your books from Tally first:
        </p>
        <ol className="mt-3 flex flex-col gap-1.5 text-detail">
          <li>
            <b>Masters</b> — Gateway of Tally → Display → List of Accounts → <span className="num">Export</span> → XML
          </li>
          <li>
            <b>Vouchers</b> — Gateway of Tally → Display → Day Book → <span className="num">Export</span> → XML for the period you want
          </li>
        </ol>
        <p className="mt-3 text-body-sm text-muted">
          Import the masters export first (groups, ledgers, stock items), then the vouchers export. Nothing is written to
          your books until you confirm on the next screen.
        </p>
        <div className="mt-5 flex justify-center">
          <Button variant="primary" data-testid="btn-import-tally-pick" disabled={busy} onClick={onPick} className="px-8 py-3 text-lead">
            {busy ? 'Reading…' : 'Choose Tally XML…'}
          </Button>
        </div>
      </Panel>
    </>
  )
}

function PreviewStep({
  summary,
  diff,
  busy,
  onImport,
  onDifferentFile
}: {
  summary: TallyImportSummary
  diff: TallyImportDiff
  busy: boolean
  onImport: () => void
  onDifferentFile: () => void
}): React.JSX.Element {
  return (
    <Panel className="p-6">
      <p className="mb-3 text-detail text-muted">
        What this import would do to your books — nothing has been written yet.
      </p>
      <DiffPanel diff={diff} />
      <p className="mt-5 mb-2 text-body-sm text-muted">What the file itself contains:</p>
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

/**
 * The reconciliation step: the moment the import becomes trustworthy.
 *
 * A migrating business has three years of books and one question, which is not "did the file
 * parse" but "is it all here". Counts cannot answer that; a number they can read off their own
 * Tally screen can. The Trial Balance debit total is the right number to ask for because it is
 * one figure, it is on a screen they already know, and it moves if anything at all is missing.
 */
function Reconcile({ totalDebit, skipped }: { totalDebit: number; skipped: number }): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const expected = parseRupees(typed)
  const difference = expected == null ? null : expected - totalDebit
  const matched = difference === 0

  return (
    <Panel className="mt-4 p-6">
      <p className="text-detail font-medium">Check it matched</p>
      <p className="mt-1 text-body-sm text-muted">
        In Tally: Gateway → Display → Trial Balance. Type the <b>Debit total</b> here.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <Field label="Tally's Trial Balance debit total">
          <TextInput
            data-testid="input-reconcile-total"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="e.g. 12,45,600.00"
            className="num w-56"
            inputMode="decimal"
          />
        </Field>
        <div className="pb-1">
          <p className="text-caption tracking-[0.08em] text-muted uppercase">Total imported</p>
          <p className="num text-lead font-semibold">{formatPaise(totalDebit)}</p>
        </div>
      </div>

      {expected != null && (
        <div
          data-testid="reconcile-verdict"
          className={`mt-4 rounded-md border px-4 py-3 ${
            matched ? 'border-dr/50 bg-dr/10' : 'border-cr/50 bg-cr/10'
          }`}
        >
          {matched ? (
            <p className="text-detail font-medium text-dr">
              Matched to the paise. Your books came across complete.
            </p>
          ) : (
            <>
              <p className="text-detail font-medium text-cr">
                Off by {formatPaise(Math.abs(difference!))}. {difference! > 0 ? 'Tally shows more.' : 'Total shows more.'}
              </p>
              <p className="mt-1.5 text-body-sm text-muted">Where the difference usually comes from:</p>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-body-sm text-muted">
                <li>The Day Book export covered a shorter period than Tally&rsquo;s Trial Balance date.</li>
                <li>Opening balances live in the masters export. Import that file too if you have not.</li>
                {skipped > 0 && (
                  <li className="text-cr">
                    {skipped} voucher{skipped > 1 ? 's were' : ' was'} skipped on import. The warnings above say why.
                  </li>
                )}
                <li>Tally&rsquo;s Trial Balance was taken as on a different date.</li>
              </ul>
            </>
          )}
        </div>
      )}
    </Panel>
  )
}

function DoneStep({ summary, onGateway }: { summary: TallyImportSummary; onGateway: () => void }): React.JSX.Element {
  const toast = useToasts()
  const today = todayISO()
  const { data: tb } = useQuery({ queryKey: ['trialBalance', today], queryFn: () => api.reports.trialBalance(today) })
  const rows = tb?.rows ?? []

  const migrationReport = async (): Promise<void> => {
    try {
      const { path, outOfBalance } = await api.tally.migrationReport()
      toast.push(
        outOfBalance === 0 ? 'success' : 'error',
        outOfBalance === 0
          ? `Migration report written to ${path}`
          : `Written to ${path}, but the books do not balance — the report says so on its face.`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const printTb = (): void => {
    void printReport(
      {
        title: 'Trial balance',
        periodLabel: `as on ${toDisplayDate(today)}`,
        columns: [
          { label: 'Ledger', align: 'l' },
          { label: 'Group', align: 'l' },
          { label: 'Debit', align: 'r' },
          { label: 'Credit', align: 'r' }
        ],
        rows: [
          ...rows.map((r) => ({
            cells: [r.ledgerName, r.groupName, formatPaise(r.debit, { zeroDash: true }), formatPaise(r.credit, { zeroDash: true })]
          })),
          {
            cells: ['Total', '', formatPaise(tb?.totalDebit ?? 0, { zeroDash: true }), formatPaise(tb?.totalCredit ?? 0, { zeroDash: true })],
            bold: true,
            rule: true
          }
        ],
        filename: 'trial-balance'
      },
      toast
    )
  }

  return (
    <>
      <Panel className="p-6">
        <p className="mb-3 text-detail text-dr font-medium">Import complete.</p>
        <CountsGrid summary={summary} />
        <WarningsBox warnings={summary.warnings} />
      </Panel>

      <Reconcile totalDebit={tb?.totalDebit ?? 0} skipped={summary.skipped} />

      <div className="mt-4 flex items-center justify-between">
        <p className="text-body-sm text-muted">Every ledger Total imported, as on {toDisplayDate(today)}.</p>
        <div className="flex gap-2">
          {/* The paper the migration is actually signed off on. Separate from the trial-balance
              print because it says something different: not what the books hold, but what was
              moved, by whom, and what was refused on the way. */}
          <Button variant="ghost" data-testid="btn-migration-report" onClick={() => void migrationReport()}>
            Migration report for the CA
          </Button>
          <Button variant="ghost" onClick={printTb}>
            Trial balance PDF
          </Button>
          <Button variant="primary" onClick={onGateway}>
            Go to Gateway
          </Button>
        </div>
      </div>

      <Panel className="mt-3" scroll={{ maxH: '60vh' }}>
        {rows.length === 0 ? (
          <EmptyState title="No balances yet" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Ledger</th>
                <th scope="col">Group</th>
                <th scope="col" className="r w-40">Debit</th>
                <th scope="col" className="r w-40">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ledgerId}>
                  <td>{r.ledgerName}</td>
                  <td className="text-muted">{r.groupName}</td>
                  <td className="r">
                    <Money paise={r.debit} />
                  </td>
                  <td className="r">
                    <Money paise={r.credit} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total</td>
                <td className="r">
                  <Money paise={tb?.totalDebit ?? 0} />
                </td>
                <td className="r">
                  <Money paise={tb?.totalCredit ?? 0} />
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </>
  )
}
