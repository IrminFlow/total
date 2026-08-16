import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { createLedger } from './masters'
import { setLockDate } from './vouchers'
import { listTemplates, saveTemplate, due, postFromTemplate, skip } from './recurring'
import type { VoucherInputParsed } from '@shared/schemas'

function expenseLedger(db: ReturnType<typeof seededDb>, name: string) {
  const group = db.prepare("SELECT id FROM groups WHERE name = 'Direct Expenses'").get() as { id: number }
  return createLedger(db, {
    name, groupId: group.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
    taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  })
}

/** Serializes a valid two-line voucher of `voucherTypeId` — the exact VoucherInputParsed JSON
 *  shape a recurring template stores (number left unset: an auto-numbered voucher type fills
 *  it in at post time). */
function voucherJsonFor(
  voucherTypeId: number,
  date: string,
  lines: VoucherInputParsed['lines']
): string {
  const input: VoucherInputParsed = {
    voucherTypeId, date, number: undefined, partyLedgerId: null, narration: 'Recurring rent',
    reference: null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null,
    transportDistanceKm: null, currencyCode: null, exchangeRate: null, lines, inventory: [], billRefs: [], tds: null
  }
  return JSON.stringify(input)
}

function journalVoucherJson(db: ReturnType<typeof seededDb>, date: string, lines: VoucherInputParsed['lines']): string {
  const vt = db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }
  return voucherJsonFor(vt.id, date, lines)
}

/** Rent journal voucher_json between the seeded Cash ledger and a freshly-created expense ledger. */
function rentVoucherJson(db: ReturnType<typeof seededDb>, date: string): string {
  const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
  const rent = expenseLedger(db, 'Rent')
  return journalVoucherJson(db, date, [
    { ledgerId: rent.id, drCr: 'dr', amount: 10000, costAllocations: [] },
    { ledgerId: cash.id, drCr: 'cr', amount: 10000, costAllocations: [] }
  ])
}

describe('recurring vouchers', () => {
  it('save+list round-trip, including the joined voucher kind', () => {
    const db = seededDb()
    const voucherJson = rentVoucherJson(db, '2026-08-05')
    const created = saveTemplate(db, {
      name: 'Monthly rent', voucherJson, cadence: 'monthly', dayOfMonth: 5, nextDue: '2026-09-05', active: true
    })
    expect(created.name).toBe('Monthly rent')
    expect(created.cadence).toBe('monthly')
    expect(created.dayOfMonth).toBe(5)
    expect(created.active).toBe(true)
    expect(created.voucherKind).toBe('journal')
    expect(listTemplates(db).map((t) => t.name)).toEqual(['Monthly rent'])
    expect(listTemplates(db)[0]!.voucherKind).toBe('journal')
  })

  it('postFromTemplate posts a voucher, sets last_posted, and advances next_due by one cadence step', () => {
    const db = seededDb()
    const voucherJson = rentVoucherJson(db, '2026-08-05')
    const tmpl = saveTemplate(db, { name: 'Monthly rent', voucherJson, cadence: 'monthly', dayOfMonth: 5, nextDue: '2026-08-05', active: true })

    const voucher = postFromTemplate(db, tmpl.id, '2026-08-05')
    expect(voucher.date).toBe('2026-08-05')
    expect(voucher.lines).toHaveLength(2)

    const updated = listTemplates(db).find((t) => t.id === tmpl.id)!
    expect(updated.lastPosted).toBe('2026-08-05')
    expect(updated.nextDue).toBe('2026-09-05')

    // due() no longer lists it once caught up.
    expect(due(db, '2026-08-05').map((t) => t.id)).not.toContain(tmpl.id)
  })

  it('skip advances next_due only — no voucher posted, last_posted untouched', () => {
    const db = seededDb()
    const voucherJson = rentVoucherJson(db, '2026-08-05')
    const tmpl = saveTemplate(db, { name: 'Monthly rent', voucherJson, cadence: 'monthly', dayOfMonth: 5, nextDue: '2026-08-05', active: true })

    const updated = skip(db, tmpl.id)
    expect(updated.nextDue).toBe('2026-09-05')
    expect(updated.lastPosted).toBeNull()

    const voucherCount = db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    expect(voucherCount.n).toBe(0)
  })

  it('post throws a clear message when the stored voucher JSON no longer validates (schema drift / stale reference)', () => {
    const db = seededDb()
    const voucherJson = rentVoucherJson(db, '2026-08-05')
    const tmpl = saveTemplate(db, { name: 'Monthly rent', voucherJson, cadence: 'monthly', dayOfMonth: 5, nextDue: '2026-08-05', active: true })

    // Simulate drift: corrupt the stored JSON directly (bypassing saveTemplate's own validation).
    db.prepare('UPDATE recurring_templates SET voucher_json = ? WHERE id = ?').run('{"nonsense":true}', tmpl.id)

    expect(() => postFromTemplate(db, tmpl.id, '2026-08-05')).toThrow(/invalid saved voucher/i)
  })

  it('post surfaces the period-lock error from saveVoucher unmodified, and leaves the template untouched (atomic)', () => {
    const db = seededDb()
    const voucherJson = rentVoucherJson(db, '2026-06-05')
    const tmpl = saveTemplate(db, { name: 'Monthly rent', voucherJson, cadence: 'monthly', dayOfMonth: 5, nextDue: '2026-06-05', active: true })
    setLockDate(db, '2026-06-30')

    expect(() => postFromTemplate(db, tmpl.id, '2026-06-05')).toThrow('Books are locked up to 2026-06-30')

    // Atomic: the failed post must not have advanced next_due/last_posted, nor created a voucher.
    const stillDue = listTemplates(db).find((t) => t.id === tmpl.id)!
    expect(stillDue.nextDue).toBe('2026-06-05')
    expect(stillDue.lastPosted).toBeNull()
    const voucherCount = db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    expect(voucherCount.n).toBe(0)
  })

  it('saveTemplate rejects a manual-numbered voucher type', () => {
    const db = seededDb()
    const manualVt = db
      .prepare("INSERT INTO voucher_types (name, kind, numbering, prefix) VALUES ('Manual Journal', 'journal', 'manual', '')")
      .run().lastInsertRowid as number
    const cash = db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }
    const rent = expenseLedger(db, 'Rent')
    const voucherJson = voucherJsonFor(manualVt, '2026-08-05', [
      { ledgerId: rent.id, drCr: 'dr', amount: 10000, costAllocations: [] },
      { ledgerId: cash.id, drCr: 'cr', amount: 10000, costAllocations: [] }
    ])

    expect(() =>
      saveTemplate(db, { name: 'Monthly rent', voucherJson, cadence: 'monthly', dayOfMonth: 5, nextDue: '2026-09-05', active: true })
    ).toThrow('Recurring templates need an auto-numbered voucher type')
    expect(listTemplates(db)).toHaveLength(0)
  })

  it('postFromTemplate rejects a pre-existing template whose voucher type became manual since it was saved', () => {
    const db = seededDb()
    const voucherJson = rentVoucherJson(db, '2026-08-05')
    const tmpl = saveTemplate(db, { name: 'Monthly rent', voucherJson, cadence: 'monthly', dayOfMonth: 5, nextDue: '2026-08-05', active: true })

    const vt = JSON.parse(voucherJson) as VoucherInputParsed
    db.prepare("UPDATE voucher_types SET numbering = 'manual' WHERE id = ?").run(vt.voucherTypeId)

    expect(() => postFromTemplate(db, tmpl.id, '2026-08-05')).toThrow('Recurring templates need an auto-numbered voucher type')
  })
})
