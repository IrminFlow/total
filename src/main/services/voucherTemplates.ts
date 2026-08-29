/**
 * Named voucher templates (#27).
 *
 * `recurring_templates` already stores a voucher shape, and the obvious move was to reuse it.
 * It does not fit: a recurring template's cadence and next_due are NOT NULL, because it is a
 * schedule that happens to carry a shape. Squeezing a template into one would mean inventing a
 * cadence for it, and an invented cadence posts entries to the books nobody asked for.
 *
 * A template is the shape without the schedule — the twelve-line branch expense journal, the
 * monthly rent entry you post when the landlord asks rather than on the 1st. It never posts by
 * itself. Applying one loads the entry screen with the lines already there, and the user saves
 * it like any other voucher, with the date and the number allocated at that moment.
 *
 * Two things are deliberately not carried over from the voucher a template was made from:
 *
 *   - the DATE is normalised to TEMPLATE_DATE. It cannot simply be dropped — voucherInputSchema
 *     requires one, and a stored shape that no longer validates is a template that can never be
 *     applied. So it is set to a date that is unmistakably not a real one, and every apply
 *     replaces it. A template that quietly kept 5 August would put next March's rent in August;
 *   - the voucher NUMBER is dropped outright. Numbers are allocated at save time against the
 *     series for the voucher's own financial year (see nextVoucherNumber), and a stored one
 *     would either collide with a live voucher or reproduce last year's series.
 */

import { z } from 'zod'
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import { voucherInputSchema, type VoucherInputParsed } from '@shared/schemas'
import { todayISO } from '@shared/dates'
import { writeAudit } from './audit'

/**
 * The date a stored template carries.
 *
 * Deliberately absurd rather than merely old: if it ever reaches the books, it is visible at a
 * glance and lands far outside any open period, where the period lock will refuse it. A
 * plausible-looking date would post silently into the wrong month.
 */
export const TEMPLATE_DATE = '1900-01-01'

export interface VoucherTemplate {
  id: number
  name: string
  voucherTypeId: number
  /** null when that voucher type has since been deleted. */
  voucherKind: VoucherKind | null
  voucherTypeName: string | null
  voucherJson: string
  usedCount: number
  lastUsedAt: string | null
  createdAt: string
  /** How many lines the saved shape carries — enough for the picker to say what it is. */
  lineCount: number
  /** Sum of the debit side, paise. A template's whole point is often "the usual ₹45,000". */
  total: number
  /** Set when the saved shape no longer validates: a ledger deleted, a schema field renamed. The
   *  template still lists (so it can be deleted) but cannot be applied. */
  problem: string | null
}

interface TemplateRow {
  id: number
  name: string
  voucher_type_id: number
  voucher_json: string
  used_count: number
  last_used_at: string | null
  created_at: string
  voucher_kind: VoucherKind | null
  voucher_type_name: string | null
}

const SELECT = `
  SELECT t.*, vt.kind AS voucher_kind, vt.name AS voucher_type_name
  FROM voucher_templates t
  LEFT JOIN voucher_types vt ON vt.id = t.voucher_type_id
`

/** ZodError or Error into one readable line. */
function describeError(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  return err instanceof Error ? err.message : String(err)
}

/**
 * Read a stored shape back, against the CURRENT schema.
 *
 * Validating on the way out as well as on the way in is what catches the two things that go wrong
 * to a template that has been sitting in the database for a year: a ledger it names has been
 * deleted, or a field has been added to the voucher schema since. Failing here says which;
 * failing deep inside saveVoucher says something about a foreign key.
 */
function parseShape(name: string, voucherJson: string): VoucherInputParsed {
  let raw: unknown
  try {
    raw = JSON.parse(voucherJson)
  } catch {
    throw new Error(`Template "${name}" has a saved voucher that is not valid JSON`)
  }
  try {
    return voucherInputSchema.parse(raw)
  } catch (err) {
    throw new Error(`Template "${name}" has an invalid saved voucher: ${describeError(err)}`)
  }
}

/** Ledgers and stock items the shape names that no longer exist. */
function missingReferences(db: DB, shape: VoucherInputParsed): string[] {
  const problems: string[] = []
  const ledgerExists = db.prepare('SELECT 1 FROM ledgers WHERE id = ?')
  const itemExists = db.prepare('SELECT 1 FROM stock_items WHERE id = ?')
  const seen = new Set<number>()
  for (const line of shape.lines) {
    if (seen.has(line.ledgerId)) continue
    seen.add(line.ledgerId)
    if (!ledgerExists.get(line.ledgerId)) problems.push(`ledger ${line.ledgerId} no longer exists`)
  }
  if (shape.partyLedgerId != null && !ledgerExists.get(shape.partyLedgerId)) {
    problems.push('the party ledger no longer exists')
  }
  for (const inv of shape.inventory) {
    if (!itemExists.get(inv.stockItemId)) problems.push(`stock item ${inv.stockItemId} no longer exists`)
  }
  return problems
}

function mapRow(db: DB, r: TemplateRow): VoucherTemplate {
  let lineCount = 0
  let total = 0
  let problem: string | null = null
  try {
    const shape = parseShape(r.name, r.voucher_json)
    lineCount = shape.lines.length
    total = shape.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    const missing = missingReferences(db, shape)
    if (missing.length > 0) problem = missing.join('; ')
  } catch (err) {
    problem = describeError(err)
  }
  if (r.voucher_kind == null) problem = problem ?? 'its voucher type has been deleted'
  return {
    id: r.id,
    name: r.name,
    voucherTypeId: r.voucher_type_id,
    voucherKind: r.voucher_kind,
    voucherTypeName: r.voucher_type_name,
    voucherJson: r.voucher_json,
    usedCount: r.used_count,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    lineCount,
    total,
    problem
  }
}

