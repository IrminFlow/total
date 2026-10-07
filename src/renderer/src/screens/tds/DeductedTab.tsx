// Deducted tab: every recorded deduction in the period — edit (the voucher's own editor, whose
// TDS banner changes section / rate / manual amount) and delete (server pipeline; the voucher
// stays balanced, a bill gets its supplier credit back).
import { useQuery } from '@tanstack/react-query'
import { DEDUCTEE_TYPE_LABELS } from '@shared/tds'
import { formatPaise } from '@shared/money'
import { api, type TdsDeductedRow } from '../../lib/client'
import { Badge, Button } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher, useCanEditMasters } from '../../lib/drill'
import { confirmDialog } from '../../lib/dialogs'
import { pctText, useTdsAction, type TdsPeriod } from './common'

const STATUS = {
  unallocated: { label: 'Not on a challan', tone: 'warning' },
  allocated: { label: 'On a challan', tone: 'info' },
  paid: { label: 'Deposited', tone: 'success' }
} as const

export const DEDUCTED_COLUMNS = defineColumns<TdsDeductedRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  {
    id: 'voucher', header: 'Voucher', kind: 'text', value: (r) => r.voucherNumber, width: 120, hideable: false, groupable: false,
    cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.voucherNumber} />
  },
  { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 160, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 116, text: (r) => r.pan ?? 'Missing', className: 'num' },
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: 92, className: 'num' },
  { id: 'base', header: 'Base', kind: 'money', value: (r) => r.basePaise, aggregate: 'sum', width: 140 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (r) => (r.rateBp == null ? null : r.rateBp / 100), text: (r) => (r.isManual ? 'Manual' : pctText(r.rateBp)), width: 80 },
  { id: 'tds', header: 'TDS', kind: 'money', value: (r) => r.tdsPaise, aggregate: 'sum', width: 130 },
  { id: 'deductee', header: 'Deductee type', kind: 'text', value: (r) => (r.deducteeType ? DEDUCTEE_TYPE_LABELS[r.deducteeType] : null), width: 140, defaultHidden: true },
  { id: 'certificate', header: 'Certificate', kind: 'text', value: (r) => r.certificateNo, width: 120, text: (r) => r.certificateNo ?? '—' },
  {
    id: 'challan', header: 'Challan', kind: 'enum', value: (r) => r.challanStatus, width: 150,
    options: Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label })),
    text: (r) => STATUS[r.challanStatus].label + (r.challanNo ? ` ${r.challanNo}` : ''),
    cell: (r) => (
      <Badge tone={STATUS[r.challanStatus].tone}>
        {STATUS[r.challanStatus].label}
        {r.challanNo ? ` · ${r.challanNo}` : ''}
      </Badge>
    )
  }
])

export function DeductedTab({ period }: { period: TdsPeriod }): React.JSX.Element {
  const canEdit = useCanEditMasters()
  const { busy, run } = useTdsAction()
  const { data: rows, isLoading } = useQuery({
    queryKey: ['tds', 'deducted', period.from, period.to],
    queryFn: () => api.tds.deducted(period.from, period.to)
  })

  const remove = async (r: TdsDeductedRow): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Delete deduction',
      message: `Remove the ${formatPaise(r.tdsPaise, { symbol: true })} TDS from ${r.voucherNumber}? The payable credit goes back to the ${r.kind === 'payment' ? 'bank / cash line' : `${r.partyName} line`}${r.challanNo ? `, and it comes off challan ${r.challanNo}` : ''}. The voucher is re-saved through the normal checks.`,
      confirmLabel: 'Delete deduction',
      danger: true
    })
    if (!ok) return
    await run(() => api.tds.removeFromVoucher(r.voucherId), `Deduction removed from ${r.voucherNumber}`)
  }

  return (
    <DataTable
      viewId="tds-deducted"
      testId="tds-deducted"
      ariaLabel={`TDS deducted — ${period.label}`}
      columns={DEDUCTED_COLUMNS}
      rows={rows ?? []}
      loading={isLoading}
      rowKey={(r) => r.entryId}
      rowAttrs={(r) => ({ 'data-row-id': r.entryId, 'data-voucher-id': r.voucherId })}
      onRowActivate={(r) => openVoucher(r.voucherId)}
      empty={{ title: `No deductions in ${period.label}`, hint: 'Apply TDS in a voucher, or Move to TDS from the Eligible tab.' }}
      exportOptions={{ title: 'TDS deducted', periodLabel: period.label, filename: `tds-deducted-${period.from}` }}
      trailingWidth={canEdit ? 128 : 0}
      trailing={
        canEdit
          ? (r) => (
              <div className="flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" data-testid={`btn-tds-edit-${r.entryId}`} onClick={() => openVoucher(r.voucherId)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" data-testid={`btn-tds-delete-${r.entryId}`} disabled={busy} onClick={() => void remove(r)}>
                  <span className="text-cr">Delete</span>
                </Button>
              </div>
            )
          : undefined
      }
    />
  )
}
