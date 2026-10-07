// WP 4.2: the Credit control screen (exposure table, hold with a reason, promised this week),
// the reminders and interest tabs, Outstandings' bill follow-ups (inline add) and statement
// preview, and the invoice form's credit-hold block with the owner override.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_FEATURES } from '@shared/features'
import { DEFAULT_RECEIVABLES_CONFIG } from '@shared/receivables/config'
import { RECEIVABLES_SOURCES } from '@shared/receivables/sources'
import type { CreditControlRow, InterestRow, ReminderCandidate } from '@shared/receivables/types'
import type { OutstandingParty } from '@shared/reports'
import { ReceivablesScreen } from '../screens/Receivables'
import { OutstandingsScreen } from '../screens/Outstandings'
import { DialogHost } from '../components/dialogs'
import { useSession } from '../state/stores'

const invoke = vi.fn()

const CC: CreditControlRow[] = [
  {
    ledgerId: 10, name: 'Mehta Traders', outstanding: 590_000, overdue: 590_000, openOrders: 0, exposure: 590_000, creditLimit: 500_000,
    utilisation: 1.18, dso: 45, maxOverdueDays: 64, hold: false, holdReason: null, holdAt: null, promisedDate: '2026-05-08', promisedAmount: 200_000, lastReminder: null
  },
  {
    ledgerId: 11, name: 'Shah & Sons', outstanding: 100_000, overdue: 0, openOrders: 0, exposure: 100_000, creditLimit: null,
    utilisation: null, dso: 12, maxOverdueDays: 0, hold: true, holdReason: 'Cheque bounced', holdAt: '2026-05-01T10:00:00Z', promisedDate: null, promisedAmount: null, lastReminder: '2026-05-02'
  }
]

const CAND: ReminderCandidate[] = [
  { ledgerId: 10, name: 'Mehta Traders', email: 'a@m.in', bucket: 'final', overdue: 590_000, total: 590_000, billCount: 1, oldestBill: 'INV-1', oldestBillDate: '2026-03-01', maxOverdueDays: 64, lastSent: null, lastBucket: null, allowed: true, nextAllowed: null },
  { ledgerId: 11, name: 'Shah & Sons', email: null, bucket: 'gentle', overdue: 10_000, total: 100_000, billCount: 1, oldestBill: 'INV-9', oldestBillDate: '2026-04-20', maxOverdueDays: 3, lastSent: '2026-05-02', lastBucket: 'gentle', allowed: false, nextAllowed: '2026-05-09' }
]

const INTEREST: InterestRow[] = [
  {
    key: '5|INV-1', billVoucherId: 5, billRef: 'INV-1', ledgerId: 10, partyName: 'Mehta Traders', billDate: '2026-03-01', dueDate: '2026-03-31', graceDays: 5,
    rateBp: 1800, pendingPaise: 590_000, chargedTo: null, from: '2026-04-06', to: '2026-05-05', days: 30, interestPaise: 8729,
    gst: [{ rate: 18, interestPaise: 8729, cgst: 786, sgst: 786, igst: 0 }], gstPaise: 1572, totalPaise: 10301, supply: 'intra'
  }
]

const PARTY: OutstandingParty = {
  ledgerId: 10, name: 'Mehta Traders', pending: 590_000, buckets: [0, 0, 590_000, 0],
  bills: [{ voucherId: 5, number: 'INV-1', date: '2026-03-01', amount: 590_000, pending: 590_000, ageDays: 65, dueDate: '2026-03-31', overdueDays: 35 }]
}

let followups: unknown[] = []

