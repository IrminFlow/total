import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, TdsCertificateRow, TdsChallan, TdsRate, TdsSection } from '@shared/domain'
import {
  tdsCertificateInputSchema, tdsChallanInputSchema, tdsRateInputSchema, tdsSectionInputSchema,
  type TdsCertificateInput, type TdsChallanInput, type TdsRateInput, type TdsSectionInput, type VoucherInputParsed
} from '@shared/schemas'
import {
  applicableRate, expectedTdsPaise, rateRowOn, resolveDeducteeType, sectionReferenceOn, tdsQuarterBounds, tdsQuarterOf,
  thresholdPeriod, thresholdStatus, validateTdsEntries,
  type ApplicableRate, type CertificateUse, type DeducteeType, type TdsCertificate, type TdsRateRow
} from '@shared/tds'
import type { PostingError } from '@shared/posting'
import { fyFromStartYear, todayISO } from '@shared/dates'
import { rowsToCsv } from '@shared/csv'
import { plainRupees } from '@shared/money'
import { companyExportsDir } from '../paths'
// IN_BOOKS, not NOT_DELETED: optional (memorandum) and unmatured post-dated vouchers are out of
// the books, so their TDS entries must not reach the 26Q export, the summary, or the threshold
// base — filing figures must tie to the ledger. (Only used inside function bodies, so the
// vouchers ⇄ tds import cycle is harmless.)
import { IN_BOOKS, NOT_DELETED } from './vouchers'
import { writeAudit } from './audit'

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

interface SectionRow {
  id: number; code: string; description: string; rate: number
  threshold_single: number; threshold_annual: number
  nature: string | null; act: TdsSection['act']; legacy_code: string | null; new_reference: string | null
}
const mapSection = (r: SectionRow): TdsSection => ({
  id: r.id, code: r.code, description: r.description, rate: r.rate,
  thresholdSingle: r.threshold_single, thresholdAnnual: r.threshold_annual,
  nature: r.nature, act: r.act, legacyCode: r.legacy_code, newReference: r.new_reference
})

export function listSections(db: DB): TdsSection[] {
  return (db.prepare('SELECT * FROM tds_sections ORDER BY code').all() as SectionRow[]).map(mapSection)
}

function getSectionRow(db: DB, id: number): SectionRow | undefined {
  return db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(id) as SectionRow | undefined
}

/**
 * Create a new section, or update an existing one when `input.id` is given. The legacy
 * rate/threshold fields (the pre-020 Sections editor) are effective-dated: on an existing
 * section a changed figure closes the open 'any' rate row the day before today and opens a new
 * one from today, so history computed at the old rate stays valid. A new section gets one open
 * 'any' row from 1 Apr 1961 carrying the figures given.
 */
