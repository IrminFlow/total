// WP 2.4 renderer: the Manufacture screen's BOM version picker (by effective date), "Explode
// sub-assemblies" toggle and sub-assembly link, by-product / scrap rows (net production cost and
// the save payload), the receive-from-job-worker mode, the stock journal's send-to-job-worker
// mode and the register's re-priced badge — real components against a mocked IPC bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { StockItem, VoucherType } from '@shared/domain'
import type { BomVersion } from '@shared/bom'
import { ManufactureScreen } from '../screens/Manufacture'
import { TransferEntry } from '../screens/StockJournal'
import { ManufactureRegisterScreen } from '../screens/ManufactureRegister'
import { DialogHost } from '../components/dialogs'
import { emptyJobWorkChallan } from '@shared/voucherEdit'
import { useNav, useSession } from '../state/stores'

vi.setConfig({ testTimeout: 30_000 })
const SLOW = { timeout: 10_000 }
const invoke = vi.fn()

const item = (id: number, name: string): StockItem => ({
  id, name, groupId: null, unitId: 1, hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 0, openingValue: 0,
  barcode: null, reorderLevelMilli: null, valuationMethod: 'weighted_avg', trackSerials: false
})
const CHAIR = 1
const STEEL = 2
const PAINT = 3
const FRAME = 4
const OFFCUT = 5
const ITEMS = [item(CHAIR, 'Chair'), item(STEEL, 'Steel'), item(PAINT, 'Paint'), item(FRAME, 'Frame'), item(OFFCUT, 'Offcut')]
const UNIT_COST: Record<number, number> = { [STEEL]: 15000, [PAINT]: 40000, [FRAME]: 50000 }
const TYPES: VoucherType[] = [
  { id: 9, name: 'Stock Journal', kind: 'stock_journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true, isSystem: true }
]
const GODOWNS = [
  { id: 1, name: 'Main', address: null, kind: 'own', partyLedgerId: null },
  { id: 7, name: 'Ravi (job work)', address: null, kind: 'job_worker', partyLedgerId: 70 }
]
const LEDGERS = [{ id: 70, name: 'Ravi Fabricators', groupId: 1, openingBalance: 0 }]
const version = (id: number, itemId: number, name: string, lines: [number, number][], o: Partial<BomVersion> = {}): BomVersion => ({
  id, itemId, name, effectiveFrom: null, effectiveTo: null, isDefault: true,
  lines: lines.map(([componentId, qtyMilliPerUnit]) => ({ componentId, qtyMilliPerUnit, scrapPctBp: null })), ...o
})
// Chair v1 (default) = 1 Frame + 0.25 Paint; Chair v2 from 2025-07-01 = 1 Frame + 0.5 Paint; Frame = 2 Steel.
const VERSIONS: BomVersion[] = [
  version(10, CHAIR, 'v1', [[FRAME, 1000], [PAINT, 250]]),
  version(11, CHAIR, 'v2', [[FRAME, 1000], [PAINT, 500]], { isDefault: false, effectiveFrom: '2025-07-01' }),
  version(20, FRAME, 'v1', [[STEEL, 2000]])
]
const saves: { channel: string; payload: unknown }[] = []

beforeEach(() => {
  saves.length = 0
  localStorage.clear()
  useNav.setState({ stack: [{ name: 'manufacture' }] })
  useSession.setState({
    slug: 'test',
    workingDate: '2025-06-10',
    from: '2025-04-01',
    to: '2026-03-31',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    switch (channel) {
      case 'master:voucherTypes:list': return { ok: true, data: TYPES }
      case 'master:stockItems:list': return { ok: true, data: ITEMS }
      case 'master:units:list': return { ok: true, data: [{ id: 1, name: 'Numbers', symbol: 'nos', decimals: 0, uqc: 'NOS' }] }
      case 'master:godowns:list': return { ok: true, data: GODOWNS }
      case 'master:ledgers:list': return { ok: true, data: LEDGERS }
      case 'master:groups:list': return { ok: true, data: [] }
      case 'master:batches:list': return { ok: true, data: [] }
      case 'voucher:nextNumber': return { ok: true, data: { number: '12' } }
      case 'voucher:numberExists': return { ok: true, data: false }
      case 'bom:get': return { ok: true, data: [] }
      case 'bom:versions': return { ok: true, data: VERSIONS }
      case 'jobWork:sendChallans': return { ok: true, data: [{ voucherId: 300, number: 'JW-1', date: '2025-05-01' }] }
      case 'stock:byGodown': return { ok: true, data: [{ stockItemId: STEEL, godownId: 1, closingQtyMilli: 9000 }] }
      case 'stock:costAsOf': {
        const q = payload as { lines: { itemId: number; qtyMilli: number }[] }
        const lines = q.lines.map((l) => ({ ...l, costPaise: Math.round((l.qtyMilli * (UNIT_COST[l.itemId] ?? 0)) / 1000) }))
        return { ok: true, data: { positions: [], consumption: { lines, totalPaise: lines.reduce((s, l) => s + l.costPaise, 0) } } }
      }
      case 'manufacture:costPreview': {
        const q = payload as { lines: { itemId: number; qtyMilli: number }[] }
        const lines = q.lines.map((l) => ({
          itemId: l.itemId, qtyMilli: l.qtyMilli, costPaise: Math.round((l.qtyMilli * (UNIT_COST[l.itemId] ?? 0)) / 1000),
          unitCostPaise: UNIT_COST[l.itemId] ?? 0, onHandQtyMilli: 10000
        }))
        return { ok: true, data: { lines, totalPaise: lines.reduce((s, l) => s + l.costPaise, 0), saleRate: { ratePaise: 100000, source: 'sales' } } }
      }
      case 'manufacture:save':
        saves.push({ channel, payload })
        return { ok: true, data: { id: 77, number: '12', warnings: { negativeStock: [] }, manufacture: { saleAmount: 200000, profitPaise: 90000 } } }
      case 'jobWork:saveChallan':
        saves.push({ channel, payload })
        return { ok: true, data: { id: 78, number: '5', warnings: { negativeStock: [] }, challan: {} } }
      case 'manufacture:register':
        return {
          ok: true,
          data: [
            {
              voucherId: 1, date: '2025-06-10', number: '1', finishedItemId: CHAIR, itemName: 'Chair', unitSymbol: 'nos', decimals: 0, qtyMilli: 2000,
              materialPaise: 100000, labourPaise: 30000, byProductPaise: 10000, productionCost: 120000, costAtSave: 100000, saleAmount: 200000,
              profitPaise: 80000, profitAtSave: 100000, repriced: true, jobWork: false
            }
          ]
        }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {ui}
      <DialogHost />
    </QueryClientProvider>
  )
}

async function pick(testId: string, name: string): Promise<void> {
  const input = (await screen.findByTestId(testId)) as HTMLInputElement
  await waitFor(() => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: name } })
    expect(screen.getAllByRole('option').some((o) => o.textContent === name)).toBe(true)
  })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(input.value).toBe(name))
}
const type = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}
const val = (testId: string): string => (screen.getByTestId(testId) as HTMLInputElement).value
const text = (testId: string): string => screen.getByTestId(testId).textContent ?? ''

