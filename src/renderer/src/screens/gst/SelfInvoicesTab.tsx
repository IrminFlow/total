// RCM self-invoices (WP 3.4) under e-documents: purchases from UNREGISTERED suppliers whose
// ledger is marked reverse charge need a self-invoice (s.31(3)(f) CGST Act) within 30 days of
// receipt (rule 47A, from 1 Nov 2024), numbered in its own FY series (rule 46(b)). Lists what is
// due / overdue / generated, generates the next number and prints through the print templates.
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { SELF_INVOICE_STATUS_LABELS, type SelfInvoiceRow, type SelfInvoiceStatus } from '@shared/gst/selfInvoice'
import { SELF_INVOICE_RULES } from '@shared/gst/sources'
import { api } from '../../lib/client'
import { useToasts } from '../../state/stores'
import { Badge, Banner, Button, DrawerSection, Field, TextInput } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { openVoucher, useCanEditMasters } from '../../lib/drill'
import { SourcesSection } from './common'

const STATUS_TONE: Record<SelfInvoiceStatus, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  generated: 'success', generated_late: 'warning', due: 'info', overdue: 'danger', cancelled: 'neutral'
}

export const SELF_INVOICE_COLUMNS = defineColumns<SelfInvoiceRow>([
  { id: 'date', header: 'Received', kind: 'date', value: (r) => r.date, className: 'text-muted' },
  { id: 'voucher', header: 'Purchase', kind: 'text', value: (r) => r.voucherNumber, width: 110, hideable: false, groupable: false, cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.voucherNumber} /> },
  { id: 'party', header: 'Supplier (unregistered)', kind: 'text', value: (r) => r.partyName, minWidth: 150, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
  { id: 'ref', header: 'Supplier ref', kind: 'text', value: (r) => r.supplierRef, width: 112, defaultHidden: true },
  { id: 'taxable', header: 'Taxable', kind: 'money', value: (r) => r.taxable, aggregate: 'sum', width: 116 },
  { id: 'tax', header: 'Tax (RCM)', kind: 'money', value: (r) => r.tax, aggregate: 'sum', width: 104 },
  { id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, width: 124,
    options: Object.entries(SELF_INVOICE_STATUS_LABELS).map(([value, label]) => ({ value, label })),
    cell: (r) => <Badge tone={STATUS_TONE[r.status]} testId={`self-invoice-status-${r.voucherId}`}>{SELF_INVOICE_STATUS_LABELS[r.status]}</Badge> },
  { id: 'due', header: 'Due by (rule 47A)', kind: 'date', value: (r) => r.dueDate, className: 'text-muted', width: 168,
    text: (r) => (r.dueDate ? `${toDisplayDate(r.dueDate)}${r.daysLeft != null ? ` (${r.daysLeft < 0 ? `${-r.daysLeft}d late` : `${r.daysLeft}d left`})` : ''}` : '—') },
  { id: 'siNo', header: 'Self-invoice', kind: 'text', value: (r) => r.selfInvoiceNumber, width: 132, className: 'num' },
  { id: 'siDate', header: 'Dated', kind: 'date', value: (r) => r.selfInvoiceDate, className: 'text-muted', defaultHidden: true }
])

export function SelfInvoiceOptions(): React.JSX.Element {
  const qc = useQueryClient()
  const toast = useToasts()
  const { data } = useQuery({ queryKey: ['selfInvoices', 'series'], queryFn: api.gst.selfInvoiceSeries })
  const [prefix, setPrefix] = useState<string | null>(null)
  const value = prefix ?? data?.prefix ?? ''
  return (
    <>
      <DrawerSection title="Self-invoice series">
        <Field label="Prefix (letters, digits, - and /)" hint={`Numbers read ${value}26-27/0001 — at most ${SELF_INVOICE_RULES.maxNumberLength} characters, consecutive per financial year (rule 46(b)).`}>
          <TextInput value={value} maxLength={6} onChange={(e) => setPrefix(e.target.value)} data-testid="input-self-invoice-prefix" />
        </Field>
        <div>
          <Button size="sm" variant="primary" disabled={prefix == null} data-testid="btn-self-invoice-prefix-save"
            onClick={() => {
              api.gst.setSelfInvoiceSeries({ prefix: value })
                .then(async () => { setPrefix(null); await qc.invalidateQueries({ queryKey: ['selfInvoices'] }); toast.push('success', 'Series saved') })
                .catch((err: Error) => toast.push('error', err.message))
            }}>
            Save series
          </Button>
        </div>
      </DrawerSection>
      <SourcesSection ids={SELF_INVOICE_RULES.sources} />
    </>
  )
}

