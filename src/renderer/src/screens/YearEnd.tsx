import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fyFromStartYear, fyOf, todayISO, toDisplayDate } from '@shared/dates'
import { planClose } from '@shared/yearEnd'
import { api } from '../lib/client'
import { useNav, useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, ScrollList, SectionTitle, Select, SkeletonRows, TextInput } from '../components/ui'

type Step = 1 | 2 | 3

export function YearEndScreen(): React.JSX.Element {
  const { info, setPeriod } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()

  const currentFy = fyOf(todayISO())
  // Only completed FYs are closeable — the running FY isn't over yet, so it never appears here.
  const lastCompletedStartYear = currentFy.startYear - 1
  const years: number[] = []
  for (let y = lastCompletedStartYear; y >= (info?.booksFrom ?? lastCompletedStartYear); y--) years.push(y)
  const noCompletedFy = years.length === 0

  const [fyStartYear, setFyStartYear] = useState(years[0] ?? lastCompletedStartYear)
  const [step, setStep] = useState<Step>(1)
  const [confirmText, setConfirmText] = useState('')
  const [posting, setPosting] = useState(false)
  const [result, setResult] = useState<{ voucherId: number; netProfit: number; lockedUpTo: string } | null>(null)

  const fy = fyFromStartYear(fyStartYear)

  const { data: preview, isLoading } = useQuery({
    queryKey: ['yearEndPreview', fyStartYear],
    queryFn: () => api.yearEnd.preview(fyStartYear),
    enabled: !noCompletedFy
  })

  const incomeRows = (preview?.rows ?? []).filter((r) => r.nature === 'income')
  const expenseRows = (preview?.rows ?? []).filter((r) => r.nature === 'expense')

  const plan = useMemo(() => (preview ? planClose(preview.rows) : { lines: [], netProfit: 0 }), [preview])
  const nameOf = (ledgerId: number): string => preview?.rows.find((r) => r.ledgerId === ledgerId)?.name ?? ''
  const retainedLine =
    plan.netProfit !== 0
      ? { drCr: (plan.netProfit > 0 ? 'cr' : 'dr') as 'dr' | 'cr', amount: Math.abs(plan.netProfit) }
      : null

  const changeYear = (y: number): void => {
    setFyStartYear(y)
    setStep(1)
    setConfirmText('')
    setResult(null)
  }

  const post = async (): Promise<void> => {
    if (posting || !preview) return
    setPosting(true)
    try {
      // The P&L may have moved since step 2 (another voucher posted in the meantime) — re-check
      // right before posting rather than trust a stale preview.
      const fresh = await api.yearEnd.preview(fyStartYear)
      if (fresh.netProfit !== preview.netProfit || fresh.alreadyClosed) {
        toast.push('error', 'The P&L changed since you reviewed it — recheck before closing.')
        await queryClient.invalidateQueries({ queryKey: ['yearEndPreview', fyStartYear] })
        setStep(1)
        return
      }
      const r = await api.yearEnd.close(fyStartYear)
      setResult(r)
      const nextFy = fyFromStartYear(fyStartYear + 1)
      setPeriod(nextFy.from, nextFy.to)
      await queryClient.invalidateQueries()
      toast.push('success', `FY ${fy.label} closed — books locked up to ${toDisplayDate(r.lockedUpTo)}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPosting(false)
    }
  }

  if (noCompletedFy) {
    return (
      <div className="mx-auto max-w-2xl">
        <SectionTitle>Year-end close</SectionTitle>
        <Panel>
          <EmptyState
            title="The first financial year is still in progress"
            hint={`Come back after 31 Mar ${currentFy.startYear + 1}`}
          />
        </Panel>
      </div>
    )
  }

  if (result) {
    return (
      <div className="mx-auto max-w-2xl">
        <SectionTitle>Year-end close</SectionTitle>
        <Panel className="p-6 text-center">
          <p className="text-lead font-medium">FY {fy.label} closed</p>
          <p className="mt-1 text-detail text-muted">
            {result.netProfit >= 0 ? 'Net profit' : 'Net loss'} of <Money paise={Math.abs(result.netProfit)} /> carried to Retained
            Earnings. Books are locked up to {toDisplayDate(result.lockedUpTo)}.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="primary" onClick={() => nav.go({ name: 'voucher-entry', voucherId: result.voucherId })}>
              Open closing voucher
            </Button>
            <Button
              onClick={() => {
                setResult(null)
                changeYear(Math.min(fyStartYear + 1, lastCompletedStartYear))
              }}
            >
              Done
            </Button>
          </div>
        </Panel>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl">
      <SectionTitle
        right={
          <Select value={fyStartYear} onChange={(e) => changeYear(Number(e.target.value))} className="w-36">
            {years.map((y) => (
              <option key={y} value={y}>
                FY {fyFromStartYear(y).label}
              </option>
            ))}
          </Select>
        }
      >
        Year-end close
      </SectionTitle>

      <div className="mb-4 flex items-center gap-2 text-small font-medium text-muted">
        <StepDot n={1} step={step} label="Review P&L" />
        <span className="text-line">—</span>
        <StepDot n={2} step={step} label="Closing journal" />
        <span className="text-line">—</span>
        <StepDot n={3} step={step} label="Confirm" />
      </div>

      {preview?.alreadyClosed && (
        <Panel className="mb-4 border-cr/40 bg-cr/5 p-4">
          <p className="text-detail font-medium text-cr">Books for FY {fy.label} are already closed.</p>
          <p className="mt-1 text-body-sm text-muted">Pick a different financial year to continue, or open the closing voucher from the day book.</p>
        </Panel>
      )}

      {step === 1 && (
        <>
          <Panel className="mb-4" scroll={{ maxH: '55vh' }}>
            {isLoading ? (
              <SkeletonRows />
            ) : !incomeRows.length && !expenseRows.length ? (
              <EmptyState title="No income or expense activity in this FY" hint="Nothing to close for this period" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th scope="col">Ledger</th>
                    <th scope="col" className="w-24">Nature</th>
                    <th scope="col" className="r w-40">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {incomeRows.map((r) => (
                    <tr key={r.ledgerId}>
                      <td>{r.name}</td>
                      <td className="text-muted">Income</td>
                      <td className="r"><Money paise={r.net} signed /></td>
                    </tr>
                  ))}
                  {expenseRows.map((r) => (
                    <tr key={r.ledgerId}>
                      <td>{r.name}</td>
                      <td className="text-muted">Expense</td>
                      <td className="r"><Money paise={r.net} signed /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          {preview && (
            <Panel className="mb-4 flex items-center justify-between px-5 py-3">
              <span className="text-body font-medium">{preview.netProfit >= 0 ? 'Net profit for FY' : 'Net loss for FY'} {fy.label}</span>
              <Money
                paise={Math.abs(preview.netProfit)}
                className={`text-title font-semibold ${preview.netProfit >= 0 ? 'text-dr' : 'text-cr'}`}
              />
            </Panel>
          )}
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!preview || preview.alreadyClosed || (!incomeRows.length && !expenseRows.length)}
              onClick={() => setStep(2)}
            >
              Next: review journal
            </Button>
          </div>
        </>
      )}

      {step === 2 && preview && (
        <>
          <Panel className="mb-4">
            <div className="border-b border-line px-4 py-2.5 text-body-sm text-muted">
              Journal · dated {toDisplayDate(fy.to)} · narration “Year-end closing entry [year-end close FY{fyStartYear}]”
            </div>
            <ScrollList maxH="50vh">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col">Ledger</th>
                  <th scope="col" className="r w-28">Debit</th>
                  <th scope="col" className="r w-28">Credit</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((l) => (
                  <tr key={l.ledgerId}>
                    <td>{nameOf(l.ledgerId)}</td>
                    <td className="r">{l.drCr === 'dr' ? <Money paise={l.amount} /> : null}</td>
                    <td className="r">{l.drCr === 'cr' ? <Money paise={l.amount} /> : null}</td>
                  </tr>
                ))}
                {retainedLine && (
                  <tr className="bg-amberbar/10 font-medium">
                    <td>Retained Earnings</td>
                    <td className="r">{retainedLine.drCr === 'dr' ? <Money paise={retainedLine.amount} /> : null}</td>
                    <td className="r">{retainedLine.drCr === 'cr' ? <Money paise={retainedLine.amount} /> : null}</td>
                  </tr>
                )}
              </tbody>
            </table>
            </ScrollList>
          </Panel>
          <Panel className="mb-4 border-amber/40 bg-amber/5 p-4">
            <p className="text-detail font-medium">
              Posting will lock all entries up to {toDisplayDate(fy.to)}.
            </p>
            <p className="mt-1 text-body-sm text-muted">
              This cannot be undone from this wizard — an owner can adjust the lock date later from Settings → About.
            </p>
          </Panel>
          <div className="flex justify-between">
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" onClick={() => setStep(3)}>
              Next: confirm
            </Button>
          </div>
        </>
      )}

      {step === 3 && preview && (
        <>
          <Panel className="mb-4 p-5">
            <p className="text-body">
              Closing FY {fy.label} will post the journal above and lock the books up to {toDisplayDate(fy.to)}. Type{' '}
              <span className="font-mono font-semibold">CLOSE</span> to confirm.
            </p>
            <div className="mt-3 max-w-xs">
              <TextInput
                data-testid="input-year-end-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="CLOSE"
                autoFocus
              />
              {confirmText !== '' && confirmText !== 'CLOSE' && (
                <p data-testid="year-end-confirm-error" className="mt-1.5 text-small text-cr">
                  Type CLOSE exactly (all caps) to enable the button.
                </p>
              )}
            </div>
          </Panel>
          <div className="flex justify-between">
            <Button onClick={() => setStep(2)}>Back</Button>
            <Button variant="primary" data-testid="btn-year-end-post" disabled={confirmText !== 'CLOSE' || posting} onClick={() => void post()}>
              {posting ? 'Posting…' : 'Post closing entry & lock'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function StepDot({ n, step, label }: { n: Step; step: Step; label: string }): React.JSX.Element {
  const active = n === step
  const done = n < step
  return (
    <span className={`flex items-center gap-1.5 ${active ? 'text-ink' : done ? 'text-dr' : ''}`}>
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-label ${
          active ? 'bg-amberbar text-onamber' : done ? 'bg-dr/20 text-dr' : 'bg-panel2 text-muted'
        }`}
      >
        {n}
      </span>
      {label}
    </span>
  )
}
