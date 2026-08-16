// useUnsavedGuard (lib/useUnsavedGuard.ts) — the screen-level unsaved-entry guard every voucher
// mode registers (AccountingEntry, InvoiceEntry, PhysicalStockEntry, ManufactureEntry): dirty
// registers, clean/unmount releases, and multiple dirty callers stack.
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { hasUnsavedChanges, useUnsavedGuard } from '../lib/useUnsavedGuard'

describe('useUnsavedGuard', () => {
  it('registers while dirty and releases on unmount', () => {
    expect(hasUnsavedChanges()).toBe(false)
    const { unmount } = renderHook(() => useUnsavedGuard(true))
    expect(hasUnsavedChanges()).toBe(true)
    unmount()
    expect(hasUnsavedChanges()).toBe(false)
  })

  it('does not register while clean, and releases when dirtiness flips back off', () => {
    const { rerender, unmount } = renderHook(({ dirty }) => useUnsavedGuard(dirty), {
      initialProps: { dirty: false }
    })
    expect(hasUnsavedChanges()).toBe(false)
    rerender({ dirty: true })
    expect(hasUnsavedChanges()).toBe(true)
    rerender({ dirty: false }) // e.g. save() resetting the form back to pristine defaults
    expect(hasUnsavedChanges()).toBe(false)
    unmount()
  })

  it('stacks multiple dirty callers — the guard holds until the last one releases', () => {
    const a = renderHook(() => useUnsavedGuard(true))
    const b = renderHook(() => useUnsavedGuard(true))
    expect(hasUnsavedChanges()).toBe(true)
    a.unmount()
    expect(hasUnsavedChanges()).toBe(true)
    b.unmount()
    expect(hasUnsavedChanges()).toBe(false)
  })
})
