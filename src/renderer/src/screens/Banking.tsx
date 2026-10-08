import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { BankLineRow } from '@shared/reports'
import { api, type BrsItem } from '../lib/client'
import { DataTable, defineColumns, type TableColumn } from '../components/table'
import { useNav, useSession, useToasts } from '../state/stores'
import {
  Button, DateInput, DrawerSection, EmptyState, Field, Modal, Money, Page, PageHeader, Panel, SkeletonRows, Select, StatTile, TabBar
} from '../components/ui'
import { OptionChoice, OptionToggle, OptionsPeriod, OptionsTable, useScreenOptions } from '../components/ScreenOptions'
import { toDisplayDate, todayISO } from '@shared/dates'
import { FirstLedgerLink, VoucherLink } from '../components/links'
import { ImportTab } from './banking/ImportTab'
import { RulesTab } from './banking/RulesTab'
import { ChequeLayoutModal, ChequesTab } from './banking/ChequesTab'
import { PdcTab } from './banking/PdcTab'
import { BulkTab } from './banking/BulkTab'
import { AUTOSELECT_CHOICES, SUGGEST_CHOICES, TOLERANCE_CHOICES, WINDOW_CHOICES, type MatchSettings } from './banking/shared'

export type BankTab = 'recon' | 'import' | 'rules' | 'cheques' | 'pdc' | 'bulk' | 'brs'

const TAB_ORDER: BankTab[] = ['recon', 'import', 'rules', 'cheques', 'pdc', 'bulk', 'brs']
const TAB_LABELS: Record<BankTab, string> = {
  recon: 'Reconcile',
  import: 'Import',
  rules: 'Rules',
  cheques: 'Cheques',
  pdc: 'Post-dated',
  bulk: 'Bulk payments',
  brs: 'BRS'
}
/** Tabs that work on one bank account (the account picker shows for these). */
const PER_BANK: ReadonlySet<BankTab> = new Set(['recon', 'import', 'cheques', 'bulk', 'brs'])

const STATUS_OPTIONS = [
  { value: 'open', label: 'Unreconciled' },
  { value: 'reconciled', label: 'Reconciled' }
]

/** Bank book lines. The bank-date cell is the inline editor's trigger, so the column set is
 *  built once per screen around that callback. Deposits / withdrawals total for the period. */
function reconColumns(onEditBankDate: (r: BankLineRow) => void): TableColumn<BankLineRow>[] {
  return defineColumns<BankLineRow>([
    { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, className: 'text-muted' },
    {
      id: 'particulars',
      header: 'Particulars',
      kind: 'text',
      value: (r) => r.particulars,
      hideable: false,
      minWidth: 160,
      cell: (r) => <FirstLedgerLink ledgerId={r.particularsLedgerId} text={r.particulars} />
    },
    { id: 'type', header: 'Type', kind: 'text', value: (r) => r.voucherType, defaultHidden: true, width: 120, className: 'text-muted' },
    {
      id: 'number',
      header: 'Number',
      kind: 'text',
      value: (r) => r.number,
      defaultHidden: true,
      width: 110,
      className: 'num text-muted',
      cell: (r) => <VoucherLink voucherId={r.voucherId} label={r.number} />
    },
    { id: 'instrument', header: 'Instrument', kind: 'text', value: (r) => r.instrumentNo, width: 140, groupable: false, className: 'num text-muted' },
    { id: 'deposit', header: 'Deposit', kind: 'money', value: (r) => r.deposit, aggregate: 'sum', width: 140 },
    { id: 'withdrawal', header: 'Withdrawal', kind: 'money', value: (r) => r.withdrawal, aggregate: 'sum', width: 140 },
    {
      id: 'bankDate',
      header: 'Bank date',
      kind: 'date',
      value: (r) => r.bankDate,
      text: (r) => (r.bankDate ? toDisplayDate(r.bankDate) : ''),
      width: 128,
      groupable: false,
      cell: (r) => (
        <button className="num text-small text-blue hover:underline" data-testid="btn-banking-edit-bank-date" onClick={() => onEditBankDate(r)}>
          {r.bankDate ? toDisplayDate(r.bankDate) : 'Set date'}
        </button>
      )
    },
    {
      id: 'status',
      header: 'Status',
      kind: 'enum',
      value: (r) => (r.bankDate ? 'reconciled' : 'open'),
      options: STATUS_OPTIONS,
      defaultHidden: true,
      width: 130
    }
  ])
}

