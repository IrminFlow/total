/**
 * Named voucher templates (#27).
 *
 * The properties that matter are the ones that separate a template from a recurring template:
 * it never posts anything by itself, it does not carry a date or a number, and a shape whose
 * ledgers have since been deleted says so instead of failing somewhere deeper.
 */
import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { listAudit, setAuditContext } from './audit'
import { deleteTemplate, getTemplate, listTemplates, saveTemplate, TEMPLATE_DATE, useTemplate } from './voucherTemplates'
import { voucherInputSchema } from '@shared/schemas'

type Db = ReturnType<typeof seededDb>

function ledgerIn(db: Db, group: string, name: string): { id: number } {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }
  return createLedger(db, { name, groupId: g.id })
}

const journalTypeId = (db: Db): number =>
  (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id

/** A valid shape: rent debited, bank credited. */
function shape(db: Db, opts: { date?: string; number?: string } = {}): string {
  const rent = ledgerIn(db, 'Indirect Expenses', `Rent ${Math.random().toString(36).slice(2, 7)}`)
  const bank = ledgerIn(db, 'Bank Accounts', `Bank ${Math.random().toString(36).slice(2, 7)}`)
  return JSON.stringify({
    voucherTypeId: journalTypeId(db),
    date: opts.date ?? '2026-08-05',
    number: opts.number,
    partyLedgerId: null,
    narration: 'Monthly office rent',
    lines: [
      { ledgerId: rent.id, drCr: 'dr', amount: 45_000_00 },
      { ledgerId: bank.id, drCr: 'cr', amount: 45_000_00 }
    ]
  })
}

describe('voucher templates (#27)', () => {
  it('saves a shape and reads it back with what the picker needs to describe it', () => {
    const db = seededDb()
    const saved = saveTemplate(db, { name: 'Office rent', voucherTypeId: journalTypeId(db), voucherJson: shape(db) })
    expect(saved.name).toBe('Office rent')
    expect(saved.lineCount).toBe(2)
    expect(saved.total).toBe(45_000_00)
    expect(saved.usedCount).toBe(0)
    expect(saved.problem).toBeNull()
    expect(saved.voucherKind).toBe('journal')
  })

  it('drops the number and neutralises the date, which belong to the moment of posting', () => {
    const db = seededDb()
    const saved = saveTemplate(db, {
      name: 'Rent', voucherTypeId: journalTypeId(db), voucherJson: shape(db, { date: '2026-08-05', number: 'JV-7' })
    })
    const stored = JSON.parse(saved.voucherJson) as Record<string, unknown>
    expect(stored.date).toBe(TEMPLATE_DATE)
    expect(stored.number).toBeUndefined()
    // The lines survived intact.
    expect((stored.lines as unknown[]).length).toBe(2)
  })

  it('never hands the placeholder date back — every apply carries a real one', () => {
    const db = seededDb()
    const saved = saveTemplate(db, {
      name: 'Rent', voucherTypeId: journalTypeId(db), voucherJson: shape(db, { date: '2026-08-05' })
    })
    expect(useTemplate(db, saved.id, '2026-09-05').shape.date).toBe('2026-09-05')
    // Defaulted rather than left as the placeholder when the caller says nothing.
    expect(useTemplate(db, saved.id).shape.date).not.toBe(TEMPLATE_DATE)
  })

  it('posts nothing — applying a template only hands back a shape', () => {
    const db = seededDb()
    const saved = saveTemplate(db, { name: 'Rent', voucherTypeId: journalTypeId(db), voucherJson: shape(db) })
    const before = db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }

    const { shape: applied } = useTemplate(db, saved.id)
    expect(applied.lines).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual(before)
  })

  it('counts a use, so the picker can put what is reached for at the top', () => {
    const db = seededDb()
    const rent = saveTemplate(db, { name: 'Rent', voucherTypeId: journalTypeId(db), voucherJson: shape(db) })
    saveTemplate(db, { name: 'Advance to staff', voucherTypeId: journalTypeId(db), voucherJson: shape(db) })

    // Alphabetically 'Advance' wins; by use, rent does.
    expect(listTemplates(db).map((t) => t.name)).toEqual(['Advance to staff', 'Rent'])
    useTemplate(db, rent.id)
    useTemplate(db, rent.id)
    expect(listTemplates(db).map((t) => t.name)).toEqual(['Rent', 'Advance to staff'])
    expect(getTemplate(db, rent.id)!.usedCount).toBe(2)
    expect(getTemplate(db, rent.id)!.lastUsedAt).not.toBeNull()
  })

  it('filters by voucher type, for the picker on one entry screen', () => {
    const db = seededDb()
    const payment = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment'").get() as { id: number }).id
    saveTemplate(db, { name: 'Rent', voucherTypeId: journalTypeId(db), voucherJson: shape(db) })
    const paymentJson = JSON.parse(shape(db)) as Record<string, unknown>
    paymentJson.voucherTypeId = payment
    saveTemplate(db, { name: 'Electricity', voucherTypeId: payment, voucherJson: JSON.stringify(paymentJson) })

    expect(listTemplates(db, journalTypeId(db)).map((t) => t.name)).toEqual(['Rent'])
    expect(listTemplates(db, payment).map((t) => t.name)).toEqual(['Electricity'])
  })

  it('refuses to save a shape that cannot be applied', () => {
    const db = seededDb()
    const type = journalTypeId(db)
    expect(() => saveTemplate(db, { name: 'Broken', voucherTypeId: type, voucherJson: 'not json' }))
      .toThrow(/not valid JSON/)
    expect(() => saveTemplate(db, { name: 'Broken', voucherTypeId: type, voucherJson: '{"lines":[]}' }))
      .toThrow(/invalid saved voucher/)
    // A ledger that never existed.
    const ghost = JSON.parse(shape(db)) as { lines: { ledgerId: number }[] }
    ghost.lines[0]!.ledgerId = 99_999
    expect(() => saveTemplate(db, { name: 'Ghost', voucherTypeId: type, voucherJson: JSON.stringify(ghost) }))
      .toThrow(/no longer exists/)
    expect(() => saveTemplate(db, { name: '  ', voucherTypeId: type, voucherJson: shape(db) }))
      .toThrow(/needs a name/)
  })

  it('refuses two templates with the same name, and allows renaming one to itself', () => {
    const db = seededDb()
    const type = journalTypeId(db)
    const first = saveTemplate(db, { name: 'Rent', voucherTypeId: type, voucherJson: shape(db) })
    expect(() => saveTemplate(db, { name: 'rent', voucherTypeId: type, voucherJson: shape(db) }))
      .toThrow(/already exists/)
    // Re-saving the same template under the same name is an edit, not a clash.
    expect(saveTemplate(db, { name: 'Rent', voucherTypeId: type, voucherJson: shape(db) }, first.id).id).toBe(first.id)
  })

  it('reports a template broken by a later deletion rather than hiding it', () => {
    const db = seededDb()
    const type = journalTypeId(db)
    const json = shape(db)
    const saved = saveTemplate(db, { name: 'Rent', voucherTypeId: type, voucherJson: json })

    const ledgerId = (JSON.parse(saved.voucherJson) as { lines: { ledgerId: number }[] }).lines[0]!.ledgerId
    db.prepare('DELETE FROM ledgers WHERE id = ?').run(ledgerId)

    // It still lists — otherwise the only way to get rid of it would be the database.
    const listed = listTemplates(db).find((t) => t.id === saved.id)!
    expect(listed.problem).toMatch(/no longer exists/)
    // But it cannot be applied.
    expect(() => useTemplate(db, saved.id)).toThrow(/cannot be applied/)
    deleteTemplate(db, saved.id)
    expect(listTemplates(db)).toHaveLength(0)
  })

  it('produces a shape the voucher schema still accepts', () => {
    const db = seededDb()
    const saved = saveTemplate(db, { name: 'Rent', voucherTypeId: journalTypeId(db), voucherJson: shape(db) })
    const { shape: applied } = useTemplate(db, saved.id)
    // Round-trips: what comes out of a template is what saveVoucher takes in.
    expect(() => voucherInputSchema.parse({ ...applied, date: '2026-09-05' })).not.toThrow()
  })

  it('audits create, update and delete', () => {
    setAuditContext({ appVersion: '1.0.0', getUserName: () => 'Tester' })
    const db = seededDb()
    const type = journalTypeId(db)
    const saved = saveTemplate(db, { name: 'Rent', voucherTypeId: type, voucherJson: shape(db) })
    saveTemplate(db, { name: 'Rent (revised)', voucherTypeId: type, voucherJson: shape(db) }, saved.id)
    deleteTemplate(db, saved.id)
    expect(listAudit(db, { entity: 'voucher_template' }).total).toBe(3)
  })

  it('refuses to act on a template that is not there', () => {
    const db = seededDb()
    expect(() => useTemplate(db, 42)).toThrow(/not found/)
    expect(() => deleteTemplate(db, 42)).toThrow(/not found/)
    expect(getTemplate(db, 42)).toBeNull()
    expect(listTemplates(db)).toEqual([])
  })
})
