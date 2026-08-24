import { useEffect, useRef, useState } from 'react'

/**
 * The half-typed voucher, kept across a crash.
 *
 * Voucher entry is the one screen where losing what is on it costs real work: a twenty-line
 * journal is ten minutes of typing, and until now a power cut, a crash or an accidental ⌘Q threw
 * all of it away. The unsaved-changes guard only covers navigation the app itself performs; it
 * cannot cover the process ending.
 *
 * localStorage, not the database, and the reasons are all about what a draft IS:
 *  - It is not a book fact. A half-entered voucher has no number, does not balance, and must
 *    never appear in a report, an audit trail or a backup — putting it in the company file would
 *    mean every query in the app growing a clause to exclude it.
 *  - It is machine-local by nature. The draft belongs to the screen the operator walked away
 *    from, not to the books, which are the same books on any machine.
 *  - Chromium flushes localStorage to disk continuously, so it survives exactly the failures
 *    this is for.
 *
 * Scoped by company slug: opening a different company must never offer someone else's draft
 * back, and the slug is what makes two companies two sets of books.
 */

/** How long an abandoned draft stays worth offering back. A week covers "I was interrupted on
 *  Friday"; beyond that the offer is archaeology, and restoring it silently re-dates old work. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Quiet period after the last keystroke before the draft is written. Long enough that typing a
 *  narration is not a hundred serialisations, short enough that a crash loses at most a word. */
const DEBOUNCE_MS = 600

interface StoredDraft<T> {
  savedAt: number
  state: T
}

export function draftKey(slug: string, kind: string): string {
  return `total-voucher-draft:${slug}:${kind}`
}

export function saveDraft<T>(slug: string, kind: string, state: T, now = Date.now()): void {
  try {
    localStorage.setItem(draftKey(slug, kind), JSON.stringify({ savedAt: now, state } satisfies StoredDraft<T>))
  } catch {
    // A full or disabled localStorage must never break data entry. Losing the safety net is bad;
    // throwing out of a keystroke handler and blanking the screen is worse.
  }
}

export function clearDraft(slug: string, kind: string): void {
  try {
    localStorage.removeItem(draftKey(slug, kind))
  } catch {
    /* see saveDraft */
  }
}

/** The stored draft, or null when there is none, it is unreadable, or it is too old to offer. */
export function loadDraft<T>(slug: string, kind: string, now = Date.now()): { state: T; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(draftKey(slug, kind))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredDraft<T>
    if (typeof parsed?.savedAt !== 'number' || parsed.state == null) return null
    if (now - parsed.savedAt > MAX_AGE_MS) {
      clearDraft(slug, kind)
      return null
    }
    return { state: parsed.state, savedAt: parsed.savedAt }
  } catch {
    // A draft written by an older version of the form shape is not worth crashing over, and not
    // worth offering either — the fields would not line up.
    clearDraft(slug, kind)
    return null
  }
}

/** "2 minutes ago" / "yesterday" — enough to decide whether the draft is the one you remember. */
export function describeAge(savedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - savedAt) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/**
 * Autosave `state`, and offer back whatever was there when the screen opened.
 *
 * The offer is read ONCE, synchronously on the first render, before autosaving starts. Reading it
 * later would hand back the draft this very screen has just written, and the banner would appear
 * on every voucher forever.
 *
 * Restoring is the caller's job — only the screen knows how to put the state back into its own
 * fields — so this returns the state and gets out of the way.
 */
export function useVoucherDraft<T>(
  slug: string | null,
  kind: string,
  state: T,
  /**
   * A serialisation of `state`, used as the effect's dependency.
   *
   * `state` itself is a fresh object on every render, so depending on it would reset the debounce
   * timer on every render and the draft would never actually be written. The caller already has
   * to build the object; stringifying it once is the cheapest stable identity there is.
   */
  signature: string,
  opts: { enabled: boolean; isEmpty: boolean }
): {
  /** The draft found on open, until it is restored or dismissed. */
  offered: { state: T; savedAt: number } | null
  dismiss: () => void
  /** Forget the draft — called after a successful save, and when the form is abandoned. */
  clear: () => void
} {
  const { enabled, isEmpty } = opts
  // Read before the first autosave can possibly run. useState's initialiser is the only place
  // that is true, and it must not re-run on later renders.
  const [offered, setOffered] = useState(() => (enabled && slug ? loadDraft<T>(slug, kind) : null))
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    if (!enabled || !slug) return
    // An empty form CLEARS the draft rather than writing an empty one: emptying the fields is
    // how a person abandons an entry, and leaving the old draft behind would offer it back on
    // the next voucher of the same kind.
    if (isEmpty) {
      clearDraft(slug, kind)
      return
    }
    const timer = setTimeout(() => saveDraft(slug, kind, stateRef.current), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, slug, kind, isEmpty, signature])

  return {
    offered,
    dismiss: () => setOffered(null),
    clear: () => {
      setOffered(null)
      if (slug) clearDraft(slug, kind)
    }
  }
}
