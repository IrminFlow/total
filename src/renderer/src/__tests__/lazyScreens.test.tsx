// Lazy screens: every simpleView and every registry screen App.tsx renders has a chunk; a lazy
// screen keeps <main data-loading> busy until its code is in and renders synchronously after that;
// a failed chunk reaches the ErrorBoundary; the idle prefetcher loads each chunk once.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SCREENS } from '../lib/screens'
import { SCREEN_CHUNKS, SIMPLE_VIEW_CHUNKS } from '../lazyScreens'
import { lazyScreen, prefetchWhenIdle } from '../lib/lazyScreen'
import { useChunkLoading } from '../lib/chunkLoading'

// The screens App.tsx draws eagerly (first paint): Home in both modes.
const EAGER = new Set(['gateway'])

describe('lazy screen registry', () => {
  it('every simpleView but SimpleHome has a lazy chunk', () => {
    for (const d of SCREENS.filter((s) => s.simpleView && s.simpleView !== 'SimpleHome')) {
      expect(SIMPLE_VIEW_CHUNKS[d.simpleView!], d.name).toBeDefined()
      expect(SCREEN_CHUNKS[d.name], d.name).toContain(SIMPLE_VIEW_CHUNKS[d.simpleView!])
    }
  })

  it('every screen App.tsx renders (gateway excepted) has its chunks listed', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8')
    const rendered = [...app.matchAll(/screen\.name === '([a-z0-9-]+)' &&/g)].map((m) => m[1]!)
    expect(rendered.length).toBeGreaterThan(80)
    for (const name of rendered) if (!EAGER.has(name)) expect(SCREEN_CHUNKS[name as keyof typeof SCREEN_CHUNKS], name).toBeDefined()
  })
})

describe('lazyScreen', () => {
  it('counts as loading until the chunk is in, then renders (and at once on the next mount)', async () => {
    let resolveLoad!: (m: { Hello: (p: { who: string }) => React.JSX.Element }) => void
    const load = vi.fn(() => new Promise<{ Hello: (p: { who: string }) => React.JSX.Element }>((r) => (resolveLoad = r)))
    const Hello = lazyScreen(load, 'Hello')
    const { unmount } = render(<Hello who="Asha" />)
    expect(useChunkLoading.getState().count).toBe(1)
    expect(screen.queryByText('Hi Asha')).toBeNull()
    await act(async () => resolveLoad({ Hello: ({ who }) => <p>Hi {who}</p> }))
    expect(screen.getByText('Hi Asha')).toBeTruthy()
    expect(useChunkLoading.getState().count).toBe(0)
    unmount()
    render(<Hello who="Ravi" />)
    expect(screen.getByText('Hi Ravi')).toBeTruthy()
    expect(useChunkLoading.getState().count).toBe(0)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a chunk that fails is thrown to the error boundary and stops counting', async () => {
    const Broken = lazyScreen(() => Promise.reject<{ X: () => null }>(new Error('chunk gone')), 'X')
    const { Component } = await import('react')
    class Boundary extends Component<{ children: React.ReactNode }, { e: Error | null }> {
      state = { e: null as Error | null }
      static getDerivedStateFromError(e: Error): { e: Error } {
        return { e }
      }
      render(): React.ReactNode {
        return this.state.e ? <p>failed: {this.state.e.message}</p> : this.props.children
      }
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Boundary><Broken /></Boundary>)
    await act(async () => {})
    spy.mockRestore()
    expect(screen.getByText('failed: chunk gone')).toBeTruthy()
    expect(useChunkLoading.getState().count).toBe(0)
  })

  it('prefetchWhenIdle loads each chunk once, one after the other', async () => {
    const order: string[] = []
    const a = vi.fn(async () => order.push('a'))
    const b = vi.fn(async () => order.push('b'))
    prefetchWhenIdle([a, b, a])
    await vi.waitFor(() => expect(order).toEqual(['a', 'b']))
    expect(a).toHaveBeenCalledTimes(1)
  })
})
