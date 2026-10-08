// Payables → Supplier reconciliation (WP 4.3): the supplier statement (our ledger of the supplier,
// in their terms, with their invoice numbers — PDF / CSV from the table) and the reconciliation
// worksheet: paste or load the supplier's ledger CSV, match by invoice number / amount / date
// within tolerances, list the differences. Nothing is posted.
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toDisplayDate } from '@shared/dates'
import { formatPaise, parseRupees } from '@shared/money'
import type { ReconPair, ReconStatus } from '@shared/payables/supplierRecon'
import type { SupplierReconResult, SupplierStatementRow } from '@shared/payables/types'
import {
  Badge, Banner, Button, DateInput, DrawerSection, Field, Page, PageHeader, Panel, StatGrid, StatTile, TextInput, Textarea
} from '../../components/ui'
import { OptionsTable } from '../../components/ScreenOptions'
import { LedgerPicker } from '../../components/pickers'
import { DataTable, defineColumns } from '../../components/table'
import { VoucherLink } from '../../components/links'
import { payablesApi } from '../../lib/payablesClient'
import { useSession, useToasts } from '../../state/stores'
import { creditorFilter } from './common'

const STATEMENT_COLUMNS = defineColumns<SupplierStatementRow>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date },
  { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherType, width: 110 },
  { id: 'number', header: 'Voucher', kind: 'text', value: (r) => r.number, width: 100, cell: (r) => <VoucherLink voucherId={r.voucherId} label={<span className="num">{r.number}</span>} /> },
  { id: 'ref', header: 'Their invoice', kind: 'text', value: (r) => r.supplierRef ?? '', width: 120, className: 'num' },
  { id: 'particulars', header: 'Particulars', kind: 'text', value: (r) => r.particulars, minWidth: 160 },
  { id: 'narration', header: 'Narration', kind: 'text', value: (r) => r.narration ?? '', defaultHidden: true },
  { id: 'debit', header: 'Paid / debited', kind: 'money', value: (r) => r.debit || null, width: 130, aggregate: 'sum' },
  { id: 'credit', header: 'Billed', kind: 'money', value: (r) => r.credit || null, width: 130, aggregate: 'sum' },
  { id: 'balance', header: 'We owe', kind: 'money', value: (r) => r.balance, width: 140, className: 'font-medium' }
])

const STATUS: Record<ReconStatus, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' }> = {
  matched: { label: 'Matched', tone: 'success' },
  amount_diff: { label: 'Amount differs', tone: 'warning' },
  only_supplier: { label: 'Only in their books', tone: 'danger' },
  only_books: { label: 'Only in our books', tone: 'info' }
}

const BY: Record<string, string> = { number: 'invoice no.', number_core: 'invoice no. (fuzzy)', amount_date: 'amount + date' }

const RECON_COLUMNS = defineColumns<ReconPair>([
  {
    id: 'status', header: 'Status', kind: 'enum', value: (r) => r.status, width: 150, groupKey: (r) => STATUS[r.status].label,
    options: (Object.keys(STATUS) as ReconStatus[]).map((k) => ({ value: k, label: STATUS[k].label })), text: (r) => STATUS[r.status].label,
    cell: (r) => <Badge tone={STATUS[r.status].tone} testId="recon-status">{STATUS[r.status].label}</Badge>
  },
  { id: 'side', header: 'Kind', kind: 'enum', value: (r) => r.side, width: 90, options: [{ value: 'bill', label: 'Bill' }, { value: 'payment', label: 'Payment' }], text: (r) => (r.side === 'bill' ? 'Bill' : 'Payment') },
  { id: 'sDate', header: 'Date', group: 'Their books', kind: 'date', value: (r) => r.supplier?.date ?? '' },
  { id: 'sDoc', header: 'Doc no.', group: 'Their books', kind: 'text', value: (r) => r.supplier?.docNo ?? '', width: 120, className: 'num' },
  { id: 'sAmt', header: 'Amount', group: 'Their books', kind: 'money', value: (r) => (r.supplier ? r.supplier.debit + r.supplier.credit : null), width: 130 },
  { id: 'bDate', header: 'Date', group: 'Our books', kind: 'date', value: (r) => r.book?.date ?? '' },
  {
    id: 'bNo', header: 'Voucher', group: 'Our books', kind: 'text', value: (r) => r.book?.number ?? '', width: 100,
    cell: (r) => (r.book ? <VoucherLink voucherId={r.book.voucherId} label={<span className="num">{r.book.number}</span>} /> : null)
  },
  { id: 'bRef', header: 'Their inv.', group: 'Our books', kind: 'text', value: (r) => r.book?.supplierRef ?? '', width: 110, className: 'num' },
  { id: 'bAmt', header: 'Amount', group: 'Our books', kind: 'money', value: (r) => (r.book ? r.book.debit + r.book.credit : null), width: 130 },
  { id: 'diff', header: 'Difference', kind: 'money', value: (r) => (r.amountDiff ? r.amountDiff : null), width: 120, className: 'text-cr' },
  { id: 'days', header: 'Days apart', kind: 'number', value: (r) => r.dateDiffDays, width: 90, defaultHidden: true },
  { id: 'by', header: 'Matched by', kind: 'text', value: (r) => (r.matchedBy ? BY[r.matchedBy] : ''), width: 140, defaultHidden: true }
])

