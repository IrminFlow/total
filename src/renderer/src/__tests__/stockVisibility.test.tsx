// WP 2.3 renderer: the movement register screen, the stock-journal transfer form (priced by
// stock:costAsOf, posting paired out/in lines) and the per-line stock detail expander. Real
// components against a mocked IPC bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { StockItem } from '@shared/domain'
import type { StockMovementRegister } from '@shared/stockPlanning'
import { StockMovementsScreen } from '../screens/StockMovements'
import { TransferEntry } from '../screens/StockJournal'
import { LineDetailToggle, LineStockDetail, useLineDetails } from '../screens/voucher/LineStockDetail'
import { screenOptionsKey } from '../components/ScreenOptions'
import { useNav, useSession } from '../state/stores'

vi.setConfig({ testTimeout: 30_000 })
const SLOW = { timeout: 10_000 }
const invoke = vi.fn()
const go = vi.fn()
const replace = vi.fn()

const item = (id: number, name: string, over: Partial<StockItem> = {}): StockItem => ({
  id, name, groupId: null, unitId: 1, hsn: null, gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0, barcode: null,
  reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false, ...over
})
const ITEMS = [item(100, 'Bolt'), item(200, 'Phone', { trackSerials: true })]
const GODOWNS = [{ id: 1, name: 'Main', address: null }, { id: 2, name: 'Annex', address: null }]

const REGISTER: StockMovementRegister = {
  item: { id: 100, name: 'Bolt', unitSymbol: 'nos', decimals: 0, valuationMethod: 'fifo' },
  from: '2026-04-01',
  to: '2027-03-31',
  godownId: null,
  opening: { qtyMilli: 5000, value: 50_000 },
  rows: [
    {
      lineId: 1, voucherId: 11, date: '2026-04-05', number: 'P-1', voucherType: 'Purchase', kind: 'purchase', particulars: 'Supplier',
      partyLedgerId: 7, narration: null, godownId: 1, godownName: 'Main', batchId: null, batchName: null, expiryDate: null,
      isAbsolute: false, inwardQtyMilli: 10_000, outwardQtyMilli: 0, ratePaise: 12_000, value: 120_000,
      runningQtyMilli: 15_000, runningValue: 170_000, serials: []
    },
    {
      lineId: 2, voucherId: 12, date: '2026-04-09', number: 'C-1', voucherType: 'Physical Stock', kind: 'physical_stock', particulars: 'Count',
      partyLedgerId: null, narration: 'Count', godownId: null, godownName: null, batchId: null, batchName: null, expiryDate: null,
      isAbsolute: true, inwardQtyMilli: 0, outwardQtyMilli: 0, ratePaise: 0, value: 0,
      runningQtyMilli: 15_000, runningValue: 170_000, serials: []
    }
  ],
  totals: { inwardQtyMilli: 10_000, inwardValue: 120_000, outwardQtyMilli: 0, outwardValue: 0 },
  closing: { qtyMilli: 15_000, value: 170_000 }
}

function wrap(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

let saved: unknown = null
beforeEach(() => {
  localStorage.clear()
  saved = null
  invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
    switch (channel) {
      case 'stock:movements': return { ok: true, data: { ...REGISTER, godownId: payload.godownId ?? null } }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:godowns:list': return { ok: true, data: GODOWNS }
      case 'master:batches:list': return { ok: true, data: [] }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'nos', decimals: 0, uqc: 'NOS' }] }
      case 'config:features:get': return { ok: false, error: 'defaults' }
      case 'voucher:nextNumber': return { ok: true, data: { number: 'SJ-7' } }
      case 'stock:byGodown': return { ok: true, data: [{ godownId: 1, godownName: 'Main', stockItemId: 100, name: 'Bolt', unitSymbol: 'nos', decimals: 0, closingQtyMilli: 9000, closingValue: 90_000 }] }
      case 'stock:costAsOf': {
        const lines = (payload.lines as { itemId: number; qtyMilli: number }[]) ?? []
        return { ok: true, data: { positions: [], consumption: { lines: lines.map((l) => ({ ...l, costPaise: l.qtyMilli * 11 })), totalPaise: 0 } } }
      }
      case 'serials:available': return { ok: true, data: ['SN-1', 'SN-2'] }
      case 'voucher:numberExists': return { ok: true, data: false }
      case 'voucher:save': saved = payload; return { ok: true, data: { id: 99, number: 'SJ-7', warnings: { negativeStock: [], creditLimitExceeded: null } } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'acme', from: '2026-04-01', to: '2027-03-31', workingDate: '2026-04-10', user: null })
    useNav.setState({ go, replace, stack: [{ name: 'stock-movements' }] })
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const rowsOf = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

