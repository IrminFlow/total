/**
 * The entry somebody was halfway through when the app died (roadmap #250).
 *
 * A voucher being typed lives in this renderer's memory until it is saved. A crash, a forced
 * quit, a renderer that dies of a GPU fault (index.ts already handles that by reloading the
 * window) all discard it silently — and a purchase invoice with thirty lines is twenty minutes of
 * somebody's evening.
 *
 * Autosaved on a debounce rather than on every keystroke: the draft is one row in SQLite, and
 * writing it on each character would put a database write in the path of typing an amount.
 */
import { useEffect, useRef } from 'react'
import { api } from './client'
import type { VoucherDraft } from '../state/stores'

/** Long enough that typing never waits on it, short enough that a crash costs one sentence. */
const DEBOUNCE_MS = 1500

/** True when there is anything worth recovering — an untouched form must not offer a draft. */
export function draftWorthKeeping(draft: VoucherDraft): boolean {
  const lines = draft.lines ?? []
  return lines.some((line) => line.ledgerId > 0 && line.amount > 0) || (draft.narration ?? '').trim().length > 0
}

/**
 * Keep `draft` on disk while the entry screen is open. `enabled` is false while altering an
 * existing voucher: that one is already in the books, and recovering it later would offer to
 * re-enter something that exists.
 */
export function useCrashDraft(enabled: boolean, draft: VoucherDraft): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Whether anything of ours is currently on disk, so an empty form does not issue a DELETE every
  // second and a half while somebody tabs around it.
  const written = useRef(false)
  const serialised = JSON.stringify(draft)

  useEffect(() => {
    if (!enabled) return
    const parsed = JSON.parse(serialised) as VoucherDraft
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      // Failure here is silent on purpose: a draft that could not be written must never put an
      // error toast over the form the user is typing into.
      if (draftWorthKeeping(parsed)) {
        written.current = true
        void api.drafts.save(parsed).catch(() => undefined)
      } else if (written.current) {
        // Emptied out again — the entry was abandoned, and an abandoned draft offered back
        // tomorrow is a prompt to re-type something nobody wanted.
        written.current = false
        void api.drafts.clear().catch(() => undefined)
      }
    }, DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [enabled, serialised])
}

/** Forget the draft — called the moment the voucher is actually in the books. */
export function clearCrashDraft(): void {
  void api.drafts.clear().catch(() => undefined)
}
