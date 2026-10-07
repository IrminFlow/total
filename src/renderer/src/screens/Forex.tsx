// Forex (WP 4.4): foreign-currency exposures by currency, the closing rates the user enters, the
// revaluation journal (restating monetary items at the closing rate — AS 11 para 11 / Ind AS 21
// para 23 — with a next-day reversal), and settlement at an actual rate with the realised
// difference. Arithmetic: src/shared/forex.ts; posting: src/main/services/forex.ts.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FxExposureRow, FxRate, FxRevaluationRow } from '@shared/cashFinance'
import { formatFc, microToRateText, parseRateMicro, settlementSplit } from '@shared/forex'
import { toDisplayDate, todayISO } from '@shared/dates'
import { formatPaise } from '@shared/money'
import { api } from '../lib/client'
import { cfApi } from '../lib/cashFinanceClient'
import { useToasts } from '../state/stores'
import {
  Badge, Banner, Button, Checkbox, DateInput, DrawerSection, Field, Modal, Page, PageHeader, Panel, SectionTitle, Select, StatTile, TextInput
} from '../components/ui'
import { OptionsTable } from '../components/ScreenOptions'
import { DataTable, defineColumns } from '../components/table'
import { LedgerLink, VoucherLink } from '../components/links'
import { LedgerPicker } from '../components/pickers'
import { underGroup } from './Loans'
import { confirmDialog } from '../lib/dialogs'

const KIND_OPTIONS = [
  { value: 'receivable', label: 'Receivable' },
  { value: 'payable', label: 'Payable' },
  { value: 'bank', label: 'Bank' }
]

const GainLoss = ({ paise }: { paise: number | null }): React.JSX.Element =>
  paise == null ? <span className="text-muted">—</span> : paise === 0 ? <span className="num text-muted">0.00</span> : (
    <span className={`num ${paise > 0 ? 'text-dr' : 'text-cr'}`}>{paise > 0 ? '+' : '−'}{formatPaise(Math.abs(paise))}</span>
  )

const EXPOSURE_COLUMNS = defineColumns<FxExposureRow>([
  { id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName, hideable: false, minWidth: 160, cell: (r) => <LedgerLink ledgerId={r.ledgerId} name={r.ledgerName} /> },
  { id: 'kind', header: 'Kind', kind: 'enum', value: (r) => r.kind, options: KIND_OPTIONS, width: 100 },
  { id: 'currency', header: 'Currency', kind: 'text', value: (r) => r.currencyCode, width: 84, groupKey: (r) => r.currencyCode },
  { id: 'fc', header: 'Foreign balance', kind: 'number', value: (r) => r.fcBalance / 100, text: (r) => formatFc(r.fcBalance, r.currencyCode), width: 150 },
  { id: 'book', header: 'Book value', kind: 'money', value: (r) => r.inrBook, signed: true, aggregate: 'sum', width: 140 },
  { id: 'carrying', header: 'Book rate', kind: 'number', value: (r) => (r.carryingRateMicro ?? 0) / 1e6, text: (r) => (r.carryingRateMicro ? microToRateText(r.carryingRateMicro) : '—'), width: 92, className: 'text-muted' },
  { id: 'closing', header: 'Closing rate', kind: 'number', value: (r) => (r.closingRateMicro ?? 0) / 1e6, text: (r) => (r.closingRateMicro ? `${microToRateText(r.closingRateMicro)} (${toDisplayDate(r.closingRateDate!)})` : 'not entered'), width: 150,
    cell: (r) => (r.closingRateMicro ? <span className="num">{microToRateText(r.closingRateMicro)} <span className="text-caption text-muted">{toDisplayDate(r.closingRateDate!)}</span></span> : <Badge tone="warning">No rate</Badge>) },
  { id: 'target', header: 'At closing rate', kind: 'money', value: (r) => r.target, signed: true, aggregate: 'sum', width: 140 },
  { id: 'gain', header: 'Unrealised gain / loss', kind: 'money', value: (r) => r.gainLoss, aggregate: 'sum', width: 160, cell: (r) => <GainLoss paise={r.gainLoss} /> },
  { id: 'inferred', header: 'Note', kind: 'text', value: (r) => (r.inferredLines > 0 ? 'rupee entries at book rate' : ''), width: 170, defaultHidden: false, className: 'text-caption text-muted' }
])