const BRS_COLUMNS = defineColumns<BrsItem>([
  { id: 'date', header: 'Date', kind: 'date', value: (it) => it.date, className: 'text-muted' },
  { id: 'type', header: 'Type', kind: 'text', value: (it) => it.voucherType, defaultHidden: true, width: 120, className: 'text-muted' },
  {
    id: 'number',
    header: 'Number',
    kind: 'text',
    value: (it) => it.number,
    width: 110,
    groupable: false,
    className: 'num text-muted',
    cell: (it) => <VoucherLink voucherId={it.voucherId} label={it.number} />
  },
  {
    id: 'particulars',
    header: 'Particulars',
    kind: 'text',
    value: (it) => it.particulars,
    hideable: false,
    minWidth: 160,
    cell: (it) => <FirstLedgerLink ledgerId={it.particularsLedgerId} text={it.particulars} />
  },
  { id: 'instrument', header: 'Instrument', kind: 'text', value: (it) => it.instrumentNo, width: 140, groupable: false, className: 'num text-muted' },
  { id: 'amount', header: 'Amount', kind: 'money', value: (it) => it.amount, aggregate: 'sum', width: 140 }
])

const BANKING_DEFAULTS = { hideCleared: false, tolerance: '0', window: '5', autoSelect: '0.75', suggest: '0.4' }

