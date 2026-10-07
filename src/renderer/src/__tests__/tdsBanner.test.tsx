// WP 3.2 — the TDS banner and hook changes: reason text, section choice, certificate, manual
// amount (confirmed), "Not applicable" written on save, and the payment-time suggestion.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { TdsDeductionState } from '@shared/voucherEdit'
import type { TdsSuggestion } from '../lib/client'
import { useTdsDeduction, type TdsCandidate } from '../screens/voucher/useTdsDeduction'
import { TdsBanner, tdsReasonText } from '../screens/voucher/TdsBanner'
import { DialogHost } from '../components/dialogs'

const invoke = vi.fn()
const calls = (channel: string): unknown[] => invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1])

function suggestion(over: Partial<TdsSuggestion> = {}): TdsSuggestion {
  return {
    sectionId: 3, code: '194C', reference: '194C', rate: 2, rateBp: 200, basis: 'section', tdsPaise: 100000, basePaise: 5000000,
    payableLedgerId: null, payableLedgerName: 'TDS Payable 194C', panAvailable: true, deducteeType: 'company',
    thresholdCrossed: true, threshold: { reason: 'aggregate', singlePaise: 3000000, aggregateLimitPaise: 10000000, basis: 'fy', priorPaise: 6000000 },
    certificate: null, sectionFrom: 'party',
    candidates: [{ sectionId: 3, code: '194C', from: 'party' }, { sectionId: 4, code: '194J', from: 'ledger' }],
    payment: null, ...over
  }
}

let suggestImpl: (p: Record<string, unknown>) => unknown = () => suggestion()

beforeEach(() => {
  invoke.mockReset()
  suggestImpl = () => suggestion()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    if (channel === 'tds:suggest') return { ok: true, data: suggestImpl(payload as Record<string, unknown>) }
    if (channel === 'tds:exemption') return { ok: true, data: { reason: null } }
    if (channel === 'tds:exempt' || channel === 'tds:unexempt') return { ok: true, data: null }
    return { ok: false, error: `unmocked channel ${channel}` }
  })
  window.total = { platform: 'test', invoke }
})
afterEach(() => cleanup())

function useHarness(candidate: TdsCandidate | null, voucherKind?: 'purchase' | 'journal' | 'payment', excludeVoucherId?: number) {
  const [tds, setTds] = useState<TdsDeductionState | null>(null)
  const hook = useTdsDeduction({ enabled: true, candidate, date: '2025-05-01', tds, onChange: setTds, debounceMs: 0, voucherKind, excludeVoucherId })
  return { tds, ...hook }
}

describe('tdsReasonText', () => {
  it('names the threshold that tripped, or the payment-time reason', () => {
    expect(tdsReasonText(suggestion())).toBe('Aggregate ₹1,10,000.00 this year crosses ₹1,00,000.00')
    expect(tdsReasonText(suggestion({ threshold: { ...suggestion().threshold, reason: 'single' } }))).toBe('Single payment above ₹30,000.00')
    expect(tdsReasonText(suggestion({ payment: { undeductedBillsPaise: 4000000, advancePaise: 0, deductedAtCredit: false }, basePaise: 4000000 })))
      .toMatch(/^Deduct on payment: ₹40,000\.00 of bills not deducted when booked/)
    expect(tdsReasonText(suggestion({ tdsPaise: 0, payment: { undeductedBillsPaise: 0, advancePaise: 0, deductedAtCredit: true } })))
      .toMatch(/deducted when the bills were booked/)
  })
})

