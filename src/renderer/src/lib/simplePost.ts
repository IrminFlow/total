// useSimplePost (WP 9.1): the thin renderer side of `simple:preview` / `simple:post` — the ONE way a
// simple screen writes the books (services/simplePost.ts maps the intent to the editors' own form
// state and saves through saveVoucher in one transaction). No UI here; Phase 9 screens build on it.
//
// - One clientId per intent being filled in: a retry after a failure (or a double click) re-sends
//   the SAME id, so the server returns the vouchers it saved instead of posting twice. A successful
//   post (or reset()) starts a new id for the next intent.
// - While a post is in flight, post() returns that same promise (never a second request).
// - The working date goes with every call, so typed dates ("yesterday") read the way the screen
//   shows them.
// - Errors are IpcErrors carrying code / field / params (WP 8.5): feed them to useFormErrors.
import { useCallback, useRef, useState } from 'react'
import type { SimpleIntentInput, SimplePostResult, SimplePreview } from '@shared/simple/intents'
import { api, IpcError } from './client'
import { useSession } from '../state/stores'

type WithoutClientId<T> = T extends unknown ? Omit<T, 'clientId'> : never
/** An intent as a screen builds it — the hook adds the clientId. */
export type IntentDraft = WithoutClientId<SimpleIntentInput>

export type SimplePostStatus = 'idle' | 'previewing' | 'posting' | 'saved' | 'error'

export interface SimplePostState {
  status: SimplePostStatus
  lastPreview: SimplePreview | null
  result: SimplePostResult | null
  error: IpcError | null
}

const IDLE: SimplePostState = { status: 'idle', lastPreview: null, result: null, error: null }

export function newClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const asIpcError = (err: unknown): IpcError => (err instanceof IpcError ? err : new IpcError({ error: err instanceof Error ? err.message : String(err) }))

export function useSimplePost(): SimplePostState & {
  clientId: string
  preview: (intent: IntentDraft) => Promise<SimplePreview>
  post: (intent: IntentDraft) => Promise<SimplePostResult>
  reset: () => void
} {
  const today = useSession((s) => s.workingDate)
  const clientId = useRef<string>(newClientId())
  const inFlight = useRef<Promise<SimplePostResult> | null>(null)
  const [state, setState] = useState<SimplePostState>(IDLE)

  const preview = useCallback(
    async (intent: IntentDraft): Promise<SimplePreview> => {
      setState((s) => ({ ...s, status: 'previewing', error: null }))
      try {
        const p = await api.simple.preview({ ...intent, clientId: clientId.current } as SimpleIntentInput, today)
        setState((s) => ({ ...s, status: 'idle', lastPreview: p }))
        return p
      } catch (err) {
        const e = asIpcError(err)
        setState((s) => ({ ...s, status: 'error', lastPreview: null, error: e }))
        throw e
      }
    },
    [today]
  )

  const post = useCallback(
    (intent: IntentDraft): Promise<SimplePostResult> => {
      if (inFlight.current) return inFlight.current
      setState((s) => ({ ...s, status: 'posting', error: null }))
      const run = (async () => {
        try {
          const r = await api.simple.post({ ...intent, clientId: clientId.current } as SimpleIntentInput, today)
          // Saved: the next intent gets its own id.
          clientId.current = newClientId()
          setState({ status: 'saved', lastPreview: null, result: r, error: null })
          return r
        } catch (err) {
          // Not saved (the whole intent rolled back): keep the id, so a retry can never double-post.
          const e = asIpcError(err)
          setState((s) => ({ ...s, status: 'error', error: e }))
          throw e
        } finally {
          inFlight.current = null
        }
      })()
      inFlight.current = run
      return run
    },
    [today]
  )

  // A post still running is never forgotten: a second post() after reset() gets that same
  // request (it may have saved) — the next intent's id is used once it has settled.
  const reset = useCallback(() => {
    if (!inFlight.current) clientId.current = newClientId()
    setState((s) => (inFlight.current ? s : { ...IDLE }))
  }, [])

  return { ...state, clientId: clientId.current, preview, post, reset }
}
