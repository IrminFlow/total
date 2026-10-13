// WP 8.4 — plain pickers and quick-create: Enter in a picker selects, never creates; the plain
// new-account dialog starts from its context and asks "Did you mean …?" before a near-duplicate;
// the new-product dialog hides GST for an unregistered company and offers the cited slabs in a
// regular one; a simple-mode company gets the plain dialogs from the existing quick-create hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CompanyInfo, Group, Ledger } from '@shared/domain'
import { useSession } from '../state/stores'
import { TypeAhead } from '../components/pickers'
import { NewAccountDialog } from '../simple/NewAccountDialog'
import { NewProductDialog } from '../simple/NewProductDialog'
import { CategoryPicker } from '../simple/CategoryPicker'
import { QuickItemModal, QuickLedgerModal } from '../screens/voucher/modals'
import { LedgerFormModal } from '../components/LedgerFormModal'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Current Assets', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sundry Debtors', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 3, name: 'Current Liabilities', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 4, name: 'Sundry Creditors', parentId: 3, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 5, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true },
  { id: 6, name: 'Indirect Expenses', parentId: null, nature: 'expense', affectsGrossProfit: false, isSystem: true },
  { id: 7, name: 'Purchase Accounts', parentId: null, nature: 'expense', affectsGrossProfit: true, isSystem: true },
  { id: 8, name: 'Bank Accounts', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number, extra: Partial<Ledger> = {}): Ledger =>
  ({ id, name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false, itcEligibility: 'eligible', priceLevelId: null, creditLimit: null, deducteeType: null, tdsPayableSectionId: null, tdsDefaultSectionId: null, isSystem: false, ...extra }) as Ledger
const LEDGERS = [ledger(10, 'Sales', 5, { simpleCategory: 'sales' }), ledger(11, 'Rent', 6, { simpleCategory: 'rent' }), ledger(12, 'Sharma Traders', 2)]
const UNITS = [
  { id: 3, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' },
  { id: 4, name: 'Pieces', symbol: 'Pcs', decimals: 0, uqc: 'PCS' },
  { id: 9, name: 'Plates', symbol: 'Plate', decimals: 0, uqc: 'OTH' }
]
const info = (gstRegistrationType: CompanyInfo['gstRegistrationType']): CompanyInfo => ({
  name: 'Sharma Kirana', stateCode: '27', gstin: gstRegistrationType === 'unregistered' ? null : '27AAACT1234A1Z5', gstRegistrationType,
  address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})

function renderUi(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)

beforeEach(() => {
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:units:list': return { ok: true, data: UNITS }
      case 'master:stockItems:list': return { ok: true, data: [{ id: 50, name: 'Basmati Rice 1kg', unitId: 4, gstRate: null }] }
      case 'master:ledgers:create': {
        const p = payload as { name: string; groupId: number }
        return { ok: true, data: ledger(99, p.name, p.groupId) }
      }
      case 'master:stockItems:quickCreate': {
        const p = payload as { item: { name: string } }
        return { ok: true, data: { item: { id: 77, name: p.item.name }, priceLevelId: 1 } }
      }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => useSession.setState({ info: info('regular'), ui: { mode: 'simple' }, workingDate: '2026-10-13' }))
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
  act(() => useSession.setState({ ui: { mode: 'accountant' } }))
})

