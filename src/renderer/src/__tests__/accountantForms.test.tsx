// WP 8.4 guard: the accountant view's create dialogs are unchanged. The snapshots were generated
// from the pre-8.4 components (main d32eadb1 + WP 8.3) — never edit them to make a change pass.
// A company in accountant mode (meta `ui` missing) must keep LedgerFormModal's full form and the
// quick "New ledger" / "New stock item" modals exactly as they were.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Group } from '@shared/domain'
import { useSession } from '../state/stores'
import { LedgerFormModal } from '../components/LedgerFormModal'
import { QuickItemModal, QuickLedgerModal } from '../screens/voucher/modals'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Current Liabilities', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 4, name: 'Sundry Creditors', parentId: 3, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 5, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true },
  { id: 6, name: 'Indirect Expenses', parentId: null, nature: 'expense', affectsGrossProfit: false, isSystem: true }
]
const UNITS = [
  { id: 3, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' },
  { id: 4, name: 'Pieces', symbol: 'Pcs', decimals: 0, uqc: 'PCS' }
]
const INFO: CompanyInfo = {
  name: 'Acme Traders', stateCode: '27', gstin: '27AAACT1234A1Z5', gstRegistrationType: 'regular',
  address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
}

function renderUi(ui: React.JSX.Element): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>).baseElement
}

beforeEach(() => {
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: [] }
      case 'master:units:list': return { ok: true, data: UNITS }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => useSession.setState({ info: INFO }))
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('accountant create dialogs (unchanged by WP 8.4)', () => {
  it('LedgerFormModal — new ledger', async () => {
    const el = renderUi(<LedgerFormModal ledger={null} onClose={() => {}} />)
    await screen.findByText('Sundry Creditors')
    expect(el.innerHTML).toMatchSnapshot()
  })

  it('QuickLedgerModal — party from a sales bill', async () => {
    const el = renderUi(<QuickLedgerModal name="Ramesh" suggestParty={true} suggestAccount={null} onClose={() => {}} onCreated={() => {}} />)
    await screen.findByText('Sundry Creditors')
    await screen.findByPlaceholderText('Optional')
    expect(el.innerHTML).toMatchSnapshot()
  })

  it('QuickItemModal — new stock item', async () => {
    const el = renderUi(<QuickItemModal name="Rice 1kg" onClose={() => {}} onCreated={() => {}} />)
    await screen.findByText('Pcs')
    expect(el.innerHTML).toMatchSnapshot()
  })
})
