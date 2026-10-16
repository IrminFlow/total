// Lazy screens: every simpleView and every registry screen App.tsx renders has a chunk; a lazy
// screen keeps <main data-loading> busy until its code is in and renders synchronously after that;
// a failed chunk reaches the ErrorBoundary; the idle prefetcher loads each chunk once.
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SCREENS } from '../lib/screens'
import { DEFAULT_FEATURES } from '@shared/features'
import { sidebarScreens } from '../components/HomePrefetch'
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

  it('App.tsx imports no screen eagerly but the first-paint ones', () => {
    // A new screen imported straight into App.tsx would ship in the start bundle unnoticed.
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8')
    const from = [...app.matchAll(/^import [^;]*? from '(\.\/(?:screens|simple)\/[^']+)'/gms)].map((m) => m[1])
    expect(from.sort()).toEqual(['./screens/CompanySelect', './screens/Gateway', './simple/SimpleHome', './simple/UpdateNotice', './simple/kitLabels'])
  })

  it('every registry screen with a view App.tsx draws lazily has a chunk', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8')
    for (const d of SCREENS) {
      if (EAGER.has(d.name) || !app.includes(`screen.name === '${d.name}'`)) continue
      expect(SCREEN_CHUNKS[d.name as keyof typeof SCREEN_CHUNKS], d.name).toBeDefined()
    }
  })

  it('a simple company warms only simple screens (bounded); the full app its sidebar', () => {
    const simple = sidebarScreens(true, DEFAULT_FEATURES)
    expect(simple.length).toBeGreaterThan(10)
    for (const n of simple) expect(SCREENS.find((d) => d.name === n)?.simpleView, n).toBeTruthy()
    expect(new Set(simple).size).toBe(simple.length)
    expect(sidebarScreens(false, DEFAULT_FEATURES)).toContain('voucher-entry')
  })
})

describe('lazyScreen', () => {
  it('leaving a screen before its chunk lands never draws it, and stops counting', async () => {
    type M = { Page: (p: { who: string }) => React.JSX.Element }
    let resolveA!: (m: M) => void
    let resolveB!: (m: M) => void
    const A = lazyScreen(() => new Promise<M>((r) => (resolveA = r)), 'Page')
    const B = lazyScreen(() => new Promise<M>((r) => (resolveB = r)), 'Page')
    const { rerender, unmount } = render(<A key="a" who="A" />)
    expect(useChunkLoading.getState().count).toBe(1)
    rerender(<B key="b" who="B" />)
    expect(useChunkLoading.getState().count).toBe(1)
    await act(async () => resolveA({ Page: ({ who }) => <p>page {who}</p> }))
    expect(screen.queryByText('page A')).toBeNull()
    expect(useChunkLoading.getState().count).toBe(1)
    await act(async () => resolveB({ Page: ({ who }) => <p>page {who}</p> }))
    expect(screen.getByText('page B')).toBeTruthy()
    expect(screen.queryByText('page A')).toBeNull()
    expect(useChunkLoading.getState().count).toBe(0)
    unmount()
  })

  it('unmounting while the chunk loads (company closed, lock) leaves nothing counted', async () => {
    let resolveLoad!: (m: { X: () => React.JSX.Element }) => void
    const X = lazyScreen(() => new Promise<{ X: () => React.JSX.Element }>((r) => (resolveLoad = r)), 'X')
    const { unmount } = render(<X />)
    expect(useChunkLoading.getState().count).toBe(1)
    unmount()
    expect(useChunkLoading.getState().count).toBe(0)
    await act(async () => resolveLoad({ X: () => <p>x</p> }))
    expect(useChunkLoading.getState().count).toBe(0)
  })

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
