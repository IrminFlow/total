// WP 10.3 — empty states that teach (plan §5): before a simple screen has anything, it shows ONE
// line saying what it is for, ONE primary button that starts the flow that fills it, and "Learn
// how", which opens that screen's help article. Checked on every simple list screen: Sales,
// Purchases, Money, Returns (sale + purchase), Bank, Products, People, Reports and Taxes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { DEFAULT_FEATURES } from '@shared/features'
import { bannedWordsIn } from '@shared/simple/bannedWords'
import { useNav, useSession } from '../state/stores'
import { useHelpPanel } from '../help/store'
import { HELP } from '../help/articles'
import { SalesList } from '../simple/sell/SalesList'
import { PurchaseList } from '../simple/buy/PurchaseList'
import { MoneyList } from '../simple/money/MoneyList'
import { BillPicker } from '../simple/returns/BillPicker'
import { BankScreen } from '../simple/bank/BankScreen'
import { StockList } from '../simple/stock/StockList'
import { PeopleList } from '../simple/people/PeopleList'
import { ReportsScreen } from '../simple/reports/ReportsScreen'
import { TaxesScreen } from '../simple/taxes/TaxesScreen'

const invoke = vi.fn()
const EMPTY: Record<string, unknown> = {
  'simple:sales': [],
  'simple:purchases': [],
  'simple:money:list': [],
  'simple:returns:bills': [],
  'simple:bank:setup': { banks: [], accounts: [], customers: [], suppliers: [] },
  'simple:stock:list': { asOn: '2026-10-14', lowCount: 0, rows: [] },
  'simple:people:list': { people: [], totals: { owesYou: 0, youOwe: 0 } },
  'simple:reports:doing': { empty: true, span: { from: '2026-10-01', to: '2026-10-14' }, asOn: '2026-10-14' },
  'simple:taxes': { kind: 'unregistered', today: '2026-10-14', withholding: [] },
  'config:features:get': DEFAULT_FEATURES,
  'ai:settings:get': { settings: { enabled: false }, ready: false }
}

function wrap(node: ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => ({ ok: true, data: channel in EMPTY ? EMPTY[channel] : [] }))
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'ramesh', user: null, ui: { mode: 'simple' }, info: { name: 'Ramesh', gstRegistrationType: 'unregistered' }, from: '2026-04-01', to: '2027-03-31', workingDate: '2026-10-14' } as never)
    useNav.setState({ stack: [{ name: 'gateway' }] })
    useHelpPanel.setState({ open: false, article: null, follow: false, query: '' })
  })
})
afterEach(() => cleanup())

const CASES: { name: string; node: () => ReactNode; testId: string; action: string; help: string; goes?: unknown }[] = [
  { name: 'Sales list', node: () => <SalesList />, testId: 'simple-sales-empty', action: 'btn-sales-empty-make', help: 'make-a-bill', goes: { name: 'simple-sell' } },
  { name: 'Purchase list', node: () => <PurchaseList />, testId: 'simple-purchases-empty', action: 'btn-purchases-empty-record', help: 'record-a-purchase', goes: { name: 'simple-buy' } },
  { name: 'Money list', node: () => <MoneyList />, testId: 'simple-money-empty', action: 'btn-money-empty-in', help: 'money-in-out', goes: { name: 'simple-money-in' } },
  { name: 'Return a sale', node: () => <BillPicker side="sale" onPick={() => undefined} />, testId: 'return-bills-empty', action: 'btn-return-empty-sell', help: 'returns', goes: { name: 'simple-sell' } },
  { name: 'Return a purchase', node: () => <BillPicker side="purchase" onPick={() => undefined} />, testId: 'return-bills-empty', action: 'btn-return-empty-buy', help: 'returns', goes: { name: 'simple-buy' } },
  { name: 'Bank', node: () => <BankScreen />, testId: 'bank-no-bank', action: 'btn-bank-add-bank', help: 'bank-statement' },
  { name: 'Products', node: () => <StockList />, testId: 'simple-stock-empty', action: 'btn-stock-empty-new', help: 'stock-and-count' },
  { name: 'People', node: () => <PeopleList />, testId: 'simple-people-empty', action: 'btn-people-empty-new', help: 'people-and-reminders' },
  { name: 'Reports', node: () => <ReportsScreen />, testId: 'doing-empty', action: 'btn-doing-empty-sell', help: 'reports', goes: { name: 'simple-sell' } },
  { name: 'Taxes (not registered)', node: () => <TaxesScreen />, testId: 'taxes-unregistered', action: 'btn-taxes-business', help: 'gst', goes: { name: 'company-info' } }
]

describe('empty states that teach (WP 10.3)', () => {
  for (const c of CASES) {
    it(`${c.name}: one purpose line, one primary action, a Learn how link to its article`, async () => {
      wrap(c.node())
      const box = await screen.findByTestId(c.testId)
      expect(box.hasAttribute('data-empty-state')).toBe(true)
      const purpose = within(box).getByTestId('empty-purpose').textContent ?? ''
      expect(purpose.length).toBeGreaterThan(15)
      expect(bannedWordsIn(purpose)).toEqual([])
      // Exactly one primary action, and on the whole screen no other primary button competes.
      const actions = box.querySelectorAll('[data-empty-action]')
      expect(actions).toHaveLength(1)
      expect(actions[0]!.getAttribute('data-testid')).toBe(c.action)
      const primaries = [...document.querySelectorAll('button')].filter((b) => b.className.includes('bg-amberbar/90'))
      const ownPrimary = actions[0]!
      expect(primaries.filter((b) => b !== ownPrimary && !box.contains(b))).toEqual([])
      // Learn how opens the screen's article in the help panel.
      const learn = within(box).getByTestId('empty-learn')
      expect(learn.getAttribute('data-help')).toBe(c.help)
      expect(HELP.article(c.help, 'en')).not.toBeNull()
      fireEvent.click(learn)
      expect(useHelpPanel.getState()).toMatchObject({ open: true, article: c.help })
      if (c.goes) {
        fireEvent.click(actions[0]!)
        await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual(c.goes))
      }
    })
  }
})
