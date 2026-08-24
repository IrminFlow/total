import type { DB } from '../db/connection'
import { writeAudit } from './audit'

/**
 * Party notes and promised payments — the call log.
 *
 * Chasing money is a conversation, and the app remembered none of it. "He said he'd pay on the
 * 20th" lived in someone's head or a diary, so the next call started from nothing and a promise
 * nobody wrote down is a promise nobody follows up.
 *
 * A promise is a note with a date on it rather than a field on the party. A party can promise
 * more than once; the promises ARE the call log; and the most recent one is not automatically
 * the one that matters — a promise made and broken is exactly what the next call needs to know.
 */

export interface PartyNote {
  id: number
  ledgerId: number
  at: string
  userName: string | null
  note: string
  promisedDate: string | null
  promisedAmount: number | null
  closedAt: string | null
}

export interface PartyNoteInput {
  ledgerId: number
  note: string
  promisedDate?: string | null
  promisedAmount?: number | null
}

const SELECT = `SELECT id, ledger_id AS ledgerId, at, user_name AS userName, note,
                       promised_date AS promisedDate, promised_amount AS promisedAmount,
                       closed_at AS closedAt
                FROM party_notes`

/** Every note against one party, newest first. */
export function listPartyNotes(db: DB, ledgerId: number): PartyNote[] {
  return db.prepare(`${SELECT} WHERE ledger_id = ? ORDER BY at DESC, id DESC`).all(ledgerId) as PartyNote[]
}

export function addPartyNote(db: DB, input: PartyNoteInput, userName: string | null): PartyNote {
  const res = db
    .prepare(
      `INSERT INTO party_notes (ledger_id, user_name, note, promised_date, promised_amount)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.ledgerId,
      userName,
      input.note,
      input.promisedDate ?? null,
      input.promisedAmount ?? null
    )
  const saved = db.prepare(`${SELECT} WHERE id = ?`).get(Number(res.lastInsertRowid)) as PartyNote
  writeAudit(db, 'party_note', saved.id, 'create', null, saved)
  return saved
}

/** Close a promise — kept rather than deleted, because a promise made and broken is history. */
export function closePartyNote(db: DB, id: number): PartyNote {
  const before = db.prepare(`${SELECT} WHERE id = ?`).get(id) as PartyNote | undefined
  if (!before) throw new Error('Note not found')
  db.prepare("UPDATE party_notes SET closed_at = datetime('now') WHERE id = ?").run(id)
  const after = db.prepare(`${SELECT} WHERE id = ?`).get(id) as PartyNote
  writeAudit(db, 'party_note', id, 'update', before, after)
  return after
}

export interface PromiseRow extends PartyNote {
  partyName: string
  /** Days past the promised date; negative while it is still in the future. */
  overdueDays: number
}

/**
 * Open promises, most overdue first — the follow-up list.
 *
 * A broken promise sorts above one still in the future, which is the order a morning's calls
 * actually go in. Promises made for a date still to come are included rather than hidden: knowing
 * that four people have promised this week is the point of writing them down.
 */
export function openPromises(db: DB, today: string): PromiseRow[] {
  const rows = db
    .prepare(
      `${SELECT.replace('FROM party_notes', ', (SELECT name FROM ledgers WHERE id = ledger_id) AS partyName FROM party_notes')}
       WHERE promised_date IS NOT NULL AND closed_at IS NULL
       ORDER BY promised_date`
    )
    .all() as (PartyNote & { partyName: string })[]

  return rows
    .map((r) => ({
      ...r,
      overdueDays: Math.round(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.promisedDate}T00:00:00Z`)) / 86_400_000
      )
    }))
    .sort((a, b) => b.overdueDays - a.overdueDays)
}
