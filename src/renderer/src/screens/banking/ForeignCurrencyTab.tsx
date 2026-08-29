import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type FcAccountRow } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import {
  Button,
  DateInput,
  EmptyState,
  Field,
  Modal,
  Money,
  Panel,
  RowAction,
  RowLink,
  SkeletonRows,
  TextInput
} from '../../components/ui'
import { confirmDialog } from '../../lib/dialogs'
import { toDisplayDate } from '@shared/dates'
import { formatFc, formatRate, parseRate, revalue } from '@shared/fx'

/**
 * Foreign-currency accounts and their revaluation (roadmap F #140).
 *
 * The screen has to say three numbers at once and keep them distinguishable: how many dollars the
 * account holds, how many rupees the books say those dollars are worth, and what they would be
 * worth at today's rate. The gap between the last two is an unrealised gain or loss — a real
 * posting with real tax consequences under AS 11, not a display adjustment — so it is posted as a
 * journal that appears in the day book, carries the rate it used, and is undone by binning it.
 */
export function ForeignCurrencyTab(): React.JSX.Element {
  const { to } = useSession()
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [revaluing, setRevaluing] = useState<FcAccountRow | null>(null)

  const { data: accounts, isLoading } = useQuery({ queryKey: ['fxAccounts', to], queryFn: () => api.fx.accounts(to) })
  const { data: history } = useQuery({ queryKey: ['fxRevaluations'], queryFn: () => api.fx.list(null) })

  const remove = async (id: number, name: string, asOn: string): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Remove this revaluation?',
      message: `${name} as on ${toDisplayDate(asOn)}. The journal it posted goes to the bin — it was a real entry, so it stays visible there.`,
      confirmLabel: 'Remove'
    })
    if (!ok) return
    try {
      await api.fx.remove(id)
      await queryClient.invalidateQueries({ queryKey: ['fxAccounts'] })
      await queryClient.invalidateQueries({ queryKey: ['fxRevaluations'] })
      toast.push('success', 'Revaluation removed')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <>
      <Panel className="mb-3">
        <h3 className="mb-2 text-body font-medium">Foreign-currency accounts as on {toDisplayDate(to)}</h3>
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : !accounts?.length ? (
          <EmptyState
            title="No account keeps a foreign currency"
            hint="Set a currency on a ledger under Masters → Ledgers to make it a foreign-currency account"
          />
        ) : (
          <table className="ledger-table" data-testid="rows-fx-accounts">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="r w-40">Foreign balance</th>
                <th scope="col" className="r w-40">As per books</th>
                <th scope="col" className="w-44">Last revalued</th>
                <th scope="col" className="w-32" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.ledgerId}>
                  <td>{a.ledgerName}</td>
                  <td className="r num">{formatFc(a.fcMinor, a.decimals, a.currencyCode)}</td>
                  <td className="r">
                    <Money paise={a.bookPaise} signed />
                    {/* Rupee-only movements on a foreign account are real (a rupee bank charge on
                        a dollar account), so this is stated rather than hidden or treated as an
                        error — but it is stated, because it is also how a missing foreign amount
                        shows up. */}
                    {a.unmatchedPaise !== 0 && (
                      <span
                        className="ml-2 text-caption text-muted"
                        title="Rupee movements on this account that carry no foreign amount"
                      >
                        (incl. rupee-only {(a.unmatchedPaise / 100).toFixed(0)})
                      </span>
                    )}
                  </td>
                  <td className="num text-muted">
                    {a.lastRevaluedOn ? `${toDisplayDate(a.lastRevaluedOn)} at ${formatRate(a.lastRateMicro ?? 0)}` : 'never'}
                  </td>
                  <td className="r whitespace-nowrap">
                    <RowAction
                      className="row-action"
                      data-testid={`btn-fx-revalue-${a.ledgerId}`}
                      onClick={() => setRevaluing(a)}
                    >
                      Revalue
                    </RowAction>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <h3 className="mb-2 text-body font-medium">Revaluations posted</h3>
        {!history?.length ? (
          <p className="px-1 text-hint text-muted">None yet.</p>
        ) : (
          <table className="ledger-table" data-testid="rows-fx-revaluations">
            <thead>
              <tr>
                <th scope="col" className="w-32">As on</th>
                <th scope="col">Account</th>
                <th scope="col" className="r w-36">Rate used</th>
                <th scope="col" className="r w-40">Was</th>
                <th scope="col" className="r w-40">Restated to</th>
                <th scope="col" className="r w-40">Difference</th>
                <th scope="col" className="w-40">Journal</th>
                <th scope="col" className="w-28" />
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td className="num">{toDisplayDate(r.asOn)}</td>
                  <td>{r.ledgerName}</td>
                  {/* The rate is on the row because it is the point: this is the rate that was
                      used, not the rate a table would give if asked again today. */}
                  <td className="r num">{formatRate(r.closingRateMicro)}</td>
                  <td className="r">
                    <Money paise={r.bookPaise} signed />
                  </td>
                  <td className="r">
                    <Money paise={r.restatedPaise} signed />
                  </td>
                  <td className={`r ${r.differencePaise < 0 ? 'text-cr' : 'text-dr'}`}>
                    <Money paise={r.differencePaise} signed />
                  </td>
                  <td>
                    {r.voucherId && r.voucherNumber ? (
                      <RowLink
                        className="px-0"
                        data-testid={`btn-fx-voucher-${r.id}`}
                        onClick={() => nav.go({ name: 'voucher-entry', voucherId: r.voucherId! })}
                      >
                        {r.voucherNumber}
                      </RowLink>
                    ) : (
                      <span className="text-muted">binned</span>
                    )}
                  </td>
                  <td className="r whitespace-nowrap">
                    <RowAction
                      className="row-action"
                      data-testid={`btn-fx-remove-${r.id}`}
                      onClick={() => void remove(r.id, r.ledgerName, r.asOn)}
                    >
                      Remove
                    </RowAction>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {revaluing && <RevalueModal account={revaluing} asOn={to} onClose={() => setRevaluing(null)} />}
    </>
  )
}

function RevalueModal({
  account,
  asOn,
  onClose
}: {
  account: FcAccountRow
  asOn: string
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(asOn)
  const [rateText, setRateText] = useState(account.lastRateMicro ? formatRate(account.lastRateMicro) : '')
  const rateMicro = parseRate(rateText)

  // Computed here from the SAME pure function the service posts with, so the number on screen and
  // the number that gets posted cannot be two different arithmetics.
  const result =
    rateMicro === null
      ? null
      : revalue({
          fcMinor: account.fcMinor,
          bookPaise: account.bookPaise,
          closingRateMicro: rateMicro,
          decimals: account.decimals
        })

  const post = async (): Promise<void> => {
    if (rateMicro === null) return
    try {
      await api.fx.revalue({ ledgerId: account.ledgerId, asOn: date, closingRateMicro: rateMicro, narration: null })
      await queryClient.invalidateQueries({ queryKey: ['fxAccounts'] })
      await queryClient.invalidateQueries({ queryKey: ['fxRevaluations'] })
      await queryClient.invalidateQueries({ queryKey: ['daybook'] })
      toast.push('success', `${account.ledgerName} revalued`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Modal title={`Revalue ${account.ledgerName}`} onClose={onClose}>
      <div className="grid gap-3">
        <Field label="As on">
          <DateInput testId="input-fx-date" context={date} value={date} onChange={setDate} />
        </Field>
        <Field
          label={`Closing rate — rupees per ${account.currencyCode}`}
          hint="Up to six decimals. A seventh is refused rather than rounded away, because the rate you type is the rate that gets recorded on the entry."
          error={rateText.trim() && rateMicro === null ? 'That is not a rate this app can store exactly' : null}
        >
          <TextInput
            data-testid="input-fx-rate"
            aria-label="Closing rate"
            className="num text-right"
            value={rateText}
            onChange={(e) => setRateText(e.target.value)}
            placeholder="83.4525"
          />
        </Field>

        <table className="ledger-table" data-testid="fx-preview">
          <tbody>
            <tr>
              <td>Balance</td>
              <td className="r num">{formatFc(account.fcMinor, account.decimals, account.currencyCode)}</td>
            </tr>
            <tr>
              <td>As per books</td>
              <td className="r">
                <Money paise={account.bookPaise} signed />
              </td>
            </tr>
            <tr>
              <td>Restated at this rate</td>
              <td className="r">{result ? <Money paise={result.restatedPaise} signed /> : '—'}</td>
            </tr>
            <tr className="total-row">
              <td>{result?.effect === 'loss' ? 'Unrealised loss' : 'Unrealised gain'}</td>
              <td className={`r ${result && result.differencePaise < 0 ? 'text-cr' : ''}`}>
                {result ? <Money paise={result.differencePaise} signed /> : '—'}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="px-1 text-hint text-muted">
          Posted as a journal: {account.ledgerName} {result?.ledgerSide === 'dr' ? 'debited' : 'credited'} against
          Exchange Gain / Loss (Unrealised). The restated figure becomes the new book value — AS 11 does not reverse it
          next period, and reversing would report the same movement twice.
        </p>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="btn-fx-post"
            disabled={!result || result.isNil}
            disabledTitle={result?.isNil ? 'The rate has not moved against the books' : 'Type a closing rate first'}
            onClick={() => void post()}
          >
            Post revaluation
          </Button>
        </div>
      </div>
    </Modal>
  )
}
