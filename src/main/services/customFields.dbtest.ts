import { describe, it, expect } from 'vitest'
import { seededDb } from '../db/testdb'
import { allFields, listFields, removeField, saveField, valuesFor } from './customFields'
import { getVoucher, saveVoucher } from './vouchers'
import { trialBalance } from './reports'
import { createLedger } from './masters'

type Db = ReturnType<typeof seededDb>

/**
 * Fields a company defines for itself, per voucher type (roadmap #195).
 *
 * Two things are being tested here, and only one of them is a feature. The feature is that a
 * business can put its customer's PO number on a sales voucher. The other is the rule underneath
 * it: a custom field can never change a total, and removing one can never change what a voucher
 * already issued says about itself.
 */
const LEDGER_DEFAULTS = {
  openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null,
  hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
}

function books(): { db: Db; typeId: number; cash: number; sales: number } {
  const db = seededDb()
  const typeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
  const groupId = (name: string): number =>
    (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const ledger = (name: string, group: string): number => {
    const row = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined
    return row?.id ?? createLedger(db, { ...LEDGER_DEFAULTS, name, groupId: groupId(group) }).id
  }
  const cash = ledger('Cash', 'Cash-in-Hand')
  const sales = ledger('Sales Account', 'Sales Accounts')
  return { db, typeId, cash, sales }
}

const entry = (
  db: Db,
  ids: { typeId: number; cash: number; sales: number },
  customFields?: { fieldId: number; value: string }[],
  amount = 1_00_000
): { id: number } =>
  saveVoucher(db, {
    voucherTypeId: ids.typeId,
    date: '2026-04-10',
    lines: [
      { ledgerId: ids.cash, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: ids.sales, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [],
    billRefs: [],
    tds: null,
    customFields
  } as never)

describe('defining a field', () => {
  it('derives a key from the label and keeps it per voucher type', () => {
    const { db, typeId } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Customer PO number', kind: 'text' })
    expect(f.key).toBe('customer_po_number')
    expect(listFields(db, typeId)).toHaveLength(1)
    // Another voucher type has none of it.
    const journal = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
    expect(listFields(db, journal)).toHaveLength(0)
  })

  it('refuses two fields with the same label on one type', () => {
    const { db, typeId } = books()
    saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text' })
    expect(() => saveField(db, { voucherTypeId: typeId, label: 'site', kind: 'text' })).toThrow('already has a field')
  })

  it('refuses a list with no choices, and refuses to change a field’s kind under existing values', () => {
    const { db, typeId } = books()
    expect(() => saveField(db, { voucherTypeId: typeId, label: 'Mode', kind: 'list', options: [] })).toThrow('at least one choice')
    const f = saveField(db, { voucherTypeId: typeId, label: 'Mode', kind: 'list', options: ['Road', 'Rail'] })
    expect(() => saveField(db, { voucherTypeId: typeId, label: 'Mode', kind: 'number' }, f.id)).toThrow('remove it and add a new one')
    // Renaming the label is fine; the key never moves.
    const renamed = saveField(db, { voucherTypeId: typeId, label: 'Dispatch mode', kind: 'list', options: ['Road', 'Rail'] }, f.id)
    expect(renamed.key).toBe('mode')
    expect(renamed.label).toBe('Dispatch mode')
  })
})

describe('values on a voucher', () => {
  it('are written with the voucher and read back with it', () => {
    const { db, typeId, cash, sales } = books()
    const po = saveField(db, { voucherTypeId: typeId, label: 'Customer PO', kind: 'text' })
    const v = entry(db, { typeId, cash, sales }, [{ fieldId: po.id, value: 'PO/2026/881' }])
    expect(valuesFor(db, v.id)).toEqual([
      { fieldId: po.id, key: 'customer_po', label: 'Customer PO', kind: 'text', value: 'PO/2026/881', printed: true, retired: false }
    ])
    expect(getVoucher(db, v.id)!.customFields[0]!.value).toBe('PO/2026/881')
  })

  it('refuse the whole voucher when a value is wrong for its kind', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Delivered on', kind: 'date' })
    expect(() => entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: '31-02-2026' }])).toThrow('must be a date')
    // Nothing was half-written: the voucher did not save either.
    expect(db.prepare('SELECT COUNT(*) AS n FROM vouchers').get()).toEqual({ n: 0 })
  })

  it('hold a number as the text it was typed as, never as paise', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Cartons', kind: 'number' })
    const v = entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: '12.5' }])
    const stored = db.prepare('SELECT value FROM custom_field_values WHERE voucher_id = ?').get(v.id) as { value: string }
    expect(stored.value).toBe('12.5')
    expect(typeof stored.value).toBe('string')
  })

  it('cannot move a total — the trial balance is the same with them and without', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Advance held', kind: 'number' })
    entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: '999999' }])
    const withField = trialBalance(db, '2026-04-30')
    db.prepare('DELETE FROM custom_field_values').run()
    const without = trialBalance(db, '2026-04-30')
    expect(withField).toEqual(without)
  })

  it('refuse a value for a field belonging to another voucher type', () => {
    const { db, typeId, cash, sales } = books()
    const journal = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
    const foreign = saveField(db, { voucherTypeId: journal, label: 'Approved by', kind: 'text' })
    expect(() => entry(db, { typeId, cash, sales }, [{ fieldId: foreign.id, value: 'x' }])).toThrow('not defined on this voucher type')
  })

  it('an empty value is nothing at all, not an empty string on the document', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text' })
    const v = entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: '  ' }])
    expect(valuesFor(db, v.id)).toEqual([])
  })

  it('a required field refuses a voucher that leaves it out', () => {
    const { db, typeId, cash, sales } = books()
    saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text', required: true })
    expect(() => entry(db, { typeId, cash, sales }, [])).toThrow('Site is required')
  })

  it('a caller that never mentions custom fields leaves the ones already there alone', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text' })
    const v = entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: 'Bhiwandi' }])
    // An importer, a recurring template, an older draft: no `customFields` key at all.
    saveVoucher(db, {
      voucherTypeId: typeId,
      date: '2026-04-10',
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 2_00_000, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 2_00_000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    } as never, v.id)
    expect(valuesFor(db, v.id)[0]!.value).toBe('Bhiwandi')
  })
})

