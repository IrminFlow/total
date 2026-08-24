import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { deleteEntryTemplate, instantiateEntryTemplate, listEntryTemplates, saveEntryTemplate } from './entryTemplates'
import { getVoucherDraft } from './voucherDrafts'

describe('one-off voucher entry templates', () => {
  it('creates a reusable pattern that instantiates as an editable outside-books draft', () => {
    const db = seededDb()
    const type = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
    const template = saveEntryTemplate(db, { name: 'Monthly Rent', voucherTypeId: type.id, mode: 'accounting', title: 'ignored', payloadVersion: 1, payload: { rows: [{ ledgerId: 10, drCr: 'dr', amount: 250_000 }] } }, 'Asha')
    const draft = instantiateEntryTemplate(db, template.id, 'Kabir')
    expect(draft).toMatchObject({ title: 'Monthly Rent', mode: 'accounting', createdBy: 'Kabir', payload: template.payload })
    expect(getVoucherDraft(db, draft.id)).not.toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(0)
    expect(() => saveEntryTemplate(db, { name: 'monthly rent', voucherTypeId: type.id, mode: 'accounting', title: 'ignored', payloadVersion: 1, payload: {} }, 'Asha')).toThrow('already exists')
    deleteEntryTemplate(db, template.id)
    expect(listEntryTemplates(db)).toEqual([])
    expect(getVoucherDraft(db, draft.id)).not.toBeNull()
  })
})
