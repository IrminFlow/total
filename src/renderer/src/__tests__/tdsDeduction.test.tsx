// useTdsDeduction (screens/voucher/useTdsDeduction.ts) — the TDS suggestion/apply hook shared by
// AccountingEntry and InvoiceEntry. window.total is mocked; each test drives the hook the way
// its entry mode does and checks the payload that mode would post.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import {
  applyTdsToAccountingRows, buildAccountingPayload, buildInvoicePayload, emptyInvoiceState,
  type InvoiceContext, type TdsDeductionState
} from '@shared/voucherEdit'
import { useTdsDeduction, type TdsCandidate } from '../screens/voucher/useTdsDeduction'

const invoke = vi.fn()
const VENDOR = 12
const BANK = 30
const PURCHASE = 22
const PAYABLE = 50
const ITEM = 100

function suggestion(over: Record<string, unknown> = {}) {
  return {
    sectionId: 3, code: '194C', reference: '194C', rate: 2, rateBp: 200, basis: 'section', tdsPaise: 100000,
    payableLedgerId: null, payableLedgerName: 'TDS Payable 194C', panAvailable: true, deducteeType: 'company',
    thresholdCrossed: true, threshold: { reason: 'single', singlePaise: 3000000, aggregateLimitPaise: 10000000, basis: 'fy', priorPaise: 0 },
    certificate: null, sectionFrom: 'party', ...over
  }
}

let suggestImpl: (p: { base: number }) => unknown = () => suggestion()

beforeEach(() => {
  invoke.mockReset()
  suggestImpl = () => suggestion()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    if (channel === 'tds:suggest') return { ok: true, data: suggestImpl(payload as { base: number }) }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke }
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The hook as an entry form uses it: the form owns the applied deduction. */
function useHarness(candidate: TdsCandidate | null, initial: TdsDeductionState | null = null) {
  const [tds, setTds] = useState<TdsDeductionState | null>(initial)
  const hook = useTdsDeduction({ enabled: true, candidate, date: '2025-05-01', tds, onChange: setTds, startDismissed: !!initial, debounceMs: 0 })
  return { tds, ...hook }
}

describe('useTdsDeduction — accounting mode (payment to a flagged vendor)', () => {
  it('suggests, applies as pending when the payable ledger does not exist yet, and the payload asks the server for the credit', async () => {
    const { result } = renderHook(() => useHarness({ partyLedgerId: VENDOR, base: 5000000 }))
    await waitFor(() => expect(result.current.suggestion?.tdsPaise).toBe(100000))
    expect(invoke).toHaveBeenCalledWith('tds:suggest', { partyLedgerId: VENDOR, base: 5000000, date: '2025-05-01', expenseLedgerId: null, excludeVoucherId: undefined })
    expect(result.current.dismissed).toBe(false)

    let applied: TdsDeductionState | null = null
    act(() => {
      applied = result.current.apply()
    })
    expect(applied).toEqual({ sectionId: 3, baseAmount: 5000000, tdsAmount: 100000, isManual: false, payableLedgerId: null, pending: true })
    expect(result.current.tds).toEqual(applied)
    expect(result.current.dismissed).toBe(true)
    // No ledger was created: Apply is client-side only.
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('tds:ensurePayable')

    const rows = applyTdsToAccountingRows(
      [
        { drCr: 'dr' as const, ledgerId: VENDOR, amount: 5000000 },
        { drCr: 'cr' as const, ledgerId: BANK, amount: 5000000 }
      ],
      { targetIdx: 1, tdsAmount: 100000, payableLedgerId: null, previous: null, makeRow: (ledgerId, amount) => ({ drCr: 'cr' as const, ledgerId, amount }) }
    )
    const t = result.current.tds!
    const r = buildAccountingPayload(
      {
        date: '2025-05-01', number: '', narration: '', instrumentNo: '', billRefs: [], advanceReceipt: false, optional: false, original: null,
        rows: rows.map((x) => ({ ...x, costAllocations: [] })),
        tds: { sectionId: t.sectionId, baseAmount: t.baseAmount, tdsAmount: t.tdsAmount, isManual: t.isManual, autoPayable: t.pending }
      },
      { kind: 'payment', voucherTypeId: 3, derivedPartyId: VENDOR }
    )
    expect(r.ok && r.payload.lines.map((l) => [l.ledgerId, l.drCr, l.amount])).toEqual([[VENDOR, 'dr', 5000000], [BANK, 'cr', 4900000]])
    expect(r.ok && r.payload.tds).toMatchObject({ tdsAmount: 100000, autoPayable: true })
  })

  it('refuses a stale suggestion until it is refetched for the new base', async () => {
    suggestImpl = (p) => suggestion({ tdsPaise: p.base / 50 })
    const { result, rerender } = renderHook(({ base }) => useHarness({ partyLedgerId: VENDOR, base }), { initialProps: { base: 5000000 } })
    await waitFor(() => expect(result.current.suggestion?.tdsPaise).toBe(100000))
    rerender({ base: 6000000 })
    // Same render as the change: the old suggestion is still showing, but must not apply.
    expect(result.current.apply()).toBeNull()
    await waitFor(() => expect(result.current.suggestion?.tdsPaise).toBe(120000))
    let applied: TdsDeductionState | null = null
    act(() => {
      applied = result.current.apply()
    })
    expect(applied).toMatchObject({ baseAmount: 6000000, tdsAmount: 120000 })
  })

  it('an alteration that already carries TDS keeps the banner closed and re-applies onto the saved payable ledger', async () => {
    suggestImpl = () => suggestion({ payableLedgerId: null, tdsPaise: 110000 })
    const saved = { sectionId: 3, baseAmount: 5000000, tdsAmount: 100000, isManual: true, payableLedgerId: PAYABLE, pending: false }
    const { result } = renderHook(() => useHarness({ partyLedgerId: VENDOR, base: 5000000 }, saved))
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())
    expect(result.current.dismissed).toBe(true)
    let applied: TdsDeductionState | null = null
    act(() => {
      applied = result.current.apply()
    })
    expect(applied).toMatchObject({ payableLedgerId: PAYABLE, pending: false, isManual: false, tdsAmount: 110000 })
  })

  it('nothing to apply without a candidate, or when the suggestion is ₹0', async () => {
    const { result, rerender } = renderHook(({ c }) => useHarness(c), { initialProps: { c: null as TdsCandidate | null } })
    expect(result.current.suggestion).toBeNull()
    expect(result.current.apply()).toBeNull()
    suggestImpl = () => suggestion({ tdsPaise: 0 })
    rerender({ c: { partyLedgerId: VENDOR, base: 100 } })
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())
    expect(result.current.apply()).toBeNull()
  })
})

