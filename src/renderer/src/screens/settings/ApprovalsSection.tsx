import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BankChangeRequest, type PendingVoucher } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { AmountInput, Button, Money, Panel, RowAction, SectionTitle, TextInput } from '../../components/ui'
import { formatPaise } from '@shared/money'
import { maskAccount } from '@shared/bankDetails'
import { toDisplayDate } from '@shared/dates'

/**
 * The owner's desk: what is waiting for them, and the one number that decides how much waits.
 *
 * Two queues, deliberately on one screen. They are the same act — somebody else changed
 * something and the owner has to look — and splitting them across two places would mean two
 * places to forget to look.
 */
export function ApprovalsSection(): React.JSX.Element {
  // Asked of main rather than read off the store: the store learns about a session at sign-in,
  // and a company that gained its first users a moment ago (or an auditor session opened from
  // the next tab along) has a live role the store has not been told about. Getting this wrong
  // disables the owner's own Approve button, which is the one thing this screen is for.
  const { data: user } = useQuery({ queryKey: ['authCurrent'], queryFn: () => api.auth.current() })
  const isOwner = user?.role === 'owner'

  return (
    <div>
      <SectionTitle>Approvals</SectionTitle>
      <ThresholdPanel canEdit={isOwner} />
      <PendingVouchers canDecide={isOwner} />
      <PendingBankChanges />
    </div>
  )
}

/** The threshold itself. Empty means off; ₹0 means every entry waits. Both are real answers. */
function ThresholdPanel({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['approvalThreshold'], queryFn: () => api.approvals.thresholdGet() })
  const [draft, setDraft] = useState<number | null>(null)
  const current = data?.threshold ?? null
  const value = draft ?? current ?? 0

  const save = async (threshold: number | null): Promise<void> => {
    try {
      await api.approvals.thresholdSet(threshold)
      void qc.invalidateQueries({ queryKey: ['approvalThreshold'] })
      void qc.invalidateQueries({ queryKey: ['approvals'] })
      toast.push(
        'success',
        threshold === null
          ? 'Approvals are off. Every entry goes straight into the books.'
          : threshold === 0
            ? 'Every entry an accountant makes now waits for you.'
            : `Entries above ${formatPaise(threshold)} now wait for you.`
      )
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="p-4">
      <p className="text-detail font-medium">Entries that need your say-so</p>
      <p className="mt-1 max-w-prose text-body-sm text-muted">
        Above this amount, a voucher entered by an accountant waits here instead of going into the books. Your
        own entries never wait — you are the person who would be approving them.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <AmountInput
          testId="input-approval-threshold"
          paise={value}
          onPaise={(paise) => setDraft(paise ?? 0)}
          className="w-44"
        />
        <Button
          variant="primary"
          data-testid="btn-approval-threshold-save"
          disabled={!canEdit}
          onClick={() => void save(value)}
        >
          Save
        </Button>
        <Button
          variant="ghost"
          data-testid="btn-approval-threshold-off"
          disabled={!canEdit || current === null}
          onClick={() => {
            setDraft(null)
            void save(null)
          }}
        >
          Switch off
        </Button>
        <span data-testid="approval-threshold-state" className="text-body-sm text-muted">
          {current === null
            ? 'Off — nothing waits.'
            : current === 0
              ? 'Every entry with an amount waits.'
              : `Above ${formatPaise(current)}.`}
        </span>
      </div>
      {!canEdit && <p className="mt-2 text-hint text-muted">Only the owner can change this.</p>}
    </Panel>
  )
}