describe('useTdsDeduction (WP 3.2)', () => {
  it('passes the voucher kind and the chosen section to tds:suggest; the base comes from the suggestion', async () => {
    suggestImpl = (p) => suggestion({ basePaise: 4000000, tdsPaise: 80000, sectionId: (p.sectionId as number) ?? 3 })
    const { result } = renderHook(() => useHarness({ partyLedgerId: 12, base: 5000000 }, 'payment'))
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())
    expect(calls('tds:suggest')[0]).toMatchObject({ voucherKind: 'payment' })
    act(() => result.current.chooseSection(4))
    await waitFor(() => expect(calls('tds:suggest').at(-1)).toMatchObject({ sectionId: 4 }))
    await waitFor(() => expect(result.current.suggestion?.sectionId).toBe(4))
    act(() => {
      result.current.apply()
    })
    expect(result.current.tds).toMatchObject({ sectionId: 4, baseAmount: 4000000, tdsAmount: 80000, isManual: false })
  })

  it('applyManual records a manual deduction', async () => {
    const { result } = renderHook(() => useHarness({ partyLedgerId: 12, base: 5000000 }))
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())
    act(() => {
      result.current.applyManual(12345)
    })
    expect(result.current.tds).toMatchObject({ tdsAmount: 12345, isManual: true, baseAmount: 5000000 })
  })

  it('"Not applicable" is written after save (tds:exempt), and cleared when undone on an alteration', async () => {
    const { result } = renderHook(() => useHarness({ partyLedgerId: 12, base: 5000000 }))
    await waitFor(() => expect(result.current.suggestion).not.toBeNull())
    act(() => result.current.setNotApplicable('Reimbursement'))
    expect(result.current.dismissed).toBe(true)
    await act(async () => result.current.afterSave(77))
    expect(calls('tds:exempt')).toEqual([{ voucherId: 77, reason: 'Reimbursement' }])

    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === 'tds:exemption') return { ok: true, data: { reason: 'Old reason' } }
      if (channel === 'tds:suggest') return { ok: true, data: suggestion() }
      if (channel === 'tds:unexempt') return { ok: true, data: null }
      return { ok: false, error: `unmocked ${channel} ${String(payload)}` }
    })
    const alter = renderHook(() => useHarness({ partyLedgerId: 12, base: 5000000 }, 'journal', 77))
    await waitFor(() => expect(alter.result.current.notApplicable).toBe('Old reason'))
    act(() => alter.result.current.setNotApplicable(null))
    await act(async () => alter.result.current.afterSave(77))
    expect(calls('tds:unexempt')).toEqual([{ voucherId: 77 }])
  })
})

describe('TdsBanner', () => {
  it('shows reason + certificate, lets the user pick a section, confirm a manual amount and mark not applicable', async () => {
    const onApplyManual = vi.fn()
    const onChooseSection = vi.fn()
    const onNotApplicable = vi.fn()
    render(
      <>
        <TdsBanner
          suggestion={suggestion({ certificate: { id: 1, certificateNo: 'LDC-9', rateBp: 50, validTo: '2026-03-31' } })}
          onApply={vi.fn()}
          onDismiss={vi.fn()}
          blockedReason={null}
          onApplyManual={onApplyManual}
          onChooseSection={onChooseSection}
          onNotApplicable={onNotApplicable}
        />
        <DialogHost />
      </>
    )
    expect(screen.getByTestId('banner-tds-reason').textContent).toMatch(/Aggregate .* crosses .*lower-deduction certificate LDC-9 at 0\.5%, valid to 31/)
    fireEvent.change(screen.getByTestId('select-tds-section'), { target: { value: '4' } })
    expect(onChooseSection).toHaveBeenCalledWith(4)

    fireEvent.click(screen.getByTestId('btn-tds-manual'))
    fireEvent.change(screen.getByTestId('input-tds-manual'), { target: { value: '750' } })
    fireEvent.click(screen.getByTestId('btn-tds-manual-apply'))
    fireEvent.click(await screen.findByTestId('confirm-ok'))
    await waitFor(() => expect(onApplyManual).toHaveBeenCalledWith(75000))

    fireEvent.click(screen.getByTestId('btn-tds-na'))
    fireEvent.change(screen.getByTestId('input-tds-na-reason'), { target: { value: 'Below threshold by agreement' } })
    fireEvent.click(screen.getByTestId('btn-tds-na-confirm'))
    expect(onNotApplicable).toHaveBeenCalledWith('Below threshold by agreement')
  })
})
