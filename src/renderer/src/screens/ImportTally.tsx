import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type TallyImportSummary } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle } from '../components/ui'
import { printReport } from '../lib/reportExport'
import { todayISO, toDisplayDate } from '@shared/dates'
import { formatPaise } from '@shared/money'

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

function WarningsBox({ warnings }: { warnings: string[] }): React.JSX.Element | null {
  if (warnings.length === 0) return null
  return (
    <div className="mt-4 max-h-56 overflow-auto rounded-md border border-amberbar/50 bg-amberbar/10 px-3 py-2">
      {warnings.map((w, i) => (
        <p key={i} className="py-0.5 text-[12.5px] text-ink">
          {w}
        </p>
      ))}
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
          <Button variant="primary" disabled={busy} onClick={onPick} className="px-8 py-3 text-[14px]">
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
        <Button variant="primary" disabled={busy} onClick={onImport}>
          {busy ? 'Importing…' : 'Import now'}
        </Button>
      </div>
    </Panel>
  )
}

function DoneStep({ summary, onGateway }: { summary: TallyImportSummary; onGateway: () => void }): React.JSX.Element {
  const toast = useToasts()
  const today = todayISO()
  const { data: tb } = useQuery({ queryKey: ['trialBalance', today], queryFn: () => api.reports.trialBalance(today) })
  const rows = tb?.rows ?? []

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
        <p className="mb-3 text-[13px] text-dr font-medium">Import complete.</p>
        <CountsGrid summary={summary} />
        <WarningsBox warnings={summary.warnings} />
      </Panel>

      <div className="mt-4 flex items-center justify-between">
        <p className="text-[12.5px] text-muted">
          Compare with Tally&rsquo;s Trial Balance — should match to the paise.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={printTb}>
            PDF
          </Button>
          <Button variant="primary" onClick={onGateway}>
            Go to Gateway
          </Button>
        </div>
      </div>

      <Panel className="mt-3">
        {rows.length === 0 ? (
          <EmptyState title="No balances yet" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Ledger</th>
                <th>Group</th>
                <th className="r w-40">Debit</th>
                <th className="r w-40">Credit</th>
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