const RATE_COLUMNS = defineColumns<FxRate>([
  { id: 'date', header: 'Date', kind: 'date', value: (r) => r.date, width: 104 },
  { id: 'currency', header: 'Currency', kind: 'text', value: (r) => r.currencyCode, width: 90 },
  { id: 'rate', header: '₹ per unit', kind: 'number', value: (r) => r.rateMicro / 1e6, text: (r) => microToRateText(r.rateMicro), width: 110 },
  { id: 'note', header: 'Source / note', kind: 'text', value: (r) => r.note ?? '', minWidth: 120, className: 'text-muted' }
])

const REVAL_COLUMNS = defineColumns<FxRevaluationRow>([
  { id: 'asOf', header: 'As on', kind: 'date', value: (r) => r.asOf, width: 104 },
  { id: 'journal', header: 'Journal', kind: 'text', value: (r) => r.voucherNumber ?? '', width: 120, cell: (r) => <VoucherLink voucherId={r.live ? r.voucherId : null} label={r.voucherNumber ?? '—'} /> },
  { id: 'reversal', header: 'Reversal', kind: 'text', value: (r) => r.reversalVoucherNumber ?? '', width: 120, cell: (r) => (r.reversalVoucherId ? <VoucherLink voucherId={r.reversalVoucherId} label={r.reversalVoucherNumber} /> : <span className="text-muted">—</span>) },
  { id: 'gain', header: 'Gain', kind: 'money', value: (r) => r.gain, width: 120, className: 'text-dr' },
  { id: 'loss', header: 'Loss', kind: 'money', value: (r) => r.loss, width: 120, className: 'text-cr' },
  { id: 'status', header: 'Status', kind: 'enum', value: (r) => (r.live ? 'live' : 'binned'), options: [{ value: 'live', label: 'Posted' }, { value: 'binned', label: 'In the bin' }], width: 100 }
])

