import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMenuCommands } from '../lib/menuCommands'
import { useNav } from '../state/stores'

let listener: ((payload: unknown) => void) | null = null
let unsubscribed = false

beforeEach(() => {
  listener = null
  unsubscribed = false
  window.total = {
    platform: 'test',
    invoke: vi.fn(),
    on: (_channel, cb) => {
      listener = cb
      return () => {
        unsubscribed = true
      }
    }
  }
  useNav.setState({ stack: [{ name: 'gateway' }] })
})

afterEach(() => vi.restoreAllMocks())

/**
 * nav.go/back/home run the unsaved-changes guard before touching the store, so the navigation
 * lands a microtask after the menu command fires. Flush before asserting.
 */
const send = async (id: string): Promise<void> => {
  await act(async () => {
    listener?.(id)
    await Promise.resolve()
  })
}

describe('useMenuCommands', () => {
  it('runs the handler a caller supplied', async () => {
    const palette = vi.fn()
    renderHook(() => useMenuCommands({ palette }))
    await send('palette')
    expect(palette).toHaveBeenCalledTimes(1)
  })

  it('navigates for ids nobody handled', async () => {
    renderHook(() => useMenuCommands({}))
    await send('go-daybook')
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'daybook' })
    await send('settings')
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'settings' })
  })

  it('go-gateway resets the stack rather than pushing another Gateway', async () => {
    renderHook(() => useMenuCommands({}))
    await send('go-masters')
    await send('go-gateway')
    expect(useNav.getState().stack).toEqual([{ name: 'gateway' }])
  })

  it('back pops one screen', async () => {
    renderHook(() => useMenuCommands({}))
    await send('go-masters')
    await send('go-daybook')
    await send('back')
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'masters' })
  })

  it('a caller handler wins over the built-in navigation', async () => {
    const settings = vi.fn()
    renderHook(() => useMenuCommands({ settings }))
    await send('settings')
    expect(settings).toHaveBeenCalledTimes(1)
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'gateway' })
  })

  it('ignores an unknown id instead of throwing', async () => {
    renderHook(() => useMenuCommands({}))
    await expect(send('not-a-command')).resolves.toBeUndefined()
    expect(useNav.getState().stack.at(-1)).toEqual({ name: 'gateway' })
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useMenuCommands({}))
    unmount()
    expect(unsubscribed).toBe(true)
  })
})
