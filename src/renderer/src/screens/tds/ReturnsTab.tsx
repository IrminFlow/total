// Returns tab: Form 26Q (Form 140 under the 2025 Act) deductee + challan data for a quarter,
// the CSV for NSDL's RPU and data for Form 16A — or, kind 'tcs', Form 27EQ (Form 143) collectee +
// challan data, its CSV and data for Form 27D (Form 133), with the statement due dates.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fyFromStartYear, toDisplayDate } from '@shared/dates'
import { TCS_REMARK_TEXT, tcsStatementDueDate } from '@shared/tcs'
import type { Form16aData, Form26qChallanRow, Form26qDeducteeRow } from '../../lib/client'
import { Badge, Button, Panel, SectionTitle, Segmented } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { LedgerLink, VoucherLink } from '../../components/links'
import { useToasts } from '../../state/stores'
import { KIND_WORDS, pctText, withholdingApi, type QuarterChoice, type WithholdingKind } from './common'
import { Form24qPanel } from './Form24qPanel'

type Q = 1 | 2 | 3 | 4
type Party16a = Form16aData['parties'][number]

const REASON_TEXT: Record<string, string> = { A: 'A — certificate u/s 197', C: 'C — higher rate, no PAN' }

export function deducteeReturnColumns(kind: WithholdingKind) {
  const w = KIND_WORDS[kind]
  const reasons = kind === 'tcs' ? TCS_REMARK_TEXT : REASON_TEXT
  return defineColumns<Form26qDeducteeRow>([
  { id: 'serial', header: '#', kind: 'number', value: (r) => r.serial, width: 44 },
  { id: 'party', header: w.party, kind: 'text', value: (r) => r.partyName, minWidth: 130, hideable: false, cell: (r) => <LedgerLink ledgerId={r.partyLedgerId} name={r.partyName} /> },
  { id: 'pan', header: 'PAN', kind: 'text', value: (r) => r.pan, width: 116, text: (r) => r.pan ?? 'PANNOTAVBL', className: 'num' },
  { id: 'code', header: 'Type', kind: 'text', value: (r) => r.deducteeCode, width: 56, className: 'num', text: (r) => r.deducteeCode || '—' },
  { id: 'section', header: 'Section', kind: 'text', value: (r) => r.sectionCode, width: kind === 'tcs' ? 172 : 80, className: 'num' },
  { id: 'returnCode', header: kind === 'tcs' ? 'Code' : 'Return code', kind: 'text', value: (r) => r.returnCode, width: kind === 'tcs' ? 72 : 112, className: 'num', text: (r) => r.returnCode ?? '—' },
  { id: 'paid', header: kind === 'tcs' ? 'Date' : 'Paid on', kind: 'date', value: (r) => r.paymentDate },
  { id: 'voucher', header: 'Voucher', kind: 'text', value: (r) => String(r.voucherId), width: 90, defaultHidden: true, cell: (r) => <VoucherLink voucherId={r.voucherId} label="Open" /> },
  { id: 'amount', header: 'Amount', kind: 'money', value: (r) => r.amountPaise, aggregate: 'sum', width: kind === 'tcs' ? 140 : 120 },
  { id: 'rate', header: 'Rate', kind: 'number', value: (r) => (r.rateBp == null ? null : r.rateBp / 100), text: (r) => pctText(r.rateBp), width: 64 },
  { id: 'tds', header: w.name, kind: 'money', value: (r) => r.tdsPaise, aggregate: 'sum', width: 112 },
  { id: 'deducted', header: `${w.done} on`, kind: 'date', value: (r) => r.deductionDate, defaultHidden: true },
  { id: 'reason', header: kind === 'tcs' ? 'Remark' : 'Reason', kind: 'text', value: (r) => r.reasonCode, width: kind === 'tcs' ? 150 : 104, text: (r) => reasons[r.reasonCode] ?? '—' },
  { id: 'challanSerial', header: 'Challan #', kind: 'number', value: (r) => r.challanSerial, width: 100, text: (r) => (r.challanSerial == null ? 'None' : String(r.challanSerial)) },
  { id: 'bsr', header: 'BSR', kind: 'text', value: (r) => r.bsrCode, width: 90, className: 'num', defaultHidden: true },
  { id: 'challanDate', header: 'Challan date', kind: 'date', value: (r) => r.challanDate, defaultHidden: true }
  ])
}

export const DEDUCTEE_26Q_COLUMNS = deducteeReturnColumns('tds')

