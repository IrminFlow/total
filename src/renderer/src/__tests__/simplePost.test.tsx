// WP 9.1: useSimplePost — one clientId per intent (a retry re-sends it, a save starts a new one),
// one request while a post is in flight, the working date with every call, IpcErrors with the field.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useSimplePost, type IntentDraft } from '../lib/simplePost'
import { useSession } from '../state/stores'
import type { SimplePostResult, SimplePreview } from '@shared/simple/intents'

const invoke = vi.fn()
const intent: IntentDraft = { kind: 'move_money', amount: '2,000', fromId: 1, toId: 2 }

const result = (ids: number[]): SimplePostResult => ({
  voucherIds: ids,
  entries: ids.map((id) => ({ role: 'money', voucherId: id, kind: 'contra', number: String(id) })),
  replayed: false,
  summary: { entries: [], parties: [], undo: { undoable: true, reason: null } },
  sentences: ['₹2,000.00 moved from Cash to HDFC Bank.'],
  facts: { kind: 'move_money', partyName: null, total: 200_000, tax: 0, paid: 0, how: null, moneyAccount: null, due: 0, settled: [], advance: 0, fromName: 'Cash', toName: 'HDFC Bank', againstBill: null, offBill: 0, credit: 0, walkIn: false, balance: null, noGst: null, side: null },
  warnings: { negativeStock: [], creditLimitExceeded: null }
})

beforeEach(() => {
  invoke.mockReset()
  window.total = { platform: 'test', invoke } as unknown as typeof window.total
  useSession.setState({ workingDate: '2025-08-14' })
})
afterEach(cleanup)

const sent = (i: number): { intent: { clientId: string }; today?: string } => invoke.mock.calls[i]![1]

describe('useSimplePost', () => {
  it('a retry after a failure re-sends the same clientId; a save starts a new one', async () => {
    invoke
      .mockResolvedValueOnce({ ok: false, error: 'Books are locked up to 2025-08-31', code: 'books_locked', field: 'date', params: { date: '31/08/2025' } })
      .mockResolvedValueOnce({ ok: true, data: result([7]) })
      .mockResolvedValueOnce({ ok: true, data: result([8]) })
    const { result: h } = renderHook(() => useSimplePost())
    let caught: unknown
    await act(async () => {
      await h.current.post(intent).catch((e) => (caught = e))
    })
    expect(caught).toMatchObject({ code: 'books_locked', field: 'date', message: 'Books are locked up to 2025-08-31' })
    expect(h.current.status).toBe('error')
    expect(h.current.error?.field).toBe('date')
    await act(async () => {
      await h.current.post(intent)
    })
    expect(invoke.mock.calls[0]![0]).toBe('simple:post')
    expect(sent(1).intent.clientId).toBe(sent(0).intent.clientId)
    expect(sent(0).today).toBe('2025-08-14')
    expect(h.current.status).toBe('saved')
    expect(h.current.result?.voucherIds).toEqual([7])
    await act(async () => {
      await h.current.post(intent)
    })
    expect(sent(2).intent.clientId).not.toBe(sent(1).intent.clientId)
  })

  it('a double click while posting sends ONE request', async () => {
    let release!: (v: unknown) => void
    invoke.mockImplementation(() => new Promise((r) => (release = r)))
    const { result: h } = renderHook(() => useSimplePost())
    let a!: Promise<SimplePostResult>
    let b!: Promise<SimplePostResult>
    act(() => {
      a = h.current.post(intent)
      b = h.current.post(intent)
    })
    expect(a).toBe(b)
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => {
      release({ ok: true, data: result([3, 4]) })
      await a
    })
    expect(h.current.result?.voucherIds).toEqual([3, 4])
  })

  it('preview sends the intent with the same clientId and keeps what the server said', async () => {
    const preview: SimplePreview = {
      kind: 'move_money', sentences: ['₹2,000.00 moved from Cash to HDFC Bank.'], facts: result([1]).facts, entries: [], warnings: { negativeStock: [], creditLimitExceeded: null }
    }
    invoke.mockResolvedValueOnce({ ok: true, data: preview }).mockResolvedValueOnce({ ok: true, data: result([9]) })
    const { result: h } = renderHook(() => useSimplePost())
    await act(async () => {
      await h.current.preview(intent)
    })
    expect(invoke.mock.calls[0]![0]).toBe('simple:preview')
    expect(h.current.lastPreview?.sentences).toEqual(preview.sentences)
    await act(async () => {
      await h.current.post(intent)
    })
    expect(sent(1).intent.clientId).toBe(sent(0).intent.clientId)
    expect(sent(1).intent).toMatchObject({ kind: 'move_money', amount: '2,000', fromId: 1, toId: 2 })
  })

  it('reset while a post is running keeps that request (no second post)', async () => {
    let release!: (v: unknown) => void
    invoke.mockImplementation(() => new Promise((r) => (release = r)))
    const { result: h } = renderHook(() => useSimplePost())
    let a!: Promise<SimplePostResult>
    let b!: Promise<SimplePostResult>
    act(() => {
      a = h.current.post(intent)
    })
    act(() => h.current.reset())
    act(() => {
      b = h.current.post(intent)
    })
    expect(b).toBe(a)
    expect(invoke).toHaveBeenCalledTimes(1)
    await act(async () => {
      release({ ok: true, data: result([5]) })
      await a
    })
    expect(h.current.status).toBe('saved')
  })

  it('reset starts over with a new clientId', async () => {
    invoke.mockResolvedValue({ ok: false, error: 'x', code: 'simple_same_account', field: 'to' })
    const { result: h } = renderHook(() => useSimplePost())
    const first = h.current.clientId
    act(() => h.current.reset())
    await waitFor(() => expect(h.current.status).toBe('idle'))
    expect(h.current.clientId).not.toBe(first)
  })
})