export function SuppliersTab({ tabs }: { tabs: ReactNode }): React.JSX.Element {
  const session = useSession()
  const toast = useToasts()
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [from, setFrom] = useState(session.from)
  const [to, setTo] = useState(session.to)
  const [csvText, setCsvText] = useState('')
  const [tolerance, setTolerance] = useState('1.00')
  const [dateDays, setDateDays] = useState('7')
  const [recon, setRecon] = useState<SupplierReconResult | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: statement, isLoading } = useQuery({
    queryKey: ['supplierStatement', ledgerId, from, to],
    queryFn: () => payablesApi.supplierStatement(ledgerId!, from, to),
    enabled: ledgerId != null
  })

  const runRecon = async (): Promise<void> => {
    if (ledgerId == null || !csvText.trim()) return
    setBusy(true)
    try {
      const r = await payablesApi.supplierRecon({
        ledgerId, from, to, csvText, amountPaise: Math.max(0, parseRupees(tolerance) ?? 0), dateDays: Math.max(0, Number(dateDays) || 0)
      })
      setRecon(r)
      if (r.parseError) toast.push('error', r.parseError)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const loadFile = (file: File | undefined): void => {
    if (!file) return
    void file.text().then(setCsvText)
  }

  const periodLabel = `${toDisplayDate(from)} → ${toDisplayDate(to)}`
  return (
    <Page width="wide">
      <PageHeader
        title="Payables"
        period={statement ? `${statement.name} · ${periodLabel}` : periodLabel}
        tabs={tabs}
        controls={
          <div className="flex items-center gap-2">
            <LedgerPicker value={ledgerId} onPick={(id) => { setLedgerId(id); setRecon(null) }} filter={creditorFilter} placeholder="Supplier" testId="picker-payables-supplier" className="w-56" />
            <DateInput value={from} context={from} onChange={setFrom} testId="input-payables-stmt-from" ariaLabel="From" className="w-28" />
            <DateInput value={to} context={to} onChange={setTo} testId="input-payables-stmt-to" ariaLabel="To" className="w-28" />
          </div>
        }
        options={{
          content: (
            <>
              <OptionsTable area="payables-statement" label="Supplier statement" />
              <DrawerSection title="Matching tolerances">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Amount ± ₹">
                    <TextInput value={tolerance} onChange={(e) => setTolerance(e.target.value)} className="num text-right" data-testid="input-recon-tolerance" />
                  </Field>
                  <Field label="Date ± days">
                    <TextInput value={dateDays} onChange={(e) => setDateDays(e.target.value)} className="num text-right" data-testid="input-recon-days" />
                  </Field>
                </div>
                <p className="text-hint text-muted">
                  Lines pair one-to-one: by invoice number (exact, then ignoring series prefixes, FY tokens and leading zeros — as the GSTR-2B
                  match does), then by amount within the tolerance and date within the window. Bills pair with bills, payments and notes with
                  payments and notes.
                </p>
              </DrawerSection>
            </>
          )
        }}
      />
      {ledgerId == null ? (
        <Panel>
          <p className="px-4 py-8 text-center text-body-sm text-muted">Pick a supplier for its statement and to reconcile it with theirs.</p>
        </Panel>
      ) : (
        <>
          <StatGrid className="mb-section">
            <StatTile label="Opening (we owe)" value={formatPaise(statement?.opening ?? 0, { symbol: true })} loading={isLoading} testId="supplier-tile-opening" />
            <StatTile label="Closing (we owe)" value={formatPaise(statement?.closing ?? 0, { symbol: true })} loading={isLoading} testId="supplier-tile-closing" />
            {recon && (
              <>
                <StatTile label="Their closing (lines given)" value={formatPaise(recon.supplierBalance, { symbol: true })} testId="supplier-tile-theirs" />
                <StatTile
                  label="Difference"
                  value={formatPaise(recon.difference, { symbol: true })}
                  tone={recon.difference !== 0 ? 'cr' : 'dr'}
                  hint={`${recon.counts.matched} matched · ${recon.counts.amount_diff} differ · ${recon.counts.only_supplier} only theirs · ${recon.counts.only_books} only ours`}
                  testId="supplier-tile-difference"
                />
              </>
            )}
          </StatGrid>
          <Panel className="mb-section">
            <DataTable
              viewId="payables-statement"
              testId="payables-statement"
              ariaLabel="Supplier statement"
              columns={STATEMENT_COLUMNS}
              rows={statement?.rows ?? []}
              rowKey={(r, i) => `${r.voucherId}-${i}`}
              loading={isLoading}
              maxHeight="40vh"
              empty={{ title: 'No entries in this period' }}
              exportOptions={{
                title: `Statement of account — ${statement?.name ?? ''}`,
                periodLabel,
                filename: 'supplier-statement',
                footNote: `Opening ${formatPaise(statement?.opening ?? 0)} · closing ${formatPaise(statement?.closing ?? 0)} (we owe)`
              }}
            />
          </Panel>
          <Panel className="mb-section">
            <div className="flex flex-col gap-2 px-4 py-3">
              <p className="text-small font-semibold text-ink">Reconcile with the supplier&apos;s ledger</p>
              <Textarea
                rows={5}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                data-testid="input-recon-csv"
                placeholder={'Paste their ledger as CSV — e.g.\nDate,Invoice No,Particulars,Debit,Credit\n05/04/2026,INV-101,Sales,11800.00,\n20/04/2026,RCPT-7,Payment received,,11800.00'}
                className="num"
              />
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-hint text-blue hover:underline">
                  <input type="file" accept=".csv,text/csv" className="sr-only" data-testid="input-recon-file" onChange={(e) => loadFile(e.target.files?.[0])} />
                  Load a CSV file…
                </label>
                <span className="flex-1" />
                <Button variant="primary" data-testid="btn-payables-reconcile" disabled={!csvText.trim() || busy} onClick={() => void runRecon()}>
                  Reconcile
                </Button>
              </div>
              {recon && recon.skipped.length > 0 && (
                <p className="text-hint text-muted" data-testid="recon-skipped">
                  Skipped {recon.skipped.length} line{recon.skipped.length === 1 ? '' : 's'}: {recon.skipped.slice(0, 4).map((s) => `line ${s.line} (${s.reason})`).join(', ')}
                  {recon.skipped.length > 4 ? '…' : ''}
                </p>
              )}
            </div>
          </Panel>
          {recon?.parseError && <Banner tone="danger" className="mb-section">{recon.parseError}</Banner>}
          {recon && !recon.parseError && (
            <Panel>
              <DataTable
                viewId="payables-recon"
                testId="payables-recon"
                ariaLabel="Supplier reconciliation"
                columns={RECON_COLUMNS}
                rows={recon.pairs}
                rowKey={(r, i) => `${r.status}-${r.supplier?.line ?? 'b'}-${r.book?.voucherId ?? 's'}-${i}`}
                rowAttrs={(r) => ({ 'data-status': r.status })}
                viewDefaults={{ groupBy: 'status' }}
                empty={{ title: 'Nothing to compare' }}
                exportOptions={{ title: `Supplier reconciliation — ${recon.name}`, periodLabel, filename: 'supplier-reconciliation' }}
              />
            </Panel>
          )}
        </>
      )}
    </Page>
  )
}
