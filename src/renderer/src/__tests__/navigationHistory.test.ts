import { beforeEach, describe, expect, it } from 'vitest'
import { navigationLabel } from '../lib/navigationLabels'
import { useNav } from '../state/stores'

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('navigation history', () => {
  beforeEach(() => {
    useNav.setState({ stack: [{ name: 'gateway' }], future: [] })
  })

  it('moves backward and forward without discarding the path', async () => {
    useNav.getState().go({ name: 'daybook', periodLabel: 'April 2026' })
    await settle()
    useNav.getState().go({ name: 'voucher-entry', voucherId: 42 })
    await settle()

    useNav.getState().back()
    await settle()
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'daybook', periodLabel: 'April 2026' })
    expect(useNav.getState().future).toEqual([{ name: 'voucher-entry', voucherId: 42 }])

    useNav.getState().forward()
    await settle()
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', voucherId: 42 })
    expect(useNav.getState().future).toEqual([])
  })

  it('clears the forward branch after navigating somewhere new', async () => {
    useNav.setState({
      stack: [{ name: 'gateway' }, { name: 'daybook' }],
      future: [{ name: 'trial-balance' }]
    })
    useNav.getState().go({ name: 'profit-loss' })
    await settle()

    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'profit-loss' })
    expect(useNav.getState().future).toEqual([])
  })

  it('seeks directly to an earlier or later point', async () => {
    useNav.setState({
      stack: [{ name: 'gateway' }, { name: 'daybook' }, { name: 'voucher-entry', voucherId: 7 }],
      future: [{ name: 'trial-balance' }, { name: 'ledger-statement', ledgerId: 9 }]
    })
    useNav.getState().seek(4)
    await settle()
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'ledger-statement', ledgerId: 9 })
    expect(useNav.getState().future).toEqual([])

    useNav.getState().seek(1)
    await settle()
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'daybook' })
    expect(useNav.getState().future).toHaveLength(3)
  })

  it('gives drilled records and filtered screens meaningful labels', () => {
    expect(navigationLabel({ name: 'voucher-entry', voucherId: 42 })).toEqual({ title: 'Voucher #42', detail: 'Voucher entry' })
    expect(navigationLabel({ name: 'daybook', periodLabel: 'Q2 FY 2026-27' })).toEqual({ title: 'Day book', detail: 'Q2 FY 2026-27' })
    expect(navigationLabel({ name: 'settings', tab: 'backups' })).toEqual({ title: 'Settings', detail: 'Backups' })
  })
})
