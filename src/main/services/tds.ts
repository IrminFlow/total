import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, TdsSection } from '@shared/domain'
import type { TdsSectionInput } from '@shared/schemas'
import { computeTds, thresholdCrossed, tdsQuarterOf } from '@shared/tds'
import {
  challanTotal, FILE_FORMAT, form16aDueDate, statementDueDate, toFlatFile, validateReturn,
  type ReturnHeader, type TdsChallan, type TdsDeduction, type TdsFormCode, type TdsReturnWorking
} from '@shared/tdsReturn'
import { buildForm16a, type Form16a } from '@shared/form16a'
import { sectionForDate } from '@shared/itAct2025'
import type { TdsChallanInput } from '@shared/schemas'
import { fyFromStartYear, toDisplayDate, todayISO } from '@shared/dates'
import { rowsToCsv } from '@shared/csv'
import { formatPaise, plainRupees } from '@shared/money'
import { companyExportsDir } from '../paths'
import { getTdsFiling } from './config'
import { findOrCreateLedger } from './masters'
import { writeExportPdf } from './pdf'
// IN_BOOKS, not NOT_DELETED: optional (memorandum) and unmatured post-dated vouchers are out of
// the books, so their TDS entries must not reach the 26Q export, the summary, or the FY-to-date
// threshold base — filing figures must tie to the ledger.
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'
import { resolveDeduction, type CertificateEffect } from './tdsCertificates'
import type { AppliedRate } from '@shared/tds/lowerDeduction'

interface SectionRow {
  id: number; code: string; description: string; rate: number
  threshold_single: number; threshold_annual: number
  code_2025: string | null
}
const mapSection = (r: SectionRow): TdsSection => ({
  id: r.id, code: r.code, description: r.description, rate: r.rate,
  thresholdSingle: r.threshold_single, thresholdAnnual: r.threshold_annual,
  // The Income-tax Act 2025 reference, when a user has recorded one. NULL until they do — the
  // app's own proposed mapping is unverified and must never be silently written into the master.
  // See src/shared/itAct2025.ts.
  code2025: r.code_2025
})

export function listSections(db: DB): TdsSection[] {
  return (db.prepare('SELECT * FROM tds_sections ORDER BY code').all() as SectionRow[]).map(mapSection)
}