export function BankingScreen({ tab: initialTab }: { tab?: BankTab } = {}): React.JSX.Element {
  const nav = useNav()
  const { from, to } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data: ledgers } = useQuery({ queryKey: ['bankLedgers'], queryFn: api.bank.ledgers })
  const [tab, setTab] = useState<BankTab>(initialTab ?? 'recon')
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [chequeSetupOpen, setChequeSetupOpen] = useState(false)
  const [dateEdit, setDateEdit] = useState<{ lineId: number; current: string | null } | null>(null)
  const columns = useMemo(() => reconColumns((r) => setDateEdit({ lineId: r.lineId, current: r.bankDate })), [])
  const opts = useScreenOptions('banking', BANKING_DEFAULTS, {
    tolerance: TOLERANCE_CHOICES.map((c) => c.value),
    window: WINDOW_CHOICES.map((c) => c.value),
    autoSelect: AUTOSELECT_CHOICES.map((c) => c.value),
    suggest: SUGGEST_CHOICES.map((c) => c.value)
  })
  const settings: MatchSettings = {
    tolerancePaise: Number(opts.options.tolerance),
    dateWindowDays: Number(opts.options.window),
    autoSelect: Number(opts.options.autoSelect),
    minSuggest: Number(opts.options.suggest)
  }

  useEffect(() => {
    if (ledgerId == null && ledgers?.length) setLedgerId(ledgers[0]!.id)
  }, [ledgers, ledgerId])
  const bankName = (ledgers ?? []).find((l) => l.id === ledgerId)?.name ?? ''

  const { data: recon } = useQuery({
    queryKey: ['bankRecon', ledgerId, from, to],
    queryFn: () => api.bank.recon(ledgerId!, from, to),
    enabled: ledgerId != null && tab === 'recon'
  })

  const refresh = (): Promise<void> =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ['bankRecon'] }), queryClient.invalidateQueries({ queryKey: ['brs'] })]).then(() => undefined)

  const markToday = async (lineId: number, current: string | null): Promise<void> => {
    try {
      await api.bank.setBankDate(lineId, current ? null : todayISO())
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (ledgers && ledgers.length === 0) {
    return (
      <Page>
        <PageHeader title="Banking" />
        <Panel>
          <EmptyState
            title="No bank ledgers yet"
            hint="Create a ledger under Bank Accounts in Masters, then reconcile it here"
            action={<Button onClick={() => nav.go({ name: 'masters', tab: 'ledgers' })}>Open Masters</Button>}
          />
        </Panel>
      </Page>
    )
  }

  return (
    <Page>
      <PageHeader
        title="Banking"
        tabs={<TabBar screen="banking" label="Banking view" tabs={TAB_ORDER.map((t) => ({ id: t, label: TAB_LABELS[t] }))} active={tab} onSelect={setTab} />}
        controls={
          PER_BANK.has(tab) ? (
            <Select value={ledgerId ?? ''} onChange={(e) => setLedgerId(Number(e.target.value))} className="w-52" aria-label="Bank account" data-testid="banking-ledger">
              {(ledgers ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
        actions={
          tab === 'recon' ? (
            <Button variant="primary" data-testid="btn-banking-import" onClick={() => setTab('import')}>
              Import statement…
            </Button>
          ) : undefined
        }
        options={{
          onReset: opts.reset,
          content: (
            <>
              <OptionsPeriod />
              <DrawerSection title="Matching" testId="options-banking-matching">
                <OptionChoice
                  label="Amount tolerance"
                  value={opts.options.tolerance}
                  options={TOLERANCE_CHOICES}
                  onChange={(v) => opts.set('tolerance', v)}
                  testId="input-banking-tolerance"
                />
                <OptionChoice label="Date window (±)" value={opts.options.window} options={WINDOW_CHOICES} onChange={(v) => opts.set('window', v)} testId="input-banking-window" />
                <OptionChoice
                  label="Pre-select proposals that are"
                  value={opts.options.autoSelect}
                  options={AUTOSELECT_CHOICES}
                  onChange={(v) => opts.set('autoSelect', v)}
                  testId="input-banking-autoselect"
                />
                <OptionChoice label="Learned suggestions" value={opts.options.suggest} options={SUGGEST_CHOICES} onChange={(v) => opts.set('suggest', v)} testId="input-banking-suggest" />
                <p className="text-hint text-muted">
                  A statement line matches a book entry on the same side whose amount is within the tolerance and whose date is within the window; cheque numbers and party names raise the score.
                </p>
              </DrawerSection>
              <DrawerSection title="Reconcile">
                <OptionToggle
                  label="Hide entries already cleared"
                  hint="Cleared rows otherwise show dimmed."
                  checked={opts.options.hideCleared}
                  onChange={(v) => opts.set('hideCleared', v)}
                  testId="input-banking-hide-cleared"
                />
              </DrawerSection>
              {tab === 'recon' && <OptionsTable area="banking" label="Entries table" />}
              {ledgerId != null && (
                <DrawerSection title="Cheque printing">
                  <p className="text-hint text-muted">Cheque layout and printer offsets for this bank account.</p>
                  <div>
                    <Button size="sm" data-testid="btn-banking-cheque-setup-drawer" onClick={() => setChequeSetupOpen(true)}>
                      Cheque layout…
                    </Button>
                  </div>
                </DrawerSection>
              )}
            </>
          )
        }}
      />

      {tab === 'recon' && recon && (
        <>
          <div className="mb-section grid grid-cols-4 gap-3">
            <StatTile label="Balance as per books" value={<Money paise={recon.bookBalance} />} />
            <StatTile label="Deposits not in bank" value={<Money paise={recon.unreconciledDeposits} />} />
            <StatTile label="Withdrawals not in bank" value={<Money paise={recon.unreconciledWithdrawals} />} />
            <StatTile label="Balance as per bank" value={<Money paise={recon.bankBalance} />} />
          </div>

          <Panel>
            <DataTable
              viewId="banking-recon"
              testId="banking"
              ariaLabel="Bank entries"
              columns={columns}
              rows={opts.options.hideCleared ? recon.rows.filter((r) => !r.bankDate) : recon.rows}
              rowKey={(r) => r.lineId}
              rowAttrs={(r) => ({ 'data-row-id': r.lineId })}
              rowClassName={(r) => (r.bankDate ? 'text-muted' : '')}
              empty={{ title: 'No bank entries in this period' }}
              maxHeight="58vh"
              trailingWidth={112}
              trailing={(r) => (
                <button
                  type="button"
                  className="text-small text-muted hover:text-ink"
                  data-testid="btn-banking-mark-today"
                  aria-label={r.bankDate ? `Clear the bank date of ${r.particulars}` : `Mark ${r.particulars} cleared today`}
                  onClick={() => void markToday(r.lineId, r.bankDate)}
                >
                  {r.bankDate ? 'Clear' : 'Cleared today'}
                </button>
              )}
              exportOptions={{
                title: `Bank reconciliation — ${recon.ledgerName}`,
                periodLabel: `${toDisplayDate(from)} to ${toDisplayDate(to)}`,
                filename: 'bank-reconciliation'
              }}
            />
          </Panel>
          <p className="mt-2 text-hint text-muted">Import a statement to match it line by line · set a bank date by hand here · F12 for options.</p>
        </>
      )}

      {tab === 'import' && ledgerId != null && <ImportTab key={ledgerId} bankLedgerId={ledgerId} bankName={bankName} settings={settings} />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'cheques' && ledgerId != null && <ChequesTab key={ledgerId} bankLedgerId={ledgerId} bankName={bankName} />}
      {tab === 'pdc' && <PdcTab />}
      {tab === 'bulk' && ledgerId != null && <BulkTab key={ledgerId} bankLedgerId={ledgerId} bankName={bankName} />}
      {tab === 'brs' && ledgerId != null && <BrsSection ledgerId={ledgerId} defaultAsOn={to} />}

      {chequeSetupOpen && ledgerId != null && <ChequeLayoutModal bankLedgerId={ledgerId} bankLedgerName={bankName} onClose={() => setChequeSetupOpen(false)} />}
      {dateEdit && (
        <BankDateModal
          lineId={dateEdit.lineId}
          current={dateEdit.current}
          context={to}
          onDone={() => {
            setDateEdit(null)
            void refresh()
          }}
          onClose={() => setDateEdit(null)}
        />
      )}
    </Page>
  )
}

/** Bank-date editor: proper DateInput (Tally shorthand + inline parse errors) instead of a text prompt. */
function BankDateModal({
  lineId,
  current,
  context,
  onDone,
  onClose
}: {
  lineId: number
  current: string | null
  /** Date context for shorthand parsing (period end). */
  context: string
  onDone: () => void
  onClose: () => void
}): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(current ?? todayISO())
  const [saving, setSaving] = useState(false)

  const set = async (value: string | null): Promise<void> => {
    setSaving(true)
    try {
      await api.bank.setBankDate(lineId, value)
      onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Modal title="Bank date" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Cleared at the bank on" hint="Shorthand works: 7, 7/4, t (today), y (yesterday)">
          <DateInput value={date} context={context} onChange={setDate} testId="input-bank-date" className="w-40" />
        </Field>
        <div className="flex justify-between gap-2">
          <span>
            {current && (
              <Button variant="danger" disabled={saving} data-testid="btn-banking-clear-bank-date" onClick={() => void set(null)}>
                Clear bank date
              </Button>
            )}
          </span>
          <span className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saving} data-testid="btn-banking-set-bank-date" onClick={() => void set(date)}>
              Set date
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  )
}

/** Bank Reconciliation Statement as on a date: book balance → uncredited/unpresented → bank balance. */
function BrsSection({ ledgerId, defaultAsOn }: { ledgerId: number; defaultAsOn: string }): React.JSX.Element {
  const toast = useToasts()
  const [asOn, setAsOn] = useState(defaultAsOn)
  const [printing, setPrinting] = useState(false)
  const { data: brs, isLoading } = useQuery({
    queryKey: ['brs', ledgerId, asOn],
    queryFn: () => api.bank.brs(ledgerId, asOn)
  })

  const pdf = async (): Promise<void> => {
    setPrinting(true)
    try {
      const r = await api.bank.brsPdf(ledgerId, asOn)
      toast.push('success', `BRS PDF: ${r.path}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setPrinting(false)
    }
  }

  const itemTable = (items: BrsItem[], area: string, title: string): React.JSX.Element =>
    items.length === 0 ? (
      <p className="px-4 py-3 text-body-sm text-muted">None</p>
    ) : (
      <DataTable
        viewId={area}
        testId={area}
        ariaLabel={title}
        columns={BRS_COLUMNS}
        rows={items}
        rowKey={(it) => it.lineId}
        rowAttrs={(it) => ({ 'data-row-id': it.voucherId })}
        maxHeight="32vh"
        exportOptions={{
          title: `BRS — ${title}`,
          periodLabel: `${brs?.ledgerName ?? ''} · as on ${toDisplayDate(asOn)}`,
          filename: area
        }}
      />
    )

  return (
    <>
      <div className="mb-3 flex items-end justify-between">
        <Field label="As on">
          <DateInput value={asOn} context={defaultAsOn} onChange={setAsOn} testId="input-brs-date" className="w-40" />
        </Field>
        <Button disabled={printing || !brs} data-testid="btn-banking-brs-pdf" onClick={() => void pdf()}>
          Export PDF
        </Button>
      </div>

      {isLoading || !brs ? (
        <Panel>
          <SkeletonRows rows={6} />
        </Panel>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-4 gap-3">
            <StatTile label="Balance as per books" value={<Money paise={brs.bookBalance} signed />} />
            <StatTile label="Deposited, not credited" value={<Money paise={brs.uncreditedTotal} />} />
            <StatTile label="Issued, not presented" value={<Money paise={brs.unpresentedTotal} />} />
            <StatTile label="Balance as per bank" value={<Money paise={brs.bankBalance} signed />} />
          </div>

          <Panel className="mb-3">
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Deposits not yet credited by the bank · {brs.uncredited.length}</p>
            </div>
            {itemTable(brs.uncredited, 'banking-brs-uncredited', 'Deposits not yet credited')}
          </Panel>

          <Panel>
            <div className="border-b border-line px-4 py-2.5">
              <p className="text-label font-semibold tracking-[0.08em] text-muted uppercase">Cheques issued, not yet presented · {brs.unpresented.length}</p>
            </div>
            {itemTable(brs.unpresented, 'banking-brs-unpresented', 'Cheques issued, not yet presented')}
          </Panel>
        </>
      )}
    </>
  )
}