describe('useSimplePost opened from an Ask Total draft', () => {
  const discards = (): unknown[] => invoke.mock.calls.filter((c) => c[0] === 'assist:draft:discard').map((c) => c[1])

  it('leaving without saving discards the draft (once, after the unmount)', async () => {
    invoke.mockResolvedValue({ ok: true, data: null })
    const { unmount } = renderHook(() => useSimplePost({ aiDraftId: 41 }))
    expect(discards()).toEqual([])
    unmount()
    await waitFor(() => expect(discards()).toEqual([{ draftId: 41 }]))
  })

  it('a save consumes it (sent with the first post) — leaving afterwards discards nothing', async () => {
    invoke.mockResolvedValue({ ok: true, data: result([9]) })
    const { result: h, unmount } = renderHook(() => useSimplePost({ aiDraftId: 42 }))
    await act(async () => {
      await h.current.post(intent)
    })
    expect(invoke.mock.calls[0]![1]).toMatchObject({ aiDraftId: 42 })
    unmount()
    await new Promise((r) => setTimeout(r, 10))
    expect(discards()).toEqual([])
  })

  it('a save still running when the screen goes (save → nav.replace) consumes it — no discard', async () => {
    let finish: (v: unknown) => void = () => undefined
    invoke.mockImplementationOnce(() => new Promise((r) => (finish = r))).mockResolvedValue({ ok: true, data: null })
    const { result: h, unmount } = renderHook(() => useSimplePost({ aiDraftId: 45 }))
    let running: Promise<unknown> = Promise.resolve()
    act(() => {
      running = h.current.post(intent)
    })
    unmount()
    await new Promise((r) => setTimeout(r, 10))
    expect(discards()).toEqual([])
    finish({ ok: true, data: result([9]) })
    await running
    await new Promise((r) => setTimeout(r, 10))
    expect(discards()).toEqual([])
  })

  it('a failed save keeps the draft for a retry; leaving then discards it', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: 'Books are locked', code: 'books_locked', field: 'date' }).mockResolvedValue({ ok: true, data: null })
    const { result: h, unmount } = renderHook(() => useSimplePost({ aiDraftId: 43 }))
    await act(async () => {
      await h.current.post(intent).catch(() => undefined)
    })
    unmount()
    await waitFor(() => expect(discards()).toEqual([{ draftId: 43 }]))
  })

  it('React StrictMode’s second mount (dev) does not discard it', async () => {
    invoke.mockResolvedValue({ ok: true, data: null })
    const { unmount } = renderHook(() => useSimplePost({ aiDraftId: 44 }), { wrapper: StrictMode })
    await new Promise((r) => setTimeout(r, 10))
    expect(discards()).toEqual([])
    unmount()
    await waitFor(() => expect(discards()).toEqual([{ draftId: 44 }]))
  })

  it('no draft → nothing to discard', async () => {
    invoke.mockResolvedValue({ ok: true, data: null })
    const { unmount } = renderHook(() => useSimplePost())
    unmount()
    await new Promise((r) => setTimeout(r, 10))
    expect(discards()).toEqual([])
  })
})
