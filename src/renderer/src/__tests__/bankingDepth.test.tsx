// WP 4.1 — Banking tabs: the statement workspace (proposals pre-selected, bulk confirm, learned
// suggestion "Suggested from N earlier matches", bulk create), the PDC bounce dialog, the cheque
// layout preview, bulk payment export, and the PDC reminder on the Gateway compliance card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PaymentCandidate, PdcRegisterRow, Workspace } from '../lib/bankingClient'
import { useNav, useSession } from '../state/stores'
import { BankingScreen } from '../screens/Banking'
import { ChequePreview } from '../screens/banking/ChequesTab'
import { ComplianceCard } from '../screens/gateway/cards'
import { DialogHost } from '../components/dialogs'
import { DEFAULT_CHEQUE_CONFIG } from '@shared/schemas'
import { BUILTIN_PAYMENT_TEMPLATES } from '@shared/bulkPayments'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])
const bodyRows = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

function renderUi(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {ui}
      <DialogHost />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  handlers = {
    'bank:ledgers': () => [{ id: 5, name: 'HDFC Bank' }],
    'master:ledgers:list': () => [],
    'master:groups:list': () => []
  }
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'bank-co', from: '2026-04-01', to: '2027-03-31' })
    useNav.setState({ stack: [{ name: 'gateway' }] })
  })
})
afterEach(() => cleanup())

const entry = (voucherId: number, number: string, amount: number) => ({
  voucherId, lineId: voucherId * 10, number, voucherType: 'Receipt', date: '2026-08-01', amount, particulars: 'Acme Traders', particularsLedgerId: 31, side: 'deposit' as const
})

const WS: Workspace = {
  imports: [{ id: 3, importedAt: '2026-08-10 09:00:00', fileName: 'aug.csv', format: 'csv', lineCount: 3, duplicateCount: 0, matched: 0, created: 0 }],
  openEntries: [entry(101, 'R1', 2_500_000)],
  lines: [
    {
      id: 1, importId: 3, date: '2026-08-02', valueDate: null, description: 'NEFT ACME TRADERS', reference: 'N1', side: 'deposit', amount: 2_500_000, balance: null,
      status: 'open', matched: [],
      proposal: { kind: 'one_to_one', lineIds: [1], score: 0.9, ambiguous: false, reasons: ['same amount'], entries: [entry(101, 'R1', 2_500_000)] },
      suggestion: null
    },
    {
      id: 2, importId: 3, date: '2026-08-03', valueDate: null, description: 'UPI RAVI KUMAR RENT', reference: '', side: 'withdrawal', amount: 1_800_000, balance: null,
      status: 'open', matched: [], proposal: null,
      suggestion: { source: 'learned', ruleId: 9, ledgerId: 40, ledgerName: 'Office Rent', partyLedgerId: null, voucherKind: 'payment', narration: 'UPI RAVI KUMAR RENT', confidence: 0.93, evidence: 12, status: 'candidate' }
    },
    {
      id: 3, importId: 3, date: '2026-08-04', valueDate: null, description: 'SOMETHING ELSE', reference: '', side: 'withdrawal', amount: 1000, balance: null,
      status: 'open', matched: [], proposal: null, suggestion: null
    }
  ]
}

