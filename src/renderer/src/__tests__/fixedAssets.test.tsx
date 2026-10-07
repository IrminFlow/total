// WP 3.6 — the Fixed assets screen against a mocked IPC bridge: the register (links, dispose
// button), create-from-purchase pre-filling the form and the exact fa:save payload, the
// depreciation run (blocked banner, posting), the disposal wizard, the year-end warning, the
// draft → input rules and the registry entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssetGroupRow, DepreciationPreview, FixedAssetRow, PurchaseCandidate } from '@shared/fixedAssets'
import { FixedAssetsScreen } from '../screens/FixedAssets'
import { YearEndScreen } from '../screens/YearEnd'
import { blankDraft, draftFromCandidate, draftToInput } from '../screens/fixedAssets/AssetForm'
import { FA_QUERY_FAMILIES } from '../screens/fixedAssets/common'
import { SCREENS, invalidationFamilies } from '../lib/screens'
import { useSession } from '../state/stores'

const invoke = vi.fn()

const GROUPS: AssetGroupRow[] = [
  {
    id: 7, name: 'Computers', caClassId: 23, caClassName: 'Computers — end user devices', lifeMonths: 36, residualBp: 500, method: 'slm',
    itBlockId: 3, itBlockName: 'Machinery and plant @40%', assetLedgerId: null, assetLedgerName: null, accDepLedgerId: null,
    accDepLedgerName: null, depExpenseLedgerId: null, depExpenseLedgerName: null, postPerAsset: false, assetCount: 1
  }
]

const ASSET: FixedAssetRow = {
  id: 11, name: 'MacBook Pro', assetGroupId: 7, groupName: 'Computers', ledgerId: 40, ledgerName: 'Computers', accDepLedgerId: null,
  purchaseVoucherId: 90, purchaseVoucherBinned: false, purchaseDate: '2025-04-01', putToUseDate: '2025-04-01', costPaise: 6_000_000,
  residualBp: 500, lifeMonths: 36, method: 'slm', basisDate: '2025-04-01', itBlockId: 3, itBlockName: 'Machinery and plant @40%',
  itAdditionalEligible: false, location: null, identifier: 'SN-1', openingAccDepPaise: 0, openingAccDepAsOf: null, notes: null,
  status: 'active', disposalDate: null, disposalVoucherId: null, disposalKind: null, disposalProceedsPaise: null,
  grossPaise: 6_000_000, accumulatedPaise: 1_900_000, carryingPaise: 4_100_000, depreciatedThrough: '2026-03-31',
  hasDepreciation: true, lifeEnd: '2028-03-31', additions: []
}

const CANDIDATE: PurchaseCandidate = {
  voucherId: 91, date: '2025-06-15', number: '7', voucherTypeName: 'Purchase', partyLedgerId: 50, partyName: 'Laptop World',
  lines: [{ ledgerId: 40, ledgerName: 'Computers', amount: 9_000_000, suggestedGroupId: 7 }]
}

let preview: DepreciationPreview
const calls: { channel: string; payload: unknown }[] = []