export function saveSection(db: DB, raw: TdsSectionInput): TdsSection {
  const input = tdsSectionInputSchema.parse(raw)
  const rateBp = Math.round(input.rate * 100)
  return db.transaction(() => {
    if (input.id) {
      const id = input.id
      const existing = getSectionRow(db, id)
      if (!existing) throw new Error('TDS section not found')
      db.prepare(
        `UPDATE tds_sections SET code = ?, description = ?, rate = ?, threshold_single = ?, threshold_annual = ?,
           nature = ?, legacy_code = ?, new_reference = ? WHERE id = ?`
      ).run(input.code, input.description, input.rate, input.thresholdSingle, input.thresholdAnnual,
        input.nature === undefined ? existing.nature : input.nature,
        input.legacyCode === undefined ? existing.legacy_code : input.legacyCode,
        input.newReference === undefined ? existing.new_reference : input.newReference, id)
      const changedFigures =
        existing.rate !== input.rate || existing.threshold_single !== input.thresholdSingle || existing.threshold_annual !== input.thresholdAnnual
      if (changedFigures) {
        const today = todayISO()
        const open = db
          .prepare("SELECT * FROM tds_section_rates WHERE section_id = ? AND deductee_type = 'any' AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1")
          .get(id) as RateRow | undefined
        if (open && open.effective_from >= today) {
          db.prepare('UPDATE tds_section_rates SET rate_bp = ?, threshold_single_paise = ?, threshold_annual_paise = ?, source = NULL WHERE id = ?')
            .run(rateBp, input.thresholdSingle, input.thresholdAnnual, open.id)
        } else {
          if (open) db.prepare('UPDATE tds_section_rates SET effective_to = ? WHERE id = ?').run(addDays(today, -1), open.id)
          db.prepare(
            `INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp,
               threshold_single_paise, threshold_annual_paise, threshold_basis, no_pan_rate_bp, source)
             VALUES (?, ?, NULL, 'any', ?, ?, ?, ?, ?, NULL)`
          ).run(id, today, rateBp, input.thresholdSingle, input.thresholdAnnual, open?.threshold_basis ?? 'fy', open?.no_pan_rate_bp ?? 2000)
        }
      }
      const updated = mapSection(getSectionRow(db, id)!)
      writeAudit(db, 'tdsSection', id, 'update', mapSection(existing), updated)
      return updated
    }
    const res = db
      .prepare(
        `INSERT INTO tds_sections (code, description, rate, threshold_single, threshold_annual, nature, act, legacy_code, new_reference)
         VALUES (?, ?, ?, ?, ?, ?, 'it_act_1961', ?, ?)`
      )
      .run(input.code, input.description, input.rate, input.thresholdSingle, input.thresholdAnnual,
        input.nature ?? null, input.legacyCode ?? input.code, input.newReference ?? null)
    const id = Number(res.lastInsertRowid)
    db.prepare(
      `INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp,
         threshold_single_paise, threshold_annual_paise, threshold_basis, no_pan_rate_bp, source)
       VALUES (?, '1961-04-01', NULL, 'any', ?, ?, ?, 'fy', 2000, NULL)`
    ).run(id, rateBp, input.thresholdSingle, input.thresholdAnnual)
    const created = mapSection(getSectionRow(db, id)!)
    writeAudit(db, 'tdsSection', created.id, 'create', null, created)
    return created
  })()
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------------------------
// Effective-dated rates
// ---------------------------------------------------------------------------------------------

interface RateRow {
  id: number; section_id: number; effective_from: string; effective_to: string | null
  deductee_type: TdsRate['deducteeType']; rate_bp: number
  threshold_single_paise: number; threshold_annual_paise: number; threshold_basis: 'fy' | 'month'
  threshold_excess_only: number; return_code: string | null
  no_pan_rate_bp: number; source: string | null
}
const mapRate = (r: RateRow): TdsRate & TdsRateRow => ({
  id: r.id, sectionId: r.section_id, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  deducteeType: r.deductee_type, rateBp: r.rate_bp,
  thresholdSinglePaise: r.threshold_single_paise, thresholdAnnualPaise: r.threshold_annual_paise,
  thresholdBasis: r.threshold_basis, thresholdExcessOnly: !!r.threshold_excess_only, returnCode: r.return_code,
  noPanRateBp: r.no_pan_rate_bp, source: r.source
})

export function listRates(db: DB, sectionId?: number): TdsRate[] {
  const rows = sectionId
    ? db.prepare('SELECT * FROM tds_section_rates WHERE section_id = ? ORDER BY effective_from, deductee_type').all(sectionId)
    : db.prepare('SELECT * FROM tds_section_rates ORDER BY section_id, effective_from, deductee_type').all()
  return (rows as RateRow[]).map(mapRate)
}

/** The legacy rate/threshold columns on tds_sections mirror the row in force today for an
 *  unknown deductee ('any', else the highest) so pre-020 readers stay sensible. */
function syncLegacyColumns(db: DB, sectionId: number): void {
  const row = rateRowOn(listRates(db, sectionId).map((r) => r as TdsRateRow), todayISO(), null)
  if (!row) return
  db.prepare('UPDATE tds_sections SET rate = ?, threshold_single = ?, threshold_annual = ? WHERE id = ?')
    .run(row.rateBp / 100, row.thresholdSinglePaise, row.thresholdAnnualPaise, sectionId)
}

export function saveRate(db: DB, raw: TdsRateInput): TdsRate {
  const input = tdsRateInputSchema.parse(raw)
  if (!getSectionRow(db, input.sectionId)) throw new Error('TDS section not found')
  return db.transaction(() => {
    let id: number
    let before: TdsRate | null = null
    if (input.id) {
      const existing = db.prepare('SELECT * FROM tds_section_rates WHERE id = ?').get(input.id) as RateRow | undefined
      if (!existing) throw new Error('TDS rate not found')
      before = mapRate(existing)
      db.prepare(
        `UPDATE tds_section_rates SET section_id = ?, effective_from = ?, effective_to = ?, deductee_type = ?, rate_bp = ?,
           threshold_single_paise = ?, threshold_annual_paise = ?, threshold_basis = ?, threshold_excess_only = ?,
           return_code = ?, no_pan_rate_bp = ?,
           source = CASE WHEN rate_bp = ? AND threshold_single_paise = ? AND threshold_annual_paise = ? AND no_pan_rate_bp = ?
                         THEN source ELSE NULL END
         WHERE id = ?`
      ).run(input.sectionId, input.effectiveFrom, input.effectiveTo, input.deducteeType, input.rateBp,
        input.thresholdSinglePaise, input.thresholdAnnualPaise, input.thresholdBasis, input.thresholdExcessOnly ? 1 : 0,
        input.returnCode, input.noPanRateBp,
        input.rateBp, input.thresholdSinglePaise, input.thresholdAnnualPaise, input.noPanRateBp, input.id)
      id = input.id
    } else {
      const res = db.prepare(
        `INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp,
           threshold_single_paise, threshold_annual_paise, threshold_basis, threshold_excess_only, return_code, no_pan_rate_bp, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(input.sectionId, input.effectiveFrom, input.effectiveTo, input.deducteeType, input.rateBp,
        input.thresholdSinglePaise, input.thresholdAnnualPaise, input.thresholdBasis, input.thresholdExcessOnly ? 1 : 0,
        input.returnCode, input.noPanRateBp)
      id = Number(res.lastInsertRowid)
    }
    const after = mapRate(db.prepare('SELECT * FROM tds_section_rates WHERE id = ?').get(id) as RateRow)
    syncLegacyColumns(db, input.sectionId)
    if (before && before.sectionId !== input.sectionId) syncLegacyColumns(db, before.sectionId)
    writeAudit(db, 'tdsRate', id, before ? 'update' : 'create', before, after)
    return after
  })()
}

export function deleteRate(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM tds_section_rates WHERE id = ?').get(id) as RateRow | undefined
  if (!existing) throw new Error('TDS rate not found')
  db.transaction(() => {
    db.prepare('DELETE FROM tds_section_rates WHERE id = ?').run(id)
    syncLegacyColumns(db, existing.section_id)
    writeAudit(db, 'tdsRate', id, 'delete', mapRate(existing), null)
  })()
}

function sectionRules(db: DB, sectionId: number): { id: number; code: string; rates: TdsRateRow[]; row: SectionRow } | null {
  const row = getSectionRow(db, sectionId)
  if (!row) return null
  return { id: row.id, code: row.code, row, rates: listRates(db, sectionId) as TdsRateRow[] }
}

// ---------------------------------------------------------------------------------------------
// Lower-deduction certificates (s.197)
// ---------------------------------------------------------------------------------------------

interface CertRow {
  id: number; ledger_id: number; section_id: number | null; certificate_no: string; rate_bp: number
  valid_from: string; valid_to: string; cap_paise: number | null
}
const mapCert = (r: CertRow): TdsCertificateRow & TdsCertificate => ({
  id: r.id, ledgerId: r.ledger_id, sectionId: r.section_id, certificateNo: r.certificate_no, rateBp: r.rate_bp,
  validFrom: r.valid_from, validTo: r.valid_to, capPaise: r.cap_paise
})

export function listCertificates(db: DB, ledgerId?: number): TdsCertificateRow[] {
  const rows = ledgerId
    ? db.prepare('SELECT * FROM tds_certificates WHERE ledger_id = ? ORDER BY valid_from DESC').all(ledgerId)
    : db.prepare('SELECT * FROM tds_certificates ORDER BY ledger_id, valid_from DESC').all()
  return (rows as CertRow[]).map(mapCert)
}

export function saveCertificate(db: DB, raw: TdsCertificateInput): TdsCertificateRow {
  const input = tdsCertificateInputSchema.parse(raw)
  if (!db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(input.ledgerId)) throw new Error('Ledger not found')
  if (input.sectionId != null && !getSectionRow(db, input.sectionId)) throw new Error('TDS section not found')
  let before: TdsCertificateRow | null = null
  let id: number
  if (input.id) {
    const existing = db.prepare('SELECT * FROM tds_certificates WHERE id = ?').get(input.id) as CertRow | undefined
    if (!existing) throw new Error('Certificate not found')
    before = mapCert(existing)
    db.prepare(
      `UPDATE tds_certificates SET ledger_id = ?, section_id = ?, certificate_no = ?, rate_bp = ?, valid_from = ?, valid_to = ?, cap_paise = ?
       WHERE id = ?`
    ).run(input.ledgerId, input.sectionId, input.certificateNo, input.rateBp, input.validFrom, input.validTo, input.capPaise, input.id)
    id = input.id
  } else {
    const res = db.prepare(
      `INSERT INTO tds_certificates (ledger_id, section_id, certificate_no, rate_bp, valid_from, valid_to, cap_paise)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(input.ledgerId, input.sectionId, input.certificateNo, input.rateBp, input.validFrom, input.validTo, input.capPaise)
    id = Number(res.lastInsertRowid)
  }
  const after = mapCert(db.prepare('SELECT * FROM tds_certificates WHERE id = ?').get(id) as CertRow)
  writeAudit(db, 'tdsCertificate', id, before ? 'update' : 'create', before, after)
  return after
}

export function deleteCertificate(db: DB, id: number): void {
  const existing = db.prepare('SELECT * FROM tds_certificates WHERE id = ?').get(id) as CertRow | undefined
  if (!existing) throw new Error('Certificate not found')
  // Entries keep their history (certificate_id → NULL via ON DELETE SET NULL); rate_bp_at stays.
  db.prepare('DELETE FROM tds_certificates WHERE id = ?').run(id)
  writeAudit(db, 'tdsCertificate', id, 'delete', mapCert(existing), null)
}

/** The certificate valid for this party/section/date (a section-specific one before a general
 *  one), with the base already deducted under it on other vouchers. */
function certificateFor(db: DB, ledgerId: number, sectionId: number, dateISO: string, excludeVoucherId?: number): CertificateUse | null {
  const row = db
    .prepare(
      `SELECT * FROM tds_certificates
       WHERE ledger_id = ? AND (section_id = ? OR section_id IS NULL) AND valid_from <= ? AND valid_to >= ?
       ORDER BY section_id IS NULL, valid_from DESC, id DESC LIMIT 1`
    )
    .get(ledgerId, sectionId, dateISO, dateISO) as CertRow | undefined
  if (!row) return null
  const { used } = db
    .prepare(
      `SELECT COALESCE(SUM(te.base_amount), 0) AS used FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id
       WHERE te.certificate_id = ? AND v.id <> ? AND ${IN_BOOKS}`
    )
    .get(row.id, excludeVoucherId ?? -1) as { used: number }
  return { certificate: mapCert(row), consumedPaise: used }
}

// ---------------------------------------------------------------------------------------------
// Payable ledgers — tagged by section (ledgers.tds_payable_section_id), the mirror of tax_type
// ---------------------------------------------------------------------------------------------

const TDS_PAYABLE_GROUP = 'Duties & Taxes'
const payableLedgerName = (code: string): string => `TDS Payable ${code}`

/** Ledger id → section id for every ledger tagged as a TDS payable ledger. */
export function payableTagMap(db: DB): Map<number, number> {
  const rows = db.prepare('SELECT id, tds_payable_section_id AS s FROM ledgers WHERE tds_payable_section_id IS NOT NULL').all() as { id: number; s: number }[]
  return new Map(rows.map((r) => [r.id, r.s]))
}

/** The (first) ledger tagged as this section's TDS payable ledger, or null. Read-only. */
export function findPayableLedger(db: DB, sectionId: number): { id: number; name: string } | null {
  return (db.prepare('SELECT id, name FROM ledgers WHERE tds_payable_section_id = ? ORDER BY id LIMIT 1').get(sectionId) as
    | { id: number; name: string }
    | undefined) ?? null
}

/**
 * Find-or-create the section's tagged payable ledger. An untagged ledger already named
 * "TDS Payable <code>" (e.g. created by hand after migration 020) is adopted and tagged rather
 * than duplicated. Callers run this inside their own transaction (saveVoucher does).
 */
export function ensureTdsPayableLedger(db: DB, sectionId: number): number {
  const section = getSectionRow(db, sectionId)
  if (!section) throw new Error('TDS section not found')
  const tagged = findPayableLedger(db, sectionId)
  if (tagged) return tagged.id
  return db.transaction(() => {
    const name = payableLedgerName(section.code)
    const byName = db.prepare('SELECT id, tds_payable_section_id AS s FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as
      | { id: number; s: number | null }
      | undefined
    if (byName && byName.s == null) {
      db.prepare('UPDATE ledgers SET tds_payable_section_id = ? WHERE id = ?').run(sectionId, byName.id)
      writeAudit(db, 'ledger', byName.id, 'update', { tdsPayableSectionId: null }, { tdsPayableSectionId: sectionId })
      return byName.id
    }
    const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(TDS_PAYABLE_GROUP) as { id: number } | undefined
    if (!group) throw new Error(`Group ${TDS_PAYABLE_GROUP} missing`)
    // The name is taken by a ledger tagged for ANOTHER section (renamed codes) — suffix it.
    const finalName = byName ? `${name} (${section.id})` : name
    const res = db.prepare('INSERT INTO ledgers (name, group_id, is_system, tds_payable_section_id) VALUES (?, ?, 0, ?)')
      .run(finalName, group.id, sectionId)
    const id = Number(res.lastInsertRowid)
    writeAudit(db, 'ledger', id, 'create', null, { id, name: finalName, groupId: group.id, tdsPayableSectionId: sectionId })
    return id
  })()
}

// ---------------------------------------------------------------------------------------------
// Rate resolution for a party
// ---------------------------------------------------------------------------------------------

interface PartyFacts {
  id: number; pan: string | null; deducteeType: DeducteeType | null; tdsSectionId: number | null
}
function partyFacts(db: DB, ledgerId: number): PartyFacts | null {
  const r = db.prepare('SELECT id, pan, deductee_type, tds_section_id FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; pan: string | null; deductee_type: DeducteeType | null; tds_section_id: number | null }
    | undefined
  if (!r) return null
  return { id: r.id, pan: r.pan, deducteeType: resolveDeducteeType(r.deductee_type, r.pan), tdsSectionId: r.tds_section_id }
}

export interface ResolvedTds {
  rate: ApplicableRate | null
  tdsPaise: number | null
  deducteeType: DeducteeType | null
  panAvailable: boolean
  /** Prior base for this party + section in the rate row's threshold period (excl. this voucher). */
  priorPaise: number
}

/** What the rate table says this deduction should be (rate, certificate, excess-only base,
 *  rounding). Shared by the suggestion and save-time validation so both always agree. */
export function resolveTds(
  db: DB, sectionId: number, partyLedgerId: number, basePaise: number, dateISO: string, excludeVoucherId?: number
): ResolvedTds {
  const rules = sectionRules(db, sectionId)
  const party = partyFacts(db, partyLedgerId)
  const panAvailable = !!party?.pan
  const deducteeType = party?.deducteeType ?? null
  if (!rules) return { rate: null, tdsPaise: null, deducteeType, panAvailable, priorPaise: 0 }
  const cert = panAvailable ? certificateFor(db, partyLedgerId, sectionId, dateISO, excludeVoucherId) : null
  const rate = applicableRate(rules, dateISO, deducteeType, panAvailable, cert)
  if (!rate) return { rate: null, tdsPaise: null, deducteeType, panAvailable, priorPaise: 0 }
  const period = thresholdPeriod(rate.row.thresholdBasis, dateISO)
  const priorPaise = priorBase(db, partyLedgerId, sectionId, period.from, period.to, excludeVoucherId)
  return { rate, tdsPaise: expectedTdsPaise(rate, basePaise, priorPaise), deducteeType, panAvailable, priorPaise }
}

// ---------------------------------------------------------------------------------------------
// Suggestion (read-only — runs while the user types)
// ---------------------------------------------------------------------------------------------

export interface TdsSuggestion {
  sectionId: number
  code: string
  /** Reference to print for the voucher date (1961 code before 1 Apr 2026, Act-2025 after). */
  reference: string
  /** Effective rate, percent (legacy field; = rateBp / 100). */
  rate: number
  rateBp: number
  basis: ApplicableRate['basis']
  tdsPaise: number
  /** Tagged payable ledger, or null when it doesn't exist yet — saveVoucher creates it
   *  (tds.autoPayable); the suggestion never writes. */
  payableLedgerId: number | null
  /** Name the payable ledger has / will be created with. */
  payableLedgerName: string
  panAvailable: boolean
  deducteeType: DeducteeType | null
  thresholdCrossed: boolean
  threshold: {
    reason: 'single' | 'aggregate' | 'none' | 'below'
    singlePaise: number
    aggregateLimitPaise: number
    basis: 'fy' | 'month'
    /** Prior base in the period (excluding this transaction), paise. */
    priorPaise: number
  }
  certificate: { id: number; certificateNo: string; rateBp: number } | null
  /** Where the section came from: the party's own flag, or the debited ledger's default. */
  sectionFrom: 'party' | 'ledger'
}

/** Prior base for this party + section inside [from, to], from recorded entries. */
function priorBase(db: DB, partyLedgerId: number, sectionId: number, from: string, to: string, excludeVoucherId?: number): number {
  return (db
    .prepare(
      `SELECT COALESCE(SUM(te.base_amount), 0) AS total
       FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id
       WHERE te.party_ledger_id = ? AND te.section_id = ? AND v.date BETWEEN ? AND ? AND v.id <> ? AND ${IN_BOOKS}`
    )
    .get(partyLedgerId, sectionId, from, to, excludeVoucherId ?? -1) as { total: number }).total
}

/**
 * Suggests a TDS deduction for a voucher to `partyLedgerId`, or null when nothing applies: the
 * party is flagged for a section, or — when it isn't — the debited expense ledger carries a
 * default section and the party has a deductee type (set, or readable off its PAN). Null too
 * when the section has no rate in force on the date. Strictly read-only.
 */
export function tdsSuggestion(
  db: DB, partyLedgerId: number, basePaise: number, dateISO: string,
  opts: { expenseLedgerId?: number | null; excludeVoucherId?: number } = {}
): TdsSuggestion | null {
  const party = partyFacts(db, partyLedgerId)
  if (!party) return null
  let sectionId = party.tdsSectionId
  let sectionFrom: TdsSuggestion['sectionFrom'] = 'party'
  if (sectionId == null && opts.expenseLedgerId != null && party.deducteeType != null) {
    const exp = db.prepare('SELECT tds_default_section_id AS s FROM ledgers WHERE id = ?').get(opts.expenseLedgerId) as { s: number | null } | undefined
    sectionId = exp?.s ?? null
    sectionFrom = 'ledger'
  }
  if (sectionId == null) return null
  const rules = sectionRules(db, sectionId)
  if (!rules) return null
  const resolved = resolveTds(db, sectionId, partyLedgerId, basePaise, dateISO, opts.excludeVoucherId)
  if (!resolved.rate || resolved.tdsPaise == null) return null
  const row = resolved.rate.row
  const prior = resolved.priorPaise
  const status = thresholdStatus(row, dateISO, basePaise, prior)
  const payable = findPayableLedger(db, sectionId)
  const cert = resolved.rate.certificateId != null
    ? (db.prepare('SELECT * FROM tds_certificates WHERE id = ?').get(resolved.rate.certificateId) as CertRow)
    : null
  const effectiveBp = resolved.rate.basis === 'certificate' ? resolved.rate.certificateRateBp! : resolved.rate.rateBp
  return {
    sectionId,
    code: rules.code,
    reference: sectionReferenceOn({ code: rules.code, legacyCode: rules.row.legacy_code, newReference: rules.row.new_reference }, dateISO),
    rate: effectiveBp / 100,
    rateBp: effectiveBp,
    basis: resolved.rate.basis,
    tdsPaise: resolved.tdsPaise,
    payableLedgerId: payable?.id ?? null,
    payableLedgerName: payable?.name ?? payableLedgerName(rules.code),
    panAvailable: resolved.panAvailable,
    deducteeType: resolved.deducteeType,
    thresholdCrossed: status.crossed,
    threshold: {
      reason: status.reason,
      singlePaise: row.thresholdSinglePaise,
      aggregateLimitPaise: row.thresholdAnnualPaise,
      basis: row.thresholdBasis,
      priorPaise: prior
    },
    certificate: cert ? { id: cert.id, certificateNo: cert.certificate_no, rateBp: cert.rate_bp } : null,
    sectionFrom
  }
}

// ---------------------------------------------------------------------------------------------
// Save-time: payable line + validation (called by saveVoucher)
// ---------------------------------------------------------------------------------------------

/** Placeholder ledger id for a payable ledger saveVoucher will create inside its transaction. */
export const PENDING_PAYABLE_LEDGER = -1

export interface PreparedTds {
  /** Lines to post (input lines + the auto payable credit, possibly on PENDING_PAYABLE_LEDGER). */
  lines: VoucherInputParsed['lines']
  /** Section whose payable ledger must be created before the lines are inserted, if any. */
  createPayableFor: number | null
  /** Basis to store on the entry. */
  basis: { rateBp: number | null; deducteeType: DeducteeType | null; certificateId: number | null } | null
  errors: PostingError[]
}

/**
 * Resolve the TDS payable credit (tds.autoPayable) and validate the voucher's TDS entry against
 * its lines and the rate table. Read-only: a payable ledger that doesn't exist yet is returned
 * as `createPayableFor` with its line on PENDING_PAYABLE_LEDGER, for saveVoucher to create and
 * substitute inside the save transaction.
 */
export function prepareVoucherTds(db: DB, input: VoucherInputParsed, existingId?: number): PreparedTds {
  const lines = input.lines.map((l) => ({ ...l }))
  const t = input.tds
  if (!t) return { lines, createPayableFor: null, basis: null, errors: [] }
  const rules = sectionRules(db, t.sectionId)
  let createPayableFor: number | null = null
  const tags = payableTagMap(db)
  if (t.autoPayable && rules) {
    const payable = findPayableLedger(db, t.sectionId)
    const ledgerId = payable?.id ?? PENDING_PAYABLE_LEDGER
    if (!payable) {
      createPayableFor = t.sectionId
      tags.set(PENDING_PAYABLE_LEDGER, t.sectionId)
    }
    lines.push({ ledgerId, drCr: 'cr', amount: t.tdsAmount, costAllocations: [] })
  }
  let resolved: ResolvedTds | null = null
  if (rules && input.partyLedgerId != null && t.baseAmount > 0) {
    resolved = resolveTds(db, t.sectionId, input.partyLedgerId, t.baseAmount, input.date, existingId)
  }
  const errors = validateTdsEntries(
    { partyLedgerId: input.partyLedgerId, lines },
    [{ sectionId: t.sectionId, baseAmount: t.baseAmount, tdsAmount: t.tdsAmount, isManual: t.isManual }],
    tags,
    () => (rules ? { code: rules.code, expectedTdsPaise: resolved?.tdsPaise ?? null } : null)
  )
  const basis = {
    rateBp: t.isManual || !resolved?.rate
      ? null
      : resolved.rate.basis === 'certificate' ? resolved.rate.certificateRateBp : resolved.rate.rateBp,
    deducteeType: resolved?.deducteeType ?? null,
    certificateId: t.isManual ? null : (resolved?.rate?.certificateId ?? null)
  }
  return { lines, createPayableFor, basis, errors }
}

// ---------------------------------------------------------------------------------------------
// Summary (by section × quarter; payable movement found by TAG, never by ledger name)
// ---------------------------------------------------------------------------------------------

export interface TdsSummaryRow {
  sectionCode: string
  quarter: string
  deductees: number
  base: number
  tds: number
  /** Credits to ledgers tagged as this section's payable in the quarter (deductions booked). */
  payableCredited: number
  /** Debits to those ledgers in the quarter (deposits to the government). */
  payableDebited: number
  /** TDS on this section's entries in the quarter already allocated to a challan. */
  allocatedToChallan: number
}

/** Section x quarter summary for a financial year, for the Tds screen's overview tab. */
export function tdsSummary(db: DB, fyStartYear: number): TdsSummaryRow[] {
  const fyFrom = `${fyStartYear}-04-01`
  const fyTo = `${fyStartYear + 1}-03-31`
  const rows = db
    .prepare(
      `SELECT te.party_ledger_id AS partyLedgerId, te.base_amount AS base, te.tds_amount AS tds,
              ts.code AS sectionCode, v.date AS date,
              CASE WHEN tec.challan_id IS NULL THEN 0 ELSE te.tds_amount END AS allocated
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN tds_sections ts ON ts.id = te.section_id
       LEFT JOIN tds_entry_challans tec ON tec.entry_id = te.id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(fyFrom, fyTo) as { partyLedgerId: number; base: number; tds: number; sectionCode: string; date: string; allocated: number }[]
  const movements = db
    .prepare(
      `SELECT ts.code AS sectionCode, v.date AS date, vl.dr_cr AS drCr, vl.amount AS amount
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN tds_sections ts ON ts.id = l.tds_payable_section_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(fyFrom, fyTo) as { sectionCode: string; date: string; drCr: 'dr' | 'cr'; amount: number }[]

  type Group = Omit<TdsSummaryRow, 'deductees'> & { deductees: Set<number> }
  const groups = new Map<string, Group>()
  const groupFor = (sectionCode: string, date: string): Group => {
    const q = tdsQuarterOf(date)
    const key = `${sectionCode}|${q.label}`
    let g = groups.get(key)
    if (!g) {
      g = { sectionCode, quarter: q.label, deductees: new Set<number>(), base: 0, tds: 0, payableCredited: 0, payableDebited: 0, allocatedToChallan: 0 }
      groups.set(key, g)
    }
    return g
  }
  for (const r of rows) {
    const g = groupFor(r.sectionCode, r.date)
    g.deductees.add(r.partyLedgerId)
    g.base += r.base
    g.tds += r.tds
    g.allocatedToChallan += r.allocated
  }
  for (const m of movements) {
    const g = groupFor(m.sectionCode, m.date)
    if (m.drCr === 'cr') g.payableCredited += m.amount
    else g.payableDebited += m.amount
  }
  return [...groups.values()]
    .map(({ deductees, ...g }) => ({ ...g, deductees: deductees.size }))
    .sort((a, b) => a.sectionCode.localeCompare(b.sectionCode) || a.quarter.localeCompare(b.quarter))
}

// ---------------------------------------------------------------------------------------------
// Challans (ITNS 281 deposits) + allocation of entries
// ---------------------------------------------------------------------------------------------

interface ChallanRow {
  id: number; date: string; bsr_code: string; challan_no: string; amount_paise: number
  payment_voucher_id: number | null; quarter: 1 | 2 | 3 | 4; fy_start_year: number
  allocated: number; entries: number
}
const mapChallan = (r: ChallanRow): TdsChallan => ({
  id: r.id, date: r.date, bsrCode: r.bsr_code, challanNo: r.challan_no, amountPaise: r.amount_paise,
  paymentVoucherId: r.payment_voucher_id, quarter: r.quarter, fyStartYear: r.fy_start_year,
  allocatedPaise: r.allocated, entryCount: r.entries
})

const CHALLAN_SELECT = `
  SELECT c.*, COALESCE(SUM(te.tds_amount), 0) AS allocated, COUNT(te.id) AS entries
  FROM tds_challans c
  LEFT JOIN tds_entry_challans tec ON tec.challan_id = c.id
  LEFT JOIN tds_entries te ON te.id = tec.entry_id`

function getChallan(db: DB, id: number): TdsChallan | null {
  const r = db.prepare(`${CHALLAN_SELECT} WHERE c.id = ? GROUP BY c.id`).get(id) as ChallanRow | undefined
  return r ? mapChallan(r) : null
}

export function listChallans(db: DB, fyStartYear: number, quarter?: number): TdsChallan[] {
  const rows = quarter
    ? db.prepare(`${CHALLAN_SELECT} WHERE c.fy_start_year = ? AND c.quarter = ? GROUP BY c.id ORDER BY c.date, c.id`).all(fyStartYear, quarter)
    : db.prepare(`${CHALLAN_SELECT} WHERE c.fy_start_year = ? GROUP BY c.id ORDER BY c.date, c.id`).all(fyStartYear)
  return (rows as ChallanRow[]).map(mapChallan)
}

export function saveChallan(db: DB, raw: TdsChallanInput): TdsChallan {
  const input = tdsChallanInputSchema.parse(raw)
  if (input.paymentVoucherId != null) {
    const v = db.prepare(`SELECT 1 FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED}`).get(input.paymentVoucherId)
    if (!v) throw new Error('Payment voucher not found')
  }
  return db.transaction(() => {
    let before: TdsChallan | null = null
    let id: number
    if (input.id) {
      before = getChallan(db, input.id)
      if (!before) throw new Error('Challan not found')
      if (before.allocatedPaise > input.amountPaise) {
        throw new Error(`Challan amount can't be below the TDS already allocated to it (${plainRupees(before.allocatedPaise)})`)
      }
      db.prepare(
        `UPDATE tds_challans SET date = ?, bsr_code = ?, challan_no = ?, amount_paise = ?, payment_voucher_id = ?, quarter = ?, fy_start_year = ?
         WHERE id = ?`
      ).run(input.date, input.bsrCode, input.challanNo, input.amountPaise, input.paymentVoucherId, input.quarter, input.fyStartYear, input.id)
      id = input.id
    } else {
      const res = db.prepare(
        `INSERT INTO tds_challans (date, bsr_code, challan_no, amount_paise, payment_voucher_id, quarter, fy_start_year)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(input.date, input.bsrCode, input.challanNo, input.amountPaise, input.paymentVoucherId, input.quarter, input.fyStartYear)
      id = Number(res.lastInsertRowid)
    }
    const after = getChallan(db, id)!
    writeAudit(db, 'tdsChallan', id, before ? 'update' : 'create', before, after)
    return after
  })()
}

export function deleteChallan(db: DB, id: number): void {
  const before = getChallan(db, id)
  if (!before) throw new Error('Challan not found')
  db.transaction(() => {
    db.prepare('DELETE FROM tds_challans WHERE id = ?').run(id) // allocations cascade
    writeAudit(db, 'tdsChallan', id, 'delete', before, null)
  })()
}

/** Allocate entries to a challan (moving them off any challan they were on). Rejects entries of
 *  binned vouchers and an allocation that would exceed the challan amount. */
export function allocateEntries(db: DB, challanId: number, entryIds: number[]): TdsChallan {
  const challan = getChallan(db, challanId)
  if (!challan) throw new Error('Challan not found')
  const ids = [...new Set(entryIds)]
  return db.transaction(() => {
    const entryStmt = db.prepare(
      `SELECT te.id, te.tds_amount AS tds, tec.challan_id AS current
       FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id
       LEFT JOIN tds_entry_challans tec ON tec.entry_id = te.id
       WHERE te.id = ? AND ${NOT_DELETED}`
    )
    let adding = 0
    for (const id of ids) {
      const e = entryStmt.get(id) as { id: number; tds: number; current: number | null } | undefined
      if (!e) throw new Error(`TDS entry ${id} not found`)
      if (e.current !== challanId) adding += e.tds
    }
    if (challan.allocatedPaise + adding > challan.amountPaise) {
      throw new Error(
        `Allocating ${plainRupees(adding)} would exceed challan ${challan.challanNo}'s ${plainRupees(challan.amountPaise)} (already ${plainRupees(challan.allocatedPaise)} allocated)`
      )
    }
    const upsert = db.prepare(
      `INSERT INTO tds_entry_challans (entry_id, challan_id) VALUES (?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET challan_id = excluded.challan_id`
    )
    for (const id of ids) upsert.run(id, challanId)
    const after = getChallan(db, challanId)!
    writeAudit(db, 'tdsChallan', challanId, 'update', challan, { ...after, allocatedEntryIds: ids })
    return after
  })()
}

export function unallocateEntries(db: DB, entryIds: number[]): void {
  db.transaction(() => {
    const find = db.prepare('SELECT challan_id FROM tds_entry_challans WHERE entry_id = ?')
    const del = db.prepare('DELETE FROM tds_entry_challans WHERE entry_id = ?')
    for (const id of new Set(entryIds)) {
      const r = find.get(id) as { challan_id: number } | undefined
      if (!r) continue
      del.run(id)
      writeAudit(db, 'tdsChallan', r.challan_id, 'update', { allocatedEntryId: id }, { unallocatedEntryId: id })
    }
  })()
}

export interface TdsEntryRow {
  entryId: number
  voucherId: number
  voucherNumber: string
  date: string
  partyLedgerId: number
  partyName: string
  pan: string | null
  sectionId: number
  sectionCode: string
  baseAmount: number
  tdsAmount: number
  rateBp: number | null
  deducteeType: string | null
  isManual: boolean
  challanId: number | null
}

/** Entries (in the books) for an FY / quarter not yet allocated to any challan. */
export function unallocatedEntries(db: DB, fyStartYear: number, quarter?: 1 | 2 | 3 | 4): TdsEntryRow[] {
  const { from, to } = quarter ? tdsQuarterBounds(fyStartYear, quarter) : fyFromStartYear(fyStartYear)
  return entriesBetween(db, from, to).filter((e) => e.challanId == null)
}

function entriesBetween(db: DB, from: string, to: string): TdsEntryRow[] {
  const rows = db
    .prepare(
      `SELECT te.id AS entryId, v.id AS voucherId, v.number AS voucherNumber, v.date AS date,
              te.party_ledger_id AS partyLedgerId, l.name AS partyName, te.pan AS pan,
              te.section_id AS sectionId, ts.code AS sectionCode, te.base_amount AS baseAmount, te.tds_amount AS tdsAmount,
              te.rate_bp_at AS rateBp, te.deductee_type_at AS deducteeType, te.is_manual AS isManual,
              tec.challan_id AS challanId
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN tds_sections ts ON ts.id = te.section_id
       JOIN ledgers l ON l.id = te.party_ledger_id
       LEFT JOIN tds_entry_challans tec ON tec.entry_id = te.id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as (Omit<TdsEntryRow, 'isManual'> & { isManual: number })[]
  return rows.map((r) => ({ ...r, isManual: !!r.isManual }))
}

// ---------------------------------------------------------------------------------------------
// 26Q CSV
// ---------------------------------------------------------------------------------------------

/**
 * 26Q deductee code: '01' company, '02' other than company (Protean/NSDL e-TDS file format —
 * see the citation block in migration 020). Unknown type → '02' is NOT assumed; left blank.
 */
function deducteeCode26q(type: string | null): string {
  if (type === 'company') return '01'
  if (type === 'individual_huf' || type === 'firm' || type === 'other') return '02'
  return ''
}

/**
 * CSV of deductee-wise TDS entries for a quarter — for manual import into NSDL's Return
 * Preparation Utility (RPU), NOT a ready-to-file FVU. Written to the company's exports folder.
 * The first seven columns are unchanged from before migration 020; deductee type, rate and the
 * allocated challan (BSR / date / serial) follow.
 */
export function export26qCsv(db: DB, _company: CompanyInfo, slug: string, fyStartYear: number, quarter: 1 | 2 | 3 | 4): string {
  const { from, to } = tdsQuarterBounds(fyStartYear, quarter)
  const entries = entriesBetween(db, from, to)
  const challans = new Map<number, { bsr: string; date: string; no: string }>()
  for (const c of db.prepare('SELECT id, bsr_code, date, challan_no FROM tds_challans').all() as { id: number; bsr_code: string; date: string; challan_no: string }[]) {
    challans.set(c.id, { bsr: c.bsr_code, date: c.date, no: c.challan_no })
  }
  const csvRows = entries.map((r) => {
    const c = r.challanId != null ? challans.get(r.challanId) : undefined
    return [
      r.partyName,
      r.pan ?? '',
      r.sectionCode,
      r.date,
      r.voucherNumber,
      plainRupees(r.baseAmount),
      plainRupees(r.tdsAmount),
      deducteeCode26q(r.deducteeType),
      r.rateBp != null ? (r.rateBp / 100).toFixed(2) : '',
      c?.bsr ?? '',
      c?.date ?? '',
      c?.no ?? ''
    ]
  })
  const csv = rowsToCsv(
    ['Deductee', 'PAN', 'Section', 'Voucher Date', 'Voucher No', 'Base (Rs)', 'TDS (Rs)',
      'Deductee Code', 'Rate (%)', 'Challan BSR', 'Challan Date', 'Challan Serial'],
    csvRows
  )
  const fy = fyFromStartYear(fyStartYear)
  const path = join(companyExportsDir(slug), `tds-26q-${fy.label}-Q${quarter}.csv`)
  writeFileSync(path, csv)
  return path
}