describe('TypeAhead: Enter selects, never creates', () => {
  const OPTIONS = [{ id: 1, label: 'Sales' }, { id: 2, label: 'Salary & wages' }, { id: 3, label: 'Rent' }]

  for (const mode of ['accountant', 'simple'] as const) {
    it(`${mode}: a typo + Enter creates nothing; ↓ onto "Create …" + Enter opens the create dialog`, () => {
      act(() => useSession.setState({ ui: { mode } }))
      const onPick = vi.fn()
      const onCreate = vi.fn()
      render(<TypeAhead options={OPTIONS} value={null} onPick={onPick} onCreate={onCreate} placeholder="Account" testId="pick" />)
      const input = screen.getByTestId('pick')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'Xyz' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onCreate).not.toHaveBeenCalled()
      expect(onPick).not.toHaveBeenCalledWith(expect.any(Number))
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onCreate).toHaveBeenCalledWith('Xyz')
    })
  }

  it('"Sal" + Enter picks the highlighted match (Sales), not a new "Sal"', () => {
    const onPick = vi.fn()
    const onCreate = vi.fn()
    render(<TypeAhead options={OPTIONS} value={null} onPick={onPick} onCreate={onCreate} placeholder="Account" testId="pick" />)
    const input = screen.getByTestId('pick')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Sal' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith(1)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('↓ past the last match reaches the create row, ↑ leaves it; the simple label is plain', () => {
    const onPick = vi.fn()
    const onCreate = vi.fn()
    render(<TypeAhead options={OPTIONS} value={null} onPick={onPick} onCreate={onCreate} placeholder="Account" testId="pick" />)
    const input = screen.getByTestId('pick')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Sal' } }) // Sales, Salary & wages
    expect(screen.getByTestId('pick-create').textContent).toContain('Create “Sal”…')
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Salary
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // create row
    expect(screen.getByTestId('pick-create').getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith(2)
    expect(onCreate).not.toHaveBeenCalled()
  })
})

describe('NewAccountDialog', () => {
  it('pre-picks from its context', async () => {
    const cases = [
      [{ field: 'party', side: 'sales' }, 'customer'],
      [{ field: 'party', side: 'purchase' }, 'supplier'],
      [{ field: 'line', voucherKind: 'payment', drCr: 'dr' }, 'expense'],
      [{ field: 'line', voucherKind: 'receipt', drCr: 'cr' }, 'customer'],
      [{ field: 'line', voucherKind: 'contra', drCr: 'dr' }, 'bank']
    ] as const
    for (const [context, kind] of cases) {
      renderUi(<NewAccountDialog name="Anita" context={context} onClose={() => {}} onCreated={() => {}} />)
      expect(screen.getByTestId(`account-kind-${kind}`).getAttribute('aria-checked')).toBe('true')
      cleanup()
    }
    renderUi(<NewAccountDialog name="Anita" context={{ field: 'none' }} onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(0)
  })

  it('creates a customer in Sundry Debtors with phone and WhatsApp; no group word anywhere', async () => {
    const onCreated = vi.fn()
    renderUi(<NewAccountDialog name="Anita Stores" context={{ field: 'party', side: 'sales' }} onClose={() => {}} onCreated={onCreated} />)
    await waitFor(() => expect(calls('master:groups:list').length).toBeGreaterThan(0))
    fireEvent.change(screen.getByTestId('input-account-phone'), { target: { value: '98765 43210' } })
    fireEvent.change(screen.getByTestId('input-account-whatsapp'), { target: { value: '+91 98765 43210' } })
    await screen.findByText('Sundry Debtors', {}, { timeout: 100 }).catch(() => null) // the full list is NOT shown
    expect(screen.queryByText('Sundry Debtors')).toBeNull()
    expect(screen.getByTestId('dialog-new-account').textContent).not.toMatch(/\b(ledger|group|sundry)\b/i)
    fireEvent.click(screen.getByTestId('btn-account-create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(calls('master:ledgers:create')[0]).toMatchObject({ name: 'Anita Stores', groupId: 2, phone: '98765 43210', whatsapp: '+91 98765 43210' })
  })

  it('a bad phone number is an error under the phone field', async () => {
    renderUi(<NewAccountDialog name="Anita Stores" context={{ field: 'party', side: 'sales' }} onClose={() => {}} onCreated={() => {}} />)
    fireEvent.change(screen.getByTestId('input-account-phone'), { target: { value: 'call me' } })
    fireEvent.click(screen.getByTestId('btn-account-create'))
    expect((await screen.findByTestId('field-error-phone')).textContent).toMatch(/phone number/)
    expect(calls('master:ledgers:create')).toHaveLength(0)
  })

  it('"Sal" asks "Did you mean Sales?" — use it, or create anyway', async () => {
    const onCreated = vi.fn()
    renderUi(<NewAccountDialog name="Sal" context={{ field: 'account', side: 'sales' }} onClose={() => {}} onCreated={onCreated} />)
    await waitFor(() => expect(calls('master:ledgers:list').length).toBeGreaterThan(0))
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('btn-account-create'))
      expect(screen.getByTestId('account-did-you-mean').textContent).toContain('Did you mean Sales?')
    })
    expect(calls('master:ledgers:create')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('btn-dup-use-10'))
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 10, name: 'Sales' }))
    cleanup()

    const created = vi.fn()
    renderUi(<NewAccountDialog name="Sal" context={{ field: 'account', side: 'sales' }} onClose={() => {}} onCreated={created} />)
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('btn-account-create'))
      screen.getByTestId('btn-dup-create')
    })
    fireEvent.click(screen.getByTestId('btn-dup-create'))
    fireEvent.click(screen.getByTestId('btn-account-create'))
    await waitFor(() => expect(created).toHaveBeenCalled())
    expect(calls('master:ledgers:create')[0]).toMatchObject({ name: 'Sal', groupId: 5 })
  })

  it('the same name (case / punctuation aside) cannot be created again', async () => {
    renderUi(<NewAccountDialog name="sales." context={{ field: 'account', side: 'sales' }} onClose={() => {}} onCreated={() => {}} />)
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('btn-account-create'))
      expect(screen.getByTestId('account-did-you-mean').textContent).toContain('already in your books')
    })
    expect(screen.queryByTestId('btn-dup-create')).toBeNull()
  })

  it('"Other…" shows the full list; an expense "for years" goes to Fixed Assets via its question', async () => {
    renderUi(<NewAccountDialog name="Odd one" context={{ field: 'none' }} onClose={() => {}} onCreated={() => {}} />)
    fireEvent.click(screen.getByTestId('account-kind-other'))
    expect(await screen.findByText('Sundry Creditors')).toBeTruthy()
    fireEvent.click(screen.getByTestId('account-kind-expense'))
    expect(screen.getByTestId('select-expense-kind')).toBeTruthy()
  })
})

