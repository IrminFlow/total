/**
 * Fields a company defines for itself, per voucher type (roadmap #195).
 *
 * The type system lives in `@shared/customFields` and is pure. This file is the part that owns
 * rows: definitions in `custom_field_defs`, values in `custom_field_values` keyed by voucher.
 *
 * Two rules are enforced here rather than trusted:
 *
 *   - **A definition is retired, never deleted.** Vouchers already carry values for it, and those
 *     values are what the document said on the day it was issued. `removeField` stamps
 *     `retired_at`; the field vanishes from entry and stays on the vouchers that have it.
 *   - **No arithmetic.** Nothing in this file adds, converts or rounds a value. A number in a
 *     custom field is text; if it were money it would have to be a ledger line, because a rupee
 *     that is not in a ledger is a rupee that is not in the trial balance. `customFieldsPurity.
 *     test.ts` greps the report services to keep it that way.
 */
import type { DB } from '../db/connection'
import {
  customFieldKey,
  validateCustomValues,
  type CustomFieldDef,
  type CustomFieldKind
} from '@shared/customFields'
import { writeAudit } from './audit'

interface DefRow {
  id: number
  voucher_type_id: number
  key: string
  label: string
  kind: CustomFieldKind
  options: string
  required: number
  printed: number
  sort_order: number
  retired_at: string | null
}

function hydrate(r: DefRow): CustomFieldDef {
  let options: string[] = []
  try {
    const parsed: unknown = JSON.parse(r.options)
    if (Array.isArray(parsed)) options = parsed.filter((o): o is string => typeof o === 'string')
  } catch {
    // A definition with unreadable options is still a definition; it degrades to no choices
    // rather than taking the whole voucher type down with it.
  }
  return {
    id: r.id,
    voucherTypeId: r.voucher_type_id,
    key: r.key,
    label: r.label,
    kind: r.kind,
    options,
    required: r.required === 1,
    printed: r.printed === 1,
    sortOrder: r.sort_order,
    retiredAt: r.retired_at
  }
}

/**
 * The fields defined for a voucher type.
 *
 * `includeRetired` is what an ALTERATION needs: an old voucher carries values for fields that
 * have since been removed, and a screen that only asked for live definitions would show the
 * voucher with a blank where its dispatch mode used to be.
 */
export function listFields(db: DB, voucherTypeId: number, includeRetired = false): CustomFieldDef[] {
  const where = includeRetired ? '' : ' AND retired_at IS NULL'
  return (
    db
      .prepare(`SELECT * FROM custom_field_defs WHERE voucher_type_id = ?${where} ORDER BY sort_order, id`)
      .all(voucherTypeId) as DefRow[]
  ).map(hydrate)
}

/** Every definition in the company, live and retired — Settings shows both. */
export function allFields(db: DB): CustomFieldDef[] {
  return (
    db.prepare('SELECT * FROM custom_field_defs ORDER BY voucher_type_id, sort_order, id').all() as DefRow[]
  ).map(hydrate)
}

export interface CustomFieldInput {
  voucherTypeId: number
  label: string
  kind: CustomFieldKind
  options?: string[]
  required?: boolean
  printed?: boolean
  sortOrder?: number
}

