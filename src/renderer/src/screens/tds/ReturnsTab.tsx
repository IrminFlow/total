// Returns tab: Form 26Q (Form 140 under the 2025 Act) deductee + challan data for a quarter,
// the CSV for NSDL's RPU, a 27EQ placeholder (TCS arrives with WP 3.3) and data for Form 16A.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyFromStartYear } from '@shared/dates'
import { api, type Form16aData, type Form26qChallanRow, type Form26qDeducteeRow } from '../../lib/client'
import { Badge, Button, Panel, SectionTitle, Segmented } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { useToasts } from '../../state/stores'
import { pctText, type QuarterChoice } from './common'
import { Form24qPanel } from './Form24qPanel'

type Q = 1 | 2 | 3 | 4
type Party16a = Form16aData['parties'][number]

const REASON_TEXT: Record<string, string> = { A: 'A — certificate u/s 197', C: 'C — higher rate, no PAN' }

export const DEDUCTEE_26Q_COLUMNS = defineColumns<Form26qDeducteeRow>([
  { id: 'serial', header: '#', kind: 'number', value: (r) => r.serial, width: 44 },
  { id: 'party', header: 'Deductee', kind: 'text', value: (r) => r.partyName, minWidth: 130, hideable: false, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 116, text: (r) => r.pan ?? 'PANNOTAVBL', className: 'num' },
  { id: 'code', header: 'Type', kind: 'text', value: (r) => r.deducteeCode, width: 56, className: 'num', text: (r) => r.deducteeCode || '—' },
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: 80, className: 'num' },
  { id: 'returnCode', header: 'Return code', kind: 'text', value: (r) => r.returnCode, width: 112, className: 'num', text: (r) => r.returnCode ?? '—' },
  { id: 'paid', header: 'Paid on', kind: 'date', value: (r) => r.paymentDate },
  { id: 'voucher', header: 'Voucher', kind: 'text', value: (r) => String(r.voucherId), width: 90, defaultHidden: true, cell: (r) => <VoucherLink voucherId={r.voucherId} label="Open" /> },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amountPaise, aggregate: 'sum', width: 120 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (r) => (r.rateBp == null ? null : r.rateBp / 100), text: (r) => pctText(r.rateBp), width: 64 },
  { id: 'tds', header: 'TDS', kind: 'money', value: (r) => r.tdsPaise, aggregate: 'sum', width: 112 },
  { id: 'deducted', header: 'Deducted on', kind: 'date', value: (r) => r.deductionDate, defaultHidden: true },
  { id: 'reason', header: 'Reason', kind: 'text', value: (r) => r.reasonCode, width: 104, text: (r) => REASON_TEXT[r.reasonCode] ?? '—' },
  { id: 'challanSerial', header: 'Challan #', kind: 'number', value: (r) => r.challanSerial, width: 100, text: (r) => (r.challanSerial == null ? 'None' : String(r.challanSerial)) },
  { id: 'bsr', header: 'BSR', kind: 'text', value: (r) => r.bsrCode, width: 90, className: 'num', defaultHidden: true },
  { id: 'challanDate', header: 'Challan date', kind: 'date', value: (r) => r.challanDate, defaultHidden: true }
])

export const CHALLAN_26Q_COLUMNS = defineColumns<Form26qChallanRow>([
  { id: 'serial', header: '#', kind: 'number', value: (c) => c.serial, width: 52 },
  { id: 'bsr', header: 'BSR code', kind: 'text', value: (c) => c.bsrCode, className: 'num', width: 110 },
  { id: 'date', header: 'Deposited', kind: 'date', value: (c) => c.date },
  { id: 'challan', header: 'Challan serial', kind: 'text', value: (c) => c.challanNo, className: 'num', width: 120 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (c) => c.amountPaise, aggregate: 'sum' },
  { id: 'allocated', header: 'TDS allocated', kind: 'money', value: (c) => c.allocatedPaise, aggregate: 'sum' },
  { id: 'entries', header: 'Entries', kind: 'number', value: (c) => c.entries, width: 80 }
])

export const FORM16A_COLUMNS = defineColumns<Party16a>([
  { id: 'party', header: 'Deductee', kind: 'text', value: (p) => p.partyName, hideable: false, cell: (p) => <LedgerLink ledgerId={p.partyLedgerId} name={p.partyName} /> },
  { id: 'pan', header: 'PAN', kind: 'text', value: (p) => p.pan, width: 120, className: 'num', text: (p) => p.pan ?? 'Missing' },
  { id: 'payments', header: 'Payments', kind: 'number', value: (p) => p.payments.length, width: 96 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (p) => p.totals.amountPaise, aggregate: 'sum' },
  { id: 'tds', header: 'TDS', kind: 'money', value: (p) => p.totals.tdsPaise, aggregate: 'sum' },
  { id: 'deposited', header: 'Deposited', kind: 'money', value: (p) => p.totals.depositedPaise, aggregate: 'sum' }
])

