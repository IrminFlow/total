import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo, TdsSection } from '@shared/domain'
import type { TdsSectionInput } from '@shared/schemas'
import { computeTds, thresholdCrossed, tdsQuarterOf } from '@shared/tds'
import { fyFromStartYear } from '@shared/dates'
import { rowsToCsv } from '@shared/csv'
import { plainRupees } from '@shared/money'
import { companyExportsDir } from '../paths'
import { findOrCreateLedger } from './masters'
import { NOT_DELETED } from './vouchers'
import { writeAudit } from './audit'

interface SectionRow {
  id: number; code: string; description: string; rate: number
  threshold_single: number; threshold_annual: number
}
const mapSection = (r: SectionRow): TdsSection => ({
  id: r.id, code: r.code, description: r.description, rate: r.rate,
  thresholdSingle: r.threshold_single, thresholdAnnual: r.threshold_annual
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
    db.prepare('UPDATE tds_sections SET code = ?, description = ?, rate = ?, threshold_single = ?, threshold_annual = ? WHERE id = ?')
      .run(input.code, input.description, input.rate, input.thresholdSingle, input.thresholdAnnual, id)
    const updated = mapSection(db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(id) as SectionRow)
    writeAudit(db, 'tdsSection', id, 'update', mapSection(existing), updated)
    return updated
  }
  const res = db
    .prepare('INSERT INTO tds_sections (code, description, rate, threshold_single, threshold_annual) VALUES (?, ?, ?, ?, ?)')
    .run(input.code, input.description, input.rate, input.thresholdSingle, input.thresholdAnnual)
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
}

/**
 * Suggests a TDS deduction for a payment/journal to `partyLedgerId`, or null when the party isn't
 * flagged for TDS at all. `payableLedgerId` is auto-created ("TDS Payable <code>" under Duties &
 * Taxes) so the caller can post the credit line without a separate master-creation round trip.
 */
export function tdsSuggestion(db: DB, partyLedgerId: number, basePaise: number, dateISO: string): TdsSuggestion | null {
  const ledger = db.prepare('SELECT tds_section_id, pan FROM ledgers WHERE id = ?').get(partyLedgerId) as
    | { tds_section_id: number | null; pan: string | null }
    | undefined
  if (!ledger || ledger.tds_section_id === null) return null

  const section = db.prepare('SELECT * FROM tds_sections WHERE id = ?').get(ledger.tds_section_id) as SectionRow
  const panAvailable = !!ledger.pan
  const tdsPaise = computeTds(section.rate, basePaise, panAvailable)
  const payableLedgerId = findOrCreateLedger(db, `TDS Payable ${section.code}`, 'Duties & Taxes')

  const q = tdsQuarterOf(dateISO)
  const fyFrom = `${q.fyStartYear}-04-01`
  const fyTo = `${q.fyStartYear + 1}-03-31`
  const soFar = db
    .prepare(
      `SELECT COALESCE(SUM(te.base_amount), 0) AS total
       FROM tds_entries te JOIN vouchers v ON v.id = te.voucher_id
       WHERE te.party_ledger_id = ? AND te.section_id = ? AND v.date BETWEEN ? AND ? AND ${NOT_DELETED}`
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
    thresholdCrossed: crossed
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
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED}`
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
       WHERE v.date BETWEEN ? AND ? AND ${NOT_DELETED}
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