export function ForexScreen(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const [asOf, setAsOf] = useState(todayISO())
  const { data: preview, isLoading } = useQuery({ queryKey: ['fxPreview', asOf], queryFn: () => cfApi.fx.preview(asOf) })
  const { data: rates = [] } = useQuery({ queryKey: ['fxRates'], queryFn: cfApi.fx.rates })
  const { data: revals = [] } = useQuery({ queryKey: ['fxRevaluations'], queryFn: cfApi.fx.revaluations })
  const { data: currencies = [] } = useQuery({ queryKey: ['currencies'], queryFn: api.currencies.list })
  const [revaluing, setRevaluing] = useState(false)
  const [settling, setSettling] = useState(false)
  const [designating, setDesignating] = useState(false)
  const rows = preview?.rows ?? []
  const byCurrency = useMemo(() => {
    const m = new Map<string, { fc: number; gain: number; ledgers: number }>()
    for (const r of rows) {
      const x = m.get(r.currencyCode) ?? { fc: 0, gain: 0, ledgers: 0 }
      x.fc += r.fcBalance
      x.gain += r.gainLoss ?? 0
      x.ledgers++
      m.set(r.currencyCode, x)
    }
    return [...m]
  }, [rows])
  const codes = useMemo(() => [...new Set([...currencies.map((c) => c.code), ...rows.map((r) => r.currencyCode)])].filter((c) => c !== 'INR').sort(), [currencies, rows])
  const refresh = async (): Promise<void> => {
    for (const k of ['fxPreview', 'fxRates', 'fxRevaluations', 'fxLedgerCurrencies', 'forecastBase']) await qc.invalidateQueries({ queryKey: [k] })
  }
  const reverse = async (r: FxRevaluationRow): Promise<void> => {
    if (!(await confirmDialog({ title: 'Reverse revaluation', message: `Post the reversal of the ${toDisplayDate(r.asOf)} revaluation, dated the next day?`, confirmLabel: 'Reverse' }))) return
    try {
      await cfApi.fx.reverse(r.id)
      await refresh()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Page width="full">
      <PageHeader
        title="Forex"
        subtitle="Foreign-currency receivables, payables and bank balances"
        period={`as on ${toDisplayDate(asOf)}`}
        actions={
          <>
            <Button data-testid="btn-forex-settle" onClick={() => setSettling(true)} disabled={rows.length === 0}>Settle at actual rate…</Button>
            <Button variant="primary" data-testid="btn-forex-revalue" onClick={() => setRevaluing(true)} disabled={!preview || !!preview.blocked}>Revalue…</Button>
          </>
        }
        options={{
          content: (
            <>
              <OptionsTable area="forex-exposures" label="Exposures table" />
              <DrawerSection title="Basis">
                <p className="text-hint text-muted">
                  Monetary items in a foreign currency (receivables, payables, bank balances) are reported at the closing rate on the
                  balance-sheet date (AS 11 para 11; Ind AS 21 para 23), and exchange differences go to profit or loss (AS 11 para 13; Ind
                  AS 21 para 28). The revaluation journal is reversed the next day so the bill is settled at its book rate and the actual
                  difference is booked on settlement.
                </p>
              </DrawerSection>
              <DrawerSection title="Foreign-currency bank accounts">
                <Button size="sm" data-testid="btn-forex-designate" onClick={() => setDesignating(true)}>Mark a ledger as foreign-currency…</Button>
                <p className="text-hint text-muted">Party ledgers are picked up from their foreign-currency invoices; an EEFC bank account must be marked here.</p>
              </DrawerSection>
            </>
          )
        }}
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="As on" className="w-40">
          <DateInput value={asOf} context={todayISO()} onChange={setAsOf} testId="input-forex-as-of" />
        </Field>
        {preview?.blocked && <Banner tone={preview.missingRates.length ? 'warning' : 'info'} testId="forex-blocked" className="flex-1">{preview.blocked}</Banner>}
      </div>

      {byCurrency.length > 0 && (
        <ul className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Exposure by currency">
          {byCurrency.map(([code, x]) => (
            <li key={code}>
              <StatTile
                label={`${code} · ${x.ledgers} ledger${x.ledgers === 1 ? '' : 's'}`}
                testId={`tile-forex-${code}`}
                value={formatFc(x.fc, code)}
                footer={<span>Unrealised <GainLoss paise={x.gain} /></span>}
              />
            </li>
          ))}
        </ul>
      )}

      {rows.some((r) => r.inferredLines > 0) && (
        <Banner tone="info" className="mb-3" testId="forex-inferred">
          Some rupee receipts or payments carry no foreign amount, so they were taken at the book rate (no gain or loss recorded on them).
          Record settlements with “Settle at actual rate” to book the realised difference.
        </Banner>
      )}

      <Panel className="mb-section">
        <DataTable
          viewId="forex-exposures"
          testId="forex-exposures"
          ariaLabel={`Foreign-currency exposures as on ${toDisplayDate(asOf)}`}
          columns={EXPOSURE_COLUMNS}
          rows={rows}
          rowKey={(r) => `${r.ledgerId}-${r.currencyCode}`}
          rowAttrs={(r) => ({ 'data-ledger-id': r.ledgerId, 'data-currency': r.currencyCode })}
          loading={isLoading}
          maxHeight="none"
          empty={{ title: 'No foreign-currency balances', hint: 'Raise an invoice in a foreign currency (Currency + rate on the invoice), or mark an EEFC bank ledger' }}
          exportOptions={{ title: 'Forex exposures', periodLabel: `as on ${toDisplayDate(asOf)}`, filename: 'forex-exposures' }}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <section>
          <SectionTitle>Closing rates</SectionTitle>
          <Panel>
            <RateEditor codes={codes} defaultDate={asOf} onSaved={refresh} />
            <DataTable
              viewId="fx-rates"
              testId="fx-rates"
              ariaLabel="Closing rates"
              columns={RATE_COLUMNS}
              rows={rates}
              rowKey={(r) => r.id}
              maxHeight="40vh"
              trailingWidth={64}
              trailing={(r) => (
                <button type="button" className="text-small text-muted hover:text-danger" aria-label={`Delete rate ${r.currencyCode} ${r.date}`} onClick={() => void cfApi.fx.rateDelete(r.id).then(refresh, (e: Error) => toast.push('error', e.message))}>
                  ✕
                </button>
              )}
              empty={{ title: 'No rates yet', hint: 'Enter the closing rate you use (RBI reference / bank TT rate) — nothing is fetched online' }}
            />
          </Panel>
        </section>
        <section>
          <SectionTitle>Revaluations</SectionTitle>
          <Panel>
            <DataTable
              viewId="fx-revaluations"
              testId="fx-revaluations"
              ariaLabel="Revaluation journals"
              columns={REVAL_COLUMNS}
              rows={revals}
              rowKey={(r) => r.id}
              maxHeight="40vh"
              trailingWidth={84}
              trailing={(r) => (r.live && !r.reversalVoucherId ? (
                <button type="button" data-testid={`btn-forex-reverse-${r.id}`} className="text-small text-blue hover:underline" onClick={() => void reverse(r)}>Reverse…</button>
              ) : null)}
              empty={{ title: 'No revaluations yet', hint: 'Revalue at the year end (31 March) or any reporting date' }}
            />
          </Panel>
        </section>
      </div>

      {revaluing && preview && <RevalueModal asOf={asOf} gain={preview.gain} loss={preview.loss} rows={rows} onClose={() => setRevaluing(false)} onDone={async () => { setRevaluing(false); await refresh() }} />}
      {settling && <SettleModal rows={rows} onClose={() => setSettling(false)} onDone={async () => { setSettling(false); await refresh() }} />}
      {designating && <DesignateModal codes={codes} onClose={() => setDesignating(false)} onDone={async () => { setDesignating(false); await refresh() }} />}
    </Page>
  )
}

function RateEditor({ codes, defaultDate, onSaved }: { codes: string[]; defaultDate: string; onSaved: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const [date, setDate] = useState(defaultDate)
  const [code, setCode] = useState(codes[0] ?? 'USD')
  const [rateText, setRateText] = useState('')
  const [note, setNote] = useState('')
  const add = async (): Promise<void> => {
    const rateMicro = parseRateMicro(rateText)
    if (!rateMicro) return toast.push('error', 'Enter the rate as rupees per unit, e.g. 83.25')
    try {
      await cfApi.fx.rateSave({ date, currencyCode: code.trim().toUpperCase(), rateMicro, note: note.trim() || null })
      setRateText('')
      await onSaved()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-line p-3" data-testid="fx-rate-editor">
      <Field label="Date" className="w-36"><DateInput value={date} context={defaultDate} onChange={setDate} testId="input-fx-rate-date" /></Field>
      <Field label="Currency" className="w-24">
        <TextInput value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 3))} list="fx-codes" data-testid="input-fx-rate-currency" />
      </Field>
      <datalist id="fx-codes">{codes.map((c) => <option key={c} value={c} />)}</datalist>
      <Field label="₹ per unit" className="w-28"><TextInput value={rateText} onChange={(e) => setRateText(e.target.value)} inputMode="decimal" placeholder="83.25" data-testid="input-fx-rate-value" /></Field>
      <Field label="Source (optional)" className="min-w-0 flex-1"><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="RBI reference rate" /></Field>
      <Button size="sm" variant="primary" data-testid="btn-fx-rate-save" onClick={() => void add()}>Save rate</Button>
    </div>
  )
}

