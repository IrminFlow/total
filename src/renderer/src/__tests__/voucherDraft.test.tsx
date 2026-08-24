import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { clearDraft, describeAge, draftKey, loadDraft, saveDraft, useVoucherDraft } from '../lib/voucherDraft'

interface Form {
  narration: string
}

const SLUG = 'acme'
const KIND = 'acct-journal'

beforeEach(() => {
  localStorage.clear()
  vi.useRealTimers()
})

describe('draft storage', () => {
  it('round-trips a draft', () => {
    saveDraft<Form>(SLUG, KIND, { narration: 'rent' }, 1000)
    expect(loadDraft<Form>(SLUG, KIND, 2000)).toEqual({ state: { narration: 'rent' }, savedAt: 1000 })
  })

  it('keeps each company’s draft apart', () => {
    saveDraft<Form>(SLUG, KIND, { narration: 'ours' })
    expect(loadDraft<Form>('someone-else', KIND)).toBeNull()
  })

  it('drops a draft older than a week, rather than offering last month’s work back', () => {
    const eightDays = 8 * 24 * 60 * 60 * 1000
    saveDraft<Form>(SLUG, KIND, { narration: 'old' }, 0)
    expect(loadDraft<Form>(SLUG, KIND, eightDays)).toBeNull()
    // And it is gone, not merely hidden — otherwise it is re-read (and re-rejected) forever.
    expect(localStorage.getItem(draftKey(SLUG, KIND))).toBeNull()
  })

  it('discards an unreadable draft instead of throwing into the render', () => {
    localStorage.setItem(draftKey(SLUG, KIND), '{not json')
    expect(loadDraft<Form>(SLUG, KIND)).toBeNull()
  })

  it('clearDraft removes it', () => {
    saveDraft<Form>(SLUG, KIND, { narration: 'x' })
    clearDraft(SLUG, KIND)
    expect(loadDraft<Form>(SLUG, KIND)).toBeNull()
  })
})

describe('describeAge', () => {
  it('reads the way a person would say it', () => {
    const now = 1_000_000_000
    expect(describeAge(now - 30_000, now)).toBe('just now')
    expect(describeAge(now - 60_000, now)).toBe('1 minute ago')
    expect(describeAge(now - 20 * 60_000, now)).toBe('20 minutes ago')
    expect(describeAge(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(describeAge(now - 26 * 3_600_000, now)).toBe('yesterday')
    expect(describeAge(now - 3 * 86_400_000, now)).toBe('3 days ago')
  })
})

describe('useVoucherDraft', () => {
  it('offers back the draft that was there when the screen opened', () => {
    saveDraft<Form>(SLUG, KIND, { narration: 'half typed' })
    const { result } = renderHook(() =>
      useVoucherDraft<Form>(SLUG, KIND, { narration: '' }, '{}', { enabled: true, isEmpty: true })
    )
    expect(result.current.offered?.state.narration).toBe('half typed')
  })

  it('never offers a draft back on an alteration, where the stored voucher is the truth', () => {
    saveDraft<Form>(SLUG, KIND, { narration: 'half typed' })
    const { result } = renderHook(() =>
      useVoucherDraft<Form>(SLUG, KIND, { narration: '' }, '{}', { enabled: false, isEmpty: true })
    )
    expect(result.current.offered).toBeNull()
  })

  it('does not offer back the draft it has just written itself', async () => {
    vi.useFakeTimers()
    const state = { narration: 'typing' }
    const { result, rerender } = renderHook(
      (props: { sig: string }) =>
        useVoucherDraft<Form>(SLUG, KIND, state, props.sig, { enabled: true, isEmpty: false }),
      { initialProps: { sig: 'a' } }
    )
    expect(result.current.offered).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(loadDraft<Form>(SLUG, KIND)?.state.narration).toBe('typing')
    rerender({ sig: 'b' })
    // The banner must stay away for the whole life of the screen, not reappear on a re-render.
    expect(result.current.offered).toBeNull()
    vi.useRealTimers()
  })

  it('writes after the debounce, not on every keystroke', async () => {
    vi.useFakeTimers()
    const { rerender } = renderHook(
      (props: { sig: string; state: Form }) =>
        useVoucherDraft<Form>(SLUG, KIND, props.state, props.sig, { enabled: true, isEmpty: false }),
      { initialProps: { sig: 'a', state: { narration: 'a' } } }
    )
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(loadDraft<Form>(SLUG, KIND)).toBeNull()
    rerender({ sig: 'ab', state: { narration: 'ab' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    // The second keystroke restarted the clock: still nothing written 300ms later.
    expect(loadDraft<Form>(SLUG, KIND)).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(loadDraft<Form>(SLUG, KIND)?.state.narration).toBe('ab')
    vi.useRealTimers()
  })

  it('clears the stored draft when the form goes empty', async () => {
    saveDraft<Form>(SLUG, KIND, { narration: 'x' })
    renderHook(() => useVoucherDraft<Form>(SLUG, KIND, { narration: '' }, '{}', { enabled: true, isEmpty: true }))
    expect(localStorage.getItem(draftKey(SLUG, KIND))).toBeNull()
  })

  it('clear() forgets it and takes the offer away', () => {
    saveDraft<Form>(SLUG, KIND, { narration: 'x' })
    const { result } = renderHook(() =>
      useVoucherDraft<Form>(SLUG, KIND, { narration: '' }, '{}', { enabled: true, isEmpty: false })
    )
    expect(result.current.offered).not.toBeNull()
    act(() => result.current.clear())
    expect(result.current.offered).toBeNull()
    expect(loadDraft<Form>(SLUG, KIND)).toBeNull()
  })
})
