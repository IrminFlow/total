import { beforeEach, describe, expect, it } from 'vitest'
import { continuationRouteKey, readContinuation, rememberContinuation } from '../lib/continuation'

describe('continue working state', () => {
  beforeEach(() => localStorage.clear())

  it('restores a safe screen, working period and per-screen scroll', () => {
    rememberContinuation('alpha', { screen: { name: 'daybook' }, from: '2026-08-01', to: '2026-08-31', scrollTop: 420 })
    rememberContinuation('alpha', { screen: { name: 'trial-balance' }, from: '2026-08-01', to: '2026-08-31', scrollTop: 80 })
    expect(readContinuation('alpha')).toEqual({
      screen: { name: 'trial-balance' }, from: '2026-08-01', to: '2026-08-31',
      scrollByScreen: { daybook: 420, 'trial-balance': 80 }
    })
  })

  it('refuses unsafe voucher-entry and malformed date state', () => {
    localStorage.setItem('total-continuation-alpha', JSON.stringify({ screen: { name: 'voucher-entry', voucherId: 99 }, from: '2026-08-01', to: '2026-08-31' }))
    expect(readContinuation('alpha')).toBeNull()
    localStorage.setItem('total-continuation-alpha', JSON.stringify({ screen: { name: 'daybook' }, from: 'bad', to: '2026-08-31' }))
    expect(readContinuation('alpha')).toBeNull()
  })

  it('distinguishes same-screen tabs and drill-down routes', () => {
    expect(continuationRouteKey({ name: 'settings', tab: 'agents' })).not.toBe(
      continuationRouteKey({ name: 'settings', tab: 'integrations' })
    )
    expect(continuationRouteKey({ name: 'daybook', voucherIds: [1, 2] })).not.toBe(
      continuationRouteKey({ name: 'daybook', voucherIds: [2, 3] })
    )
    expect(continuationRouteKey({ name: 'ledger-statement', ledgerId: 7 })).not.toBe(
      continuationRouteKey({ name: 'ledger-statement', ledgerId: 8 })
    )
  })
})
