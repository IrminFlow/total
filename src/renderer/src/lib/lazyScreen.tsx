import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { useChunkLoading } from './chunkLoading'

/**
 * A screen (or dialog) whose code is a separate chunk, loaded on first use.
 *
 * Why not React.lazy + Suspense: React throttles revealing Suspense content (it waits until
 * 300 ms after a fallback was shown), so every first visit to a screen would wait up to 0.3 s
 * for nothing; and a lazy component suspends even when its chunk is already loaded. This wrapper
 * renders the screen synchronously once its module is in (prefetched or visited before), and
 * otherwise shows nothing for the few milliseconds the chunk takes from disk — while it does,
 * `<main data-loading>` says "true" (chunkLoading.ts). The count drops in a passive effect AFTER
 * the screen's own effects have run, so its first queries are already fetching by then.
 * A chunk that fails to load is thrown to the screen's ErrorBoundary.
 */
export interface LazyComponent<P> {
  (props: P): React.JSX.Element | null
  /** Starts loading the chunk (idempotent); resolves once it is in. */
  preload: () => Promise<unknown>
  displayName?: string
}

type Props<C> = C extends ComponentType<infer P> ? P : never

export function lazyScreen<M, K extends keyof M>(load: () => Promise<M>, name: K): LazyComponent<Props<M[K]>> {
  let mod: M | undefined
  let promise: Promise<M> | undefined
  const preload = (): Promise<M> =>
    (promise ??= load().then(
      (m) => (mod = m),
      (e: unknown) => {
        promise = undefined
        throw e
      }
    ))

  function Lazy(props: Props<M[K]>): React.JSX.Element | null {
    const [loaded, setLoaded] = useState<M | undefined>(() => mod)
    const [error, setError] = useState<unknown>(null)
    const pending = useRef(false)

    useLayoutEffect(() => {
      if (mod) {
        if (!loaded) setLoaded(mod)
        return
      }
      let live = true
      pending.current = true
      useChunkLoading.getState().inc()
      preload().then(
        (m) => live && setLoaded(m),
        (e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e)))
      )
      return () => {
        live = false
        if (pending.current) {
          pending.current = false
          useChunkLoading.getState().dec()
        }
      }
    }, [])

    // Runs after the screen's own effects (children first): its queries have started.
    useEffect(() => {
      if (loaded && pending.current) {
        pending.current = false
        useChunkLoading.getState().dec()
      }
    }, [loaded])

    if (error) throw error
    if (!loaded) return null
    const C = loaded[name] as unknown as ComponentType<Props<M[K]>>
    return <C {...(props as Props<M[K]> & React.JSX.IntrinsicAttributes)} />
  }
  Lazy.preload = preload
  Lazy.displayName = `Lazy(${String(name)})`
  return Lazy
}

/** Loads chunks one per idle slot (so prefetching never holds up typing or a click). */
export function prefetchWhenIdle(preloads: readonly (() => Promise<unknown>)[]): () => void {
  const queue = [...new Set(preloads)]
  let cancelled = false
  let handle: number | undefined
  const idle =
    typeof window.requestIdleCallback === 'function'
      ? (cb: () => void) => window.requestIdleCallback(cb, { timeout: 2000 })
      : (cb: () => void) => window.setTimeout(cb, 50)
  const cancelIdle =
    typeof window.cancelIdleCallback === 'function' ? (h: number) => window.cancelIdleCallback(h) : (h: number) => window.clearTimeout(h)
  const next = (): void => {
    if (cancelled) return
    const p = queue.shift()
    if (!p) return
    handle = idle(() => {
      handle = undefined
      if (cancelled) return
      // A chunk that fails here is retried (and reported) when the screen is opened.
      p().catch(() => {}).finally(next)
    })
  }
  next()
  return () => {
    cancelled = true
    if (handle !== undefined) cancelIdle(handle)
  }
}
