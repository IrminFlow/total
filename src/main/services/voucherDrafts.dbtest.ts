import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import { deleteVoucherDraft, getVoucherDraft, listVoucherDrafts, saveVoucherDraft } from './voucherDrafts'

describe('voucher drafts outside books', () => {
  it('round-trips incomplete raw form state without creating accounting rows', () => {
    const db = seededDb()
    const type = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
    const draft = saveVoucherDraft(db, {
      voucherTypeId: type.id,
      mode: 'accounting',
      title: 'Bank charge awaiting ledger',
      payloadVersion: 1,
      payload: { date: '2026-08-24', rows: [{ drCr: 'dr', ledgerId: null, amount: 12_345 }], narration: 'Awaiting bank advice' }
    }, 'Asha')

    expect(getVoucherDraft(db, draft.id)).toMatchObject({
      mode: 'accounting', title: 'Bank charge awaiting ledger', createdBy: 'Asha',
      payload: { rows: [{ drCr: 'dr', ledgerId: null, amount: 12_345 }] }
    })
    expect((db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM voucher_lines').get() as { n: number }).n).toBe(0)

    const updated = saveVoucherDraft(db, { voucherTypeId: type.id, mode: 'accounting', title: 'Bank charge ready', payloadVersion: 1, payload: { rows: [] } }, 'Asha', draft.id)
    expect(updated.title).toBe('Bank charge ready')
    expect(listVoucherDrafts(db)).toHaveLength(1)
    deleteVoucherDraft(db, draft.id)
    expect(listVoucherDrafts(db)).toEqual([])
  })

  it('rejects missing types, oversized JSON and unknown records', () => {
    const db = seededDb()
    const type = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
    expect(() => saveVoucherDraft(db, { voucherTypeId: 999999, mode: 'accounting', title: 'Bad', payloadVersion: 1, payload: {} }, 'Asha')).toThrow('type was not found')
    expect(() => saveVoucherDraft(db, { voucherTypeId: type.id, mode: 'accounting', title: 'Huge', payloadVersion: 1, payload: { body: 'x'.repeat(270_000) } }, 'Asha')).toThrow('too large')
    expect(() => deleteVoucherDraft(db, 999999)).toThrow('not found')
  })
})