beforeEach(() => {
  followups = []
  useSession.setState({
    slug: 'test', from: '2026-04-01', to: '2026-05-05', user: null,
    info: { name: 'Acme', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'config:features:get': return { ok: true, data: { ...DEFAULT_FEATURES } }
      case 'receivables:config': return { ok: true, data: { config: DEFAULT_RECEIVABLES_CONFIG, sources: RECEIVABLES_SOURCES } }
      case 'receivables:creditControl': return { ok: true, data: CC }
      case 'receivables:promisedThisWeek':
        return { ok: true, data: { weekFrom: '2026-05-04', weekTo: '2026-05-10', count: 1, amount: 200_000, overdueCount: 0, rows: [{ id: 1, ledgerId: 10, partyName: 'Mehta Traders', billVoucherId: 5, billRef: 'INV-1', date: '2026-05-01', note: 'Will pay Friday', promisedDate: '2026-05-08', promisedAmount: 200_000, userName: 'Priya', createdAt: '', stillPending: 590_000 }] } }
      case 'receivables:setHold': return { ok: true, data: { hold: true, reason: (payload as { reason: string }).reason, at: 'x' } }
      case 'receivables:reminderCandidates': return { ok: true, data: CAND }
      case 'receivables:reminderLog': return { ok: true, data: [] }
      case 'receivables:interestPreview': return { ok: true, data: INTEREST }
      case 'receivables:interestCharges': return { ok: true, data: [] }
      case 'receivables:postInterest': return { ok: true, data: { voucherId: 77, number: 'DN-3', interestPaise: 8729, gstPaise: 1572, charges: 1 } }
      case 'analysis:outstandings': return { ok: true, data: [PARTY] }
      case 'receivables:followups': return { ok: true, data: followups }
      case 'receivables:addFollowup': {
        const f = payload as Record<string, unknown>
        followups = [{ id: 9, partyName: 'Mehta Traders', userName: 'Priya', createdAt: '', ...f }]
        return { ok: true, data: followups[0] }
      }
      case 'receivables:statement': return { ok: true, data: { html: '<html><body>STATEMENT OF ACCOUNT</body></html>', data: { party: { id: 10, name: 'Mehta Traders', email: null }, opening: 0, closing: 590_000, openBills: PARTY.bills } } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(ui: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {ui}
      <DialogHost />
    </QueryClientProvider>
  )
}

describe('Credit control', () => {
  it('lists parties by exposure with limit use, hold and promises, and holds a party with a reason', async () => {
    wrap(<ReceivablesScreen tab="control" />)
    const rows = await screen.findByTestId('rows-credit-control')
    await waitFor(() => expect(within(rows).getAllByRole('row')).toHaveLength(2))
    expect(rows.textContent).toContain('118 %')
    expect(within(rows).getByTestId('badge-credit-hold').textContent).toBe('On hold')
    expect(screen.getByTestId('cc-holds').textContent).toContain('1')
    expect((await screen.findByTestId('rows-promised-week')).textContent).toContain('Will pay Friday')
    fireEvent.click(within(rows).getAllByTestId('btn-credit-hold')[0]!)
    fireEvent.change(await screen.findByTestId('prompt-input'), { target: { value: '90+ days overdue' } })
    fireEvent.click(screen.getByTestId('prompt-ok'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('receivables:setHold', { ledgerId: 10, hold: true, reason: '90+ days overdue' }))
  })

  it('shows the letter per party and when the cadence allows the next one', async () => {
    wrap(<ReceivablesScreen tab="reminders" />)
    const rows = await screen.findByTestId('rows-reminder-candidates')
    await waitFor(() => expect(within(rows).getAllByRole('row')).toHaveLength(2))
    expect(within(rows).getByTestId('badge-bucket-final')).toBeTruthy()
    expect(rows.textContent).toContain('09-May-26')
  })

  it('previews interest with the GST split and posts a party’s debit note', async () => {
    wrap(<ReceivablesScreen tab="interest" />)
    const rows = await screen.findByTestId('rows-interest-preview')
    await waitFor(() => expect(rows.textContent).toContain('INV-1'))
    expect(rows.textContent).toContain('87.29')
    expect(rows.textContent).toContain('18%')
    fireEvent.click(within(rows).getByTestId('btn-interest-post'))
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('receivables:postInterest', { asOn: '2026-05-05', ledgerId: 10, keys: ['5|INV-1'], gstOnInterest: true })
    )
  })
})

describe('Outstandings follow-ups and statements', () => {
  it('adds a follow-up with a promised date inline on a bill', async () => {
    wrap(<OutstandingsScreen />)
    const rows = await screen.findByTestId('rows-outstandings')
    await waitFor(() => expect(within(rows).getAllByRole('row').length).toBeGreaterThan(0))
    fireEvent.click(within(rows).getByText('Mehta Traders').closest('tr')!.querySelector('td:last-child')!.previousSibling as HTMLElement)
    const bills = await screen.findByTestId('outstandings-bills-10')
    fireEvent.click(within(bills).getByTestId('btn-followup-add'))
    fireEvent.change(await screen.findByTestId('input-followup-note'), { target: { value: 'Cheque ready Friday' } })
    const promised = screen.getByTestId('input-followup-promised')
    fireEvent.change(promised, { target: { value: '08-05-2026' } })
    fireEvent.blur(promised)
    fireEvent.click(screen.getByTestId('btn-followup-save'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('receivables:addFollowup', expect.objectContaining({ ledgerId: 10, billVoucherId: 5, billRef: 'INV-1', note: 'Cheque ready Friday', promisedDate: '2026-05-08' }))
    )
    await waitFor(() => expect(within(screen.getByTestId('outstandings-bills-10')).getByTestId('bill-followup').textContent).toContain('Promised 08-May-26'))
  })

  it('opens the statement preview from the row', async () => {
    wrap(<OutstandingsScreen />)
    const rows = await screen.findByTestId('rows-outstandings')
    await waitFor(() => expect(within(rows).getByTestId('btn-outstandings-soa')).toBeTruthy())
    fireEvent.click(within(rows).getByTestId('btn-outstandings-soa'))
    await screen.findByTestId('statement-modal')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('receivables:statement', { ledgerId: 10, from: '2026-04-01', to: '2026-05-05' }))
    await waitFor(() => expect(screen.getByTestId('statement-closing').textContent).toContain('5,900.00'))
  })
})
