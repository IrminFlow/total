/**
 * WP 6.4 — notes and tasks on parties (party_notes, migration 036). Party-level only: a note on
 * one bill is a bill follow-up (bill_followups, services/receivables.ts). Every write is audited
 * as 'party_note' with the whole before / after row.
 */
import type { DB } from '../db/connection'
import {
  partyNoteInputSchema, partyNoteUpdateSchema, partyNotesQuerySchema, summariseTasks,
  type PartyNote, type PartyNoteInput, type PartyNotesQuery, type TasksDueSummary
} from '@shared/partyNotes'
import { currentAuditUserName, writeAudit } from './audit'

const SQL = `SELECT n.id, n.ledger_id AS ledgerId, l.name AS ledgerName, n.kind, n.text, n.due_date AS dueDate,
  n.done_at AS doneAt, n.created_by AS createdBy, n.created_at AS createdAt
  FROM party_notes n JOIN ledgers l ON l.id = n.ledger_id`

function getNote(db: DB, id: number): PartyNote {
  const r = db.prepare(`${SQL} WHERE n.id = ?`).get(id) as PartyNote | undefined
  if (!r) throw new Error('Note not found')
  return r
}

export function listPartyNotes(db: DB, raw: PartyNotesQuery = {}): PartyNote[] {
  const q = partyNotesQuerySchema.parse(raw)
  const where: string[] = []
  const args: unknown[] = []
  if (q.ledgerId) {
    where.push('n.ledger_id = ?')
    args.push(q.ledgerId)
  }
  if (q.kind) {
    where.push('n.kind = ?')
    args.push(q.kind)
  }
  if (!q.includeDone) where.push('n.done_at IS NULL')
  // Open tasks by due date (undated last), then notes newest first.
  return db
    .prepare(
      `${SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY n.kind = 'note', n.done_at IS NOT NULL, n.due_date IS NULL, n.due_date, n.created_at DESC, n.id DESC`
    )
    .all(...args) as PartyNote[]
}

export function addPartyNote(db: DB, raw: PartyNoteInput): PartyNote {
  const n = partyNoteInputSchema.parse(raw)
  if (!db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(n.ledgerId)) throw new Error('Ledger not found')
  const id = Number(
    db
      .prepare('INSERT INTO party_notes (ledger_id, kind, text, due_date, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(n.ledgerId, n.kind, n.text, n.kind === 'task' ? n.dueDate : null, currentAuditUserName()).lastInsertRowid
  )
  const created = getNote(db, id)
  writeAudit(db, 'party_note', id, 'create', null, created)
  return created
}

export function updatePartyNote(db: DB, raw: unknown): PartyNote {
  const u = partyNoteUpdateSchema.parse(raw)
  const before = getNote(db, u.id)
  if (before.kind === 'note' && (u.dueDate !== undefined || u.done !== undefined)) throw new Error('Only a task has a due date or can be marked done')
  const text = u.text ?? before.text
  const dueDate = u.dueDate === undefined ? before.dueDate : u.dueDate
  const doneAt = u.done === undefined ? before.doneAt : u.done ? (before.doneAt ?? new Date().toISOString().slice(0, 19).replace('T', ' ')) : null
  db.prepare('UPDATE party_notes SET text = ?, due_date = ?, done_at = ? WHERE id = ?').run(text, dueDate, doneAt, u.id)
  const after = getNote(db, u.id)
  writeAudit(db, 'party_note', u.id, 'update', before, after)
  return after
}

export function deletePartyNote(db: DB, id: number): void {
  const before = getNote(db, id)
  db.prepare('DELETE FROM party_notes WHERE id = ?').run(id)
  writeAudit(db, 'party_note', id, 'delete', before, null)
}

/** The dashboard compliance card's "Tasks due" chip — open party tasks overdue / due today /
 *  due this week. A separate function (and channel) so the dashboard series stays untouched. */
export function tasksDue(db: DB, today: string): TasksDueSummary & { total: number } {
  const open = db.prepare("SELECT kind, due_date AS dueDate, done_at AS doneAt FROM party_notes WHERE kind = 'task' AND done_at IS NULL AND due_date IS NOT NULL").all() as Pick<PartyNote, 'kind' | 'dueDate' | 'doneAt'>[]
  const s = summariseTasks(open, today)
  return { ...s, total: s.overdue + s.today + s.week }
}