function PendingVouchers({ canDecide }: { canDecide: boolean }): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['approvals'], queryFn: () => api.approvals.list() })
  const [note, setNote] = useState<Record<number, string>>({})

  const decide = async (row: PendingVoucher, approve: boolean): Promise<void> => {
    try {
      await api.approvals.decide(row.voucherId, approve, note[row.voucherId] || null)
      void qc.invalidateQueries({ queryKey: ['approvals'] })
      // The books have just changed shape, so everything computed from vouchers is stale.
      void qc.invalidateQueries({ queryKey: ['daybook'] })
      void qc.invalidateQueries({ queryKey: ['trialBalance'] })
      void qc.invalidateQueries({ queryKey: ['dashboard'] })
      toast.push('success', approve ? `${row.voucherType} ${row.number} approved` : `${row.voucherType} ${row.number} refused`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const pending = data?.pending ?? []

  return (
    <Panel className="mt-4 p-4" data-testid="approvals-pending">
      <p className="text-detail font-medium">
        Waiting{' '}
        <span data-testid="badge-approvals-pending" className="ml-1 rounded-md bg-panel2 px-1.5 py-0.5 num text-caption text-muted">
          {pending.length}
        </span>
      </p>
      {pending.length === 0 ? (
        <p className="mt-2 text-body-sm text-muted">Nothing is waiting for you.</p>
      ) : (
        <table className="ledger-table mt-3">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Voucher</th>
              <th scope="col">Party</th>
              <th scope="col">Entered by</th>
              <th scope="col" className="r w-36">Amount</th>
              <th scope="col" className="w-64">Decision</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((row) => (
              <tr key={row.voucherId} data-testid={`approval-row-${row.voucherId}`}>
                <td className="num">{toDisplayDate(row.date)}</td>
                <td>
                  {row.voucherType} <span className="num">{row.number}</span>
                </td>
                <td className="text-muted">{row.partyName ?? '—'}</td>
                <td className="text-muted">{row.enteredBy ?? 'unknown'}</td>
                <td className="r">
                  <Money paise={row.amount} />
                </td>
                <td>
                  <div className="flex items-center gap-1.5">
                    <TextInput
                      data-testid={`input-approval-note-${row.voucherId}`}
                      placeholder="Why (optional)"
                      value={note[row.voucherId] ?? ''}
                      onChange={(e) => setNote((n) => ({ ...n, [row.voucherId]: e.target.value }))}
                      className="w-32"
                    />
                    <Button
                      variant="primary"
                      data-testid={`btn-approve-${row.voucherId}`}
                      disabled={!canDecide}
                      onClick={() => void decide(row, true)}
                    >
                      Approve
                    </Button>
                    <RowAction
                      data-testid={`btn-reject-${row.voucherId}`}
                      disabled={!canDecide}
                      onClick={() => void decide(row, false)}
                    >
                      Refuse
                    </RowAction>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!canDecide && pending.length > 0 && (
        <p className="mt-2 text-hint text-muted">Only the owner can decide these, and never their own entry.</p>
      )}
      <DecidedList rows={data?.decided ?? []} />
    </Panel>
  )
}

function DecidedList({ rows }: { rows: PendingVoucher[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return (
    <div className="mt-3">
      <button className="text-small text-muted hover:text-ink" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Recently decided ({rows.length})
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1 text-body-sm">
          {rows.map((row) => (
            <li key={row.voucherId} className="flex items-center gap-2">
              <span className={row.state === 'approved' ? 'text-dr' : 'text-cr'}>
                {row.state === 'approved' ? 'Approved' : 'Refused'}
              </span>
              <span>
                {row.voucherType} <span className="num">{row.number}</span>
              </span>
              <span className="num text-muted">{formatPaise(row.amount)}</span>
              <span className="text-muted">by {row.decidedBy ?? '—'}</span>
              {row.note && <span className="truncate text-muted">&ldquo;{row.note}&rdquo;</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Bank-detail changes waiting for a second person (roadmap V #388).
 *
 * Not owner-only: an accountant may confirm an owner's change and vice versa. What matters is
 * that it is not the same person twice, which is the rule the service enforces.
 */
function PendingBankChanges(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { data: user } = useQuery({ queryKey: ['authCurrent'], queryFn: () => api.auth.current() })
  const { data } = useQuery({ queryKey: ['bankChanges'], queryFn: () => api.bankChanges.list() })
  const pending = data?.pending ?? []

  const decide = async (row: BankChangeRequest, approve: boolean): Promise<void> => {
    try {
      await api.bankChanges.decide(row.id, approve)
      void qc.invalidateQueries({ queryKey: ['bankChanges'] })
      void qc.invalidateQueries({ queryKey: ['ledgers'] })
      toast.push('success', approve ? `${row.ledgerName}'s bank details updated` : 'Change refused; the old account stands')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <Panel className="mt-4 p-4" data-testid="bank-changes-pending">
      <p className="text-detail font-medium">
        Bank details waiting for a second pair of eyes{' '}
        <span data-testid="badge-bank-changes" className="ml-1 rounded-md bg-panel2 px-1.5 py-0.5 num text-caption text-muted">
          {pending.length}
        </span>
      </p>
      <p className="mt-1 max-w-prose text-body-sm text-muted">
        Changing where a supplier is paid is the easiest fraud there is, so it takes two people once this
        company has two. Confirm it against something other than the email that asked for it.
      </p>
      {pending.length === 0 ? (
        <p className="mt-2 text-body-sm text-muted">Nothing waiting.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {pending.map((row) => (
            <li key={row.id} className="rounded-md border border-line px-3 py-2" data-testid={`bank-change-${row.id}`}>
              <p className="text-body-sm">
                <b>{row.ledgerName}</b> — <span className="num">{maskAccount(row.oldAccount)}</span> →{' '}
                <span className="num text-ink">{maskAccount(row.newAccount)}</span>
                {row.newIfsc && <span className="num text-muted"> ({row.newIfsc})</span>}
              </p>
              <p className="mt-0.5 text-caption text-muted">
                Asked for by {row.requestedBy ?? 'someone'} on {row.requestedAt.slice(0, 10)}
                {row.requestedBy === user?.name ? ' — you, so somebody else has to confirm it' : ''}
              </p>
              <div className="mt-2 flex gap-1.5">
                <Button variant="primary" data-testid={`btn-bank-change-approve-${row.id}`} onClick={() => void decide(row, true)}>
                  Confirm
                </Button>
                <Button variant="ghost" data-testid={`btn-bank-change-reject-${row.id}`} onClick={() => void decide(row, false)}>
                  Refuse
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(data?.decided ?? []).length === 0 ? null : (
        <p className="mt-3 text-hint text-muted">
          {data!.decided.length} decided earlier — the full record is in the audit trail.
        </p>
      )}
    </Panel>
  )
}
