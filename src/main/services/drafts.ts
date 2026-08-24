/**
 * The entry somebody was halfway through when the power went (roadmap #250).
 *
 * A voucher being typed lives in renderer memory until it is saved. A crash, a forced quit, a
 * renderer that dies of a GPU fault (which index.ts already handles by reloading the window) —
 * all of them discard it silently, and a long purchase invoice with thirty stock lines is twenty
 * minutes of somebody's evening.
 *
 * The draft is stored as opaque JSON that only the entry screen understands. Main never parses
 * it, which is what makes this safe across versions: if the entry form changes shape, an old
 * draft is still handed back and the screen decides what it can use, rather than main refusing to
 * return something it can no longer validate.
 *
 * One draft per person, replaced as they type (debounced by the caller). Cleared the moment the
 * voucher is saved or the form is abandoned — a draft that outlives its entry is a prompt to
 * re-enter something already in the books, which is worse than losing it.
 */
import type { DB } from '../db/connection'

/** Signed-out / no-accounts case shares one slot; the company has one typist by definition then. */
const ANONYMOUS = ''

export interface StoredDraft {
  owner: string
  savedAt: string
  appVersion: string | null
  /** Whatever the entry screen put there. Parsed by the renderer, never by main. */
  payload: unknown
}

/** How stale a draft can be before it is offered as "recovered" rather than silently dropped. */
export const DRAFT_MAX_AGE_DAYS = 14

export function saveDraft(db: DB, owner: string | null, payload: unknown, appVersion: string | null): void {
  db.prepare(
    `INSERT INTO voucher_drafts (owner, saved_at, app_version, payload_json)
     VALUES (?, datetime('now'), ?, ?)
     ON CONFLICT(owner) DO UPDATE SET saved_at = excluded.saved_at,
                                      app_version = excluded.app_version,
                                      payload_json = excluded.payload_json`
  ).run(owner ?? ANONYMOUS, appVersion, JSON.stringify(payload))
}

/** The draft waiting for this person, or null. Anything older than DRAFT_MAX_AGE_DAYS is dropped. */
export function getDraft(db: DB, owner: string | null): StoredDraft | null {
  const row = db
    .prepare('SELECT owner, saved_at AS savedAt, app_version AS appVersion, payload_json AS payloadJson FROM voucher_drafts WHERE owner = ?')
    .get(owner ?? ANONYMOUS) as { owner: string; savedAt: string; appVersion: string | null; payloadJson: string } | undefined
  if (!row) return null

  const age = Date.now() - Date.parse(`${row.savedAt.replace(' ', 'T')}Z`)
  if (Number.isFinite(age) && age > DRAFT_MAX_AGE_DAYS * 86_400_000) {
    // A fortnight-old draft is not a recovery, it is an ambush: whatever it was has almost
    // certainly been entered by hand since.
    clearDraft(db, owner)
    return null
  }

  try {
    return { owner: row.owner, savedAt: row.savedAt, appVersion: row.appVersion, payload: JSON.parse(row.payloadJson) }
  } catch {
    // Unreadable JSON is a draft nobody can use; drop it rather than failing the screen that
    // asked for it.
    clearDraft(db, owner)
    return null
  }
}

export function clearDraft(db: DB, owner: string | null): void {
  db.prepare('DELETE FROM voucher_drafts WHERE owner = ?').run(owner ?? ANONYMOUS)
}
