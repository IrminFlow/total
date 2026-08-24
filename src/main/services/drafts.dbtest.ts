import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { clearDraft, getDraft, saveDraft, DRAFT_MAX_AGE_DAYS } from './drafts'

const entry = { voucherTypeId: 3, date: '2026-04-01', lines: [{ ledgerId: 1, drCr: 'dr', amount: 125000 }] }

describe('the entry that was half typed', () => {
  it('comes back after the app has died and restarted', () => {
    const db = seededDb()
    saveDraft(db, 'Asha', entry, '0.4.0')
    // A crash is just a new process reading the same file.
    const recovered = getDraft(db, 'Asha')
    expect(recovered!.payload).toEqual(entry)
    expect(recovered!.appVersion).toBe('0.4.0')
  })

  it('keeps one draft per person, so two typists do not overwrite each other', () => {
    const db = seededDb()
    saveDraft(db, 'Asha', { note: 'hers' }, '0.4.0')
    saveDraft(db, 'Ravi', { note: 'his' }, '0.4.0')
    expect(getDraft(db, 'Asha')!.payload).toEqual({ note: 'hers' })
    expect(getDraft(db, 'Ravi')!.payload).toEqual({ note: 'his' })
  })

  it('replaces the draft as typing goes on rather than piling them up', () => {
    const db = seededDb()
    saveDraft(db, null, { lines: 1 }, '0.4.0')
    saveDraft(db, null, { lines: 2 }, '0.4.0')
    saveDraft(db, null, { lines: 3 }, '0.4.0')
    expect(getDraft(db, null)!.payload).toEqual({ lines: 3 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM voucher_drafts').get() as { n: number }).n).toBe(1)
  })

  it('is gone once the voucher is actually saved', () => {
    const db = seededDb()
    saveDraft(db, 'Asha', entry, '0.4.0')
    clearDraft(db, 'Asha')
    expect(getDraft(db, 'Asha')).toBeNull()
  })

  it('does not ambush anyone with a fortnight-old draft', () => {
    const db = seededDb()
    saveDraft(db, 'Asha', entry, '0.4.0')
    db.prepare("UPDATE voucher_drafts SET saved_at = datetime('now', ?)").run(`-${DRAFT_MAX_AGE_DAYS + 1} days`)
    expect(getDraft(db, 'Asha')).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM voucher_drafts').get() as { n: number }).n).toBe(0)
  })

  it('hands back a draft written by an older version rather than refusing it', () => {
    const db = seededDb()
    // Main never parses the payload, so a shape this build has never seen still comes back.
    saveDraft(db, 'Asha', { somethingFromTheFuture: true, lines: [] }, '0.9.9')
    expect(getDraft(db, 'Asha')!.payload).toEqual({ somethingFromTheFuture: true, lines: [] })
  })

  it('drops a draft nobody can parse instead of failing the screen', () => {
    const db = seededDb()
    saveDraft(db, 'Asha', entry, '0.4.0')
    db.prepare("UPDATE voucher_drafts SET payload_json = '{not json'").run()
    expect(getDraft(db, 'Asha')).toBeNull()
  })
})