describe('Stock movements screen', () => {
  it('asks for an item first, then shows the pass figures: opening/inward/outward/closing and running columns', async () => {
    wrap(<StockMovementsScreen />)
    expect(screen.getByText('Pick a stock item')).toBeTruthy()
    cleanup()

    wrap(<StockMovementsScreen itemId={100} />)
    await waitFor(() => expect(rowsOf('stock-movements')).toHaveLength(2), SLOW)
    expect(invoke).toHaveBeenCalledWith('stock:movements', { itemId: 100, from: '2026-04-01', to: '2027-03-31', godownId: undefined })
    expect(screen.getByTestId('movements-opening').textContent).toContain('5 nos')
    expect(screen.getByTestId('movements-closing').textContent).toContain('15 nos')
    expect(screen.getByTestId('movements-closing').textContent).toContain('FIFO')
    const purchase = rowsOf('stock-movements')[0]!
    expect(purchase.textContent).toContain('P-1')
    expect(purchase.textContent).toContain('1,700.00') // running value
    expect(within(purchase).getByTestId('voucher-link')).toBeTruthy()
  })

  it('"show zero-value lines" off hides lines that moved no value; a godown param shows a removable chip', async () => {
    localStorage.setItem(screenOptionsKey('acme', 'stock-movements'), JSON.stringify({ showZeroValue: false }))
    wrap(<StockMovementsScreen itemId={100} godownId={2} />)
    await waitFor(() => expect(rowsOf('stock-movements')).toHaveLength(1), SLOW)
    expect(invoke).toHaveBeenCalledWith('stock:movements', expect.objectContaining({ godownId: 2 }))
    const chip = await screen.findByTestId('chip-movements-godown')
    expect(chip.textContent).toContain('Annex')
    fireEvent.click(within(chip).getByRole('button', { name: 'Show all godowns' }))
    expect(replace).toHaveBeenCalledWith({ name: 'stock-movements', itemId: 100, godownId: undefined })
  })
})

/** Type into a TypeAhead and pick the first match with Enter. */
async function pick(input: HTMLElement, text: string): Promise<void> {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0))
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('Stock journal — transfer form', () => {
  it('prices each row via stock:costAsOf and saves a value-conserving out/in pair', async () => {
    wrap(<TransferEntry typeId={5} />)
    await waitFor(() => expect(screen.getByTestId('rows-stock-transfer')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByTestId('picker-transfer-item')).toHaveLength(1))
    await pick(screen.getAllByTestId('picker-transfer-item')[0]!, 'Bolt')
    await pick(screen.getAllByTestId('picker-transfer-from')[0]!, 'Main')
    await pick(screen.getAllByTestId('picker-transfer-to')[0]!, 'Annex')
    fireEvent.change(screen.getAllByTestId('input-transfer-qty')[0]!, { target: { value: '3' } })
    // 3000 × 11 paise from the mocked engine.
    await waitFor(() => expect(screen.getByTestId('transfer-total').textContent).toContain('330.00'), SLOW)
    expect(screen.getAllByText(/9 nos there/).length).toBeGreaterThan(0)
    // A second row starts with the same godowns.
    expect((screen.getAllByTestId('picker-transfer-from')[1] as HTMLInputElement).value).toBe('Main')

    fireEvent.click(screen.getByTestId('btn-save-transfer'))
    await waitFor(() => expect(saved).not.toBeNull(), SLOW)
    const { data } = saved as { data: { voucherTypeId: number; inventory: Record<string, unknown>[]; lines: unknown[] } }
    expect(data.voucherTypeId).toBe(5)
    expect(data.lines).toEqual([])
    expect(data.inventory).toEqual([
      expect.objectContaining({ stockItemId: 100, godownId: 1, direction: 'out', qtyMilli: 3000, amount: 33_000 }),
      expect.objectContaining({ stockItemId: 100, godownId: 2, direction: 'in', qtyMilli: 3000, amount: 33_000 })
    ])
  })

  it('refuses a row without both godowns', async () => {
    wrap(<TransferEntry typeId={5} />)
    await waitFor(() => expect(screen.getAllByTestId('picker-transfer-item')).toHaveLength(1))
    await pick(screen.getAllByTestId('picker-transfer-item')[0]!, 'Bolt')
    fireEvent.change(screen.getAllByTestId('input-transfer-qty')[0]!, { target: { value: '1' } })
    await waitFor(() => expect(screen.getByTestId('transfer-total').textContent).toContain('110.00'), SLOW)
    fireEvent.click(screen.getByTestId('btn-save-transfer'))
    await new Promise((r) => setTimeout(r, 50))
    expect(saved).toBeNull()
  })
})