export function challanReturnColumns(kind: WithholdingKind) {
  return defineColumns<Form26qChallanRow>([
  { id: 'serial', header: '#', kind: 'number', value: (c) => c.serial, width: 52 },
  { id: 'bsr', header: 'BSR code', kind: 'text', value: (c) => c.bsrCode, className: 'num', width: 110 },
  { id: 'date', header: 'Deposited', kind: 'date', value: (c) => c.date },
  { id: 'challan', header: 'Challan serial', kind: 'text', value: (c) => c.challanNo, className: 'num', width: 120 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (c) => c.amountPaise, aggregate: 'sum' },
  { id: 'allocated', header: `${KIND_WORDS[kind].name} allocated`, kind: 'money', value: (c) => c.allocatedPaise, aggregate: 'sum' },
  { id: 'entries', header: 'Entries', kind: 'number', value: (c) => c.entries, width: 80 }
  ])
}

export const CHALLAN_26Q_COLUMNS = challanReturnColumns('tds')

export function certificateColumns(kind: WithholdingKind) {
  const w = KIND_WORDS[kind]
  return defineColumns<Party16a>([
  { id: 'party', header: w.party, kind: 'text', value: (p) => p.partyName, hideable: false, cell: (p) => <LedgerLink ledgerId={p.partyLedgerId} name={p.partyName} /> },
  { id: 'pan', header: 'PAN', kind: 'text', value: (p) => p.pan, width: 120, className: 'num', text: (p) => p.pan ?? 'Missing' },
  { id: 'payments', header: kind === 'tcs' ? 'Sales' : 'Payments', kind: 'number', value: (p) => p.payments.length, width: 96 },
  { id: 'amount', header: 'Amount', kind: 'money', value: (p) => p.totals.amountPaise, aggregate: 'sum' },
  { id: 'tds', header: w.name, kind: 'money', value: (p) => p.totals.tdsPaise, aggregate: 'sum' },
  { id: 'deposited', header: 'Deposited', kind: 'money', value: (p) => p.totals.depositedPaise, aggregate: 'sum' }
  ])
}

export const FORM16A_COLUMNS = certificateColumns('tds')

const LAYOUT_LABEL: Record<string, string> = {
  form26q: 'Form 26Q', form140: 'Form 140 (26Q under the 2025 Act)', form27eq: 'Form 27EQ', form143: 'Form 143 (27EQ under the 2025 Act)'
}

