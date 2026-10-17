// TCS after WP 3.3 on screen: TCS → Sections lists the statutory s.206C(1C) sections and adds the
// missing ones (owner), with the sources / not-modelled / unverified points; Returns shows the
// 27EQ note of a s.206C(1G) slab split; the banner reads the slab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Form26qData } from '@shared/tdsTypes'
import { TCS_UNVERIFIED } from '@shared/tcsSources'
import { useNav, useSession } from '../state/stores'
import { TcsScreen } from '../screens/Tcs'
import { DialogHost } from '../components/dialogs'
import { TdsBanner } from '../screens/voucher/TdsBanner'
import type { TcsStatutoryStatus, TcsSuggestion } from '../lib/client'

const invoke = vi.fn()
let handlers: Record<string, (payload: unknown) => unknown> = {}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])
const bodyRows = (area: string): HTMLElement[] => Array.from(screen.getByTestId(`rows-${area}`).querySelectorAll<HTMLElement>('tr.dt-row'))

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TcsScreen />
      <DialogHost />
    </QueryClientProvider>
  )
}

let statutory: TcsStatutoryStatus[]
const row = (serial: number, amountPaise: number, tdsPaise: number, rateBp: number, note: string) => ({
  serial, entryId: 91, voucherId: 20, partyLedgerId: 15, partyName: 'Mehta Family', pan: 'ABCPM1234K', deducteeCode: '02', sectionCode: '206C(1G) TOUR',
  returnCode: 'O', paymentDate: '2025-08-20', amountPaise, tdsPaise, deductionDate: '2025-08-20', rateBp, reasonCode: '',
  challanSerial: null, bsrCode: null, challanDate: null, challanNo: null, note
})
const F27EQ: Form26qData = {
  fyStartYear: 2025, quarter: 2, layout: 'form27eq',
  deductees: [
    row(1, 37000000, 1850000, 500, '1G slab: one collection split at ₹10,00,000.00 (UNVERIFIED) — part up to the limit'),
    row(2, 5000000, 1000000, 2000, '1G slab: one collection split at ₹10,00,000.00 (UNVERIFIED) — part above the limit')
  ],
  challans: [],
  totals: { amountPaise: 42000000, tdsPaise: 2850000, depositedPaise: 0 }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2025-08-25T10:00:00Z'))
  localStorage.clear()
  statutory = [
    { code: '206C(1C) PARKING', description: 'Licence / lease of a parking lot for business', legacyCode: '206C(1C)', newReference: '394(1) Sl. 9', sectionId: null },
    { code: '206C(1C) TOLL', description: 'Licence / lease of a toll plaza for business', legacyCode: '206C(1C)', newReference: '394(1) Sl. 9', sectionId: null },
    { code: '206C(1C) MINE', description: 'Licence / lease of a mine or quarry for business', legacyCode: '206C(1C)', newReference: '394(1) Sl. 9', sectionId: 77 }
  ]
  handlers = {
    'tcs:ledgerSummary': () => [],
    'tcs:eligible': () => [],
    'tcs:deducted': () => [],
    'tcs:challanRows': () => [],
    'tcs:unallocated': () => [],
    'tcs:form27eq': () => F27EQ,
    'tcs:form27d': () => ({ deductor: { name: 'Tours', address: '', pan: null, tan: null }, fyStartYear: 2025, quarter: 2, period: { from: '2025-07-01', to: '2025-09-30' }, assessmentYear: '2026-27', parties: [] }),
    'tcs:sections': () => [],
    'tcs:certificates': () => [],
    'tcs:statutory': () => statutory,
    'tcs:statutoryAdd': () => {
      const added = statutory.filter((s) => s.sectionId == null).map((s, i) => ({ id: 80 + i, code: s.code, kind: 'tcs' }))
      statutory = statutory.map((s, i) => ({ ...s, sectionId: s.sectionId ?? 80 + i }))
      return added
    },
    'master:ledgers:list': () => [],
    'master:groups:list': () => []
  }
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    const h = handlers[channel]
    if (!h) return { ok: false, error: `unmocked channel ${channel}` }
    return { ok: true, data: h(payload) }
  })
  window.total = { platform: 'test', invoke }
  act(() => {
    useSession.setState({ slug: 'tcs-co', info: { booksFrom: 2025 } as never, user: null })
    useNav.setState({ stack: [{ name: 'tcs' }] })
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TCS → Sections: statutory sections and sources', () => {
  it('lists s.206C(1C) sections, adds the missing ones, and shows the unverified points', async () => {
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tcs-sections'))
    const list = await screen.findByTestId('tcs-statutory')
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(3))
    expect(list.querySelector('[data-code="206C(1C) PARKING"]')!.textContent).toMatch(/parking lot.*206C\(1C\) \/ 2025 Act 394\(1\) Sl\. 9.*Not added/)
    expect(list.querySelector('[data-code="206C(1C) MINE"]')!.textContent).toContain('In your list')
    expect(screen.getByTestId('tcs-unverified').querySelectorAll('li')).toHaveLength(TCS_UNVERIFIED.length)
    expect(screen.getByTestId('tcs-not-modelled').textContent).toMatch(/AUTHORISED DEALER/)
    expect(screen.getByTestId('tcs-sources').textContent).toContain('https://egazette.gov.in/WriteReadData/2025/265620.pdf')
    const add = screen.getByTestId('btn-tcs-statutory-add')
    expect(add.textContent).toBe('Add these 2')
    fireEvent.click(add)
    await waitFor(() => expect(calls('tcs:statutoryAdd')).toEqual([{}]))
    await waitFor(() => expect(screen.queryByTestId('btn-tcs-statutory-add')).toBeNull())
  })

  it('a viewer sees the list but no Add button', async () => {
    act(() => useSession.setState({ user: { id: 2, name: 'V', role: 'viewer' } as never }))
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tcs-sections'))
    await waitFor(() => expect(screen.getByTestId('tcs-statutory').querySelectorAll('li')).toHaveLength(3))
    expect(screen.queryByTestId('btn-tcs-statutory-add')).toBeNull()
  })
})

