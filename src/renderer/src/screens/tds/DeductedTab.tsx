// Deducted tab (TDS) / Collected tab (TCS): every recorded entry in the period — edit (the
// voucher's own editor, whose banner changes section / rate / manual amount) and delete (server
// pipeline; the voucher stays balanced: a bill gets its supplier credit back, a sale's buyer debit
// drops the TCS).
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DEDUCTEE_TYPE_LABELS } from '@shared/tds'
import { formatPaise } from '@shared/money'
import type { TdsDeductedRow } from '../../lib/client'
import { Badge, Button } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher, useCanEditMasters } from '../../lib/drill'
import { confirmDialog } from '../../lib/dialogs'
import { KIND_WORDS, pctText, useTdsAction, withholdingApi, type TdsPeriod, type WithholdingKind } from './common'

const STATUS = {
  unallocated: { label: 'Not on a challan', tone: 'warning' },
  allocated: { label: 'On a challan', tone: 'info' },
  paid: { label: 'Deposited', tone: 'success' }
} as const

export function deductedColumns(kind: WithholdingKind) {
  const w = KIND_WORDS[kind]
  return defineColumns<TdsDeductedRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'voucher', header: 'Voucher', kind: 'text', value: (r) => r.voucherNumber, width: 90, hideable: false, groupable: false,
      cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.voucherNumber} />
    },
    { id: 'party', header: 'Party', kind: 'text', value: (r) => r.partyName, minWidth: 120, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
    { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 116, text: (r) => r.pan ?? 'Missing', className: 'num', defaultHidden: true },
    { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: kind === 'tcs' ? 150 : 80, className: 'num' },
    { id: 'base', header: 'Base', kind: 'money', value: (r) => r.basePaise, aggregate: 'sum', width: 116 },
    { id: 'rate', header: 'Rate', kind: 'number', value: (r) => (r.rateBp == null ? null : r.rateBp / 100), text: (r) => (r.isManual ? 'Manual' : pctText(r.rateBp)), width: 72 },
    { id: 'tds', header: w.name, kind: 'money', value: (r) => r.tdsPaise, aggregate: 'sum', width: 112 },
    { id: 'deductee', header: `${w.party} type`, kind: 'text', value: (r) => (r.deducteeType ? DEDUCTEE_TYPE_LABELS[r.deducteeType] : null), width: 112 },
    { id: 'certificate', header: 'Certificate', kind: 'text', value: (r) => r.certificateNo, width: 96, text: (r) => r.certificateNo ?? '—' },
    {
      id: 'challan', header: 'Challan', kind: 'enum', value: (r) => r.challanStatus, width: 140,
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
}

export const DEDUCTED_COLUMNS = deductedColumns('tds')

export function DeductedTab({ period, kind = 'tds' }: { period: TdsPeriod; kind?: WithholdingKind }): React.JSX.Element {
  const w = KIND_WORDS[kind]
  const k = kind
  const wapi = withholdingApi(kind)
  const canEdit = useCanEditMasters()
  const { busy, run } = useTdsAction()
  const columns = useMemo(() => deductedColumns(kind), [kind])
  const { data: rows, isLoading } = useQuery({
    queryKey: [k, 'deducted', period.from, period.to],
    queryFn: () => wapi.deducted(period.from, period.to)
  })

  const remove = async (r: TdsDeductedRow): Promise<void> => {
    const back =
      kind === 'tcs'
        ? r.kind === 'receipt' ? `${r.partyName} credit` : `${r.partyName} debit (it comes off)`
        : r.kind === 'payment' ? 'bank / cash line' : `${r.partyName} line`
    const ok = await confirmDialog({
      title: `Delete ${w.noun}`,
      message: `Remove the ${formatPaise(r.tdsPaise, { symbol: true })} ${w.name} from ${r.voucherNumber}? The payable credit goes back to the ${back}${r.challanNo ? `, and it comes off challan ${r.challanNo}` : ''}. The voucher is re-saved through the normal checks.`,
      confirmLabel: `Delete ${w.noun}`,
      danger: true
    })
    if (!ok) return
    await run(() => wapi.removeFromVoucher(r.voucherId), `${w.noun[0]!.toUpperCase()}${w.noun.slice(1)} removed from ${r.voucherNumber}`)
  }

  return (
    <DataTable
      viewId={`${k}-deducted`}
      testId={`${k}-deducted`}
      ariaLabel={`${w.name} ${w.done.toLowerCase()} — ${period.label}`}
      columns={columns}
      rows={rows ?? []}
      loading={isLoading}
      rowKey={(r) => r.entryId}
      rowAttrs={(r) => ({ 'data-row-id': r.entryId, 'data-voucher-id': r.voucherId })}
      onRowActivate={(r) => openVoucher(r.voucherId)}
      empty={{
        title: `No ${w.noun}s in ${period.label}`,
        hint: kind === 'tcs' ? 'Apply TCS on a sales invoice, or Move to TCS from the Eligible tab.' : 'Apply TDS in a voucher, or Move to TDS from the Eligible tab.'
      }}
      exportOptions={{ title: `${w.name} ${w.done.toLowerCase()}`, periodLabel: period.label, filename: `${k}-deducted-${period.from}` }}
      trailingWidth={canEdit ? 120 : 0}
      trailing={
        canEdit
          ? (r) => (
              <div className="flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" data-testid={`btn-${k}-edit-${r.entryId}`} onClick={() => openVoucher(r.voucherId)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" data-testid={`btn-${k}-delete-${r.entryId}`} disabled={busy} onClick={() => void remove(r)}>
                  <span className="text-cr">Delete</span>
                </Button>
              </div>
            )
          : undefined
      }
    />
  )
}