export function saveField(db: DB, input: CustomFieldInput, id?: number): CustomFieldDef {
  const label = input.label.trim()
  if (!label) throw new Error('A field needs a label')
  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean)
  if (input.kind === 'list' && options.length === 0) throw new Error('A list field needs at least one choice')

  const before = id ? (db.prepare('SELECT * FROM custom_field_defs WHERE id = ?').get(id) as DefRow | undefined) : undefined
  if (id && !before) throw new Error('No such field')
  if (before?.retired_at) throw new Error('That field was removed — add a new one instead')

  if (id) {
    // The KEY never moves. Vouchers already carry values against it and an export addresses the
    // field by it; renaming the label is cosmetic, renaming the key would orphan the history.
    if (before!.kind !== input.kind) {
      throw new Error(
        `${before!.label} is a ${before!.kind} field and vouchers may already carry ${before!.kind} values — remove it and add a new one`
      )
    }
    db.prepare(
      `UPDATE custom_field_defs SET label = ?, options = ?, required = ?, printed = ?, sort_order = ? WHERE id = ?`
    ).run(label, JSON.stringify(options), input.required ? 1 : 0, input.printed === false ? 0 : 1, input.sortOrder ?? before!.sort_order, id)
  } else {
    const key = customFieldKey(label)
    if (!key) throw new Error('That label has no letters or digits in it')
    const clash = db
      // Live fields only — see the partial unique index. A retired field with the same key is
      // history, and history does not get to block a name for ever.
      .prepare('SELECT id FROM custom_field_defs WHERE voucher_type_id = ? AND key = ? AND retired_at IS NULL')
      .get(input.voucherTypeId, key) as { id: number } | undefined
    if (clash) throw new Error(`This voucher type already has a field called ${label}`)
    id = Number(
      db
        .prepare(
          `INSERT INTO custom_field_defs (voucher_type_id, key, label, kind, options, required, printed, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.voucherTypeId, key, label, input.kind, JSON.stringify(options),
          input.required ? 1 : 0, input.printed === false ? 0 : 1, input.sortOrder ?? 0
        ).lastInsertRowid
    )
  }
  const after = hydrate(db.prepare('SELECT * FROM custom_field_defs WHERE id = ?').get(id) as DefRow)
  writeAudit(db, 'custom_field', id, before ? 'update' : 'create', before ? hydrate(before) : null, after)
  return after
}

/**
 * Remove a field.
 *
 * A retirement, not a delete — and the count of vouchers that still carry it is returned so the
 * screen can say so out loud. Removing a field must never change what a voucher already issued
 * says about itself.
 */
export function removeField(db: DB, id: number, now: string): { retained: number } {
  const before = db.prepare('SELECT * FROM custom_field_defs WHERE id = ?').get(id) as DefRow | undefined
  if (!before) throw new Error('No such field')
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM custom_field_values WHERE field_id = ?').get(id) as { n: number }
  db.prepare('UPDATE custom_field_defs SET retired_at = ? WHERE id = ?').run(now, id)
  writeAudit(db, 'custom_field', id, 'update', hydrate(before), { ...hydrate(before), retiredAt: now })
  return { retained: n }
}

export interface CustomFieldValue {
  fieldId: number
  key: string
  label: string
  kind: CustomFieldKind
  value: string
  printed: boolean
  retired: boolean
}

/** What one voucher carries, in the order the fields are defined. */
export function valuesFor(db: DB, voucherId: number): CustomFieldValue[] {
  const rows = db
    .prepare(
      `SELECT d.id AS id, d.key AS key, d.label AS label, d.kind AS kind, d.printed AS printed,
              d.retired_at AS retired_at, v.value AS value
       FROM custom_field_values v
       JOIN custom_field_defs d ON d.id = v.field_id
       WHERE v.voucher_id = ?
       ORDER BY d.sort_order, d.id`
    )
    .all(voucherId) as {
    id: number; key: string; label: string; kind: CustomFieldKind; printed: number; retired_at: string | null; value: string
  }[]
  return rows.map((r) => ({
    fieldId: r.id,
    key: r.key,
    label: r.label,
    kind: r.kind,
    value: r.value,
    printed: r.printed === 1,
    retired: r.retired_at !== null
  }))
}

/**
 * Write the values for a voucher, having validated them against the type's definitions.
 *
 * Called from inside `saveVoucher`'s transaction, so a rejected custom field takes the whole
 * voucher down with it rather than leaving a saved entry with a half-written extra field.
 * An empty value is a deletion: a field somebody cleared is a field with nothing in it, not a
 * field holding an empty string.
 */
export function setValues(
  db: DB,
  voucherId: number,
  voucherTypeId: number,
  values: { fieldId: number; value: string }[]
): void {
  const defs = listFields(db, voucherTypeId, true)
  const checked = validateCustomValues(defs, values)
  if (!checked.ok) throw new Error(checked.error)
  db.prepare('DELETE FROM custom_field_values WHERE voucher_id = ?').run(voucherId)
  const insert = db.prepare('INSERT INTO custom_field_values (voucher_id, field_id, value) VALUES (?, ?, ?)')
  for (const v of checked.values) {
    if (v.value === '') continue
    insert.run(voucherId, v.fieldId, v.value)
  }
}
