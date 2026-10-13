// WP 8.0 — renderer side of the correctness fixes: item defaults (unit Pcs, GST rate blank and
// required in a regular company, hidden in a composition / unregistered one), no placeholder that
// reads like real data, the purchase narration hint, and the compliance card's TDS applicability.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useNav, useSession } from '../state/stores'
import { QuickItemModal } from '../screens/voucher/modals'
import { ComplianceCard } from '../screens/gateway/cards'
import { defaultUnitId, newItemGstRateError } from '../lib/itemDefaults'
import type { CompanyInfo } from '@shared/domain'

const invoke = vi.fn()
const UNITS = [
  { id: 1, name: 'Boxes', symbol: 'Box', decimals: 0, uqc: 'BOX' },
  { id: 2, name: 'Kilograms', symbol: 'Kg', decimals: 3, uqc: 'KGS' },
  { id: 3, name: 'Numbers', symbol: 'Nos', decimals: 0, uqc: 'NOS' },
  { id: 4, name: 'Pieces', symbol: 'Pcs', decimals: 0, uqc: 'PCS' }
]
const info = (gstRegistrationType: CompanyInfo['gstRegistrationType']): CompanyInfo => ({
  name: 'Sharma Kirana', stateCode: '27', gstin: gstRegistrationType === 'unregistered' ? null : '27AAACT1234A1Z5', gstRegistrationType,
  address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
})

function renderUi(ui: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    if (channel === 'master:units:list') return { ok: true, data: UNITS }
    if (channel === 'master:stockItems:create') return { ok: true, data: { id: 99, name: (payload as { name: string }).name } }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke }
  act(() => useNav.setState({ stack: [{ name: 'gateway' }] }))
})
afterEach(() => {
  cleanup()
  invoke.mockReset()
})

describe('item defaults', () => {
  it('unit Pcs, else Nos, else the first; GST rate required only in a regular company', () => {
    expect(defaultUnitId(UNITS)).toBe(4)
    expect(defaultUnitId(UNITS.filter((u) => u.symbol !== 'Pcs'))).toBe(3)
    expect(defaultUnitId([UNITS[0]!])).toBe(1)
    expect(defaultUnitId([])).toBeNull()
    expect(newItemGstRateError('regular', '')).toMatch(/Pick the GST rate/)
    expect(newItemGstRateError('regular', '0')).toBeNull()
    expect(newItemGstRateError('regular', 'abc')).toMatch(/between 0 and 100/)
    expect(newItemGstRateError('unregistered', '')).toBeNull()
    expect(newItemGstRateError('composition', '')).toBeNull()
  })

  it('quick item, regular company: Pcs preselected, GST blank, saving without a rate is refused', async () => {
    act(() => useSession.setState({ slug: 'k', info: info('regular') }))
    const onCreated = vi.fn()
    renderUi(<QuickItemModal name="Sugar 1kg" onClose={() => {}} onCreated={onCreated} />)
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('4'))
    const gst = screen.getByTestId('input-quick-item-gst') as HTMLInputElement
    expect(gst.value).toBe('')
    expect((screen.getByTestId('input-quick-item-hsn') as HTMLInputElement).placeholder).toBe('Optional')
    fireEvent.click(screen.getByText('Create item'))
    await waitFor(() => expect(screen.getByText(/Pick the GST rate for this item/)).toBeTruthy())
    expect(invoke.mock.calls.some((c) => c[0] === 'master:stockItems:create')).toBe(false)
    fireEvent.change(gst, { target: { value: '5' } })
    fireEvent.click(screen.getByText('Create item'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(99))
    expect(invoke.mock.calls.find((c) => c[0] === 'master:stockItems:create')![1]).toMatchObject({ name: 'Sugar 1kg', unitId: 4, gstRate: 5 })
  })

  it('quick item, unregistered company: no GST field, saved with no rate', async () => {
    act(() => useSession.setState({ slug: 'k', info: info('unregistered') }))
    const onCreated = vi.fn()
    renderUi(<QuickItemModal name="Sugar 1kg" onClose={() => {}} onCreated={onCreated} />)
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('4'))
    expect(screen.queryByTestId('input-quick-item-gst')).toBeNull()
    expect(screen.queryByText('GST %')).toBeNull()
    fireEvent.click(screen.getByText('Create item'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(99))
    expect(invoke.mock.calls.find((c) => c[0] === 'master:stockItems:create')![1]).toMatchObject({ unitId: 4, gstRate: null })
  })
})

describe('placeholders that look like real data are gone', () => {
  const root = join(__dirname, '..')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (f === '__tests__') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(f)) files.push(p)
    }
  }
  walk(root)
  it('no sample GSTIN, vehicle number, HSN or PF number as a placeholder', () => {
    const bad = /placeholder="(27AAPFU0939F1ZV|MH01AB1234|8471|MHBAN\d+)"/
    const hits = files.filter((f) => bad.test(readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
    expect(files.length).toBeGreaterThan(50)
  })
  it('the narration hint is per kind — a purchase never says "goods sold"', () => {
    const src = readFileSync(join(root, 'screens/voucher/InvoiceEntry.tsx'), 'utf8')
    expect(src).not.toContain('placeholder="Being goods sold…"')
    expect(src).toMatch(/purchase: 'Being goods purchased…'/)
  })
})

describe('compliance card applicability', () => {
  it('no TDS row and no TDS deposit date when the dashboard sends no TDS section', () => {
    act(() => useSession.setState({ slug: 'k2', info: info('unregistered') }))
    renderUi(<ComplianceCard gst={{ state: 'ready', data: null }} tds={{ state: 'ready', data: null }} hasPayroll={false} dashboardLoaded={false} />)
    const card = screen.getByTestId('dash-compliance')
    expect(screen.queryByTestId('dash-tds')).toBeNull()
    expect(screen.queryByTestId('dash-gst')).toBeNull()
    expect(card.textContent).not.toMatch(/TDS/)
  })
})
