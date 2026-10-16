// to-do §4 (hand-off review, shots-96): switching company with unsaved editor changes asks the
// discard question FIRST — "Stay" closes nothing and keeps the screen; "Discard" closes the company
// and the next one starts on its own Home, never on the previous company's screens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'

const confirm = vi.hoisted(() => vi.fn<(opts: unknown) => Promise<boolean>>())
vi.mock('../lib/dialogs', async (orig) => ({ ...(await orig<typeof import('../lib/dialogs')>()), confirmDialog: confirm }))

import { switchCompany, useNav, useSession, type Screen } from '../state/stores'
import { useUnsavedGuard } from '../lib/useUnsavedGuard'
import type { CompanyInfo } from '@shared/domain'

function DirtyEditor(): null {
  useUnsavedGuard(true)
  return null
}

const editorStack: Screen[] = [{ name: 'gateway' }, { name: 'daybook' }, { name: 'voucher-entry', kind: 'sales' } as Screen]
const info = { name: 'Other Traders' } as unknown as CompanyInfo

beforeEach(() => {
  confirm.mockReset()
  act(() => {
    useSession.setState({ slug: 'first-traders', info: { name: 'First Traders' } as unknown as CompanyInfo })
    useNav.setState({ stack: editorStack })
  })
})
afterEach(() => act(() => useSession.getState().clearCompany()))

describe('switch company with an unsaved editor', () => {
  it('Stay: the question comes first, nothing closes, the stack is untouched', async () => {
    confirm.mockResolvedValue(false)
    const close = vi.fn(async () => null)
    const view = render(<DirtyEditor />)
    let switched: boolean | undefined
    await act(async () => {
      switched = await switchCompany(close)
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(switched).toBe(false)
    expect(close).not.toHaveBeenCalled()
    expect(useSession.getState().slug).toBe('first-traders')
    expect(useNav.getState().stack).toBe(editorStack)
    view.unmount()
  })

  it('Discard: asked before closing; the company closes and the stack is that of a fresh Home', async () => {
    const order: string[] = []
    confirm.mockImplementation(async () => {
      order.push('ask')
      return true
    })
    const close = vi.fn(async () => {
      order.push('close')
      return null
    })
    const view = render(<DirtyEditor />)
    await act(async () => {
      expect(await switchCompany(close)).toBe(true)
    })
    expect(order).toEqual(['ask', 'close'])
    expect(useSession.getState().slug).toBeNull()
    expect(useNav.getState().stack).toEqual([{ name: 'gateway' }])
    view.unmount()
    // The next company opens on its own Home.
    act(() => useSession.getState().setCompany('other-traders', info))
    expect(useNav.getState().stack).toEqual([{ name: 'gateway' }])
  })

  it('nothing unsaved: no question, straight through', async () => {
    const close = vi.fn(async () => null)
    await act(async () => {
      expect(await switchCompany(close)).toBe(true)
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(useNav.getState().stack).toEqual([{ name: 'gateway' }])
  })

  it('any other slug change (a lock screen\'s "another business", a direct open) drops the old stack too', () => {
    act(() => useSession.getState().setCompany('other-traders', info))
    expect(useNav.getState().stack).toEqual([{ name: 'gateway' }])
    // Same company re-read (a restore, an info edit): the stack stays.
    act(() => useNav.setState({ stack: editorStack }))
    act(() => useSession.getState().setCompany('other-traders', info))
    expect(useNav.getState().stack).toBe(editorStack)
  })
})