describe('useTdsDeduction — invoice mode (purchase invoice)', () => {
  const ctx: InvoiceContext = {
    kind: 'purchase',
    companyStateCode: '27',
    items: new Map([[ITEM, { gstRate: 18, cessRate: null }]]),
    ledgers: new Map([
      [VENDOR, { stateCode: '27', gstRate: null }],
      [PURCHASE, { stateCode: null, gstRate: null }],
      [PAYABLE, { stateCode: null, gstRate: null, tdsPayableSectionId: 3 }]
    ])
  }
  const TAX = { cgst: 40, sgst: 41, igst: 42, cess: 43, roundOff: 44 }

  it('passes the purchase ledger for its default section, and the applied deduction lays out the invoice lines', async () => {
    suggestImpl = () => suggestion({ payableLedgerId: PAYABLE, tdsPaise: 2000 })
    const taxable = 100000 // ₹1,000
    const { result } = renderHook(() => useHarness({ partyLedgerId: VENDOR, base: taxable, expenseLedgerId: PURCHASE }))
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())
    expect(invoke).toHaveBeenCalledWith('tds:suggest', expect.objectContaining({ expenseLedgerId: PURCHASE, base: taxable }))
    act(() => {
      result.current.apply()
    })
    expect(result.current.tds).toEqual({ sectionId: 3, baseAmount: taxable, tdsAmount: 2000, isManual: false, payableLedgerId: PAYABLE, pending: false })
    const r = buildInvoicePayload(
      {
        ...emptyInvoiceState('2025-05-01'), partyId: VENDOR, accountId: PURCHASE, billName: 'P-1',
        rows: [{ itemId: ITEM, qtyText: '1', rate: taxable, discount: null, godownId: null, batchId: null }],
        tds: result.current.tds
      },
      ctx, 2, TAX
    )
    if (!r.ok) throw new Error(r.error)
    // ₹1,000 + 18% GST = ₹1,180 total; vendor is owed ₹1,160; ₹20 to TDS Payable.
    expect(r.payload.lines[0]).toMatchObject({ ledgerId: VENDOR, drCr: 'cr', amount: 116000 })
    expect(r.payload.lines[r.payload.lines.length - 1]).toMatchObject({ ledgerId: PAYABLE, drCr: 'cr', amount: 2000 })
    expect(r.payload.tds).toMatchObject({ autoPayable: false })
    expect(r.payload.billRefs[0]!.amount).toBe(116000)
  })

  it('reset() after saving clears the deduction and the suggestion', async () => {
    const { result } = renderHook(() => useHarness({ partyLedgerId: VENDOR, base: 100000 }))
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())
    act(() => {
      result.current.apply()
    })
    act(() => result.current.reset())
    expect(result.current.tds).toBeNull()
    expect(result.current.suggestion).toBeNull()
  })
})
