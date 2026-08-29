import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  defaultRegistrationFor,
  primaryOf,
  resolveRegistration,
  validateRegistration,
  type CrossRegistrationTransfer,
  type GstRegistration,
  type GstRegistrationInput
} from '@shared/gst/registrations'
import { readCompanyInfo } from '../db/seed'
import { writeAudit } from './audit'
import { IN_BOOKS } from './vouchers'

export type { GstRegistration, GstRegistrationInput, CrossRegistrationTransfer }

interface RegRow {
  id: number
  gstin: string | null
  state_code: string
  trade_name: string
  address: string | null
  registered_on: string | null
  surrendered_on: string | null
  is_primary: number
}

const mapReg = (r: RegRow): GstRegistration => ({
  id: r.id,
  gstin: r.gstin,
  stateCode: r.state_code,
  tradeName: r.trade_name,
  address: r.address,
  registeredOn: r.registered_on,
  surrenderedOn: r.surrendered_on,
  isPrimary: !!r.is_primary
})

export function listRegistrations(db: DB): GstRegistration[] {
  const rows = db
    .prepare(
      `SELECT id, gstin, state_code, trade_name, address, registered_on, surrendered_on, is_primary
       FROM gst_registrations ORDER BY is_primary DESC, state_code, id`
    )
    .all() as RegRow[]
  return rows.map(mapReg)
}

/**
 * Make sure the company has at least the one registration it always implicitly had.
 *
 * Migration 47 does this for every database that already existed. This covers the other case —
 * a company created after it, where `meta.company` is written by `seedCompany` AFTER migrations
 * have run, so the migration's INSERT found nothing to copy. Idempotent, and called on company
 * open as well as at seed time.
 */
export function ensureRegistrations(db: DB): GstRegistration[] {
  const existing = listRegistrations(db)
  if (existing.length > 0) return existing
  let info: CompanyInfo
  try {
    info = readCompanyInfo(db)
  } catch {
    return [] // no company row yet: nothing to derive a registration from
  }
  const res = db
    .prepare(
      `INSERT INTO gst_registrations (gstin, state_code, trade_name, address, is_primary)
       VALUES (?, ?, ?, ?, 1)`
    )
    .run(info.gstin, info.stateCode, info.name, info.address || null)
  const id = Number(res.lastInsertRowid)
  // Stamp, don't infer. See migration 47.
  db.prepare('UPDATE vouchers SET gst_registration_id = ? WHERE gst_registration_id IS NULL').run(id)
  db.prepare('UPDATE godowns SET gst_registration_id = ? WHERE gst_registration_id IS NULL').run(id)
  return listRegistrations(db)
}

export function primaryRegistration(db: DB): GstRegistration | null {
  return primaryOf(ensureRegistrations(db))
}

/**
 * The other half of the mirror in `db/seed.ts`: editing the PRIMARY registration writes its
 * GSTIN and state back onto `meta.company`, so every screen and every query that reads
 * `company.gstin` keeps seeing the same fact.
 */
function writeCompanyIdentity(db: DB, gstin: string | null, stateCode: string): void {
  const info = readCompanyInfo(db)
  db.prepare("UPDATE meta SET value = ? WHERE key = 'company'").run(
    JSON.stringify({ ...info, gstin, stateCode })
  )
}