/** Create a new section, or update an existing one when `input.id` is given. */
export function saveSection(db: DB, input: TdsSectionInput): TdsSection {
  if (input.id) {
    const id = input.id
    const existing = db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(id) as SectionRow | undefined
    if (!existing) throw new Error('TDS section not found')
    db.prepare('UPDATE tds_sections SET code = ?, description = ?, rate = ?, threshold_single = ?, threshold_annual = ?, code_2025 = ? WHERE id = ?')
      .run(input.code, input.description, input.rate, input.thresholdSingle, input.thresholdAnnual, input.code2025, id)
    const updated = mapSection(db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(id) as SectionRow)
    writeAudit(db, 'tdsSection', id, 'update', mapSection(existing), updated)
    return updated
  }
  const res = db
    .prepare('INSERT INTO tds_sections (code, description, rate, threshold_single, threshold_annual, code_2025) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.code, input.description, input.rate, input.thresholdSingle, input.thresholdAnnual, input.code2025)
  const created = mapSection(db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(res.lastInsertRowid) as SectionRow)
  writeAudit(db, 'tdsSection', created.id, 'create', null, created)
  return created
}

export interface TdsSuggestion {
  sectionId: number
  code: string
  rate: number
  tdsPaise: number
  payableLedgerId: number
  panAvailable: boolean
  thresholdCrossed: boolean
  /**
   * The section 197 / 197A certificate in force for this payee, section and date, with its
   * Rule 28AA consumption — or null, which is the ordinary case and the unchanged behaviour.
   */
  certificate: CertificateEffect | null
  /**
   * The rate(s) `tdsPaise` is actually made of. One entry normally; TWO when this payment
   * straddles the certificate's Rule 28AA(4) ceiling, because the part above the ceiling reverts
   * to the ordinary section rate inside the very same payment — and is filed as its own deductee
   * row. Empty only for a zero-amount payment.
   */
  ratesApplied: AppliedRate[]
  /** True when the certificate's ceiling is spent as at the end of this payment. */
  certificateExhausted: boolean
}

/**
 * Suggests a TDS deduction for a payment/journal to `partyLedgerId`, or null when the party isn't
 * flagged for TDS at all. `payableLedgerId` is auto-created ("TDS Payable <code>" under Duties &
 * Taxes) so the caller can post the credit line without a separate master-creation round trip.
 *
 * The amount comes from `resolveDeduction`, which honours a section 197 lower-deduction
 * certificate held for the payee's PAN. With no certificate on file it is `computeTds(rate, base,
 * panAvailable)` — the same call this function used to make directly, including the section 206AA
 * 20% floor when there is no PAN.
 *
 * `excludeVoucherId` is the voucher being edited, if any: its own lines are already in the books
 * and would otherwise consume the payee's own ceiling before we ask how much is left, so a saved
 * voucher re-opened for editing would deduct at a stricter rate the second time.
 */
export function tdsSuggestion(
  db: DB,
  partyLedgerId: number,
  basePaise: number,
  dateISO: string,
  excludeVoucherId?: number
): TdsSuggestion | null {
  const ledger = db.prepare('SELECT tds_section_id, pan FROM ledgers WHERE id = ?').get(partyLedgerId) as
    | { tds_section_id: number | null; pan: string | null }
    | undefined
  if (!ledger || ledger.tds_section_id === null) return null

  const section = db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(ledger.tds_section_id) as SectionRow
  const panAvailable = !!ledger.pan
  const deduction = resolveDeduction(db, {
    pan: ledger.pan,
    sectionCode: section.code,
    normalRatePercent: section.rate,
    basePaise,
    date: dateISO,
    excludeVoucherId
  })
  const tdsPaise = deduction.tdsPaise
  const payableLedgerId = findOrCreateLedger(db, `TDS Payable ${section.code}`, 'Duties & Taxes')

  const q = tdsQuarterOf(dateISO)
  const fyFrom = `${q.fyStartYear}-04-01`
  const fyTo = `${q.fyStartYear + 1}-03-31`
  const soFar = db
    .prepare(
      `SELECT COALESCE(SUM(te.base_amount), 0) AS total
       FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id
       WHERE te.party_ledger_id = ? AND te.section_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .get(partyLedgerId, section.id, fyFrom, fyTo) as { total: number }

  const crossed = thresholdCrossed(
    { thresholdSingle: section.threshold_single, thresholdAnnual: section.threshold_annual },
    basePaise,
    soFar.total
  )

  return {
    sectionId: section.id,
    code: section.code,
    rate: section.rate,
    tdsPaise,
    payableLedgerId,
    panAvailable,
    thresholdCrossed: crossed,
    certificate: deduction.certificate,
    ratesApplied: deduction.ratesApplied,
    certificateExhausted: deduction.certificateExhausted
  }
}

export interface TdsSummaryRow {
  sectionCode: string
  quarter: string
  deductees: number
  base: number
  tds: number
}

/** Section x quarter summary for a financial year, for the Tds screen's overview tab. */
export function tdsSummary(db: DB, fyStartYear: number): TdsSummaryRow[] {
  const fyFrom = `${fyStartYear}-04-01`
  const fyTo = `${fyStartYear + 1}-03-31`
  const rows = db
    .prepare(
      `SELECT te.party_ledger_id AS partyLedgerId, te.base_amount AS base, te.tds_amount AS tds,
              ts.code AS sectionCode, v.date AS date
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN tds_sections ts ON ts.id = te.section_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}`
    )
    .all(fyFrom, fyTo) as { partyLedgerId: number; base: number; tds: number; sectionCode: string; date: string }[]

  const groups = new Map<string, { sectionCode: string; quarter: string; deductees: Set<number>; base: number; tds: number }>()
  for (const r of rows) {
    const q = tdsQuarterOf(r.date)
    const key = `${r.sectionCode}|${q.label}`
    const g = groups.get(key) ?? { sectionCode: r.sectionCode, quarter: q.label, deductees: new Set<number>(), base: 0, tds: 0 }
    g.deductees.add(r.partyLedgerId)
    g.base += r.base
    g.tds += r.tds
    groups.set(key, g)
  }
  return [...groups.values()]
    .map(({ sectionCode, quarter, deductees, base, tds }) => ({ sectionCode, quarter, deductees: deductees.size, base, tds }))
    .sort((a, b) => a.sectionCode.localeCompare(b.sectionCode) || a.quarter.localeCompare(b.quarter))
}

function quarterBounds(fyStartYear: number, quarter: 1 | 2 | 3 | 4): { from: string; to: string } {
  const table: Record<1 | 2 | 3 | 4, [number, string, string]> = {
    1: [fyStartYear, '04-01', '06-30'],
    2: [fyStartYear, '07-01', '09-30'],
    3: [fyStartYear, '10-01', '12-31'],
    4: [fyStartYear + 1, '01-01', '03-31']
  }
  const [year, from, to] = table[quarter]
  return { from: `${year}-${from}`, to: `${year}-${to}` }
}

/**
 * CSV of deductee-wise TDS entries for a quarter — for manual import into NSDL's Return
 * Preparation Utility (RPU), NOT a ready-to-file FVU. Written to the company's exports folder.
 */
export function export26qCsv(db: DB, _company: CompanyInfo, slug: string, fyStartYear: number, quarter: 1 | 2 | 3 | 4): string {
  const { from, to } = quarterBounds(fyStartYear, quarter)
  const rows = db
    .prepare(
      `SELECT l.name AS deductee, te.pan AS pan, ts.code AS section, v.date AS date, v.number AS number,
              te.base_amount AS base, te.tds_amount AS tds
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN tds_sections ts ON ts.id = te.section_id
       JOIN ledgers l ON l.id = te.party_ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as { deductee: string; pan: string | null; section: string; date: string; number: string; base: number; tds: number }[]

  const csvRows = rows.map((r) => [
    r.deductee,
    r.pan ?? '',
    r.section,
    r.date,
    r.number,
    plainRupees(r.base),
    plainRupees(r.tds)
  ])
  const csv = rowsToCsv(['Deductee', 'PAN', 'Section', 'Voucher Date', 'Voucher No', 'Base (Rs)', 'TDS (Rs)'], csvRows)
  const fy = fyFromStartYear(fyStartYear)
  const path = join(companyExportsDir(slug), `tds-26q-${fy.label}-Q${quarter}.csv`)
  writeFileSync(path, csv)
  return path
}

// ---------- challans (roadmap #360) ----------

/**
 * The tax was paid with a challan, and until now nothing recorded which one.
 *
 * That is the actual reason a business pays somebody else to file: the deductions are all here,
 * and every one of them has to be attached to a BSR code, a date and a five-digit serial that
 * exist only on a piece of paper from the bank. Nothing about a challan can be derived, so all of
 * it is entered.
 */
interface ChallanRow {
  id: number; form: '24Q' | '26Q'; bsr_code: string; paid_on: string; serial: string
  tax: number; surcharge: number; cess: number; interest: number; fee: number
  book_entry: number; note: string | null
}

const mapChallan = (r: ChallanRow): TdsChallan & { form: TdsFormCode; note: string | null } => ({
  id: r.id,
  form: r.form,
  bsrCode: r.bsr_code,
  paidOn: r.paid_on,
  serial: r.serial,
  tax: r.tax,
  surcharge: r.surcharge,
  cess: r.cess,
  interest: r.interest,
  fee: r.fee,
  bookEntry: r.book_entry === 1,
  note: r.note
})

export function listChallans(db: DB, fyStartYear: number): (TdsChallan & { form: TdsFormCode; note: string | null; linked: number; claimed: number })[] {
  const fy = fyFromStartYear(fyStartYear)
  // A challan for Q4 is paid in April or May of the next year, so the window runs to 31 May
  // rather than to 31 March — a challan list that stopped at the year end would hide exactly the
  // challans the Q4 statement needs.
  const rows = db
    .prepare('SELECT * FROM tds_challans WHERE paid_on BETWEEN ? AND ? ORDER BY paid_on, id')
    .all(fy.from, `${fyStartYear + 1}-05-31`) as ChallanRow[]
  return rows.map((r) => {
    const use = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tds_amount), 0) AS claimed FROM tds_entries WHERE challan_id = ?')
      .get(r.id) as { n: number; claimed: number }
    return { ...mapChallan(r), linked: use.n, claimed: use.claimed }
  })
}

