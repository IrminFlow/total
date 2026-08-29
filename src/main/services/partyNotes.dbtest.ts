import { describe, it, expect } from 'vitest'
import { addPartyNote, closePartyNote, listPartyNotes, openPromises } from './partyNotes'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'

/**
 * The call log.
 *
 * Chasing money is a conversation, and a promise nobody wrote down is a promise nobody follows
 * up. What matters here: nothing is overwritten (a party can promise more than once), nothing is
 * deleted (a broken promise is what the next call needs to know), and the follow-up list is
 * ordered by who to call first rather than by when they promised.
 */
function books() {
  const db = seededDb()
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const party = (name: string): number => createLedger(db, { name, groupId: groupId('Sundry Debtors') }).id
  return { db, party }
}

describe('party notes', () => {
  it('records what was said, and who said it', () => {
    const b = books()
    const p = b.party('Krishna Enterprises')
    const note = addPartyNote(b.db, { ledgerId: p, note: 'Spoke to Ramesh' }, 'Priya')
    expect(note.note).toBe('Spoke to Ramesh')
    expect(note.userName).toBe('Priya')
    expect(note.promisedDate).toBeNull()
    expect(listPartyNotes(b.db, p)).toHaveLength(1)
  })

  it('keeps every note rather than replacing the last', () => {
    // A party can promise more than once, and a promise made and broken is exactly what the next
    // call needs to know.
    const b = books()
    const p = b.party('Krishna Enterprises')
    addPartyNote(b.db, { ledgerId: p, note: 'First call', promisedDate: '2026-05-20' }, null)
    addPartyNote(b.db, { ledgerId: p, note: 'Did not pay', promisedDate: '2026-06-10' }, null)
    expect(listPartyNotes(b.db, p)).toHaveLength(2)
    expect(openPromises(b.db, '2026-06-15')).toHaveLength(2)
  })

  it('keeps one party’s notes out of another’s', () => {
    const b = books()
    const a = b.party('A')
    const c = b.party('C')
    addPartyNote(b.db, { ledgerId: a, note: 'For A' }, null)
    expect(listPartyNotes(b.db, c)).toEqual([])
  })

  it('lists open promises most overdue first', () => {
    // The order a morning's calls actually go in: a broken promise before one still to come.
    const b = books()
    const soon = b.party('Promised Soon')
    const late = b.party('Promised Long Ago')
    const future = b.party('Promised Next Week')
    addPartyNote(b.db, { ledgerId: soon, note: 'x', promisedDate: '2026-06-10' }, null)
    addPartyNote(b.db, { ledgerId: late, note: 'x', promisedDate: '2026-01-10' }, null)
    addPartyNote(b.db, { ledgerId: future, note: 'x', promisedDate: '2026-06-30' }, null)

    const promises = openPromises(b.db, '2026-06-15')
    expect(promises.map((p) => p.partyName)).toEqual([
      'Promised Long Ago',
      'Promised Soon',
      'Promised Next Week'
    ])
    expect(promises[0]!.overdueDays).toBeGreaterThan(0)
    // A promise still to come has a negative "overdue", which is what keeps it last.
    expect(promises[2]!.overdueDays).toBeLessThan(0)
  })

  it('includes promises still to come rather than hiding them', () => {
    // Knowing four people have promised this week is the point of writing them down.
    const b = books()
    addPartyNote(b.db, { ledgerId: b.party('Future'), note: 'x', promisedDate: '2026-12-31' }, null)
    expect(openPromises(b.db, '2026-06-15')).toHaveLength(1)
  })

  it('leaves ordinary notes out of the follow-up list', () => {
    const b = books()
    addPartyNote(b.db, { ledgerId: b.party('Chatty'), note: 'Just a note' }, null)
    expect(openPromises(b.db, '2026-06-15')).toEqual([])
  })

  it('closes a promise without deleting it', () => {
    const b = books()
    const p = b.party('Paid Up')
    const note = addPartyNote(b.db, { ledgerId: p, note: 'x', promisedDate: '2026-06-10' }, null)
    closePartyNote(b.db, note.id)

    expect(openPromises(b.db, '2026-06-15')).toEqual([])
    // Still in the party's history, which is the whole point of a call log.
    const kept = listPartyNotes(b.db, p)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.closedAt).toBeTruthy()
  })

  it('carries the promised amount when one was named, and null when it was not', () => {
    const b = books()
    const p = b.party('Specific')
    addPartyNote(b.db, { ledgerId: p, note: 'Half now', promisedDate: '2026-06-10', promisedAmount: 500000 }, null)
    addPartyNote(b.db, { ledgerId: p, note: 'The rest', promisedDate: '2026-07-10' }, null)
    const promises = openPromises(b.db, '2026-06-15')
    expect(promises.find((x) => x.note === 'Half now')!.promisedAmount).toBe(500000)
    expect(promises.find((x) => x.note === 'The rest')!.promisedAmount).toBeNull()
  })

  it('removes a deleted party’s notes with it', () => {
    // ON DELETE CASCADE: notes about a ledger that no longer exists would be unreachable rows.
    const b = books()
    const p = b.party('Gone')
    addPartyNote(b.db, { ledgerId: p, note: 'x' }, null)
    b.db.prepare('DELETE FROM ledgers WHERE id = ?').run(p)
    expect((b.db.prepare('SELECT COUNT(*) AS n FROM party_notes').get() as { n: number }).n).toBe(0)
  })
})