export function saveRegistration(db: DB, input: GstRegistrationInput): GstRegistration {
  ensureRegistrations(db)
  const errors = validateRegistration(input)
  if (errors.length) throw new Error(errors.join('; '))

  const gstin = input.gstin?.trim().toUpperCase() || null
  const before = input.id ? (listRegistrations(db).find((r) => r.id === input.id) ?? null) : null
  if (input.id && !before) throw new Error('Registration not found')

  const clash = gstin
    ? (db.prepare('SELECT id FROM gst_registrations WHERE gstin = ? AND id <> ?').get(gstin, input.id ?? -1) as
        | { id: number }
        | undefined)
    : undefined
  if (clash) throw new Error(`GSTIN ${gstin} is already on this company`)

  let id: number
  if (before) {
    // The primary flag is not editable here — setPrimary owns it, so that "exactly one primary"
    // can never be broken by a save that forgot to clear the old one.
    db.prepare(
      `UPDATE gst_registrations SET gstin = ?, state_code = ?, trade_name = ?, address = ?,
         registered_on = ?, surrendered_on = ? WHERE id = ?`
    ).run(
      gstin, input.stateCode, input.tradeName.trim(), input.address?.trim() || null,
      input.registeredOn || null, input.surrenderedOn || null, before.id
    )
    id = before.id
  } else {
    const res = db
      .prepare(
        `INSERT INTO gst_registrations (gstin, state_code, trade_name, address, registered_on, surrendered_on, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        gstin, input.stateCode, input.tradeName.trim(), input.address?.trim() || null,
        input.registeredOn || null, input.surrenderedOn || null
      )
    id = Number(res.lastInsertRowid)
  }

  const saved = listRegistrations(db).find((r) => r.id === id)!
  if (saved.isPrimary) writeCompanyIdentity(db, saved.gstin, saved.stateCode)
  writeAudit(db, 'gstRegistration', id, before ? 'update' : 'create', before, saved)
  return saved
}

export function setPrimaryRegistration(db: DB, id: number): GstRegistration[] {
  const regs = ensureRegistrations(db)
  const target = regs.find((r) => r.id === id)
  if (!target) throw new Error('Registration not found')
  const before = primaryOf(regs)
  const run = db.transaction(() => {
    db.prepare('UPDATE gst_registrations SET is_primary = 0').run()
    db.prepare('UPDATE gst_registrations SET is_primary = 1 WHERE id = ?').run(id)
    // Vouchers already stamped keep the registration they were stamped with — moving the primary
    // flag must not re-attribute last year's invoices to a different GSTIN.
    writeCompanyIdentity(db, target.gstin, target.stateCode)
  })
  run()
  writeAudit(db, 'gstRegistration', id, 'update', { primary: before?.id ?? null }, { primary: id })
  return listRegistrations(db)
}

export function deleteRegistration(db: DB, id: number): void {
  const regs = ensureRegistrations(db)
  const target = regs.find((r) => r.id === id)
  if (!target) throw new Error('Registration not found')
  if (target.isPrimary) throw new Error('The primary registration cannot be deleted; make another one primary first')
  // Binned vouchers count. A soft-deleted invoice can be restored, and restoring one whose
  // registration had been deleted would leave it attributed to nothing at all.
  const used = db
    .prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE v.gst_registration_id = ?`)
    .get(id) as { n: number }
  if (used.n > 0) {
    throw new Error('Vouchers are filed under this registration; surrender it instead of deleting it')
  }
  db.prepare('UPDATE godowns SET gst_registration_id = NULL WHERE gst_registration_id = ?').run(id)
  db.prepare('DELETE FROM gst_registrations WHERE id = ?').run(id)
  writeAudit(db, 'gstRegistration', id, 'delete', target, null)
}

// ---------- the scope every GST computation runs under ----------

/**
 * A company as one registration sees it.
 *
 * Structurally a `CompanyInfo` with `gstin`/`stateCode` replaced by the registration's own, plus
 * a SQL fragment that narrows every voucher query to that registration's supplies. Both extra
 * fields are OPTIONAL on purpose: `CompanyInfo` is assignable to `GstScope`, so every existing
 * caller — and every existing test — keeps compiling and keeps computing exactly what it did.
 */
export interface GstScope extends CompanyInfo {
  registrationId?: number | null
  /** `''` when the company has one registration, so a single-GSTIN book runs the same SQL it always did. */
  regScopeSql?: string
  registrationCount?: number
}

/** The registration filter for a query that aliases `vouchers` as `v`, or '' for none. */
export function regScope(scope: GstScope | undefined): string {
  return scope?.regScopeSql ?? ''
}

/**
 * Build the scope for `registrationId` (or the primary when not given).
 *
 * With one registration the fragment is empty — not "COALESCE(...) = 1". That is deliberate:
 * a single-GSTIN company must run byte-identical SQL to the one it ran before this feature
 * existed, so there is no query plan and no NULL-handling subtlety to get wrong for the
 * overwhelming majority of books.
 */
export function gstScope(db: DB, info: CompanyInfo, registrationId?: number | null): GstScope {
  const regs = ensureRegistrations(db)
  if (regs.length <= 1) {
    const only = regs[0]
    return {
      ...info,
      registrationId: only?.id ?? null,
      registrationCount: regs.length,
      regScopeSql: ''
    }
  }
  const reg = resolveRegistration(regs, registrationId)!
  // The COALESCE fallback is the OLDEST registration — the one migration 47 created from the
  // company's single GSTIN and stamped every existing voucher with — and deliberately NOT
  // whichever registration is primary today. An unstamped voucher predates this feature, so it
  // belonged to that first registration; making the fallback follow the primary flag would move
  // last year's invoices into another state's return the day somebody changed which GSTIN is
  // primary. In practice nothing reaches it: the migration and `ensureRegistrations` stamp every
  // row. It is the residue that matters, and the residue must not drift.
  const anchorId = Math.min(...regs.map((r) => r.id))
  return {
    ...info,
    gstin: reg.gstin,
    stateCode: reg.stateCode,
    registrationId: reg.id,
    registrationCount: regs.length,
    regScopeSql: ` AND COALESCE(v.gst_registration_id, ${anchorId}) = ${reg.id}`
  }
}

/** The registration id a new voucher should carry, given the godown its goods moved through. */
export function defaultVoucherRegistrationId(
  db: DB,
  opts: { godownId?: number | null; date?: string | null } = {}
): number | null {
  const regs = ensureRegistrations(db)
  if (!regs.length) return null
  const godownReg =
    opts.godownId != null
      ? ((db.prepare('SELECT gst_registration_id AS id FROM godowns WHERE id = ?').get(opts.godownId) as
          | { id: number | null }
          | undefined)?.id ?? null)
      : null
  return defaultRegistrationFor(regs, { godownRegistrationId: godownReg, date: opts.date })?.id ?? null
}

// ---------- stock moved between two registrations of the same PAN ----------

/**
 * Stock transfers that crossed a registration boundary.
 *
 * Schedule I para 2 of the CGST Act makes a supply between two registrations of the same person
 * a supply even without consideration — so a godown-to-godown transfer from the Maharashtra
 * registration to the Gujarat one is a TAXABLE supply requiring a tax invoice valued under rule
 * 28, reported in the sender's GSTR-1 and claimed in the receiver's return. Nothing was sold and
 * the books are unchanged, which is exactly why it is the thing multi-GSTIN software gets wrong.
 *
 * This finds those movements. `src/main/services/branchTransfer.ts` raises the invoice for one:
 * rule 28 valuation, a serial from the sender's own series, output tax in the sender's GSTR-1 and
 * input credit in the receiver's 4(A)(5) — and no posting at all, because a transfer between two
 * branches of one business creates no revenue and no expense and the trial balance must not move.
 * `undocumentedCrossTransfers` there is what the validation warning reads, so what is still warned
 * about is only what still has no document. See docs/roadmap.md #108.
 */
export function crossRegistrationTransfers(db: DB, from: string, to: string): CrossRegistrationTransfer[] {
  const regs = ensureRegistrations(db)
  if (regs.length <= 1) return []
  const byId = new Map(regs.map((r) => [r.id, r]))
  const primary = primaryOf(regs)!

  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.number,
              il.godown_id AS godownId, il.direction, il.amount,
              COALESCE(g.gst_registration_id, ${primary.id}) AS regId
       FROM inventory_lines il
       JOIN vouchers v ON v.id = il.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN godowns g ON g.id = il.godown_id
       WHERE vt.kind = 'stock_journal' AND il.is_absolute = 0
         AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as {
      voucherId: number; date: string; number: string
      godownId: number | null; direction: 'in' | 'out'; amount: number; regId: number
    }[]

  const byVoucher = new Map<number, { date: string; number: string; out: Map<number, number>; in: Map<number, number> }>()
  for (const r of rows) {
    const v = byVoucher.get(r.voucherId) ?? { date: r.date, number: r.number, out: new Map(), in: new Map() }
    const side = r.direction === 'out' ? v.out : v.in
    side.set(r.regId, (side.get(r.regId) ?? 0) + r.amount)
    byVoucher.set(r.voucherId, v)
  }

  const out: CrossRegistrationTransfer[] = []
  for (const [voucherId, v] of byVoucher) {
    for (const [fromReg, value] of v.out) {
      for (const [toReg] of v.in) {
        if (fromReg === toReg) continue
        const f = byId.get(fromReg)
        const t = byId.get(toReg)
        if (!f || !t) continue
        out.push({
          voucherId,
          date: v.date,
          number: v.number,
          fromRegistrationId: f.id,
          fromGstin: f.gstin,
          fromStateCode: f.stateCode,
          toRegistrationId: t.id,
          toGstin: t.gstin,
          toStateCode: t.stateCode,
          valuePaise: value
        })
      }
    }
  }
  return out
}

/**
 * The scope one particular voucher belongs to.
 *
 * A single-voucher e-invoice or e-way payload must be signed with the GSTIN that RAISED it, not
 * with whichever registration the screen happens to be showing — the IRP rejects a payload whose
 * seller GSTIN is not the one authenticating, and a wrong one that is accepted files the supply
 * under the wrong return. Reads the bin too: an e-document already generated for a voucher that
 * was later binned still has to say which GSTIN generated it.
 */
export function gstScopeForVoucher(db: DB, info: CompanyInfo, voucherId: number): GstScope {
  const row = db
    .prepare('SELECT v.gst_registration_id AS id FROM vouchers v WHERE v.id = ?')
    .get(voucherId) as { id: number | null } | undefined
  return gstScope(db, info, row?.id ?? null)
}
