import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BinRow } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, EmptyState, Modal, Money, Panel, SectionTitle, Select, TextInput } from '../../components/ui'
import { toDisplayDate } from '@shared/dates'

export function BinSection(): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['bin'], queryFn: api.vouchers.bin })
  const { user } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [purging, setPurging] = useState<BinRow | null>(null)
  const rows = data ?? []
  // voucher:restore has no explicit minRole (defaults to accountant); voucher:purge is
  // owner-only (see ipc.ts). `user == null` covers the no-users bootstrap window, where every
  // IPC call is ungated. Showing a button a viewer/accountant can't actually use would just be
  // a doomed round-trip to a permission error.
  const canRestore = user == null || user.role !== 'viewer'
  const canPurge = user == null || user.role === 'owner'
  const showActions = canRestore || canPurge

  const restore = async (row: BinRow): Promise<void> => {
    try {
      // A restored voucher affects every report — invalidate everything, not just ['bin'].
      await api.vouchers.restore(row.id)
      await queryClient.invalidateQueries()
      toast.push('success', `Voucher ${row.number} restored`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div>
      <SectionTitle>Bin</SectionTitle>
      <PurgePolicy canEdit={canPurge} />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="Bin is empty" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col" className="w-20">Date</th>
                <th scope="col" className="w-20">No.</th>
                <th scope="col" className="w-28">Type</th>
                <th scope="col">Account</th>
                <th scope="col" className="r w-28">Amount</th>
                <th scope="col" className="w-24">Deleted</th>
                {showActions && <th scope="col" className="r w-36"></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num text-muted">{toDisplayDate(r.date)}</td>
                  <td className="num">{r.number}</td>
                  <td>{r.voucherType}</td>
                  <td>{r.account}</td>
                  <td className="r">
                    <Money paise={r.amount} />
                  </td>
                  <td className="num text-muted">{toDisplayDate(r.deletedAt.slice(0, 10))}</td>
                  {showActions && (
                    <td className="r whitespace-nowrap">
                      {canRestore && (
                        <button className="mr-2 text-small text-blue hover:underline" onClick={() => void restore(r)}>
                          Restore
                        </button>
                      )}
                      {canPurge && (
                        <button className="text-small text-cr hover:underline" onClick={() => setPurging(r)}>
                          Delete forever
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-2 text-hint text-muted">Items are removed permanently after 30 days.</p>
      {purging && <PurgeModal row={purging} onClose={() => setPurging(null)} />}
    </div>
  )
}

function PurgeModal({ row, onClose }: { row: BinRow; onClose: () => void }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)

  const purge = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.vouchers.purge(row.id)
      await queryClient.invalidateQueries({ queryKey: ['bin'] })
      toast.push('success', `Voucher ${row.number} deleted permanently`)
      onClose()
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Delete forever" onClose={onClose}>
      <p className="text-detail text-ink">
        Permanently delete voucher {row.number} ({toDisplayDate(row.date)})? This cannot be undone.
      </p>
      <div className="mt-4">
        <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">
          Type DELETE to confirm
        </span>
        <TextInput value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={confirmText !== 'DELETE' || busy} onClick={() => void purge()}>
          {busy ? 'Deleting…' : 'Delete forever'}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * The bin's auto-purge policy, and what the next purge would take.
 *
 * A policy that silently deletes is a policy nobody can check, so the warning belongs on the
 * screen the vouchers would disappear from rather than in a log. Thirty days was a guess: a shop
 * that bins a mistyped receipt daily wants them gone, and a business under audit wants nothing to
 * disappear at all — which "Never" expresses as a policy rather than as a disabled feature.
 */
function PurgePolicy({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['binPurge'], queryFn: api.vouchers.purgePolicy })

  const save = async (days: number): Promise<void> => {
    try {
      await api.vouchers.setPurgeDays(days)
      await queryClient.invalidateQueries({ queryKey: ['binPurge'] })
      toast.push('success', days === 0 ? 'Nothing will be purged automatically' : `Purging after ${days} days`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mb-3 flex items-center gap-3 rounded-md border border-line bg-panel2 px-3.5 py-2.5 text-body-sm">
      <span>Purge binned vouchers after</span>
      <Select
        data-testid="select-bin-purge-days"
        className="w-36"
        value={data?.days ?? 30}
        disabled={!canEdit}
        onChange={(e) => void save(Number(e.target.value))}
      >
        <option value={0}>Never</option>
        {[30, 90, 180, 365].map((d) => (
          <option key={d} value={d}>
            {d} days
          </option>
        ))}
      </Select>
      <span className="flex-1" />
      {data && data.count > 0 ? (
        <span className="text-amber" data-testid="bin-purge-warning">
          {data.count} will be purged the next time these books open
          {data.oldestDate && `, the oldest dated ${toDisplayDate(data.oldestDate)}`}.
        </span>
      ) : (
        <span className="text-hint text-muted">
          Only vouchers dated on or before the books lock date are ever purged automatically.
        </span>
      )}
    </div>
  )
}