describe('Import tab workspace', () => {
  beforeEach(() => {
    handlers['bankImport:workspace'] = () => WS
    handlers['bankImport:confirm'] = () => ({ confirmed: 1 })
    handlers['bankImport:createVouchers'] = () => ({ created: [{ lineId: 2, voucherId: 500, number: 'P-1' }], failed: [] })
    handlers['bankImport:undo'] = () => ({ binned: 0, unmatched: 0, removedLines: 3 })
  })

  it('pre-selects confident proposals, shows learned evidence, confirms and creates in bulk', async () => {
    renderUi(<BankingScreen tab="import" />)
    await waitFor(() => expect(bodyRows('banking-statement')).toHaveLength(3))
    const [r1, r2, r3] = bodyRows('banking-statement')
    expect(within(r1!).getByTestId('input-banking-line-pick')).toHaveProperty('checked', true)
    expect(within(r2!).getByTestId('text-banking-evidence').textContent).toBe('Suggested from 12 earlier matches')
    expect(within(r3!).queryByTestId('input-banking-line-pick')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-banking-confirm-matches'))
    await waitFor(() => expect(calls('bankImport:confirm')).toEqual([{ bankLedgerId: 5, groups: [{ lineIds: [1], voucherIds: [101] }], tolerance: 0 }]))
    fireEvent.click(within(r2!).getByTestId('input-banking-line-pick'))
    fireEvent.click(screen.getByTestId('btn-banking-create-vouchers'))
    await waitFor(() =>
      expect(calls('bankImport:createVouchers')).toEqual([
        { bankLedgerId: 5, items: [{ lineId: 2, ledgerId: 40, partyLedgerId: null, narration: 'UPI RAVI KUMAR RENT', source: { kind: 'learned', ruleId: 9 } }] }
      ])
    )
  })

  it('undo last import asks first, then calls the latest import', async () => {
    renderUi(<BankingScreen tab="import" />)
    fireEvent.click(await screen.findByTestId('btn-banking-undo-import'))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo import' }))
    await waitFor(() => expect(calls('bankImport:undo')).toEqual([{ bankLedgerId: 5, importId: 3 }]))
  })

  it('tolerance from the Options drawer reaches the workspace query', async () => {
    localStorage.setItem('total-screenopts-bank-co-banking', JSON.stringify({ tolerance: '100', window: '7', suggest: '0.6' }))
    renderUi(<BankingScreen tab="import" />)
    await waitFor(() =>
      expect(calls('bankImport:workspace').at(-1)).toEqual({
        bankLedgerId: 5, includeDone: false, options: { amountTolerance: 100, dateWindowDays: 7 }, minSuggestScore: 0.6
      })
    )
  })
})

describe('Post-dated tab', () => {
  const row = (o: Partial<PdcRegisterRow>): PdcRegisterRow => ({
    voucherId: 1, number: 'R9', voucherTypeName: 'Receipt', date: '2026-08-10', direction: 'received', partyLedgerId: 31, partyName: 'Acme Traders',
    bankLedgerId: 5, bankLedgerName: 'HDFC Bank', instrumentNo: '111', instrumentDate: null, amount: 500_000, status: 'matured',
    maturedAt: '2026-08-10', bouncedOn: null, bounceVoucherId: null, bounceCharges: null, bounceReason: null, ...o
  })
  it('records a bounce with charges recovered from the party', async () => {
    handlers['pdc:register'] = () => [row({}), row({ voucherId: 2, number: 'P3', direction: 'issued', status: 'pending', date: '2099-01-01' })]
    handlers['pdc:bounce'] = () => ({ reversalVoucherId: 9, chargesVoucherId: 10 })
    renderUi(<BankingScreen tab="pdc" />)
    // Older matured cheques are folded away until "Show all" is ticked.
    await waitFor(() => expect(bodyRows('banking-pdc')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('input-banking-pdc-all'))
    await waitFor(() => expect(bodyRows('banking-pdc')).toHaveLength(2))
    fireEvent.click(within(bodyRows('banking-pdc')[0]!).getByTestId('btn-banking-pdc-bounce'))
    fireEvent.change(await screen.findByTestId('input-banking-bounce-charges'), { target: { value: '590' } })
    fireEvent.blur(screen.getByTestId('input-banking-bounce-charges'))
    fireEvent.change(screen.getByTestId('input-banking-bounce-reason'), { target: { value: 'Funds insufficient' } })
    fireEvent.click(screen.getByTestId('btn-banking-bounce-save'))
    await waitFor(() => expect(calls('pdc:bounce')).toHaveLength(1))
    expect(calls('pdc:bounce')[0]).toMatchObject({ voucherId: 1, charges: 59_000, recoverChargesFromParty: true, reason: 'Funds insufficient' })
  })
})

describe('Cheque layout preview', () => {
  it('draws the leaf, the date boxes, the words and the crossing at their mm positions', () => {
    renderUi(<ChequePreview config={{ ...DEFAULT_CHEQUE_CONFIG, acPayeePos: { xMm: 9, yMm: 7 } }} />)
    const svg = screen.getByTestId('banking-cheque-preview')
    expect(svg.getAttribute('viewBox')).toBe('-6 -6 214 104')
    expect(svg.textContent).toContain('Twelve Thousand Three Hundred')
    expect(svg.textContent).toContain('Fifty Paise Only')
    expect(svg.textContent).toContain('12,345.50/-')
    expect(svg.textContent).toContain('A/C PAYEE ONLY')
    expect(svg.querySelector('g')!.getAttribute('transform')).toBe('translate(9 7) rotate(-12)')
  })
})

describe('Bulk payments tab', () => {
  it('exports the selected ready payments with the chosen template', async () => {
    const cand = (o: Partial<PaymentCandidate>): PaymentCandidate => ({
      voucherId: 1, number: 'P1', date: '2026-08-12', amount: 1_234_550, payeeLedgerId: 7, payeeName: 'Shree', narration: null, accountNo: '1111', ifsc: 'ICIC0000001',
      accountName: 'Shree', email: null, problems: [], postDated: false, exportedIn: [], chequeNo: null, ...o
    })
    handlers['bulkPay:templates'] = () => BUILTIN_PAYMENT_TEMPLATES.map(({ key, source, ...spec }) => ({ id: null, key: `builtin:${key}`, builtin: true, source, spec }))
    handlers['bulkPay:candidates'] = () => [cand({}), cand({ voucherId: 2, number: 'P2', problems: ['no IFSC'], ifsc: null })]
    handlers['bulkPay:beneficiaries'] = () => [{ ledgerId: 5, name: 'HDFC Bank', groupName: 'Bank Accounts', isBank: true, accountNo: '5668', ifsc: 'UBIN0556688', accountName: null, email: null, problems: [] }]
    handlers['bulkPay:batches'] = () => []
    handlers['bulkPay:export'] = () => ({ batchId: 1, fileName: 'f.txt', text: '', count: 1, total: 1_234_550, path: '/x/f.txt' })
    renderUi(<BankingScreen tab="bulk" />)
    await waitFor(() => expect(bodyRows('banking-bulk')).toHaveLength(2))
    expect(bodyRows('banking-bulk')[1]!.textContent).toContain('no IFSC')
    fireEvent.click(within(bodyRows('banking-bulk')[0]!).getByTestId('input-bulk-pick'))
    fireEvent.change(screen.getByTestId('input-bulk-corporate'), { target: { value: 'DEMOCORP' } })
    fireEvent.click(screen.getByTestId('btn-bulk-export'))
    await waitFor(() => expect(calls('bulkPay:export')).toHaveLength(1))
    expect(calls('bulkPay:export')[0]).toMatchObject({ bankLedgerId: 5, voucherIds: [1], templateKey: 'builtin:unionbank-neft-rtgs', corporateId: 'DEMOCORP' })
  })
})

describe('Gateway compliance card', () => {
  it('shows post-dated cheques maturing this week and drills to the PDC tab', async () => {
    useSession.setState({ info: { name: 'Bank Co', gstRegistrationType: 'unregistered' } as never })
    renderUi(
      <ComplianceCard
        gst={{ state: 'ready', data: null }}
        tds={null}
        hasPayroll={false}
        dashboardLoaded={false}
        pdc={{ until: '2026-08-15', received: { count: 2, amount: 500_000 }, issued: { count: 1, amount: 200_000 }, overdue: 1, items: [] }}
      />
    )
    const row = await screen.findByTestId('dash-pdc')
    expect(row.textContent).toContain('Received · 2')
    expect(row.textContent).toContain('Issued · 1')
    expect(screen.getByTestId('chip-pdc-overdue').textContent).toBe('1 past due')
    fireEvent.click(row)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'banking', tab: 'pdc' }))
  })
})
