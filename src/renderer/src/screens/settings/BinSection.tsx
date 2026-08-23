import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BinRow } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, EmptyState, Modal, Money, Panel, SectionTitle, TextInput } from '../../components/ui'
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
      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="Bin is empty" />
        ) : (
          <table className="ledger-table">
            <thead>
              <tr>
                <th className="w-20">Date</th>
                <th className="w-20">No.</th>
                <th className="w-28">Type</th>
                <th>Account</th>
                <th className="r w-28">Amount</th>
                <th className="w-24">Deleted</th>
                {showActions && <th className="r w-36"></th>}
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