function RevalueModal({ asOf, gain, loss, rows, onClose, onDone }: { asOf: string; gain: number; loss: number; rows: FxExposureRow[]; onClose: () => void; onDone: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const [autoReverse, setAutoReverse] = useState(true)
  const post = async (): Promise<void> => {
    try {
      const r = await cfApi.fx.revalue(asOf, autoReverse)
      toast.push('success', `Revaluation posted (${r.voucherNumber})`)
      await onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title={`Revalue as on ${toDisplayDate(asOf)}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3" data-testid="forex-revalue-modal">
        <table className="ledger-table">
          <thead><tr><th>Ledger</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
          <tbody>
            {rows.filter((r) => r.gainLoss).map((r) => (
              <tr key={`${r.ledgerId}-${r.currencyCode}`}>
                <td>{r.ledgerName} <span className="text-caption text-muted">{formatFc(r.fcBalance, r.currencyCode)} @ {microToRateText(r.closingRateMicro!)}</span></td>
                <td className="r num">{r.gainLoss! > 0 ? formatPaise(r.gainLoss!) : ''}</td>
                <td className="r num">{r.gainLoss! < 0 ? formatPaise(-r.gainLoss!) : ''}</td>
              </tr>
            ))}
            {gain > 0 && <tr><td>Unrealised Forex Gain <span className="text-caption text-muted">Indirect Incomes</span></td><td /><td className="r num">{formatPaise(gain)}</td></tr>}
            {loss > 0 && <tr><td>Unrealised Forex Loss <span className="text-caption text-muted">Indirect Expenses</span></td><td className="r num">{formatPaise(loss)}</td><td /></tr>}
          </tbody>
        </table>
        <Checkbox
          label="Reverse it on the next day"
          hint="Tally-style adjustment: the next period starts again from the book rate, and the real difference is booked when the bill is settled."
          checked={autoReverse}
          onChange={setAutoReverse}
          testId="input-forex-auto-reverse"
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-forex-revalue-post" onClick={() => void post()}>Post journal</Button>
        </div>
      </div>
    </Modal>
  )
}

function SettleModal({ rows, onClose, onDone }: { rows: FxExposureRow[]; onClose: () => void; onDone: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const parties = rows.filter((r) => r.kind !== 'bank' && r.fcBalance !== 0)
  const [ledgerId, setLedgerId] = useState<number | null>(parties[0]?.ledgerId ?? null)
  const party = parties.find((p) => p.ledgerId === ledgerId) ?? null
  const [bank, setBank] = useState<number | null>(null)
  const [date, setDate] = useState(todayISO())
  const [fcText, setFcText] = useState(party ? (Math.abs(party.fcBalance) / 100).toFixed(2) : '')
  const [rateText, setRateText] = useState('')
  const fc = /^\d+(\.\d{1,2})?$/.test(fcText.trim()) ? Math.round(Number(fcText.trim()) * 100) : null
  const rateMicro = parseRateMicro(rateText)
  let split: ReturnType<typeof settlementSplit> | null = null
  let splitError: string | null = null
  if (party && fc && rateMicro) {
    try {
      split = settlementSplit(party, fc, rateMicro)
    } catch (e) {
      splitError = (e as Error).message
    }
  }
  const post = async (): Promise<void> => {
    if (!party || !bank || !fc || !rateMicro) return toast.push('error', 'Pick the party and bank, and enter the amount and rate')
    try {
      const r = await cfApi.fx.settle({ partyLedgerId: party.ledgerId, bankLedgerId: bank, date, fcAmount: fc, settleRateMicro: rateMicro })
      toast.push('success', r.gainLoss === 0 ? 'Settlement posted' : `Settlement posted with a realised ${r.gainLoss > 0 ? 'gain' : 'loss'} of ${formatPaise(Math.abs(r.gainLoss), { symbol: true })}`)
      await onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title="Settle at the actual rate" onClose={onClose}>
      <div className="flex flex-col gap-3" data-testid="forex-settle-modal">
        <Field label="Party">
          <Select value={ledgerId ?? ''} onChange={(e) => { const id = Number(e.target.value); setLedgerId(id); const p = parties.find((x) => x.ledgerId === id); if (p) setFcText((Math.abs(p.fcBalance) / 100).toFixed(2)) }} data-testid="select-forex-settle-party">
            {parties.map((p) => <option key={p.ledgerId} value={p.ledgerId}>{p.ledgerName} — {formatFc(p.fcBalance, p.currencyCode)}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank"><LedgerPicker value={bank} onPick={setBank} filter={(l, g) => underGroup(l.groupId, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'], g)} placeholder="Bank" testId="picker-forex-settle-bank" /></Field>
          <Field label="Date"><DateInput value={date} context={todayISO()} onChange={setDate} testId="input-forex-settle-date" /></Field>
          <Field label={`Amount (${party?.currencyCode ?? 'foreign'})`}><TextInput value={fcText} onChange={(e) => setFcText(e.target.value)} inputMode="decimal" data-testid="input-forex-settle-fc" /></Field>
          <Field label="Rate (₹ per unit)"><TextInput value={rateText} onChange={(e) => setRateText(e.target.value)} inputMode="decimal" placeholder="84.10" data-testid="input-forex-settle-rate" /></Field>
        </div>
        {splitError && <p className="text-small text-danger">{splitError}</p>}
        {split && (
          <dl className="grid grid-cols-2 gap-1 rounded-md border border-line bg-panel2 p-3 text-small" data-testid="forex-settle-preview">
            <dt className="text-muted">{party!.kind === 'payable' ? 'Paid from bank' : 'Received in bank'}</dt><dd className="num text-right">{formatPaise(split.bankInr, { symbol: true })}</dd>
            <dt className="text-muted">Book value settled</dt><dd className="num text-right">{formatPaise(split.partyInr, { symbol: true })}</dd>
            <dt className="text-muted">Realised {split.gainLoss >= 0 ? 'gain' : 'loss'}</dt><dd className="text-right"><GainLoss paise={split.gainLoss} /></dd>
          </dl>
        )}
        <p className="text-hint text-muted">Posts a {party?.kind === 'payable' ? 'payment' : 'receipt'} at the rupees actually moved and a journal for the difference (Realised Forex Gain / Loss).</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="btn-forex-settle-post" onClick={() => void post()} disabled={!split}>Post</Button>
        </div>
      </div>
    </Modal>
  )
}

function DesignateModal({ codes, onClose, onDone }: { codes: string[]; onClose: () => void; onDone: () => Promise<void> }): React.JSX.Element {
  const toast = useToasts()
  const { data: list = [] } = useQuery({ queryKey: ['fxLedgerCurrencies'], queryFn: cfApi.fx.ledgerCurrencies })
  const [ledgerId, setLedgerId] = useState<number | null>(null)
  const [code, setCode] = useState(codes[0] ?? 'USD')
  const save = async (id: number, c: string | null): Promise<void> => {
    try {
      await cfApi.fx.setLedgerCurrency(id, c)
      await onDone()
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <Modal title="Foreign-currency ledgers" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {list.length > 0 && (
          <ul className="flex flex-col gap-1">
            {list.map((l) => (
              <li key={l.ledgerId} className="flex items-center justify-between text-small">
                <span>{l.ledgerName} · {l.currencyCode}</span>
                <button type="button" className="text-muted hover:text-danger" onClick={() => void save(l.ledgerId, null)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <Field label="Ledger"><LedgerPicker value={ledgerId} onPick={setLedgerId} testId="picker-forex-designate" /></Field>
          <Field label="Currency"><TextInput value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 3))} /></Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => ledgerId && void save(ledgerId, code)} disabled={!ledgerId || code.length !== 3}>Mark</Button>
        </div>
      </div>
    </Modal>
  )
}