function ExpanderHarness({ items }: { items: StockItem[] }): React.JSX.Element {
  const details = useLineDetails()
  return (
    <table>
      <tbody>
        {items.map((it, i) => {
          const open = details.isOpen(i, it)
          return (
            <tr key={i} data-testid={`line-${it.name}`} onKeyDown={details.onRowKeyDown(i)}>
              <td>
                <input aria-label={`qty ${it.name}`} />
                <LineDetailToggle open={open} onToggle={() => details.toggle(i)} fields={{ godownId: null, batchId: null }} />
                {open && <LineStockDetail item={it} direction="out" qtyMilli={2000} fields={{ godownId: null, batchId: null, serials: ['SN-1'] }} onChange={() => {}} />}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

describe('line stock-detail expander', () => {
  it('stays closed for a plain item (▸, ⌥D toggles), opens on its own for a serial-tracked one', async () => {
    wrap(<ExpanderHarness items={ITEMS} />)
    const bolt = screen.getByTestId('line-Bolt')
    const phone = screen.getByTestId('line-Phone')
    expect(within(bolt).queryByTestId('line-stock-detail')).toBeNull()
    expect(within(phone).getByTestId('line-stock-detail')).toBeTruthy()
    // The toggle is not a tab stop — keyboard entry never lands on it.
    expect(within(bolt).getByTestId('btn-line-detail').getAttribute('tabindex')).toBe('-1')

    fireEvent.keyDown(within(bolt).getByLabelText('qty Bolt'), { key: '∂', code: 'KeyD', altKey: true })
    expect(within(bolt).getByTestId('line-stock-detail')).toBeTruthy()
    expect(within(bolt).queryByTestId('line-serials')).toBeNull() // untracked: godown + batch only
    fireEvent.click(within(bolt).getByTestId('btn-line-detail'))
    expect(within(bolt).queryByTestId('line-stock-detail')).toBeNull()

    // Serial-tracked outward line: chips + "n of N" + the serials in stock to pick from.
    expect(within(phone).getByTestId('badge-serial-count').textContent).toContain('1 of 2')
    await waitFor(() => expect(within(phone).getByTestId('serial-pick-SN-2')).toBeTruthy())
    expect(within(phone).queryByTestId('serial-pick-SN-1')).toBeNull() // already on the line
  })

  it('"always show" (remembered per company) opens every line', () => {
    localStorage.setItem(screenOptionsKey('acme', 'voucher-lines'), JSON.stringify({ showStockDetail: true }))
    wrap(<ExpanderHarness items={ITEMS} />)
    expect(within(screen.getByTestId('line-Bolt')).getByTestId('line-stock-detail')).toBeTruthy()
    cleanup()
    act(() => useSession.setState({ slug: 'other-co' }))
    wrap(<ExpanderHarness items={ITEMS} />)
    expect(within(screen.getByTestId('line-Bolt')).queryByTestId('line-stock-detail')).toBeNull()
  })
})