describe('Manufacture — BOM versions and explosion', () => {
  it('defaults the version by the voucher date; a later date switches to the version in force', async () => {
    wrap(<ManufactureScreen />)
    await pick('picker-manufacture-item', 'Chair')
    type('input-manufacture-qty', '2')
    await waitFor(() => expect(val('input-manufacture-bom-version')).toBe('10'))
    await waitFor(() => expect(val('input-manufacture-raw-qty-1')).toBe('0.5'))
    expect(val('picker-manufacture-raw-0')).toBe('Frame')
    // Move the voucher date into v2's range.
    const date = screen.getByTestId('input-manufacture-date')
    fireEvent.change(date, { target: { value: '15-07-2025' } })
    fireEvent.blur(date)
    await waitFor(() => expect(val('input-manufacture-bom-version')).toBe('11'))
    await waitFor(() => expect(val('input-manufacture-raw-qty-1')).toBe('1'))
    // Picking a version explicitly wins over the date.
    fireEvent.change(screen.getByTestId('input-manufacture-bom-version'), { target: { value: '10' } })
    await waitFor(() => expect(val('input-manufacture-raw-qty-1')).toBe('0.5'))
  })

  it('explode: raw rows become the leaves; sub-assemblies are listed with a "manufacture first" link', async () => {
    wrap(<ManufactureScreen />)
    await pick('picker-manufacture-item', 'Chair')
    type('input-manufacture-qty', '2')
    await waitFor(() => expect(val('picker-manufacture-raw-0')).toBe('Frame'))
    expect(text('manufacture-subassemblies')).toMatch(/Frame — needs 2/)
    fireEvent.click(screen.getByTestId('input-manufacture-explode'))
    await waitFor(() => expect(val('picker-manufacture-raw-0')).toBe('Steel'))
    expect(val('input-manufacture-raw-qty-0')).toBe('4')
    expect(val('picker-manufacture-raw-1')).toBe('Paint')
    // Exploded leaves are not offered as this item's own BOM.
    expect(screen.queryByTestId('btn-manufacture-save-bom')).toBeNull()
    fireEvent.click(screen.getByTestId(`btn-manufacture-subassembly-${FRAME}`))
    // The half-filled form asks before it is left.
    await act(async () => fireEvent.click(await screen.findByTestId('confirm-ok')))
    await waitFor(() => expect(useNav.getState().stack).toHaveLength(2))
    const top = useNav.getState().stack.at(-1)
    expect(top).toEqual({ name: 'manufacture', prefill: { itemId: FRAME, qtyMilli: 2000 } })
  })

  it('saves the version id and the explode flag with the rows', async () => {
    wrap(<ManufactureScreen />)
    await pick('picker-manufacture-item', 'Chair')
    type('input-manufacture-qty', '1')
    fireEvent.click(await screen.findByTestId('input-manufacture-explode'))
    await waitFor(() => expect(val('picker-manufacture-raw-0')).toBe('Steel'))
    await waitFor(() => expect((screen.getByTestId('btn-save-manufacture') as HTMLButtonElement).disabled).toBe(false), SLOW)
    await act(async () => fireEvent.click(screen.getByTestId('btn-save-manufacture')))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect((saves[0]!.payload as { data: unknown }).data).toMatchObject({
      bomVersionId: 10, bomExploded: true, raw: [{ stockItemId: STEEL, qtyMilli: 2000 }, { stockItemId: PAINT, qtyMilli: 250 }]
    })
  })
})

