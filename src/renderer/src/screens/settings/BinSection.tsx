import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type BinRow } from '../../lib/client'
import { canWriteOrNoUsers, isOwnerOrNoUsers } from '../../lib/roles'
import { useSession, useToasts } from '../../state/stores'
import { Badge, Button, Modal, Panel, SectionTitle, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { todayISO, toDisplayDate } from '@shared/dates'
import { withCreditHoldOverride } from '../../lib/creditHoldOverride'

const BIN_COLUMNS = defineColumns<BinRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted', width: 104 },
  { id: 'number', header: 'No.', kind: 'text', value: (r) => r.number, className: 'num', width: 84, groupable: false },
  { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherType, width: 84 },
  {
    id: 'account',
    header: 'Account',
    kind: 'text',
    value: (r) => r.account,
    // WP 8.5: entries one Undo binned together come back together — a badge when there are several.
    cell: (r) => (
      <span>
        {r.account}
        {r.undoGroupId != null && (r.undoGroupSize ?? 0) > 1 && (
          <Badge tone="info" className="ml-2" testId={`bin-undo-group-${r.id}`}>
            {`Undone with ${(r.undoGroupSize ?? 1) - 1} more`}
          </Badge>
        )}
      </span>
    ),
    hideable: false
  },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amount, width: 112 },
  { id: 'deleted', header: 'Deleted', kind: 'date', value: (r) => r.deletedAt.slice(0, 10), className: 'text-muted', width: 106 }
])

export function BinSection(): React.JSX.Element {
  const { data, isLoading } = useQuery({ queryKey: ['bin'], queryFn: api.vouchers.bin })
  const { user } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [purging, setPurging] = useState<BinRow | null>(null)
  const rows = data ?? []
  // voucher:restore has no explicit minRole (defaults to accountant); voucher:purge is
  // owner-only (see ipc.ts). `user == null` covers the no-users bootstrap window, where every
  // IPC call is ungated. Showing a button a viewer/accountant can't actually use would just be
  // a doomed round-trip to a permission error.
  const canRestore = canWriteOrNoUsers(user)
  const canPurge = isOwnerOrNoUsers(user)
  const showActions = canRestore || canPurge

  const restore = async (row: BinRow): Promise<void> => {
    try {
      // A restored voucher affects every report — invalidate everything, not just ['bin'].
      const r = await withCreditHoldOverride((o) => api.vouchers.restore(row.id, o), { canOverride: canPurge, what: 'The restore' })
      if (r === null) return
      await queryClient.invalidateQueries()
      const n = r?.restored?.length ?? 1
      toast.push('success', n > 1 ? `Voucher ${row.number} restored with ${n - 1} more undone with it` : `Voucher ${row.number} restored`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div>
      <SectionTitle>Bin</SectionTitle>
      <Panel>
        <DataTable
          viewId="settings-bin"
          testId="settings-bin"
          ariaLabel="Deleted vouchers"
          columns={BIN_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          rowAttrs={(r) => ({ 'data-row-id': r.id })}
          loading={isLoading}
          maxHeight="60vh"
          empty={{ title: 'Bin is empty' }}
          exportOptions={{ title: 'Bin — deleted vouchers', periodLabel: `as on ${toDisplayDate(todayISO())}`, filename: 'bin' }}
          trailingWidth={canRestore && canPurge ? 172 : 110}
          trailing={
            showActions
              ? (r) => (
                  <span className="whitespace-nowrap">
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
                  </span>
                )
              : undefined
          }
        />
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