describe('TCS Returns and banner — the s.206C(1G) slab', () => {
  it('27EQ rows of one split collection carry the note', async () => {
    renderScreen()
    fireEvent.click(await screen.findByTestId('tab-tcs-returns'))
    await waitFor(() => expect(bodyRows('tcs-26q')).toHaveLength(2))
    expect(bodyRows('tcs-26q')[0]!.textContent).toMatch(/3,70,000\.00.*5%.*18,500\.00.*part up to the limit/)
    expect(bodyRows('tcs-26q')[1]!.textContent).toMatch(/50,000\.00.*20%.*10,000\.00.*part above the limit/)
  })

  it('the banner says the rate per part of the slab', () => {
    const s: TcsSuggestion = {
      kind: 'tcs', sectionId: 9, code: '206C(1G) TOUR', reference: '206C(1G)', rate: 20, rateBp: 2000, basis: 'section', tdsPaise: 2850000, basePaise: 42000000,
      payableLedgerId: 60, payableLedgerName: 'TCS Payable 206C(1G) TOUR', panAvailable: true, deducteeType: 'individual_huf', thresholdCrossed: true,
      threshold: { reason: 'none', singlePaise: 0, aggregateLimitPaise: 0, basis: 'fy', priorPaise: 63000000 }, certificate: null, sectionFrom: 'party',
      candidates: [{ sectionId: 9, code: '206C(1G) TOUR', from: 'party' }], payment: null, gstInBase: true,
      slab: { limitPaise: 100000000, priorPaise: 63000000, belowPaise: 37000000, abovePaise: 5000000, lowerRateBp: 500, upperRateBp: 2000 }
    }
    render(<TdsBanner kind="tcs" suggestion={s} onApply={() => undefined} onDismiss={() => undefined} blockedReason={null} />)
    expect(screen.getByTestId('tcs-slab').textContent).toBe('at 5% on ₹3,70,000.00 + 20% on ₹50,000.00 (slab: 5% up to ₹10,00,000.00 a year, 20% above)')
  })
})