export function ReturnsTab({ fyStartYear, initialQuarter }: { fyStartYear: number; initialQuarter: QuarterChoice }): React.JSX.Element {
  const toast = useToasts()
  const [quarter, setQuarter] = useState<Q>(initialQuarter === 0 ? 1 : initialQuarter)
  const fy = fyFromStartYear(fyStartYear)
  const label = `Q${quarter} FY${fy.label}`
  const { data, isLoading } = useQuery({ queryKey: ['tds', 'form26q', fyStartYear, quarter], queryFn: () => api.tds.form26q(fyStartYear, quarter) })
  const { data: f16 } = useQuery({ queryKey: ['tds', 'form16a', fyStartYear, quarter], queryFn: () => api.tds.form16a(fyStartYear, quarter) })
  const exportCsv = async (): Promise<void> => {
    try {
      const r = await api.tds.export26q(fyStartYear, quarter)
      toast.push('success', `26Q CSV ready (${r.path.split('/').pop()}) — import into NSDL's RPU manually, this is not a filed FVU`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const pdf = async (partyLedgerId?: number): Promise<void> => {
    try {
      const r = await api.tds.form16aPdf(fyStartYear, quarter, partyLedgerId)
      toast.push('success', `Form 16A data saved (${r.path.split('/').pop()}) — TRACES issues the certificate itself`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const unchallaned = (data?.deductees ?? []).filter((d) => d.challanSerial == null).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Return quarter"
          testId="tds-returns-q"
          options={[1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q}` }))}
          value={String(quarter)}
          onChange={(v) => setQuarter(Number(v) as Q)}
        />
        <Badge tone="info" testId="tds-returns-layout">
          {data?.layout === 'form140' ? 'Form 140 (26Q under the 2025 Act)' : 'Form 26Q'}
        </Badge>
        {unchallaned > 0 && <Badge tone="warning">{unchallaned} without a challan</Badge>}
        <span className="flex-1" />
        <Button data-testid="btn-tds-export" variant="primary" onClick={() => void exportCsv()}>
          Export 26Q CSV
        </Button>
      </div>

      <Panel>
        <div className="px-3 pt-3"><SectionTitle as="h3">Deductee details — {label}</SectionTitle></div>
        <DataTable
          viewId="tds-26q"
          testId="tds-26q"
          ariaLabel={`Form 26Q deductee details — ${label}`}
          columns={DEDUCTEE_26Q_COLUMNS}
          rows={data?.deductees ?? []}
          loading={isLoading}
          rowKey={(r) => r.entryId}
          maxHeight="50vh"
          empty={{ title: `No deductions in ${label}` }}
          exportOptions={{ title: `Form 26Q deductees`, periodLabel: label, filename: `tds-26q-deductees-${fyStartYear}-q${quarter}` }}
        />
      </Panel>

      <Panel>
        <div className="px-3 pt-3"><SectionTitle as="h3">Challan details</SectionTitle></div>
        <DataTable
          viewId="tds-26q-challans"
          testId="tds-26q-challans"
          ariaLabel={`Form 26Q challans — ${label}`}
          columns={CHALLAN_26Q_COLUMNS}
          rows={data?.challans ?? []}
          rowKey={(c) => c.challanId}
          maxHeight="30vh"
          empty={{ title: 'No challans for this quarter', hint: 'Create them on the Challans tab' }}
          exportOptions={{ title: 'Form 26Q challans', periodLabel: label, filename: `tds-26q-challans-${fyStartYear}-q${quarter}` }}
        />
      </Panel>

      <Panel>
        <div className="px-3 pt-3">
          <SectionTitle
            as="h3"
            right={
              <Button size="sm" data-testid="btn-tds-16a-pdf-all" disabled={!f16?.parties.length} onClick={() => void pdf()}>
                PDF for every deductee
              </Button>
            }
          >
            Data for Form 16A
          </SectionTitle>
        </div>
        <p className="px-3 pb-2 text-hint text-muted">
          The fields Form No. 16A carries (rule 31(1)(b)) — the certificate itself is downloaded from TRACES after the return is processed.
        </p>
        <DataTable
          viewId="tds-16a"
          testId="tds-16a"
          ariaLabel={`Form 16A data — ${label}`}
          columns={FORM16A_COLUMNS}
          rows={f16?.parties ?? []}
          rowKey={(p) => p.partyLedgerId}
          maxHeight="30vh"
          empty={{ title: `No deductees in ${label}` }}
          trailingWidth={72}
          trailing={(p) => (
            <Button size="sm" variant="ghost" data-testid={`btn-tds-16a-pdf-${p.partyLedgerId}`} onClick={() => void pdf(p.partyLedgerId)}>
              PDF
            </Button>
          )}
        />
      </Panel>

      {/* WP 3.7: salary TDS (section 192) — Form 24Q / Form 138 */}
      <Form24qPanel fyStartYear={fyStartYear} quarter={quarter} label={label} />

      <Panel>
        <div className="px-3 py-3 text-body-sm text-muted" data-testid="tds-27eq-placeholder">
          <SectionTitle as="h3">Form 27EQ (TCS)</SectionTitle>
          <p>Tax collected at source on sales arrives with WP 3.3; its 27EQ data will sit here, beside 26Q.</p>
        </div>
      </Panel>
    </div>
  )
}