export function ReturnsTab({ fyStartYear, initialQuarter, kind = 'tds' }: { fyStartYear: number; initialQuarter: QuarterChoice; kind?: WithholdingKind }): React.JSX.Element {
  const w = KIND_WORDS[kind]
  const k = kind
  const wapi = withholdingApi(kind)
  const tcs = kind === 'tcs'
  const deducteeCols = useMemo(() => deducteeReturnColumns(kind), [kind])
  const challanCols = useMemo(() => challanReturnColumns(kind), [kind])
  const certCols = useMemo(() => certificateColumns(kind), [kind])
  const toast = useToasts()
  const [quarter, setQuarter] = useState<Q>(initialQuarter === 0 ? 1 : initialQuarter)
  const fy = fyFromStartYear(fyStartYear)
  const label = `Q${quarter} FY${fy.label}`
  const returnName = tcs ? (fyStartYear >= 2026 ? 'Form 143' : '27EQ') : '26Q'
  const certName = tcs ? (fyStartYear >= 2026 ? 'Form 133' : 'Form 27D') : 'Form 16A'
  const due = tcs ? tcsStatementDueDate(fyStartYear, quarter) : null
  const { data, isLoading } = useQuery({ queryKey: [k, 'form26q', fyStartYear, quarter], queryFn: () => wapi.returnData(fyStartYear, quarter) })
  const { data: f16 } = useQuery({ queryKey: [k, 'form16a', fyStartYear, quarter], queryFn: () => wapi.certificateData(fyStartYear, quarter) })
  const exportCsv = async (): Promise<void> => {
    try {
      const r = await wapi.exportReturn(fyStartYear, quarter)
      toast.push('success', `${returnName} CSV ready (${r.path.split('/').pop()}) — import into the return preparation utility manually, this is not a filed FVU`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  const pdf = async (partyLedgerId?: number): Promise<void> => {
    try {
      const r = await wapi.certificatePdf(fyStartYear, quarter, partyLedgerId)
      toast.push('success', `${certName} data saved (${r.path.split('/').pop()}) — TRACES issues the certificate itself`)
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
          testId={`${k}-returns-q`}
          options={[1, 2, 3, 4].map((q) => ({ value: String(q), label: `Q${q}` }))}
          value={String(quarter)}
          onChange={(v) => setQuarter(Number(v) as Q)}
        />
        <Badge tone="info" testId={`${k}-returns-layout`}>
          {LAYOUT_LABEL[data?.layout ?? (tcs ? 'form27eq' : 'form26q')]}
        </Badge>
        {unchallaned > 0 && <Badge tone="warning">{unchallaned} without a challan</Badge>}
        {due && (
          <span className="text-small text-muted" data-testid="tcs-returns-due">
            Statement due {toDisplayDate(due.statement)} · {certName} by {toDisplayDate(due.certificate)}
          </span>
        )}
        <span className="flex-1" />
        <Button data-testid={`btn-${k}-export`} variant="primary" onClick={() => void exportCsv()}>
          Export {returnName} CSV
        </Button>
      </div>

      <Panel>
        <div className="px-3 pt-3"><SectionTitle as="h3">{w.party} details — {label}</SectionTitle></div>
        <DataTable
          viewId={`${k}-26q`}
          testId={`${k}-26q`}
          ariaLabel={`Form ${returnName} ${w.party.toLowerCase()} details — ${label}`}
          columns={deducteeCols}
          rows={data?.deductees ?? []}
          loading={isLoading}
          rowKey={(r) => r.entryId}
          maxHeight="50vh"
          empty={{ title: `No ${w.noun}s in ${label}` }}
          exportOptions={{ title: `Form ${returnName} ${w.party.toLowerCase()}s`, periodLabel: label, filename: `${k}-${tcs ? '27eq' : '26q'}-${w.party.toLowerCase()}s-${fyStartYear}-q${quarter}` }}
        />
      </Panel>

      <Panel>
        <div className="px-3 pt-3"><SectionTitle as="h3">Challan details</SectionTitle></div>
        <DataTable
          viewId={`${k}-26q-challans`}
          testId={`${k}-26q-challans`}
          ariaLabel={`Form ${returnName} challans — ${label}`}
          columns={challanCols}
          rows={data?.challans ?? []}
          rowKey={(c) => c.challanId}
          maxHeight="30vh"
          empty={{ title: 'No challans for this quarter', hint: 'Create them on the Challans tab' }}
          exportOptions={{ title: `Form ${returnName} challans`, periodLabel: label, filename: `${k}-${tcs ? '27eq' : '26q'}-challans-${fyStartYear}-q${quarter}` }}
        />
      </Panel>

      <Panel>
        <div className="px-3 pt-3">
          <SectionTitle
            as="h3"
            right={
              <Button size="sm" data-testid={`btn-${k}-16a-pdf-all`} disabled={!f16?.parties.length} onClick={() => void pdf()}>
                PDF for every {w.party.toLowerCase()}
              </Button>
            }
          >
            Data for {certName}
          </SectionTitle>
        </div>
        <p className="px-3 pb-2 text-hint text-muted">
          {tcs
            ? `The fields Form No. 27D carries (rule 37D; Form 133 under the Income-tax Rules 2026) — the certificate itself is downloaded from TRACES after the statement is processed.`
            : 'The fields Form No. 16A carries (rule 31(1)(b)) — the certificate itself is downloaded from TRACES after the return is processed.'}
        </p>
        <DataTable
          viewId={`${k}-16a`}
          testId={`${k}-16a`}
          ariaLabel={`${certName} data — ${label}`}
          columns={certCols}
          rows={f16?.parties ?? []}
          rowKey={(p) => p.partyLedgerId}
          maxHeight="30vh"
          empty={{ title: `No ${w.party.toLowerCase()}s in ${label}` }}
          trailingWidth={72}
          trailing={(p) => (
            <Button size="sm" variant="ghost" data-testid={`btn-${k}-16a-pdf-${p.partyLedgerId}`} onClick={() => void pdf(p.partyLedgerId)}>
              PDF
            </Button>
          )}
        />
      </Panel>

      {/* WP 3.7: salary TDS (section 192) — Form 24Q / Form 138 */}
      {!tcs && <Form24qPanel fyStartYear={fyStartYear} quarter={quarter} label={label} />}

      {!tcs && (
        <p className="text-hint text-muted" data-testid="tds-27eq-placeholder">
          Form 27EQ (TCS on sales) data is on the TCS screen.
        </p>
      )}
    </div>
  )
}
