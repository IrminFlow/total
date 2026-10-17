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
import { AssetFormModal, blankDraft, draftFromAsset, draftFromCandidate, draftToInput } from '../screens/fixedAssets/AssetForm'
import { FA_QUERY_FAMILIES } from '../screens/fixedAssets/common'
import { gstRateOf, partOf } from '../screens/fixedAssets/DisposalWizard'
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
    rows: [{ assetId: 11, assetName: 'MacBook Pro', groupId: 7, groupName: 'Computers', method: 'slm', openingWdv: 0, additions: 6_000_000, depreciation: 1_900_000, closingWdv: 4_100_000, daysUsed: 365, fullyDepreciated: false, ratePpb: null, extraShiftAllowed: true, extraShift: null }],
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
        const p = payload as { proceedsPaise: number; part?: { quantity: number; of: number } | null; gst?: { ratePercent: number } | null }
        return {
          ok: true,
          data: {
            part: p.part ?? null, remainingCost: p.part ? 4_500_000 : null, gstApplies: true, suggestedGstRate: 18,
            gst: p.gst
              ? {
                  ratePercent: p.gst.ratePercent, supply: 'intra', taxableValue: p.proceedsPaise, itcSource: 'purchase', invoiceTotal: p.proceedsPaise * 1.18,
                  workingText: 's.18(6) CGST Act: ITC ₹10,800.00; higher = ₹10,800.00 (extra output tax ₹2,700.00)',
                  extraOutputTax: { igst: 0, cgst: 135_000, sgst: 135_000, cess: 0 },
                  invoice: [{ ledgerId: 60, ledgerName: 'HDFC Bank', drCr: 'dr', amount: p.proceedsPaise * 1.18, assetId: null }],
                  working: {}
                }
              : null,
            assetId: 11, date: '2026-03-31', gross: 6_000_000, accumulatedBooked: 1_900_000, catchUp: 0, catchUpFrom: null,
            carrying: 4_100_000, proceeds: p.proceedsPaise, profit: p.proceedsPaise - 4_100_000, blocked: p.proceedsPaise > 0 ? null : 'Pick the cash, bank or buyer account the proceeds go to',
            journal: [{ ledgerId: 40, ledgerName: 'Computers', drCr: 'cr', amount: 6_000_000, assetId: null }]
          }
        }
      }
      case 'fa:componentSplit': return { ok: true, data: { asset: { ...ASSET, costPaise: 4_800_000 }, component: { ...ASSET, id: 13, name: 'Battery', costPaise: 1_200_000, lifeMonths: 24 } } }
      case 'fa:itStatement': {
        const q = payload as { fyStartYear: number; concessionalRegime: boolean }
        return {
          ok: true,
          data: {
            fyStartYear: q.fyStartYear, concessionalRegime: q.concessionalRegime, unassignedAssets: [],
            blocks: [{
              blockId: 3, blockCode: 'PM45', blockName: 'Motor buses on hire', rateBp: q.concessionalRegime ? 4000 : 4500,
              cappedFromBp: q.concessionalRegime ? 4500 : null, additionalDisallowed: q.concessionalRegime, additionalRateBp: 0, act: '2025',
              sectionRef: '', rateSource: '', openingSource: 'none', assetCount: 1, openingWdv: 0, additionsFullRate: 10_000_000,
              additionsHalfRate: 0, saleProceeds: 0, wdvBeforeDepreciation: 10_000_000, depreciationFullRate: q.concessionalRegime ? 4_000_000 : 4_500_000,
              depreciationHalfRate: 0, additionalDepreciation: 0, additionalCarriedForward: 0, totalDepreciation: q.concessionalRegime ? 4_000_000 : 4_500_000,
              closingWdv: q.concessionalRegime ? 6_000_000 : 5_500_000, shortTermCapitalGain: 0, shortTermCapitalLoss: 0
            }]
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

  it('extra-shift days go with the preview and the posting', async () => {
    renderUi(<FixedAssetsScreen tab="depreciation" />)
    await screen.findByTestId('fixed-assets-extra-shift')
    fireEvent.change(screen.getByTestId('input-fixed-assets-shift-double'), { target: { value: '100' } })
    fireEvent.change(screen.getByTestId('input-fixed-assets-shift-triple'), { target: { value: '50' } })
    fireEvent.click(screen.getByTestId('btn-fixed-assets-shift-add'))
    const sent = { from: '2025-04-01', to: '2026-03-31', shifts: [{ assetId: 11, doubleShiftDays: 100, tripleShiftDays: 50 }] }
    await waitFor(() => expect(calls.some((c) => c.channel === 'fa:runPreview' && JSON.stringify(c.payload) === JSON.stringify(sent))).toBe(true))
    expect(screen.getByTestId('fixed-assets-shift-11').textContent).toContain('100 double / 50 triple')
    await waitFor(() => expect((screen.getByTestId('btn-fixed-assets-post-run') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('btn-fixed-assets-post-run'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fa:runPost')?.payload).toEqual(sent))
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

describe('partial disposal', () => {
  it('reads the part as two whole numbers, the part less than the whole', () => {
    expect(partOf('3', '10')).toEqual({ quantity: 3, of: 10 })
    expect(partOf(' 1 ', '4')).toEqual({ quantity: 1, of: 4 })
    for (const [q, o] of [['', '10'], ['0', '10'], ['10', '10'], ['11', '10'], ['1.5', '4'], ['1', '1'], ['-1', '4'], ['a', '4']]) {
      expect(partOf(q!, o!), `${q} of ${o}`).toBeNull()
    }
  })

  it('the wizard sends the part with the preview and says what stays on the register', async () => {
    renderUi(<FixedAssetsScreen />)
    fireEvent.click(await screen.findByTestId('btn-fixed-assets-dispose-11'))
    await screen.findByTestId('fixed-assets-disposal')
    fireEvent.click(screen.getByTestId('btn-fixed-assets-disposal-scope-part'))
    expect(screen.getByTestId('fixed-assets-disposal-part-hint').textContent).toMatch(/3 of 10/)
    fireEvent.change(screen.getByTestId('input-fixed-assets-part-qty'), { target: { value: '1' } })
    fireEvent.change(screen.getByTestId('input-fixed-assets-part-of'), { target: { value: '4' } })
    fireEvent.change(screen.getByTestId('input-fixed-assets-proceeds'), { target: { value: '8000' } })
    await waitFor(() => expect(calls.some((c) => c.channel === 'fa:disposalPreview' && (c.payload as { part: unknown }).part != null)).toBe(true))
    const sent = calls.filter((c) => c.channel === 'fa:disposalPreview').at(-1)!.payload as { part: unknown; proceedsPaise: number }
    expect(sent).toMatchObject({ part: { quantity: 1, of: 4 }, proceedsPaise: 800_000 })
    expect((await screen.findByTestId('fixed-assets-disposal-remaining')).textContent).toContain('45,000.00')
  })
})

describe('GST on the sale', () => {
  it('reads the rate as a percentage', () => {
    expect(gstRateOf('18')).toBe(18)
    expect(gstRateOf('0.25')).toBe(0.25)
    expect(gstRateOf('')).toBeNull()
    expect(gstRateOf('101')).toBeNull()
    expect(gstRateOf('1.234')).toBeNull()
  })

  it('charging GST starts from the purchase rate, sends it and shows the s.18(6) working', async () => {
    renderUi(<FixedAssetsScreen />)
    fireEvent.click(await screen.findByTestId('btn-fixed-assets-dispose-11'))
    fireEvent.change(await screen.findByTestId('input-fixed-assets-proceeds'), { target: { value: '45000' } })
    const box = await screen.findByTestId('input-fixed-assets-charge-gst')
    fireEvent.click(box.querySelector('input') ?? box)
    await waitFor(() => expect((screen.getByTestId('input-fixed-assets-gst-rate') as HTMLInputElement).value).toBe('18'))
    await waitFor(() => expect(calls.some((c) => c.channel === 'fa:disposalPreview' && (c.payload as { gst: unknown }).gst != null)).toBe(true))
    expect((calls.filter((c) => c.channel === 'fa:disposalPreview').at(-1)!.payload as { gst: unknown }).gst).toEqual({ ratePercent: 18, scrapProviso: false, itc: null })
    expect((await screen.findByTestId('fixed-assets-disposal-gst-working')).textContent).toContain('s.18(6)')
  })
})

describe('income-tax statement', () => {
  it('the rule 25(2) switch asks for the capped statement and marks the capped rate', async () => {
    renderUi(<FixedAssetsScreen tab="income-tax" />)
    const table = await screen.findByTestId('rows-fixed-assets-it')
    await waitFor(() => expect(table.textContent).toContain('45.00%'))
    expect(calls.find((c) => c.channel === 'fa:itStatement')!.payload).toMatchObject({ concessionalRegime: false })
    fireEvent.click(screen.getByTestId('input-fixed-assets-it-concessional'))
    await waitFor(() => expect(screen.getByTestId('fixed-assets-it-capped-3')).toBeTruthy())
    expect(calls.filter((c) => c.channel === 'fa:itStatement').at(-1)!.payload).toMatchObject({ concessionalRegime: true })
    expect(screen.getByTestId('rows-fixed-assets-it').textContent).toContain('40.00%')
  })
})

describe('component lives', () => {
  it('an asset with no depreciation offers "Split off a component" and sends name, cost and life', async () => {
    const fresh = { ...ASSET, hasDepreciation: false, depreciatedThrough: null, accumulatedPaise: 0 }
    renderUi(<AssetFormModal asset={fresh} initial={draftFromAsset(fresh)} onClose={() => undefined} />)
    fireEvent.click(await screen.findByTestId('btn-fixed-assets-component'))
    fireEvent.change(screen.getByTestId('input-fixed-assets-component-name'), { target: { value: 'Battery' } })
    fireEvent.change(screen.getByTestId('input-fixed-assets-component-cost'), { target: { value: '12000' } })
    fireEvent.change(screen.getByTestId('input-fixed-assets-component-life'), { target: { value: '24' } })
    fireEvent.click(screen.getByTestId('btn-fixed-assets-component-save'))
    await waitFor(() => expect(calls.find((c) => c.channel === 'fa:componentSplit')?.payload).toEqual({ assetId: 11, name: 'Battery', costPaise: 1_200_000, lifeMonths: 24 }))
  })

  it('is not offered once depreciation is booked', async () => {
    renderUi(<AssetFormModal asset={ASSET} initial={draftFromAsset(ASSET)} onClose={() => undefined} />)
    await screen.findByTestId('fixed-assets-form')
    expect(screen.queryByTestId('btn-fixed-assets-component')).toBeNull()
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