/**
 * Most-used first, then alphabetically.
 *
 * Alphabetical alone puts "Advance to staff" above the rent journal somebody posts every month.
 * The count is the better ordering for something typed daily, and the name breaks ties so the
 * list is still stable for templates nobody has used yet.
 */
export function listTemplates(db: DB, voucherTypeId?: number): VoucherTemplate[] {
  const rows = (
    voucherTypeId != null
      ? db.prepare(`${SELECT} WHERE t.voucher_type_id = ? ORDER BY t.used_count DESC, t.name COLLATE NOCASE`).all(voucherTypeId)
      : db.prepare(`${SELECT} ORDER BY t.used_count DESC, t.name COLLATE NOCASE`).all()
  ) as TemplateRow[]
  return rows.map((r) => mapRow(db, r))
}

export function getTemplate(db: DB, id: number): VoucherTemplate | null {
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as TemplateRow | undefined
  return row ? mapRow(db, row) : null
}

export interface TemplateInput {
  name: string
  voucherTypeId: number
  voucherJson: string
}

/**
 * Save a shape under a name, or rename/replace one.
 *
 * The shape is validated before it is stored, so a template that cannot be applied can never be
 * created in the first place — the only broken templates are ones the books changed underneath.
 * The date and the number are stripped rather than merely ignored: leaving them in the JSON would
 * make the stored blob disagree with what the template actually does the next time somebody read
 * it, and a stale voucher number sitting in a file is exactly the kind of thing that gets pasted
 * back in by a later maintainer.
 */
export function saveTemplate(db: DB, input: TemplateInput, id?: number): VoucherTemplate {
  const name = input.name.trim()
  if (name === '') throw new Error('A template needs a name')

  const vt = db.prepare('SELECT id FROM voucher_types WHERE id = ?').get(input.voucherTypeId)
  if (!vt) throw new Error('Voucher type not found')

  const shape = parseShape(name, input.voucherJson)
  const missing = missingReferences(db, shape)
  if (missing.length > 0) throw new Error(`Cannot save this template: ${missing.join('; ')}`)

  // Stored without the two fields that belong to the moment of posting rather than to the shape.
  const stored = JSON.stringify({ ...shape, date: TEMPLATE_DATE, number: undefined })

  const clash = db.prepare('SELECT id FROM voucher_templates WHERE name = ? COLLATE NOCASE').get(name) as
    | { id: number }
    | undefined
  if (clash && clash.id !== id) throw new Error(`A template called "${name}" already exists`)

  if (id != null) {
    const before = db.prepare('SELECT * FROM voucher_templates WHERE id = ?').get(id)
    if (!before) throw new Error('Template not found')
    db.prepare('UPDATE voucher_templates SET name = ?, voucher_type_id = ?, voucher_json = ? WHERE id = ?')
      .run(name, input.voucherTypeId, stored, id)
    writeAudit(db, 'voucher_template', id, 'update', before, { name, voucherTypeId: input.voucherTypeId })
  } else {
    const res = db
      .prepare('INSERT INTO voucher_templates (name, voucher_type_id, voucher_json) VALUES (?, ?, ?)')
      .run(name, input.voucherTypeId, stored)
    id = Number(res.lastInsertRowid)
    writeAudit(db, 'voucher_template', id, 'create', null, { name, voucherTypeId: input.voucherTypeId })
  }
  const saved = getTemplate(db, id)
  if (!saved) throw new Error('Template not found after save')
  return saved
}

export function deleteTemplate(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM voucher_templates WHERE id = ?').get(id)
  if (!before) throw new Error('Template not found')
  db.prepare('DELETE FROM voucher_templates WHERE id = ?').run(id)
  writeAudit(db, 'voucher_template', id, 'delete', before, null)
}

/**
 * The shape to load into the entry screen, with the usage counter bumped.
 *
 * Returns a shape, not a voucher: nothing is posted here. Counting the use at this point rather
 * than when the voucher is finally saved is deliberate — the ordering this feeds is "which
 * template do I reach for", and reaching for one and then changing your mind is still reaching
 * for it. The alternative would need the entry screen to report back after a save that may never
 * come.
 */
export function useTemplate(
  db: DB,
  id: number,
  date?: string
): { template: VoucherTemplate; shape: VoucherInputParsed } {
  const row = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as TemplateRow | undefined
  if (!row) throw new Error('Template not found')
  const stored = parseShape(row.name, row.voucher_json)
  const missing = missingReferences(db, stored)
  if (missing.length > 0) throw new Error(`This template cannot be applied: ${missing.join('; ')}`)

  // Defaulted here rather than left to the caller: TEMPLATE_DATE reaching a voucher would be a
  // bug in whoever forgot to set it, and this is the one place that knows it is a placeholder.
  const shape: VoucherInputParsed = { ...stored, date: date ?? todayISO() }

  db.prepare("UPDATE voucher_templates SET used_count = used_count + 1, last_used_at = datetime('now') WHERE id = ?")
    .run(id)
  return { template: mapRow(db, row), shape }
}