describe('Manufacture — by-products / scrap', () => {
  it('a scrap row comes off the production cost; profit = sale − net cost; payload carries it', async () => {
    wrap(<ManufactureScreen />)
    await pick('picker-manufacture-item', 'Offcut') // no BOM — type the rows
    type('input-manufacture-qty', '2')
    await pick('picker-manufacture-raw-0', 'Steel')
    type('input-manufacture-raw-qty-0', '4') // ₹600
    type('input-manufacture-labour', '300')
    await waitFor(() => expect(text('manufacture-production-cost')).toContain('900.00'))
    fireEvent.click(screen.getByTestId('btn-manufacture-add-byproduct'))
    await pick('picker-manufacture-bp-0', 'Paint')
    type('input-manufacture-bp-qty-0', '0.5')
    fireEvent.change(screen.getByTestId('input-manufacture-bp-kind-0'), { target: { value: 'scrap' } })
    type('input-manufacture-bp-value-0', '100')
    await waitFor(() => expect(text('manufacture-byproduct-total')).toContain('-100.00'))
    expect(text('manufacture-production-cost')).toContain('800.00')
    // Sale ₹1,000 × 2 = 2,000 − 800.
    await waitFor(() => expect(text('manufacture-profit')).toContain('1,200.00'))
    expect(text('manufacture-hint')).toMatch(/materials \+ labour − by-products/)
    await act(async () => fireEvent.click(screen.getByTestId('btn-save-manufacture')))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect((saves[0]!.payload as { data: unknown }).data).toMatchObject({
      byProducts: [{ stockItemId: PAINT, qtyMilli: 500, valuePaise: 10000, kind: 'scrap' }],
      profitPaise: 120000
    })
  })

  it('by-products worth more than the cost block Save with the reason', async () => {
    wrap(<ManufactureScreen />)
    await pick('picker-manufacture-item', 'Offcut')
    type('input-manufacture-qty', '1')
    await pick('picker-manufacture-raw-0', 'Steel')
    type('input-manufacture-raw-qty-0', '1')
    fireEvent.click(screen.getByTestId('btn-manufacture-add-byproduct'))
    await pick('picker-manufacture-bp-0', 'Paint')
    type('input-manufacture-bp-qty-0', '1')
    type('input-manufacture-bp-value-0', '500')
    await waitFor(() => expect(text('manufacture-issue')).toMatch(/worth more than materials \+ labour/))
    expect((screen.getByTestId('btn-save-manufacture') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Manufacture — receive from job worker', () => {
  it('raw rows from the job worker’s godown, a loss column, job charges credited to the job worker', async () => {
    wrap(<ManufactureScreen jobWork />)
    expect((await screen.findByTestId('manufacture-form')).getAttribute('data-mode')).toBe('job-work')
    await pick('picker-manufacture-job-worker', 'Ravi (job work)')
    await waitFor(() => expect(text('manufacture-job-work')).toMatch(/Job charges credited to Ravi Fabricators/))
    await pick('picker-manufacture-item', 'Frame')
    type('input-manufacture-qty', '2')
    await waitFor(() => expect(val('picker-manufacture-raw-0')).toBe('Steel')) // Frame's BOM
    type('input-manufacture-raw-loss-0', '0.2')
    type('input-manufacture-labour', '200')
    type('input-manufacture-jw-challan', 'RF/112')
    type('input-manufacture-jw-nature', 'Welding')
    fireEvent.change(screen.getByTestId('input-manufacture-jw-original'), { target: { value: '300' } })
    expect(screen.queryByTestId('picker-manufacture-labour-credit')).toBeNull()
    await waitFor(() => expect((screen.getByTestId('btn-save-manufacture') as HTMLButtonElement).disabled).toBe(false), SLOW)
    expect(screen.getByTestId('btn-save-manufacture').textContent).toMatch(/Save receipt/)
    await act(async () => fireEvent.click(screen.getByTestId('btn-save-manufacture')))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect((saves[0]!.payload as { data: unknown }).data).toMatchObject({
      raw: [{ stockItemId: STEEL, qtyMilli: 4000, lossQtyMilli: 200 }],
      labourPaise: 20000,
      labourPosted: true,
      labourCreditLedgerId: null,
      jobWork: { godownId: 7, challanNo: 'RF/112', challanDate: '2025-06-10', natureOfProcessing: 'Welding', originalChallanVoucherId: 300 }
    })
  })

  it('the mode switch on a new manufacture toggles the job-work header', async () => {
    wrap(<ManufactureScreen />)
    expect(screen.queryByTestId('manufacture-job-work')).toBeNull()
    fireEvent.click(await screen.findByRole('radio', { name: 'Receive from job worker' }))
    expect(await screen.findByTestId('manufacture-job-work')).toBeTruthy()
  })
})

describe('Stock journal — send to job worker', () => {
  it('rows pick only our godowns; the job worker is fixed on the other side; saves through jobWork:saveChallan', async () => {
    wrap(<TransferEntry typeId={9} jobWork={emptyJobWorkChallan('send')} />)
    expect(await screen.findByTestId('form-job-work-challan')).toBeTruthy()
    expect(screen.queryAllByTestId('picker-transfer-to')).toHaveLength(0)
    await pick('picker-job-worker', 'Ravi (job work)')
    type('input-job-work-nature', 'Powder coating')
    const items = await screen.findAllByTestId('picker-transfer-item')
    fireEvent.focus(items[0]!)
    fireEvent.change(items[0]!, { target: { value: 'Steel' } })
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0))
    fireEvent.keyDown(items[0]!, { key: 'Enter' })
    const from = screen.getAllByTestId('picker-transfer-from')[0]!
    fireEvent.focus(from)
    fireEvent.change(from, { target: { value: '' } })
    // Only own godowns are offered on the "from" side.
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Main'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain('Ravi (job work)')
    fireEvent.keyDown(from, { key: 'Enter' })
    fireEvent.change(screen.getAllByTestId('input-transfer-qty')[0]!, { target: { value: '3' } })
    await waitFor(() => expect(screen.getByTestId('transfer-total').textContent).toContain('450.00'), SLOW)
    fireEvent.click(screen.getByTestId('btn-save-transfer'))
    await waitFor(() => expect(saves).toHaveLength(1), SLOW)
    const p = saves[0]!.payload as { voucher: { inventory: Record<string, unknown>[] }; challan: unknown }
    expect(saves[0]!.channel).toBe('jobWork:saveChallan')
    expect(p.challan).toEqual({
      kind: 'send', godownId: 7, natureOfProcessing: 'Powder coating', goodsType: 'inputs', challanNo: null, challanDate: null, originalChallanVoucherId: null
    })
    expect(p.voucher.inventory).toEqual([
      expect.objectContaining({ stockItemId: STEEL, godownId: 1, direction: 'out', qtyMilli: 3000, amount: 45000 }),
      expect.objectContaining({ stockItemId: STEEL, godownId: 7, direction: 'in', qtyMilli: 3000, amount: 45000 })
    ])
  })
})

describe('Manufacture register — live re-pricing', () => {
  it('shows cost at save next to cost now, flags the re-priced row and explains it', async () => {
    useNav.setState({ stack: [{ name: 'manufacture-register' }] })
    wrap(<ManufactureRegisterScreen />)
    const cell = await screen.findByTestId('register-cost-now')
    expect(cell.getAttribute('data-repriced')).toBe('true')
    expect(cell.textContent).toMatch(/re-priced/)
    expect(cell.textContent).toContain('1,200.00')
    expect(text('register-repriced-note')).toMatch(/1 manufacture was re-priced/)
    expect(screen.getByText('Cost at save')).toBeTruthy()
  })
})
