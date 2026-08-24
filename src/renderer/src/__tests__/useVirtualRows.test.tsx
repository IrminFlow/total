import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVirtualRows, VIRTUALIZE_THRESHOLD } from '../lib/useVirtualRows'

describe('useVirtualRows', () => {
  it('leaves a short list alone, so find-in-page still works on every row', () => {
    const { result } = renderHook(() => useVirtualRows(20, 29))
    expect(result.current.virtualized).toBe(false)
    expect(result.current.window).toEqual({ start: 0, end: 20, padTop: 0, padBottom: 0 })
  })

  it('windows a long list and accounts for every unrendered row in the spacers', () => {
    const { result } = renderHook(() => useVirtualRows(30_000, 29))
    expect(result.current.virtualized).toBe(true)
    const w = result.current.window
    expect(w.end - w.start).toBeLessThan(200)
    expect(w.padTop + (w.end - w.start) * 29 + w.padBottom).toBe(30_000 * 29)
  })

  it('turns on exactly at the documented threshold', () => {
    expect(renderHook(() => useVirtualRows(VIRTUALIZE_THRESHOLD - 1, 29)).result.current.virtualized).toBe(false)
    expect(renderHook(() => useVirtualRows(VIRTUALIZE_THRESHOLD, 29)).result.current.virtualized).toBe(true)
  })

  it('renders nothing for an empty report rather than a stray spacer', () => {
    const { result } = renderHook(() => useVirtualRows(0, 29))
    expect(result.current.window).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
  })
})
