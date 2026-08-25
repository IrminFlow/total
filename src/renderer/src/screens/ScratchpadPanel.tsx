import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useToasts } from '../state/stores'
import { Button, EmptyState, Money, Panel } from '../components/ui'
import { LedgerPicker } from '../components/pickers'
import { toDisplayDate } from '@shared/dates'
import { SCRATCHPAD_HINT, SCRATCHPAD_LEDGER_NAME } from '@shared/scratchpad'

/**
 * The scratchpad ledger (roadmap B #46).
 *
 * Lives on Exceptions because that is what an unclassified balance is: a thing the books are
 * carrying that nobody has finished. It is deliberately not tucked into Masters — a suspense
 * balance that is only visible where ledgers are edited is one that survives to the year end.
 *
 * Classifying a line EDITS it rather than posting a transfer journal. A journal out of suspense
 * leaves the original entry pointing at Suspense forever, so a year later the ledger shows a
 * payment to Suspense and a separate journal, and nothing on screen connects them to "this was
 * for printing".
 */
export function ScratchpadPanel(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [classifying, setClassifying] = useState<number | null>(null)
  const [target, setTarget] = useState<number | null>(null)

  const { data } = useQuery({ queryKey: ['scratchpad'], queryFn: () => api.scratchpad.list() })

  const create = async (): Promise<void> => {
    try {
      await api.scratchpad.ensure()
      await queryClient.invalidateQueries({ queryKey: ['scratchpad'] })
      await queryClient.invalidateQueries({ queryKey: ['ledgers'] })
      toast.push('success', `${SCRATCHPAD_LEDGER_NAME} is ready to park entries on`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const classify = async (voucherLineId: number): Promise<void> => {
    if (target == null) return
    try {
      const result = await api.scratchpad.classify(voucherLineId, target)
      await queryClient.invalidateQueries({ queryKey: ['scratchpad'] })
      await queryClient.invalidateQueries({ queryKey: ['daybook'] })
      await queryClient.invalidateQueries({ queryKey: ['trialBalance'] })
      toast.push('success', `Classified to ${result.toLedger}`)
      setClassifying(null)
      setTarget(null)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const entries = data?.entries ?? []

  return (
    <Panel className="mb-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-body font-medium">Scratchpad</h3>
        {/* The balance an accountant is trained to want at zero. Coloured only when it is not. */}
        <span className={`num text-small ${data && data.balancePaise !== 0 ? 'text-warn' : 'text-muted'}`}>
          {data?.ledgerId == null ? 'not in use' : <Money paise={data.balancePaise} signed />}
        </span>
      </div>

      {data?.ledgerId == null ? (
        <div className="px-1">
          <p className="mb-2 text-hint text-muted">{SCRATCHPAD_HINT}</p>
          <Button data-testid="btn-scratchpad-create" onClick={() => void create()}>
            Create the scratchpad ledger
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing parked" hint="Anything posted to the scratchpad ledger shows up here until you classify it" />
      ) : (
        <table className="ledger-table" data-testid="rows-scratchpad">
          <thead>
            <tr>
              <th scope="col" className="w-28">Date</th>
              <th scope="col" className="w-36">Voucher</th>
              <th scope="col">Other side</th>
              <th scope="col">Narration</th>
              <th scope="col" className="r w-36">Amount</th>
              <th scope="col" className="w-72" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.voucherLineId}>
                <td className="num">{toDisplayDate(e.date)}</td>
                <td>
                  <Button
                    variant="ghost"
                    className="px-0"
                    data-testid={`btn-scratchpad-voucher-${e.voucherLineId}`}
                    onClick={() => nav.go({ name: 'voucher-entry', voucherId: e.voucherId })}
                  >
                    {e.voucherType} {e.voucherNumber}
                  </Button>
                </td>
                <td className="text-muted">{e.contraNames || e.partyName || '—'}</td>
                <td className="text-muted">{e.narration ?? '—'}</td>
                <td className="r">
                  <Money paise={e.drCr === 'dr' ? e.amount : -e.amount} signed />
                </td>
                <td className="r whitespace-nowrap">
                  {classifying === e.voucherLineId ? (
                    <span className="flex items-center justify-end gap-2">
                      <LedgerPicker
                        value={target}
                        onPick={setTarget}
                        placeholder="Which account?"
                        testId="picker-scratchpad-target"
                        autoFocus
                        className="w-56"
                      />
                      <Button
                        variant="primary"
                        data-testid={`btn-scratchpad-confirm-${e.voucherLineId}`}
                        disabled={target == null}
                        disabledTitle="Choose the account it belongs on"
                        onClick={() => void classify(e.voucherLineId)}
                      >
                        Move
                      </Button>
                      <Button
                        data-testid={`btn-scratchpad-cancel-${e.voucherLineId}`}
                        onClick={() => {
                          setClassifying(null)
                          setTarget(null)
                        }}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      className="row-action"
                      data-testid={`btn-scratchpad-classify-${e.voucherLineId}`}
                      onClick={() => {
                        setClassifying(e.voucherLineId)
                        setTarget(null)
                      }}
                    >
                      Classify
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