export function SelfInvoicesTab({ from, to }: { from: string; to: string }): React.JSX.Element {
  const qc = useQueryClient()
  const toast = useToasts()
  const canEdit = useCanEditMasters()
  const [busy, setBusy] = useState<number | null>(null)
  const { data, isLoading } = useQuery({ queryKey: ['selfInvoices', from, to], queryFn: () => api.gst.selfInvoices(from, to) })
  const rows = data ?? []
  const pending = rows.filter((r) => r.status === 'due' || r.status === 'overdue')
  const overdue = rows.filter((r) => r.status === 'overdue')

  const generate = async (r: SelfInvoiceRow): Promise<void> => {
    setBusy(r.voucherId)
    try {
      const x = await api.gst.selfInvoiceGenerate(r.voucherId)
      await qc.invalidateQueries({ queryKey: ['selfInvoices'] })
      toast.push('success', `Self-invoice ${x.number} dated ${toDisplayDate(x.date)}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {pending.length > 0 && (
        <Banner tone={overdue.length ? 'danger' : 'warning'} className="mb-3" testId="self-invoices-due">
          {pending.length} RCM purchase{pending.length > 1 ? 's' : ''} from unregistered suppliers without a self-invoice
          {overdue.length ? ` — ${overdue.length} past the 30 days of rule 47A` : ''}. Mark the supplier ledger “Reverse charge” for a purchase to appear here.
        </Banner>
      )}
      <DataTable
        viewId="self-invoices"
        testId="self-invoices"
        ariaLabel="RCM self-invoices"
        columns={SELF_INVOICE_COLUMNS}
        rows={rows}
        loading={isLoading}
        rowKey={(r) => r.voucherId}
        rowAttrs={(r) => ({ 'data-row-id': r.voucherId })}
        onRowActivate={(r) => openVoucher(r.voucherId)}
        maxHeight="calc(100vh - 16rem)"
        empty={{ title: 'No reverse-charge purchases from unregistered suppliers in this period', hint: 'Masters → Ledger → Reverse charge marks a supplier; purchases from it then need a self-invoice.' }}
        exportOptions={{ title: 'RCM self-invoices', periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`, filename: 'self-invoices' }}
        trailingWidth={120}
        trailing={(r) => (
          <span className="whitespace-nowrap">
            {r.selfInvoiceNumber == null && r.status !== 'cancelled' && canEdit && (
              <button className="mr-2 text-small text-blue hover:underline disabled:opacity-40" data-testid={`btn-self-invoice-generate-${r.voucherId}`} disabled={busy === r.voucherId} onClick={() => void generate(r)}>
                Generate
              </button>
            )}
            {r.selfInvoiceNumber != null && (
              <button className="mr-2 text-small text-blue hover:underline" data-testid={`btn-self-invoice-pdf-${r.voucherId}`}
                onClick={() => { api.gst.selfInvoicePdf(r.voucherId).catch((err: Error) => toast.push('error', err.message)) }}>
                PDF
              </button>
            )}
          </span>
        )}
      />
      <p className="px-3 py-2 text-hint text-muted">
        Time of supply on reverse charge: goods — earliest of receipt, payment, or 30 days after the supplier&apos;s invoice (s.12(3)); services — earlier of
        payment or the date of this self-invoice (s.13(3)(c)). The tax shows in GSTR-3B 3.1(d) and, as credit, 4(A)(3).
      </p>
    </>
  )
}
