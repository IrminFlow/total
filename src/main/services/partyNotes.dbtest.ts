// WP 6.4 — notes and tasks on parties: add / edit / done / delete (each audited), the list with
// and without done tasks, the dashboard's tasks-due summary, and the cascade with the ledger.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import { createLedger, deleteLedger } from './masters'
import { addPartyNote, deletePartyNote, listPartyNotes, tasksDue, updatePartyNote } from './partyNotes'

function party(db: DB, name: string): number {
  const g = (db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number }).id
  return createLedger(db, { name, groupId: g }).id
}
const audits = (db: DB, action: string): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'party_note' AND action = ?").get(action) as { n: number }).n

describe('party notes and tasks', () => {
  it('adds notes and tasks, marks done, hides done unless asked, audits every write', () => {
    const db = seededDb()
    const alpha = party(db, 'Alpha')
    const beta = party(db, 'Beta')
    const note = addPartyNote(db, { ledgerId: alpha, kind: 'note', text: 'Prefers email statements' })
    const t1 = addPartyNote(db, { ledgerId: alpha, kind: 'task', text: 'Call about March dues', dueDate: '2026-10-05' })
    const t2 = addPartyNote(db, { ledgerId: alpha, kind: 'task', text: 'Collect cheque', dueDate: '2026-10-08' })
    addPartyNote(db, { ledgerId: beta, kind: 'task', text: 'Send KYC form', dueDate: '2026-10-12' })
    addPartyNote(db, { ledgerId: beta, kind: 'task', text: 'Someday', dueDate: '2026-12-01' })
    expect(note).toMatchObject({ ledgerName: 'Alpha', kind: 'note', dueDate: null, doneAt: null })
    expect(audits(db, 'create')).toBe(5)

    expect(listPartyNotes(db, { ledgerId: alpha }).map((n) => n.text)).toEqual(['Call about March dues', 'Collect cheque', 'Prefers email statements'])
    expect(tasksDue(db, '2026-10-08')).toEqual({ overdue: 1, today: 1, week: 1, total: 3 })

    const done = updatePartyNote(db, { id: t1.id, done: true })
    expect(done.doneAt).not.toBeNull()
    expect(listPartyNotes(db, { ledgerId: alpha, kind: 'task' }).map((n) => n.id)).toEqual([t2.id])
    expect(listPartyNotes(db, { ledgerId: alpha, kind: 'task', includeDone: true }).map((n) => n.id)).toEqual([t2.id, t1.id])
    expect(tasksDue(db, '2026-10-08').overdue).toBe(0)
    expect(updatePartyNote(db, { id: t1.id, done: false }).doneAt).toBeNull()
    expect(updatePartyNote(db, { id: t2.id, text: 'Collect the cheque', dueDate: null })).toMatchObject({ text: 'Collect the cheque', dueDate: null })
    expect(audits(db, 'update')).toBe(3)

    expect(() => updatePartyNote(db, { id: note.id, done: true })).toThrow(/Only a task/)
    expect(() => addPartyNote(db, { ledgerId: alpha, kind: 'note', text: 'x', dueDate: '2026-10-01' })).toThrow(/Only a task has a due date/)
    expect(() => addPartyNote(db, { ledgerId: alpha, kind: 'note', text: '   ' })).toThrow()

    deletePartyNote(db, note.id)
    expect(audits(db, 'delete')).toBe(1)
    const before = (db.prepare('SELECT before_json FROM audit_log WHERE entity = ? AND action = ?').get('party_note', 'delete') as { before_json: string }).before_json
    expect(JSON.parse(before)).toMatchObject({ text: 'Prefers email statements' })
  })

  it('a deleted ledger takes its notes with it, and the ledger audit row says so', () => {
    const db = seededDb()
    const gamma = party(db, 'Gamma')
    addPartyNote(db, { ledgerId: gamma, kind: 'task', text: 'Follow up', dueDate: '2026-10-01' })
    deleteLedger(db, gamma)
    expect(listPartyNotes(db, { includeDone: true })).toEqual([])
    const row = db.prepare("SELECT before_json FROM audit_log WHERE entity = 'ledger' AND action = 'delete'").get() as { before_json: string }
    expect(JSON.parse(row.before_json).cascaded).toEqual({ party_notes: 1 })
  })
})