beforeEach(() => {
  calls.length = 0
  preview = {
    from: '2025-04-01', to: '2026-03-31', fyStartYear: 2025, total: 1_900_000, blocked: null, existingRun: null,
    rows: [{ assetId: 11, assetName: 'MacBook Pro', groupId: 7, groupName: 'Computers', method: 'slm', openingWdv: 0, additions: 6_000_000, depreciation: 1_900_000, closingWdv: 4_100_000, daysUsed: 365, fullyDepreciated: false, ratePpb: null }],
    journal: [
      { ledgerId: null, ledgerName: 'Depreciation', drCr: 'dr', amount: 1_900_000, assetId: null },
      { ledgerId: null, ledgerName: 'Accumulated Depreciation - Computers', drCr: 'cr', amount: 1_900_000, assetId: null }
    ]
  }
  useSession.setState({
    slug: 'test', from: '2025-04-01', to: '2026-03-31', workingDate: '2026-03-31',
    info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null }
  })
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload })
    switch (channel) {
      case 'fa:list': return { ok: true, data: [ASSET] }
      case 'fa:groups': return { ok: true, data: GROUPS }
      case 'fa:blocks': return { ok: true, data: [{ id: 3, code: 'PM40', name: 'Machinery and plant @40%', isSeeded: true, rates: [], openings: [] }] }
      case 'fa:purchaseCandidates': return { ok: true, data: [CANDIDATE] }
      case 'fa:save': return { ok: true, data: { ...ASSET, id: 12, name: 'Laptop for sales' } }
      case 'fa:runPreview': return { ok: true, data: preview }
      case 'fa:runs': return { ok: true, data: [] }
      case 'fa:runPost': return { ok: true, data: { id: 1, voucherNumber: '4', voucherId: 300 } }
      case 'fa:disposalPreview': {
        const p = payload as { proceedsPaise: number }
        return {
          ok: true,
          data: {
            assetId: 11, date: '2026-03-31', gross: 6_000_000, accumulatedBooked: 1_900_000, catchUp: 0, catchUpFrom: null,
            carrying: 4_100_000, proceeds: p.proceedsPaise, profit: p.proceedsPaise - 4_100_000, blocked: p.proceedsPaise > 0 ? null : 'Pick the cash, bank or buyer account the proceeds go to',
            journal: [{ ledgerId: 40, ledgerName: 'Computers', drCr: 'cr', amount: 6_000_000, assetId: null }]
          }
        }
      }
      case 'master:ledgers:list': return { ok: true, data: [{ id: 40, name: 'Computers', groupId: 5 }, { id: 60, name: 'HDFC Bank', groupId: 9 }] }
      case 'master:groups:list': return { ok: true, data: [{ id: 5, name: 'Fixed Assets', parentId: null, nature: 'asset' }, { id: 9, name: 'Bank Accounts', parentId: null, nature: 'asset' }] }
      case 'yearend:preview':
        return { ok: true, data: { rows: [], netProfit: 0, alreadyClosed: false, depreciation: { fyStartYear: 2025, assetsInService: 2, coveredThrough: null, missing: true } } }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderUi(ui: React.ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('registry', () => {
  it('lists Fixed assets under Books, refreshing every fa* query family', () => {
    const def = SCREENS.find((s) => s.name === 'fixed-assets')!
    expect(def).toMatchObject({ navSection: 'books', title: 'Fixed assets' })
    expect([...invalidationFamilies('fixed-assets')].sort()).toEqual([...FA_QUERY_FAMILIES].sort())
  })
})

describe('asset drafts', () => {
  it('validates and converts to the IPC input in paise / basis points / months', () => {
    const d = { ...blankDraft('2025-04-01', GROUPS[0]), name: 'Laptop', ledgerId: 40, costPaise: 6_000_000, residualText: '5', lifeMonthsText: '36' }
    expect(draftToInput(d).input).toMatchObject({ assetGroupId: 7, residualBp: 500, lifeMonths: 36, method: 'slm', itBlockId: 3, costPaise: 6_000_000 })
    expect(draftToInput({ ...d, residualText: 'five' }).error).toMatch(/percentage/)
    expect(draftToInput({ ...d, lifeMonthsText: '2.5' }).error).toMatch(/whole number/)
    expect(draftToInput({ ...d, method: 'wdv', residualText: '0' }).error).toMatch(/WDV/)
    expect(draftToInput({ ...d, putToUseDate: '2025-03-01' }).error).toMatch(/before the purchase/)
    expect(draftToInput({ ...d, openingAccDepPaise: 100, openingAccDepAsOf: '' }).error).toMatch(/runs to/)
  })

  it('a purchase line pre-fills ledger, cost, date, voucher and the suggested group', () => {
    const d = draftFromCandidate(CANDIDATE, CANDIDATE.lines[0]!, GROUPS)
    expect(d).toMatchObject({ ledgerId: 40, costPaise: 9_000_000, purchaseDate: '2025-06-15', putToUseDate: '2025-06-15', purchaseVoucherId: 91, assetGroupId: 7, lifeMonthsText: '36' })
    expect(d.sourceLabel).toBe('Purchase 7 · Laptop World · 15-Jun-25')
  })
})

describe('Fixed assets screen', () => {
  it('register: ledger and purchase links, a dispose action per active asset', async () => {
    renderUi(<FixedAssetsScreen />)
    const row = await screen.findByText('MacBook Pro')
    const tr = row.closest('tr')!
    expect(within(tr).getByTestId('ledger-link').textContent).toBe('Computers')
    expect(within(tr).getByTestId('voucher-link').textContent).toBe('01-Apr-25')
    expect(within(tr).getByTestId('btn-fixed-assets-dispose-11')).toBeTruthy()
    expect(tr.textContent).toContain('41,000.00')
  })

  it('creates an asset from a purchase and saves the exact payload', async () => {
    renderUi(<FixedAssetsScreen />)
    fireEvent.click(await screen.findByTestId('btn-fixed-assets-from-purchase'))
    const candidate = await screen.findByText('Laptop World')
    fireEvent.click(candidate.closest('tr')!)
    await screen.findByTestId('fixed-assets-form')
    expect((screen.getByTestId('input-fixed-assets-cost') as HTMLInputElement).value).toBe('90,000.00')
    fireEvent.change(screen.getByTestId('input-fixed-assets-name'), { target: { value: 'Laptop for sales' } })
    fireEvent.click(screen.getByTestId('btn-fixed-assets-save'))
    await waitFor(() => expect(calls.some((c) => c.channel === 'fa:save')).toBe(true))
    const saved = calls.find((c) => c.channel === 'fa:save')!.payload as { data: Record<string, unknown>; id?: number }
    expect(saved.id).toBeUndefined()
    expect(saved.data).toMatchObject({
      name: 'Laptop for sales', assetGroupId: 7, ledgerId: 40, purchaseVoucherId: 91, purchaseDate: '2025-06-15',
      putToUseDate: '2025-06-15', costPaise: 9_000_000, residualBp: 500, lifeMonths: 36, method: 'slm', itBlockId: 3
    })
  })

  it('depreciation run: preview + journal, posting, and a blocked period', async () => {
    renderUi(<FixedAssetsScreen tab="depreciation" />)
    const journal = await screen.findByTestId('rows-fixed-assets-run-journal')
    await waitFor(() => expect(journal.textContent).toContain('Accumulated Depreciation - Computers'))
    expect(journal.textContent).toContain('created on posting')
    fireEvent.click(screen.getByTestId('btn-fixed-assets-post-run'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fa:runPost')?.payload).toEqual({ from: '2025-04-01', to: '2026-03-31' }))
  })

  it('a blocked period disables posting and says why', async () => {
    preview = { ...preview, blocked: 'Books are locked up to 2026-03-31' }
    renderUi(<FixedAssetsScreen tab="depreciation" />)
    expect((await screen.findByTestId('fixed-assets-run-blocked')).textContent).toContain('locked')
    expect((screen.getByTestId('btn-fixed-assets-post-run') as HTMLButtonElement).disabled).toBe(true)
  })

  it('disposal wizard: figures from the server, Next blocked until the proceeds account is picked', async () => {
    renderUi(<FixedAssetsScreen />)
    fireEvent.click(await screen.findByTestId('btn-fixed-assets-dispose-11'))
    await screen.findByTestId('fixed-assets-disposal')
    fireEvent.change(screen.getByTestId('input-fixed-assets-proceeds'), { target: { value: '45000' } })
    await waitFor(() => expect(screen.getByTestId('fixed-assets-disposal-figures').textContent).toContain('Profit on sale'))
    expect(screen.getByTestId('fixed-assets-disposal-figures').textContent).toContain('4,000.00')
    await waitFor(() => expect((screen.getByTestId('btn-fixed-assets-disposal-next') as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('year-end close', () => {
  it('warns when depreciation for the year has not been run', async () => {
    useSession.setState({ info: { name: 'T', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2020, email: null, phone: null, pan: null, tan: null } })
    renderUi(<YearEndScreen />)
    const banner = await screen.findByTestId('year-end-depreciation-missing')
    expect(banner.textContent).toMatch(/Depreciation for FY .* has not been run/)
    expect(banner.textContent).toContain('2 fixed assets are in service')
  })
})
