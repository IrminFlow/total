import { z } from 'zod'
import type { DB } from '../db/connection'
import type { RecurringTemplate, Voucher } from '@shared/domain'
import { voucherInputSchema, type RecurringInput, type VoucherInputParsed } from '@shared/schemas'
import { nextDueAfter, dueTemplates } from '@shared/recurring'
import { writeAudit } from './audit'
import { saveVoucher } from './vouchers'

interface RecurringRow {
  id: number
  name: string
  voucher_json: string
  cadence: 'monthly' | 'weekly'
  day_of_month: number | null
  weekday: number | null
  next_due: string
  last_posted: string | null
  active: number
}

const mapRow = (r: RecurringRow): RecurringTemplate => ({
  id: r.id,
  name: r.name,
  voucherJson: r.voucher_json,
  cadence: r.cadence,
  dayOfMonth: r.day_of_month,
  weekday: r.weekday,
  nextDue: r.next_due,
  lastPosted: r.last_posted,
  active: !!r.active
})

function getRow(db: DB, id: number): RecurringRow | undefined {
  return db.prepare('SELECT * FROM recurring_templates WHERE id = ?').get(id) as RecurringRow | undefined
}

/** Formats a caught error (ZodError or plain Error) into one readable string. */
function describeError(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  return err instanceof Error ? err.message : String(err)
}

/** Parses+validates a stored template's voucher_json against the CURRENT voucherInputSchema —
 *  this is what catches schema drift (a field added/renamed since the template was saved) or a
 *  stale reference (a ledger/stock item deleted since) rather than failing deep inside saveVoucher
 *  with a confusing message. */
function parseTemplateVoucher(name: string, voucherJson: string): VoucherInputParsed {
  let raw: unknown
  try {
    raw = JSON.parse(voucherJson)
  } catch {
    throw new Error(`Recurring template "${name}" has a saved voucher that is not valid JSON`)
  }
  try {
    return voucherInputSchema.parse(raw)
  } catch (err) {
    throw new Error(`Recurring template "${name}" has an invalid saved voucher: ${describeError(err)}`)
  }
}

export function listTemplates(db: DB): RecurringTemplate[] {
  return (db.prepare('SELECT * FROM recurring_templates ORDER BY next_due, name').all() as RecurringRow[]).map(mapRow)
}

export function saveTemplate(db: DB, input: RecurringInput, id?: number): RecurringTemplate {
  // Canonicalise through voucherInputSchema (fills defaults, trims strings) so what's stored is
  // exactly the shape saveVoucher will see again at post time.
  const parsed = parseTemplateVoucher(input.name, input.voucherJson)
  const voucherJson = JSON.stringify(parsed)
  const dayOfMonth = input.cadence === 'monthly' ? (input.dayOfMonth ?? null) : null
  const weekday = input.cadence === 'weekly' ? (input.weekday ?? null) : null

  if (id) {
    const existing = getRow(db, id)
    if (!existing) throw new Error('Recurring template not found')
    db.prepare(
      `UPDATE recurring_templates SET name = ?, voucher_json = ?, cadence = ?, day_of_month = ?, weekday = ?, next_due = ?
       WHERE id = ?`
    ).run(input.name, voucherJson, input.cadence, dayOfMonth, weekday, input.nextDue, id)
    const updated = mapRow(getRow(db, id)!)
    writeAudit(db, 'recurring_template', id, 'update', mapRow(existing), updated)
    return updated
  }

  const res = db
    .prepare(
      `INSERT INTO recurring_templates (name, voucher_json, cadence, day_of_month, weekday, next_due, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(input.name, voucherJson, input.cadence, dayOfMonth, weekday, input.nextDue)
  const created = mapRow(getRow(db, Number(res.lastInsertRowid))!)
  writeAudit(db, 'recurring_template', created.id, 'create', null, created)
  return created
}

export function deleteTemplate(db: DB, id: number): void {
  const existing = getRow(db, id)
  if (!existing) throw new Error('Recurring template not found')
  db.prepare('DELETE FROM recurring_templates WHERE id = ?').run(id)
  writeAudit(db, 'recurring_template', id, 'delete', mapRow(existing), null)
}

/** Active templates whose next_due has arrived, earliest first. */
export function due(db: DB, todayISO: string): RecurringTemplate[] {
  return dueTemplates(listTemplates(db), todayISO)
}

function cadenceOpts(row: RecurringRow): { dayOfMonth?: number; weekday?: number } {
  return {
    dayOfMonth: row.day_of_month ?? undefined,
    weekday: row.weekday ?? undefined
  }
}

/** Posts one voucher from `id`'s stored template, dated `dateISO`. The stored JSON is re-parsed
 *  through voucherInputSchema (catches drift/stale references) then handed to saveVoucher, which
 *  applies its own validation — including the period lock, whose error is left to propagate as-is
 *  so the caller sees exactly "Books are locked up to …". Advances last_posted/next_due only on
 *  success, from the template's own (pre-post) next_due — so a late post steps the schedule
 *  forward by exactly one cadence, not to "today", keeping it due again if still behind. */
export function postFromTemplate(db: DB, id: number, dateISO: string): Voucher {
  const row = getRow(db, id)
  if (!row) throw new Error('Recurring template not found')
  const parsed = parseTemplateVoucher(row.name, row.voucher_json)
  const input: VoucherInputParsed = { ...parsed, date: dateISO, number: undefined }
  const saved = saveVoucher(db, input)

  const nextDue = nextDueAfter(row.cadence, cadenceOpts(row), row.next_due)
  db.prepare('UPDATE recurring_templates SET last_posted = ?, next_due = ? WHERE id = ?').run(dateISO, nextDue, id)
  return saved
}

/** Advances next_due one cadence step without posting anything. */
export function skip(db: DB, id: number): RecurringTemplate {
  const row = getRow(db, id)
  if (!row) throw new Error('Recurring template not found')
  const nextDue = nextDueAfter(row.cadence, cadenceOpts(row), row.next_due)
  db.prepare('UPDATE recurring_templates SET next_due = ? WHERE id = ?').run(nextDue, id)
  return mapRow(getRow(db, id)!)
}
