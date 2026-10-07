// Returns tab → Form 24Q (WP 3.7): salary TDS (section 192 / 2025 Act s.392) recorded by pay runs.
// Annexure I (deductee details) every quarter, Annexure II (salary details for the year) in Q4 —
// Form No. 138 under the Income-tax Rules 2026 from 1 Apr 2026. Data only: the CSV is for the
// RPU by hand, not a filed FVU.
import { useQuery } from '@tanstack/react-query'
import { statApi, type Form24qData, type Form24qSalaryRow } from '../../lib/payrollStatutoryClient'
import { useToasts } from '../../state/stores'
import { Badge, Button, Panel, SectionTitle } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { VoucherLink } from '../../components/links'

type Row = Form24qData['deductees'][number]

export const DEDUCTEE_24Q_COLUMNS = defineColumns<Row>([
  { id: 'serial', header: '#', kind: 'number', value: (r) => r.serial, width: 44 },
  { id: 'employee', header: 'Employee', kind: 'text', value: (r) => r.employeeName, minWidth: 140, hideable: false },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 116, text: (r) => r.pan ?? 'PANNOTAVBL', className: 'num' },
  { id: 'section', header: 'Section code', kind: 'text', value: (r) => r.sectionCode, width: 110, className: 'num' },
  { id: 'paid', header: 'Paid on', kind: 'date', value: (r) => r.paymentDate },
  { id: 'voucher', header: 'Voucher', kind: 'text', value: (r) => String(r.voucherId), width: 90, defaultHidden: true, cell: (r) => <VoucherLink voucherId={r.voucherId} label="Open" /> },
  { id: 'amount', header: 'Salary paid', kind: 'money', value: (r) => r.amountPaise, aggregate: 'sum', width: 124 },
  { id: 'tds', header: 'TDS', kind: 'money', value: (r) => r.tdsPaise, aggregate: 'sum', width: 112 },
  { id: 'challan', header: 'Challan #', kind: 'number', value: (r) => r.challanSerial, width: 100, text: (r) => (r.challanSerial == null ? 'None' : String(r.challanSerial)) },
  { id: 'bsr', header: 'BSR', kind: 'text', value: (r) => r.bsrCode, width: 90, className: 'num', defaultHidden: true }
])

export const SALARY_24Q_COLUMNS = defineColumns<Form24qSalaryRow>([
  { id: 'employee', header: 'Employee', kind: 'text', value: (r) => r.employeeName, minWidth: 140, hideable: false },
  { id: 'regime', header: 'Regime', kind: 'enum', value: (r) => r.regime, options: [{ value: 'new', label: 'New' }, { value: 'old', label: 'Old' }], width: 80 },
  { id: 'gross', header: 'Gross salary', kind: 'money', value: (r) => r.workings.gross, aggregate: 'sum', width: 124 },
  { id: 'exempt', header: 'Exempt (HRA)', kind: 'money', value: (r) => r.workings.hraExemption, width: 112, defaultHidden: true },
  { id: 'std', header: 'Std. deduction', kind: 'money', value: (r) => r.workings.standardDeduction, width: 112, defaultHidden: true },
  { id: 'via', header: 'Chapter VI-A', kind: 'money', value: (r) => r.workings.deductionsTotal, width: 112 },
  { id: 'income', header: 'Total income', kind: 'money', value: (r) => r.workings.totalIncome, aggregate: 'sum', width: 124 },
  { id: 'tax', header: 'Tax payable', kind: 'money', value: (r) => r.workings.taxOnIncome.total, aggregate: 'sum', width: 116 },
  { id: 'tds', header: 'TDS deducted', kind: 'money', value: (r) => r.tdsDeductedPaise, aggregate: 'sum', width: 116 },
  { id: 'short', header: 'Short (excess)', kind: 'money', value: (r) => r.shortfallPaise, aggregate: 'sum', width: 116 }
])

export function Form24qPanel({ fyStartYear, quarter, label }: { fyStartYear: number; quarter: 1 | 2 | 3 | 4; label: string }): React.JSX.Element {
  const toast = useToasts()
  const { data, isLoading } = useQuery({ queryKey: ['tds', 'form24q', fyStartYear, quarter], queryFn: () => statApi.form24q(fyStartYear, quarter) })
  const exportCsv = async (): Promise<void> => {
    try {
      const r = await statApi.form24qCsv(fyStartYear, quarter)
      toast.push('success', `24Q data CSV ready (${r.path.split('/').pop()}) — key into the RPU by hand, this is not a filed FVU`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const unchallaned = (data?.deductees ?? []).filter((d) => d.challanSerial == null).length
  return (
    <Panel>
      <div className="px-3 pt-3">
        <SectionTitle
          as="h3"
          right={
            <span className="inline-flex items-center gap-2">
              <Badge tone="info" testId="tds-24q-layout">{data?.layout === 'form138' ? 'Form 138 (24Q under the 2026 Rules)' : 'Form 24Q'}</Badge>
              {unchallaned > 0 && <Badge tone="warning">{unchallaned} without a challan</Badge>}
              <Button size="sm" data-testid="btn-tds-24q-export" disabled={!data?.deductees.length} onClick={() => void exportCsv()}>
                Export 24Q CSV
              </Button>
            </span>
          }
        >
          Salary TDS — Form 24Q annexure I — {label}
        </SectionTitle>
      </div>
      <p className="px-3 pb-2 text-hint text-muted">
        Recorded by pay runs (section 192; 2025 Act s.392). Section code 92B to FY 2025-26, 1002 (non-Government) on Form 138 from April 2026.
      </p>
      <DataTable
        viewId="tds-24q"
        testId="tds-24q"
        ariaLabel={`Form 24Q annexure I — ${label}`}
        columns={DEDUCTEE_24Q_COLUMNS}
        rows={data?.deductees ?? []}
        loading={isLoading}
        rowKey={(r) => r.entryId}
        maxHeight="36vh"
        empty={{ title: `No salary TDS in ${label}`, hint: 'Pay runs record it once an employee’s projected tax is above nil' }}
        exportOptions={{ title: 'Form 24Q annexure I', periodLabel: label, filename: `tds-24q-${fyStartYear}-q${quarter}` }}
      />
      {quarter === 4 && (
        <>
          <div className="px-3 pt-3"><SectionTitle as="h3">Annexure II — salary details for the year</SectionTitle></div>
          <DataTable
            viewId="tds-24q-annexure2"
            testId="tds-24q-annexure2"
            ariaLabel="Form 24Q annexure II"
            columns={SALARY_24Q_COLUMNS}
            rows={data?.salaries ?? []}
            rowKey={(r) => r.employeeId}
            maxHeight="36vh"
            empty={{ title: 'No salary paid in this year' }}
          />
        </>
      )}
    </Panel>
  )
}
