import { z } from 'zod'
import type { DB } from '../db/connection'
import type { RecurringTemplate, Voucher, VoucherKind } from '@shared/domain'
import { voucherInputSchema, type RecurringInput, type VoucherInputParsed } from '@shared/schemas'
import { nextDueAfter, dueTemplates } from '@shared/recurring'
import { writeAudit } from './audit'
import { saveVoucher } from './vouchers'
import type { Role } from './roles'
import * as departmentScope from './departmentScope'
import { assertVoucherDiscountAuthority, postVoucherWithApprovalControl, type ControlledVoucherPostResult, type VoucherPostingActor } from './voucherPostingControls'

const SELECT_WITH_KIND = `
  SELECT rt.*, vt.kind AS voucher_kind
  FROM recurring_templates rt
  LEFT JOIN voucher_types vt ON vt.id = rt.voucher_type_id
`

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
  voucher_type_id: number | null
  /** Joined off voucher_types — null if that type has since been deleted. */
  voucher_kind: VoucherKind | null
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
  active: !!r.active,
  voucherKind: r.voucher_kind,
})

/** Always joined with voucher_types so callers (and mapRow) consistently see voucher_kind,
 *  whether they're reading one row or the whole list. */
function getRow(db: DB, id: number): RecurringRow | undefined {
  return db.prepare(`${SELECT_WITH_KIND} WHERE rt.id = ?`).get(id) as RecurringRow | undefined
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

/** A recurring template auto-posts with its number left blank (see postFromTemplate) — that only
 *  works for an auto-numbered voucher type. Checked both at save time (reject early) and at post
 *  time (guards a template saved before this check existed, or a type edited to 'manual' since). */
function assertAutoNumbered(db: DB, voucherTypeId: number): void {
  const vt = db.prepare('SELECT numbering FROM voucher_types WHERE id = ?').get(voucherTypeId) as { numbering: 'auto' | 'manual' } | undefined
  if (!vt) throw new Error('Voucher type not found')
  if (vt.numbering === 'manual') throw new Error('Recurring templates need an auto-numbered voucher type')
}

export function listTemplates(db: DB): RecurringTemplate[] {
  return (db.prepare(`${SELECT_WITH_KIND} ORDER BY rt.next_due, rt.name`).all() as RecurringRow[]).map(mapRow)
}

function templateVoucher(row: Pick<RecurringRow, 'name' | 'voucher_json'>): VoucherInputParsed {
  return parseTemplateVoucher(row.name, row.voucher_json)
}

function assertTemplateInScope(db: DB, id: number, role: Role): RecurringRow {
  const row = getRow(db, id)
  if (!row) throw new Error('Recurring template not found')
  departmentScope.assertVoucherInputDepartmentScope(db, role, templateVoucher(row))
  return row
}

function assertNoPendingApproval(db: DB, id: number): void {
  const pendingApproval = db
    .prepare(
      `SELECT 1
       FROM recurring_approval_links link
       JOIN approval_requests request ON request.id = link.approval_request_id
       WHERE link.recurring_template_id = ? AND request.status = 'pending'`,
    )
    .get(id)
  if (pendingApproval) throw new Error('This recurring template has an approval pending')
}

/** Never return an opaque saved voucher payload before its dimensions have been authorized. */
export function listTemplatesInScope(db: DB, role: Role): RecurringTemplate[] {
  if (role === 'owner' || !departmentScope.hasDepartmentScope(db, role)) return listTemplates(db)
  return (db.prepare(`${SELECT_WITH_KIND} ORDER BY rt.next_due, rt.name`).all() as RecurringRow[])
    .filter((row) => {
      try {
        return departmentScope.voucherInputInDepartmentScope(db, role, templateVoucher(row))
      } catch {
        return false
      }
    })
    .map(mapRow)
}

export function saveTemplate(db: DB, input: RecurringInput, id?: number): RecurringTemplate {
  // Canonicalise through voucherInputSchema (fills defaults, trims strings) so what's stored is
  // exactly the shape saveVoucher will see again at post time.
  const parsed = parseTemplateVoucher(input.name, input.voucherJson)
  assertAutoNumbered(db, parsed.voucherTypeId)
  const voucherJson = JSON.stringify(parsed)
  const dayOfMonth = input.cadence === 'monthly' ? (input.dayOfMonth ?? null) : null
  const weekday = input.cadence === 'weekly' ? (input.weekday ?? null) : null
  const active = input.active ? 1 : 0

  if (id) {
    assertNoPendingApproval(db, id)
    const existing = getRow(db, id)
    if (!existing) throw new Error('Recurring template not found')
    db.prepare(
      `UPDATE recurring_templates
       SET name = ?, voucher_json = ?, cadence = ?, day_of_month = ?, weekday = ?, next_due = ?, voucher_type_id = ?, active = ?
       WHERE id = ?`,
    ).run(input.name, voucherJson, input.cadence, dayOfMonth, weekday, input.nextDue, parsed.voucherTypeId, active, id)
    const updated = mapRow(getRow(db, id)!)
    writeAudit(db, 'recurring_template', id, 'update', mapRow(existing), updated)
    return updated
  }

  const res = db
    .prepare(
      `INSERT INTO recurring_templates (name, voucher_json, cadence, day_of_month, weekday, next_due, voucher_type_id, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.name, voucherJson, input.cadence, dayOfMonth, weekday, input.nextDue, parsed.voucherTypeId, active)
  const created = mapRow(getRow(db, Number(res.lastInsertRowid))!)
  writeAudit(db, 'recurring_template', created.id, 'create', null, created)
  return created
}

export function saveTemplateInScope(db: DB, input: RecurringInput, id: number | undefined, role: Role): RecurringTemplate {
  const parsed = parseTemplateVoucher(input.name, input.voucherJson)
  departmentScope.assertVoucherInputDepartmentScope(db, role, parsed)
  if (id) {
    assertTemplateInScope(db, id, role)
  }
  return saveTemplate(db, input, id)
}

export function deleteTemplate(db: DB, id: number): void {
  const existing = getRow(db, id)
  if (!existing) throw new Error('Recurring template not found')
  assertNoPendingApproval(db, id)
  db.prepare('DELETE FROM recurring_templates WHERE id = ?').run(id)
  writeAudit(db, 'recurring_template', id, 'delete', mapRow(existing), null)
}

export function deleteTemplateInScope(db: DB, id: number, role: Role): void {
  assertTemplateInScope(db, id, role)
  deleteTemplate(db, id)
}

/** Active templates whose next_due has arrived, earliest first. */
export function due(db: DB, todayISO: string): RecurringTemplate[] {
  return dueTemplates(listTemplates(db), todayISO)
}

export function dueInScope(db: DB, todayISO: string, role: Role): RecurringTemplate[] {
  return dueTemplates(listTemplatesInScope(db, role), todayISO)
}

function cadenceOpts(row: RecurringRow): {
  dayOfMonth?: number
  weekday?: number
} {
  return {
    dayOfMonth: row.day_of_month ?? undefined,
    weekday: row.weekday ?? undefined,
  }
}

/** Posts one voucher from `id`'s stored template, dated `dateISO`. The stored JSON is re-parsed
 *  through voucherInputSchema (catches drift/stale references) then handed to saveVoucher, which
 *  applies its own validation — including the period lock, whose error is left to propagate as-is
 *  so the caller sees exactly "Books are locked up to …". The voucher post and the template's
 *  last_posted/next_due update are one atomic transaction (better-sqlite3 nests it as a savepoint
 *  inside saveVoucher's own transaction) — a failure on either side leaves neither committed.
 *  Advances next_due from the template's own (pre-post) next_due, not "today" — so a late post
 *  steps the schedule forward by exactly one cadence, keeping it due again if still behind. */
export function postFromTemplate(db: DB, id: number, dateISO: string): Voucher {
  const row = getRow(db, id)
  if (!row) throw new Error('Recurring template not found')
  const parsed = parseTemplateVoucher(row.name, row.voucher_json)
  assertAutoNumbered(db, parsed.voucherTypeId)
  const nextDue = nextDueAfter(row.cadence, cadenceOpts(row), row.next_due)

  const run = db.transaction((): Voucher => {
    const input: VoucherInputParsed = {
      ...parsed,
      date: dateISO,
      number: undefined,
    }
    const saved = saveVoucher(db, input)
    db.prepare('UPDATE recurring_templates SET last_posted = ?, next_due = ? WHERE id = ?').run(dateISO, nextDue, id)
    return saved
  })
  return run()
}

/** The IPC posting path: scope, discount authority and maker-checker are all enforced before the
 * schedule advances. An approval request is the durable occurrence when approval is required. */
export function postFromTemplateControlled(db: DB, id: number, dateISO: string, actor: VoucherPostingActor | null): ControlledVoucherPostResult {
  const row = assertTemplateInScope(db, id, actor?.role ?? 'owner')
  const parsed = templateVoucher(row)
  assertAutoNumbered(db, parsed.voucherTypeId)
  const input: VoucherInputParsed = {
    ...parsed,
    date: dateISO,
    number: undefined,
  }
  assertVoucherDiscountAuthority(db, input, actor)
  const nextDue = nextDueAfter(row.cadence, cadenceOpts(row), row.next_due)
  return db.transaction(() => {
    assertNoPendingApproval(db, id)
    const result = postVoucherWithApprovalControl(db, input, actor)
    if (result.approvalRequired) {
      db.prepare(
        `INSERT INTO recurring_approval_links
          (approval_request_id, recurring_template_id, occurrence_date, next_due)
         VALUES (?, ?, ?, ?)`,
      ).run(result.request.id, id, row.next_due, nextDue)
    } else {
      db.prepare(`UPDATE recurring_templates SET last_posted = ?, next_due = ? WHERE id = ?`).run(dateISO, nextDue, id)
    }
    return result
  })()
}

/** Advances next_due one cadence step without posting anything. */
export function skip(db: DB, id: number): RecurringTemplate {
  const row = getRow(db, id)
  if (!row) throw new Error('Recurring template not found')
  assertNoPendingApproval(db, id)
  const nextDue = nextDueAfter(row.cadence, cadenceOpts(row), row.next_due)
  db.prepare('UPDATE recurring_templates SET next_due = ? WHERE id = ?').run(nextDue, id)
  return mapRow(getRow(db, id)!)
}

export function skipInScope(db: DB, id: number, role: Role): RecurringTemplate {
  assertTemplateInScope(db, id, role)
  return skip(db, id)
}