export function saveChallan(db: DB, input: TdsChallanInput): number {
  if (input.id) {
    const before = db.prepare('SELECT * FROM tds_challans WHERE id = ?').get(input.id) as ChallanRow | undefined
    if (!before) throw new Error('Challan not found')
    db.prepare(
      `UPDATE tds_challans SET form = ?, bsr_code = ?, paid_on = ?, serial = ?, tax = ?, surcharge = ?,
        cess = ?, interest = ?, fee = ?, book_entry = ?, note = ? WHERE id = ?`
    ).run(
      input.form, input.bsrCode, input.paidOn, input.serial, input.tax, input.surcharge,
      input.cess, input.interest, input.fee, input.bookEntry ? 1 : 0, input.note, input.id
    )
    const after = db.prepare('SELECT * FROM tds_challans WHERE id = ?').get(input.id) as ChallanRow
    writeAudit(db, 'tdsChallan', input.id, 'update', mapChallan(before), mapChallan(after))
    return input.id
  }
  const res = db
    .prepare(
      `INSERT INTO tds_challans (form, bsr_code, paid_on, serial, tax, surcharge, cess, interest, fee, book_entry, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.form, input.bsrCode, input.paidOn, input.serial, input.tax, input.surcharge,
      input.cess, input.interest, input.fee, input.bookEntry ? 1 : 0, input.note
    )
  const id = Number(res.lastInsertRowid)
  writeAudit(db, 'tdsChallan', id, 'create', null, mapChallan(db.prepare('SELECT * FROM tds_challans WHERE id = ?').get(id) as ChallanRow))
  return id
}

export function deleteChallan(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM tds_challans WHERE id = ?').get(id) as ChallanRow | undefined
  if (!before) return
  // The deductions survive and become unlinked again, which is the honest state: the tax was
  // still deducted, it just no longer claims to have been paid with this challan.
  db.prepare('UPDATE tds_entries SET challan_id = NULL WHERE challan_id = ?').run(id)
  db.prepare('DELETE FROM tds_challans WHERE id = ?').run(id)
  writeAudit(db, 'tdsChallan', id, 'delete', mapChallan(before), null)
}

/** Attach deductions to a challan, or detach them by passing null. */
export function linkDeductions(db: DB, entryIds: number[], challanId: number | null): number {
  if (entryIds.length === 0) return 0
  if (challanId !== null) {
    const exists = db.prepare('SELECT id FROM tds_challans WHERE id = ?').get(challanId)
    if (!exists) throw new Error('Challan not found')
  }
  const placeholders = entryIds.map(() => '?').join(',')
  const res = db.prepare(`UPDATE tds_entries SET challan_id = ? WHERE id IN (${placeholders})`).run(challanId, ...entryIds)
  writeAudit(db, 'tdsChallan', challanId ?? 0, 'update', null, { linked: entryIds, challanId })
  return res.changes
}

// ---------- the quarterly return (roadmap #360) ----------

/**
 * The deductions of a quarter, with the section reference resolved for each payment's own date.
 *
 * `24Q` is salary and `26Q` is everything else. This app posts salary TDS through payroll and
 * everything else through `tds_entries`, so 26Q is built from the entries and 24Q is built from
 * the entries that happen to sit under section 192 — which is the honest mapping, and is stated
 * on the screen. A business running payroll here and filing 24Q will still need the salary
 * annexure, which no set of books can produce on its own.
 */
export function tdsReturnWorking(
  db: DB,
  company: CompanyInfo,
  form: TdsFormCode,
  fyStartYear: number,
  quarter: 1 | 2 | 3 | 4
): TdsReturnWorking {
  const { from, to } = quarterBounds(fyStartYear, quarter)
  const rows = db
    .prepare(
      `SELECT te.id AS entryId, te.challan_id AS challanId, l.name AS deducteeName, te.pan AS pan,
              ts.code AS code, ts.code_2025 AS code2025, ts.rate AS sectionRate,
              v.date AS paidOn, v.number AS voucherNumber,
              te.base_amount AS amountPaid, te.tds_amount AS tds
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN tds_sections ts ON ts.id = te.section_id
       JOIN ledgers l ON l.id = te.party_ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, te.id`
    )
    .all(from, to) as {
      entryId: number; challanId: number | null; deducteeName: string; pan: string | null
      code: string; code2025: string | null; sectionRate: number
      paidOn: string; voucherNumber: string; amountPaid: number; tds: number
    }[]

  const forForm = rows.filter((r) => (form === '24Q' ? r.code.toUpperCase().startsWith('192') : !r.code.toUpperCase().startsWith('192')))

  const deductions: TdsDeduction[] = forForm.map((r) => {
    const section = sectionForDate({ code: r.code, code2025: r.code2025 }, r.paidOn)
    return {
      entryId: r.entryId,
      challanId: r.challanId,
      deducteeName: r.deducteeName,
      pan: r.pan,
      // '01' company / '02' other. The books do not record a party's constitution, and guessing
      // it from the name is exactly the kind of confident wrongness this app avoids — '02' is the
      // safe default and the export's caveats say so.
      deducteeCode: '02',
      sectionCode: section.code,
      sectionUnverified: section.unverified,
      paidOn: r.paidOn,
      // These books post the deduction on the voucher that creates the liability, so the two
      // dates are the same. Kept as separate fields because the return asks for both, and a
      // future entry form that separates them must not have to change this shape.
      deductedOn: r.paidOn,
      amountPaid: r.amountPaid,
      tds: r.tds,
      surcharge: 0,
      cess: 0,
      rate: r.tds === 0 || r.amountPaid === 0 ? r.sectionRate : (r.tds / r.amountPaid) * 100,
      voucherNumber: r.voucherNumber
    }
  })

  const challanIds = new Set(deductions.map((d) => d.challanId).filter((x): x is number => x !== null))
  const challans = (
    db.prepare('SELECT * FROM tds_challans WHERE form = ? ORDER BY paid_on, id').all(form) as ChallanRow[]
  )
    .map(mapChallan)
    .filter((c) => challanIds.has(c.id))

  const working: TdsReturnWorking = {
    form,
    fyStartYear,
    quarter,
    label: `Q${quarter} FY${fyStartYear}-${String(fyStartYear + 1).slice(2)}`,
    from,
    to,
    dueDate: statementDueDate(fyStartYear, quarter),
    challans,
    deductions,
    totalPaid: deductions.reduce((s, d) => s + d.amountPaid, 0),
    totalTds: deductions.reduce((s, d) => s + d.tds, 0),
    unlinkedTds: deductions.filter((d) => d.challanId === null).reduce((s, d) => s + d.tds, 0),
    issues: []
  }
  working.issues = validateReturn(working, returnHeader(db, company))
  return working
}

function returnHeader(db: DB, company: CompanyInfo): ReturnHeader {
  const filing = getTdsFiling(db)
  return {
    tan: company.tan,
    pan: company.pan,
    deductorName: company.name,
    deductorType: filing.deductorType,
    responsiblePerson: filing.responsiblePerson,
    responsibleDesignation: filing.responsibleDesignation,
    address: company.address,
    email: company.email,
    phone: company.phone
  }
}

/**
 * The quarter as CSVs the Return Preparation Utility's operator can work from.
 *
 * Two files: the challans, and the deductees under them. This is the SAFE export — nothing in it
 * depends on a published file layout, and everything in it is a fact out of the books. It is what
 * somebody currently retypes from a printout.
 */
export function exportTdsReturnCsv(
  db: DB,
  company: CompanyInfo,
  slug: string,
  form: TdsFormCode,
  fyStartYear: number,
  quarter: 1 | 2 | 3 | 4
): { challansPath: string; deducteesPath: string; issues: TdsReturnWorking['issues'] } {
  const w = tdsReturnWorking(db, company, form, fyStartYear, quarter)
  const fy = fyFromStartYear(fyStartYear)
  const stem = `tds-${form.toLowerCase()}-${fy.label}-Q${quarter}`

  const challansCsv = rowsToCsv(
    ['BSR Code', 'Challan Date', 'Serial', 'Tax (Rs)', 'Surcharge (Rs)', 'Cess (Rs)', 'Interest (Rs)', 'Fee (Rs)', 'Total (Rs)', 'Book entry'],
    w.challans.map((c) => [
      c.bsrCode, c.paidOn, c.serial, plainRupees(c.tax), plainRupees(c.surcharge), plainRupees(c.cess),
      plainRupees(c.interest), plainRupees(c.fee), plainRupees(challanTotal(c)), c.bookEntry ? 'Y' : 'N'
    ])
  )
  const challansPath = join(companyExportsDir(slug), `${stem}-challans.csv`)
  writeFileSync(challansPath, challansCsv)

  const byId = new Map(w.challans.map((c) => [c.id, c]))
  const deducteesCsv = rowsToCsv(
    ['Deductee', 'PAN', 'Deductee code', 'Section', 'Paid on', 'Deducted on', 'Amount paid (Rs)', 'TDS (Rs)', 'Rate %', 'Voucher', 'Challan BSR', 'Challan date', 'Challan serial'],
    w.deductions.map((d) => {
      const c = d.challanId === null ? null : byId.get(d.challanId)
      return [
        d.deducteeName, d.pan ?? 'PANNOTAVBL', d.deducteeCode, d.sectionCode, d.paidOn, d.deductedOn,
        plainRupees(d.amountPaid), plainRupees(d.tds), d.rate.toFixed(2), d.voucherNumber,
        c?.bsrCode ?? '', c?.paidOn ?? '', c?.serial ?? ''
      ]
    })
  )
  const deducteesPath = join(companyExportsDir(slug), `${stem}-deductees.csv`)
  writeFileSync(deducteesPath, deducteesCsv)

  return { challansPath, deducteesPath, issues: w.issues }
}

/**
 * The '^'-separated e-TDS file.
 *
 * THE RECORD LAYOUT IS NOW VERIFIED against the published Protean File Format workbooks — see
 * `FILE_FORMAT` in src/shared/tdsReturn.ts, which names them. THE FILE IS STILL NOT FILEABLE, and
 * that is a different statement: it carries empty slots in Batch Header fields the format marks
 * mandatory and these books have never held (the deductor's State code and PIN, the responsible
 * person's PAN, address, State, PIN and mobile). `blankMandatoryFields` names every one of them.
 *
 * So the acknowledgement stays, the `.unverified.txt` name stays, and the message the caller has to
 * agree to says what is actually true rather than what used to be true. The file must go through
 * the FVU, and the FVU will reject it until somebody fills those fields in — which is the correct
 * outcome, because the alternative is a file that passes because the app invented a PIN code.
 *
 * Refuses outright when the return has a blocking issue. A file built from a return that cannot
 * be filed is not a draft, it is a way to waste an afternoon at a facilitation centre.
 */
export function exportTdsReturnFile(
  db: DB,
  company: CompanyInfo,
  slug: string,
  form: TdsFormCode,
  fyStartYear: number,
  quarter: 1 | 2 | 3 | 4,
  acknowledgedUnverifiedFormat: boolean
): { path: string; lineCount: number; unverifiedFormat: boolean; blankMandatoryFields: string[]; formatVersion: string } {
  if (!acknowledgedUnverifiedFormat) {
    throw new Error(
      'This file cannot be filed as it stands: it leaves mandatory deductor and responsible-person fields empty ' +
        'because these books do not hold them, and it has never been through the FVU. Acknowledge that before exporting.'
    )
  }
  const w = tdsReturnWorking(db, company, form, fyStartYear, quarter)
  const blocking = w.issues.filter((i) => i.severity === 'blocking')
  if (blocking.length > 0) {
    throw new Error(`This return cannot be filed yet: ${blocking[0]!.message}`)
  }
  const out = toFlatFile(w, returnHeader(db, company), todayISO())
  const fy = fyFromStartYear(fyStartYear)
  const path = join(companyExportsDir(slug), `tds-${form.toLowerCase()}-${fy.label}-Q${quarter}.unverified.txt`)
  writeFileSync(path, out.text)
  return {
    path,
    lineCount: out.lineCount,
    unverifiedFormat: out.unverifiedFormat,
    blankMandatoryFields: out.blankMandatoryFields,
    formatVersion: FILE_FORMAT.version
  }
}

// ---------- Form 16A (roadmap #361) ----------

/** Parties with something to certify in a quarter — the picker's list. */
export function form16aDeductees(
  db: DB,
  fyStartYear: number,
  quarter: 1 | 2 | 3 | 4
): { ledgerId: number; name: string; pan: string | null; tds: number }[] {
  const { from, to } = quarterBounds(fyStartYear, quarter)
  return db
    .prepare(
      `SELECT te.party_ledger_id AS ledgerId, l.name AS name, l.pan AS pan, SUM(te.tds_amount) AS tds
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN ledgers l ON l.id = te.party_ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       GROUP BY te.party_ledger_id
       HAVING SUM(te.tds_amount) > 0
       ORDER BY l.name`
    )
    .all(from, to) as { ledgerId: number; name: string; pan: string | null; tds: number }[]
}

/** One vendor's quarterly certificate. A working copy — see src/shared/form16a.ts. */
export function form16aFor(
  db: DB,
  company: CompanyInfo,
  ledgerId: number,
  fyStartYear: number,
  quarter: 1 | 2 | 3 | 4
): Form16a {
  const { from, to } = quarterBounds(fyStartYear, quarter)
  const party = db.prepare('SELECT name, pan FROM ledgers WHERE id = ?').get(ledgerId) as
    | { name: string; pan: string | null }
    | undefined
  if (!party) throw new Error('Party not found')

  const rows = db
    .prepare(
      `SELECT ts.code AS code, ts.code_2025 AS code2025, ts.rate AS sectionRate,
              v.date AS paidOn, v.number AS voucherNumber,
              te.base_amount AS amountPaid, te.tds_amount AS tds,
              c.bsr_code AS bsrCode, c.paid_on AS challanPaidOn, c.serial AS challanSerial
       FROM tds_entries te
       JOIN vouchers v ON v.id = te.voucher_id
       JOIN tds_sections ts ON ts.id = te.section_id
       LEFT JOIN tds_challans c ON c.id = te.challan_id
       WHERE te.party_ledger_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, te.id`
    )
    .all(ledgerId, from, to) as {
      code: string; code2025: string | null; sectionRate: number
      paidOn: string; voucherNumber: string; amountPaid: number; tds: number
      bsrCode: string | null; challanPaidOn: string | null; challanSerial: string | null
    }[]

  return buildForm16a({
    deducteeLedgerId: ledgerId,
    deducteeName: party.name,
    deducteePan: party.pan,
    deductorName: company.name,
    deductorTan: company.tan,
    deductorPan: company.pan,
    fyStartYear,
    quarter,
    from,
    to,
    dueDate: form16aDueDate(fyStartYear, quarter),
    deductions: rows.map((r) => {
      const section = sectionForDate({ code: r.code, code2025: r.code2025 }, r.paidOn)
      return {
        sectionCode: section.code,
        sectionUnverified: section.unverified,
        paidOn: r.paidOn,
        amountPaid: r.amountPaid,
        tds: r.tds,
        rate: r.tds === 0 || r.amountPaid === 0 ? r.sectionRate : (r.tds / r.amountPaid) * 100,
        voucherNumber: r.voucherNumber,
        challan: r.bsrCode ? { bsrCode: r.bsrCode, paidOn: r.challanPaidOn as string, serial: r.challanSerial as string } : null
      }
    })
  })
}

const esc = (s: string | null): string => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The certificate, as paper.
 *
 * Headed "working copy" in the title, in the tag, and in a box the reader cannot miss. That is
 * not defensive drafting: a vendor who files their return against this instead of their 26AS will
 * get a demand, and the only thing standing between them and that is the sentence on this page.
 */
export async function form16aPdf(
  db: DB,
  company: CompanyInfo,
  slug: string,
  ledgerId: number,
  fyStartYear: number,
  quarter: 1 | 2 | 3 | 4
): Promise<string> {
  const f = form16aFor(db, company, ledgerId, fyStartYear, quarter)
  const money = (p: number): string => formatPaise(p)

  const sectionRows = f.bySection
    .map(
      (s) =>
        `<tr><td>${esc(s.sectionCode)}${s.unverified ? ' <span class="flag">unverified</span>' : ''}</td>` +
        `<td class="r num">${money(s.amountPaid)}</td><td class="r num">${money(s.tds)}</td></tr>`
    )
    .join('')

  const detailRows = f.deductions
    .map(
      (d) =>
        `<tr><td class="num">${toDisplayDate(d.paidOn)}</td><td class="num">${esc(d.voucherNumber)}</td>` +
        `<td class="num">${esc(d.sectionCode)}</td><td class="r num">${money(d.amountPaid)}</td>` +
        `<td class="r num">${d.rate.toFixed(2)}%</td><td class="r num">${money(d.tds)}</td>` +
        `<td class="num">${d.challan ? `${esc(d.challan.bsrCode)} / ${esc(d.challan.serial)} / ${toDisplayDate(d.challan.paidOn)}` : '—'}</td></tr>`
    )
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Form 16A (working copy)</title><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #16181f; padding: 30px; }
    .num { font-variant-numeric: tabular-nums; font-family: Menlo, monospace; font-size: 11.5px; }
    .head { border-bottom: 1.5px solid #16181f; padding-bottom: 12px; display: flex; justify-content: space-between; }
    h1 { font-size: 17px; } .sub { color: #555; font-size: 11px; }
    .tag { text-align: right; } .tag b { font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; }
    .parties { display: flex; gap: 40px; padding: 14px 0; border-bottom: 1px solid #16181f; }
    h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin: 14px 0 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; text-align: left; border-bottom: 1.5px solid #16181f; padding: 6px 0; }
    td { padding: 5px 0; border-bottom: 1px dotted #bbb; }
    .r { text-align: right; }
    .flag { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: #b45309; }
    .warn { margin-top: 16px; font-size: 11px; border: 1.5px solid #b45309; padding: 10px 12px; }
    .warn ul { margin: 6px 0 0 16px; }
    .sign { margin-top: 30px; display: flex; justify-content: space-between; font-size: 11px; }
  </style></head><body>
    <div class="head">
      <div><h1>${esc(company.name)}</h1><div class="sub">${esc(company.address)}</div>
        <div class="sub">${f.deductorTan ? 'TAN ' + esc(f.deductorTan) : 'No TAN on record'}${f.deductorPan ? ' · PAN ' + esc(f.deductorPan) : ''}</div></div>
      <div class="tag"><b>Form 16A — working copy</b>
        <div class="sub">${esc(f.fyLabel)} · ${esc(f.ayLabel)} · ${esc(f.quarterLabel)}</div>
        <div class="sub">Due ${toDisplayDate(f.dueDate)}</div></div>
    </div>

    <div class="parties">
      <div><h3 style="margin-top:0">Deductee</h3><b>${esc(f.deducteeName)}</b>
        <div class="sub">${f.deducteePan ? 'PAN ' + esc(f.deducteePan) : 'PAN not on record'}</div></div>
      <div><h3 style="margin-top:0">Period</h3><span class="num">${toDisplayDate(f.from)} – ${toDisplayDate(f.to)}</span></div>
      <div><h3 style="margin-top:0">Total deducted</h3><span class="num">${money(f.totalTds)}</span></div>
    </div>

    <h3>Summary by section</h3>
    <table>
      <thead><tr><th>Section</th><th class="r">Amount paid or credited</th><th class="r">Tax deducted</th></tr></thead>
      <tbody>${sectionRows}
        <tr><td><b>Total</b></td><td class="r num"><b>${money(f.totalPaid)}</b></td><td class="r num"><b>${money(f.totalTds)}</b></td></tr>
      </tbody>
    </table>

    <h3>Payment by payment</h3>
    <table>
      <thead><tr><th>Date</th><th>Voucher</th><th>Section</th><th class="r">Amount</th><th class="r">Rate</th>
        <th class="r">TDS</th><th>Challan (BSR / serial / date)</th></tr></thead>
      <tbody>${detailRows}</tbody>
    </table>

    <div class="warn">
      <b>This is a working copy, not the certificate.</b>
      <ul>${f.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
    </div>

    <div class="sign"><span>Place: ${esc(company.address.split(',').pop()?.trim() ?? '')}</span>
      <span>For <b>${esc(company.name)}</b><br><br><br>Person responsible for deduction</span></div>
  </body></html>`

  const safeName = f.deducteeName.replace(/[^a-zA-Z0-9-_]/g, '_')
  return writeExportPdf(slug, `form16a-${fyStartYear}-Q${quarter}-${safeName}.pdf`, html, { pageSize: 'A4', pageNumbers: true })
}
