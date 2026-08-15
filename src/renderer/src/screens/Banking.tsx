import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel, SectionTitle, Select } from '../components/ui'
import { parseSmartDate, toDisplayDate, todayISO } from '@shared/dates'

export function BankingScreen(): React.JSX.Element {
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: ledgers } = useQuery({ queryKey: ['bankLedgers'], queryFn: api.bank.ledgers })
  const [ledgerId, setLedgerId] = useState<number | null>(null)

  useEffect(() => {
    if (ledgerId == null && ledgers?.length) setLedgerId(ledgers[0]!.id)
  }, [ledgers, ledgerId])

  const { data: recon } = useQuery({
    queryKey: ['bankRecon', ledgerId, from, to],
    queryFn: () => api.bank.recon(ledgerId!, from, to),
    enabled: ledgerId != null
  })

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['bankRecon'] }).then(() => undefined)

  const markToday = async (lineId: number, current: string | null): Promise<void> => {
    await api.bank.setBankDate(lineId, current ? null : todayISO())
    await refresh()
  }

  const editBankDate = async (lineId: number, current: string | null): Promise<void> => {
    const answer = window.prompt('Bank date (e.g. 15-08-2026, or 7, 7/4, t, y). Empty clears it.', current ? toDisplayDate(current) : '')
    if (answer === null) return
    if (answer.trim() === '') {
      await api.bank.setBankDate(lineId, null)
    } else {
      const parsed = parseSmartDate(answer, todayISO())
      if (!parsed) return void toast.push('error', 'That date didn’t parse')
      await api.bank.setBankDate(lineId, parsed)
    }
    await refresh()
  }

  const doImport = async (): Promise<void> => {
    if (ledgerId == null) return
    const result = await api.bank.importCsv(ledgerId)
    if (!result) return
    toast.push(
      result.matched > 0 ? 'success' : 'warning',
      `${result.matched} of ${result.statementRows} statement rows matched and reconciled${result.unmatched.length ? `; ${result.unmatched.length} unmatched` : ''}`
    )
    if (result.unmatched.length) {
      const first = result.unmatched.slice(0, 3).map((u) => `${u.date} ${u.kind} ₹${(u.amount / 100).toLocaleString('en-IN')}`).join(' · ')
      toast.push('info', `Unmatched: ${first}${result.unmatched.length > 3 ? ' …' : ''} — enter these as vouchers, then re-import`)
    }
    await refresh()
  }

  if (ledgers && ledgers.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <SectionTitle>Bank reconciliation</SectionTitle>
        <Panel>
          <EmptyState title="No bank ledgers yet" hint="Create a ledger under Bank Accounts in Masters, then reconcile it here" />
        </Panel>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl">
      <SectionTitle
        right={
          <div className="flex items-center gap-2">
            <Select value={ledgerId ?? ''} onChange={(e) => setLedgerId(Number(e.target.value))} className="w-52">
              {(ledgers ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void doImport()}>
              Import statement CSV
            </Button>
          </div>
        }
      >
        Bank reconciliation
      </SectionTitle>

      {recon && (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Balance as per books</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.bookBalance} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Deposits not in bank</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.unreconciledDeposits} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Withdrawals not in bank</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.unreconciledWithdrawals} /></p>
            </Panel>
            <Panel className="px-4 py-2.5">
              <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">Balance as per bank</p>
              <p className="num mt-1 text-[15px] font-medium"><Money paise={recon.bankBalance} /></p>
            </Panel>
          </div>

          <Panel>
            {recon.rows.length === 0 ? (
              <EmptyState title="No bank entries in this period" />
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th className="w-24">Date</th>
                    <th>Particulars</th>
                    <th className="w-28">Instrument</th>
                    <th className="r w-32">Deposit</th>
                    <th className="r w-32">Withdrawal</th>
                    <th className="w-32">Bank date</th>
                    <th className="w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {recon.rows.map((r) => (
                    <tr key={r.lineId} className={r.bankDate ? 'opacity-60' : ''}>
                      <td className="num text-muted">{toDisplayDate(r.date)}</td>
                      <td className="max-w-56 truncate">{r.particulars}</td>
                      <td className="num text-muted">{r.instrumentNo ?? ''}</td>
                      <td className="r"><Money paise={r.deposit} /></td>
                      <td className="r"><Money paise={r.withdrawal} /></td>
                      <td>
                        <button className="num text-[12px] text-blue hover:underline" onClick={() => void editBankDate(r.lineId, r.bankDate)}>
                          {r.bankDate ? toDisplayDate(r.bankDate) : 'Set date'}
                        </button>
                      </td>
                      <td className="r">
                        <button className="text-[12px] text-muted hover:text-ink" onClick={() => void markToday(r.lineId, r.bankDate)}>
                          {r.bankDate ? 'Clear' : 'Cleared today'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <p className="mt-2 text-[11.5px] text-muted">
            Import a statement CSV (date + debit/credit columns) to auto-match by amount and date; anything left over, set the bank date by hand.
          </p>
        </>
      )}
    </div>
  )
}