describe('removing a field while vouchers carry values for it', () => {
  it('retires it rather than deleting it, and says how many documents keep it', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Dispatch mode', kind: 'list', options: ['Road', 'Rail'] })
    const v = entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: 'Rail' }])

    const { retained } = removeField(db, f.id, '2026-06-01T00:00:00.000Z')
    expect(retained).toBe(1)

    // Gone from entry…
    expect(listFields(db, typeId)).toHaveLength(0)
    // …still defined, and still on the voucher that was issued with it.
    expect(allFields(db)).toHaveLength(1)
    const carried = valuesFor(db, v.id)
    expect(carried[0]).toMatchObject({ label: 'Dispatch mode', value: 'Rail', retired: true })
  })

  it('lets that voucher be altered without losing or re-validating the retired value', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Dispatch mode', kind: 'list', options: ['Road'] })
    const v = entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: 'Road' }])
    removeField(db, f.id, '2026-06-01T00:00:00.000Z')

    // The alteration resubmits what the voucher carries. The value is no longer a valid choice —
    // the definition is retired — and it must survive anyway.
    saveVoucher(db, {
      voucherTypeId: typeId,
      date: '2026-04-11',
      lines: [
        { ledgerId: cash, drCr: 'dr', amount: 1_00_000, costAllocations: [] },
        { ledgerId: sales, drCr: 'cr', amount: 1_00_000, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null,
      customFields: [{ fieldId: f.id, value: 'Road' }]
    } as never, v.id)
    expect(valuesFor(db, v.id)[0]!.value).toBe('Road')
  })

  it('refuses to re-edit a retired definition', () => {
    const { db, typeId } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text' })
    removeField(db, f.id, '2026-06-01T00:00:00.000Z')
    expect(() => saveField(db, { voucherTypeId: typeId, label: 'Site again', kind: 'text' }, f.id)).toThrow('was removed')
  })

  it('a new field with the same label is a different field, not the old one back', () => {
    const { db, typeId, cash, sales } = books()
    const old = saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text' })
    const v = entry(db, { typeId, cash, sales }, [{ fieldId: old.id, value: 'Bhiwandi' }])
    removeField(db, old.id, '2026-06-01T00:00:00.000Z')
    const fresh = saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text' })
    expect(fresh.id).not.toBe(old.id)
    // The old voucher still carries the old field's value, under the old definition.
    expect(valuesFor(db, v.id)[0]!.fieldId).toBe(old.id)
  })

  it('a deleted voucher takes its values with it, and nothing else loses one', () => {
    const { db, typeId, cash, sales } = books()
    const f = saveField(db, { voucherTypeId: typeId, label: 'Site', kind: 'text' })
    const keep = entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: 'Bhiwandi' }])
    const drop = entry(db, { typeId, cash, sales }, [{ fieldId: f.id, value: 'Nashik' }], 2_00_000)
    // A hard purge from the bin, which is the only path that removes the row itself.
    db.prepare('DELETE FROM vouchers WHERE id = ?').run(drop.id)
    expect(valuesFor(db, drop.id)).toEqual([])
    expect(valuesFor(db, keep.id)[0]!.value).toBe('Bhiwandi')
  })
})