describe('NewProductDialog', () => {
  it('unregistered: no GST field; the price goes to quickCreate', async () => {
    act(() => useSession.setState({ info: info('unregistered') }))
    const onCreated = vi.fn()
    renderUi(<NewProductDialog name="Samosa" onClose={() => {}} onCreated={onCreated} />)
    await screen.findByText('Pcs')
    expect(screen.queryByTestId('product-gst')).toBeNull()
    expect(screen.queryByTestId('input-product-hsn')).toBeNull()
    fireEvent.change(screen.getByTestId('input-product-selling'), { target: { value: '15' } })
    fireEvent.blur(screen.getByTestId('input-product-selling'))
    fireEvent.click(screen.getByTestId('btn-product-create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(77))
    expect(calls('master:stockItems:quickCreate')[0]).toMatchObject({ item: { name: 'Samosa', unitId: 4, gstRate: null }, sellingPricePaise: 1500, purchasePricePaise: null })
  })

  it('composition: no GST rate either (HSN stays)', async () => {
    act(() => useSession.setState({ info: info('composition') }))
    renderUi(<NewProductDialog name="Samosa" onClose={() => {}} onCreated={() => {}} />)
    await screen.findByText('Pcs')
    expect(screen.queryByTestId('product-gst')).toBeNull()
    expect(screen.getByTestId('input-product-hsn')).toBeTruthy()
  })

  it('regular: the rate is required, picked from the slabs in force (0 / 5 / 18 now), never pre-picked', async () => {
    const onCreated = vi.fn()
    renderUi(<NewProductDialog name="Notebook" onClose={() => {}} onCreated={onCreated} />)
    await screen.findByText('Pcs')
    expect(screen.getByTestId('gst-rate-0')).toBeTruthy()
    expect(screen.getByTestId('gst-rate-5')).toBeTruthy()
    expect(screen.getByTestId('gst-rate-18')).toBeTruthy()
    expect(screen.queryByTestId('gst-rate-12')).toBeNull()
    expect(screen.getAllByRole('radio').some((r) => r.getAttribute('aria-checked') === 'true')).toBe(false)
    fireEvent.click(screen.getByTestId('btn-product-create'))
    expect((await screen.findByTestId('field-error-gstRate')).textContent).toMatch(/GST rate/)
    fireEvent.click(screen.getByTestId('gst-rate-18'))
    expect(screen.queryByTestId('field-error-gstRate')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-product-create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(77))
    expect(calls('master:stockItems:quickCreate')[0]).toMatchObject({ item: { gstRate: 18 } })
  })

  it('a restaurant starts on its preset unit (Plate); a near-duplicate product asks first', async () => {
    act(() => useSession.setState({ ui: { mode: 'simple', setup: { businessType: 'restaurant', gst: 'unregistered', stock: true } } as never, info: info('unregistered') }))
    renderUi(<NewProductDialog name="Basmati Rice" onClose={() => {}} onCreated={() => {}} />)
    await waitFor(() => expect((screen.getByTestId('select-product-unit') as HTMLSelectElement).value).toBe('9'))
    await waitFor(() => {
      fireEvent.click(screen.getByTestId('btn-product-create'))
      expect(screen.getByTestId('product-did-you-mean').textContent).toContain('Basmati Rice 1kg')
    })
  })
})

describe('simple mode swaps the quick-create hooks', () => {
  it('QuickLedgerModal → plain dialog (party of a purchase = Supplier); accountant mode → old form', async () => {
    renderUi(<QuickLedgerModal name="Gupta" suggestParty={false} suggestAccount={null} onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByTestId('account-kind-supplier').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('btn-account-full-form'))
    expect(await screen.findByText('Create ledger')).toBeTruthy()
  })

  it('QuickItemModal → New product', async () => {
    renderUi(<QuickItemModal name="Pen" onClose={() => {}} onCreated={() => {}} />)
    expect(screen.getByTestId('dialog-new-product')).toBeTruthy()
  })
})

describe('CategoryPicker', () => {
  it('lists the company’s own categories first; a missing one is created with its key on click', async () => {
    const onPick = vi.fn()
    renderUi(<CategoryPicker value={null} onPick={onPick} keys={['electricity', 'rent', 'travel']} context={{ field: 'line', voucherKind: 'payment', drCr: 'dr' }} />)
    await waitFor(() => expect(calls('master:ledgers:list').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByTestId('picker-category'))
    const tiles = (await screen.findByTestId('picker-category-list')).querySelectorAll('[data-testid^="category-"]')
    expect([...tiles].map((t) => t.getAttribute('data-testid'))).toEqual(['category-rent', 'category-electricity', 'category-travel'])
    fireEvent.click(screen.getByTestId('category-rent'))
    expect(onPick).toHaveBeenLastCalledWith(11)
    fireEvent.click(screen.getByTestId('picker-category'))
    fireEvent.click(await screen.findByTestId('category-travel'))
    await waitFor(() => expect(onPick).toHaveBeenLastCalledWith(99))
    expect(calls('master:ledgers:create')[0]).toMatchObject({ name: 'Travel', groupId: 6, simpleCategory: 'travel' })
  })
})

describe('review fixes', () => {
  it('accountant: Enter with no match shows a small "↓ to create" hint; the create row is data-create', () => {
    act(() => useSession.setState({ ui: { mode: 'accountant' } }))
    render(<TypeAhead options={[{ id: 1, label: 'Sales' }]} value={null} onPick={() => {}} onCreate={() => {}} placeholder="Account" testId="pick" />)
    const input = screen.getByTestId('pick')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Xyz' } })
    expect(screen.queryByTestId('pick-nomatch')).toBeNull()
    expect(screen.getByTestId('pick-create').getAttribute('data-create')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('pick-nomatch').textContent).toBe('No match — ↓ to create')
    expect(screen.getByTestId('pick-create').textContent).toBe('Create “Xyz”')
  })

  it('simple: the no-match hint is its own line, not inside the create row', () => {
    render(<TypeAhead options={[{ id: 1, label: 'Sales' }]} value={null} onPick={() => {}} onCreate={() => {}} placeholder="Account" testId="pick" />)
    const input = screen.getByTestId('pick')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Xyz' } })
    expect(screen.getByTestId('pick-create').textContent).toBe('Create “Xyz”…')
    expect(screen.getByTestId('pick-nomatch').textContent).toMatch(/Press ↓/)
  })

  it('"Loan" asks which way: a loan I gave goes under Loans & Advances (Asset)', async () => {
    const groups = [...GROUPS, { id: 20, name: 'Loans (Liability)', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true }, { id: 21, name: 'Loans & Advances (Asset)', parentId: 1, nature: 'asset', affectsGrossProfit: false, isSystem: true }] as Group[]
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'master:groups:list') return { ok: true, data: groups }
      if (channel === 'master:ledgers:list') return { ok: true, data: LEDGERS }
      if (channel === 'master:ledgers:create') return { ok: true, data: ledger(98, (payload as { name: string }).name, (payload as { groupId: number }).groupId) }
      return { ok: true, data: [] }
    })
    const onCreated = vi.fn()
    renderUi(<NewAccountDialog name="Loan to Vijay" context={{ field: 'loan' }} onClose={() => {}} onCreated={onCreated} />)
    await waitFor(() => expect(calls('master:groups:list').length).toBeGreaterThan(0))
    fireEvent.change(screen.getByTestId('select-loan-kind'), { target: { value: 'gave' } })
    fireEvent.click(screen.getByTestId('btn-account-create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(calls('master:ledgers:create')[0]).toMatchObject({ groupId: 21 })
  })

  it('money out: "Pay a supplier" is the first tile and searches customers / suppliers only', async () => {
    renderUi(<CategoryPicker value={null} onPick={() => {}} keys={['rent']} partyTile context={{ field: 'line', voucherKind: 'payment', drCr: 'dr' }} />)
    await waitFor(() => expect(calls('master:ledgers:list').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByTestId('picker-category'))
    const first = (await screen.findByTestId('picker-category-list')).querySelector('button')!
    expect(first.getAttribute('data-testid')).toBe('picker-category-pay-supplier')
    fireEvent.click(first)
    const search = await screen.findByTestId('picker-category-search')
    expect(search.getAttribute('placeholder')).toBe('Search your suppliers')
    fireEvent.focus(search)
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Sharma Traders')])
  })

  it('the full form shows and saves a party’s phone / WhatsApp', async () => {
    act(() => useSession.setState({ ui: { mode: 'accountant' } }))
    const party = ledger(12, 'Sharma Traders', 2, { phone: '98111 22233' })
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'master:groups:list') return { ok: true, data: GROUPS }
      if (channel === 'master:ledgers:list') return { ok: true, data: [party] }
      if (channel === 'master:ledgers:update') return { ok: true, data: { ...party, ...(payload as { data: object }).data } }
      return { ok: true, data: [] }
    })
    renderUi(<LedgerFormModal ledger={party} onClose={() => {}} />)
    const phone = (await screen.findByTestId('ledger-phone')) as HTMLInputElement
    expect(phone.value).toBe('98111 22233')
    fireEvent.change(screen.getByTestId('ledger-whatsapp'), { target: { value: '98111 22234' } })
    fireEvent.click(screen.getByTestId('btn-ledger-save'))
    await waitFor(() => expect(calls('master:ledgers:update')).toHaveLength(1))
    expect(calls('master:ledgers:update')[0]).toMatchObject({ data: { phone: '98111 22233', whatsapp: '98111 22234' } })
  })

  it('the product dialog calls the purchase price a reference figure and explains HSN', async () => {
    renderUi(<NewProductDialog name="Notebook" onClose={() => {}} onCreated={() => {}} />)
    await screen.findByText('Pcs')
    expect(screen.getByText('What it usually costs you')).toBeTruthy()
    expect(screen.getByText('Optional, for your reference.')).toBeTruthy()
    expect(screen.getByText('HSN code (needed for GST returns and e-invoices)')).toBeTruthy()
  })
})
