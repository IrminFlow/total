// WP 9.10 review (shots-96): the full editor a simple form handed off to. An account the answers
// use that does not exist yet and that the editor makes on first use (the walk-in customer, GST /
// round-off ledgers) shows by NAME in its pick and is created when the user saves — never on open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Group, Ledger, StockItem, VoucherType } from '@shared/domain'
import type { SimpleHandoff } from '@shared/simple/handoff'
import { emptyInvoiceState } from '@shared/voucherEdit'
import { VoucherEntry } from '../screens/VoucherEntry'
import { DialogHost } from '../components/dialogs'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
const GROUPS: Group[] = [
  { id: 1, name: 'Sundry Debtors', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 2, name: 'Sales Accounts', parentId: null, nature: 'income', affectsGrossProfit: true, isSystem: true },
  { id: 3, name: 'Duties & Taxes', parentId: null, nature: 'liability', affectsGrossProfit: false, isSystem: true },
  { id: 4, name: 'Cash-in-Hand', parentId: null, nature: 'asset', affectsGrossProfit: false, isSystem: true },
  { id: 5, name: 'Indirect Expenses', parentId: null, nature: 'expense', affectsGrossProfit: false, isSystem: true }
]
const ledger = (id: number, name: string, groupId: number, over: Partial<Ledger> = {}): Ledger => ({
  id, name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, rcm: false, itcEligibility: 'eligible',
  priceLevelId: null, creditLimit: null, deducteeType: null, tdsPayableSectionId: null, tdsDefaultSectionId: null, isSystem: false, ...over
})
let ledgers: Ledger[]
const ITEMS: StockItem[] = [
  { id: 100, name: 'Steel bolt', groupId: null, unitId: 1, hsn: '7318', gstRate: 0, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false }
]
const TYPES: VoucherType[] = [
  { id: 1, name: 'Sales', kind: 'sales', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true },
  { id: 2, name: 'Journal', kind: 'journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true }
]
const saved: { data: { partyLedgerId: number | null; lines: { ledgerId: number; drCr: string; amount: number }[] } }[] = []
const created: { name: string; groupId: number; taxType: string | null }[] = []

beforeEach(() => {
  ledgers = [ledger(20, 'Sales', 2), ledger(30, 'Cash', 4)]
  saved.length = 0
  created.length = 0
  useSession.setState({
    slug: 'test', user: null, workingDate: '2026-10-14',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'unregistered', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null } as never
  })
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'master:ledgers:list': return { ok: true, data: ledgers }
      case 'master:ledgers:create': {
        const p = payload as { name: string; groupId: number; taxType: string | null }
        created.push({ name: p.name, groupId: p.groupId, taxType: p.taxType })
        const l = ledger(500 + created.length, p.name, p.groupId, { taxType: p.taxType as never })
        ledgers = [...ledgers, l]
        return { ok: true, data: l }
      }
      case 'master:groups:list': return { ok: true, data: GROUPS }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Box', symbol: 'Box', decimals: 0, uqc: 'BOX' }] }
      case 'master:godowns:list': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '1' } }
      case 'voucher:numberExists': return { ok: true, data: false }
      case 'voucher:duplicates': return { ok: true, data: [] }
      case 'intel:anomaly': return { ok: true, data: { unusual: false, typicalAmount: null } }
      case 'voucher:save': saved.push(payload as never); return { ok: true, data: { id: 99, number: '1', warnings: { negativeStock: [], creditLimitExceeded: null } } }
      case 'report:dashboard': return { ok: true, data: { voucherCount: 3 } }
      case 'log:renderer': return { ok: true, data: null }
      default: return { ok: true, data: null }
    }
  })
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderHandoff(handoff: SimpleHandoff): void {
  useNav.setState({ stack: [{ name: 'gateway' }, { name: 'simple-sell' }, { name: 'voucher-entry', handoff }] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <VoucherEntry handoff={handoff} />
      <DialogHost />
    </QueryClientProvider>
  )
}

const WALK_IN = { name: 'Cash sale', create: { kind: 'walkIn' as const } }

describe('the walk-in customer of a handed-off sale', () => {
  it('shows "Cash sale" in the party pick, creates it on save (not on open) and saves the bill to it', async () => {
    renderHandoff({
      from: 'simple-sell', kind: 'sale', others: [], missing: [], addedOnSave: ['Cash sale'],
      entry: {
        role: 'bill', kind: 'sales', voucherTypeId: 1, form: 'invoice', amount: 30_000, pending: { party: WALK_IN },
        state: { ...emptyInvoiceState('2026-10-14'), partyId: null, accountId: 20, rows: [{ itemId: 100, qtyText: '3', rate: 10_000, discount: null, godownId: null, batchId: null }] }
      }
    })
    const party = (await screen.findByTestId('picker-party', undefined, { timeout: 3000 })) as HTMLInputElement
    const input = party.tagName === 'INPUT' ? party : (party.querySelector('input') as HTMLInputElement)
    expect(input.getAttribute('placeholder')).toBe('Cash sale (added when you save)')
    expect(screen.getByTestId('handoff-added-on-save').textContent).toContain('Cash sale')
    await waitFor(() => expect((screen.getAllByTestId('input-line-qty')[0] as HTMLInputElement).value).toBe('3'))
    expect(created).toEqual([])
    await act(async () => fireEvent.click(screen.getByTestId('btn-save-voucher')))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(created).toEqual([{ name: 'Cash sale', groupId: 1, taxType: null }])
    expect(saved[0]!.data.partyLedgerId).toBe(501)
  })
})
