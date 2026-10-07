/**
 * TDS (Tax Deducted at Source) — pure rate/threshold/quarter math and voucher validation shared
 * by main (persistence, suggestions, save-time validation) and renderer (voucher-entry banner,
 * Tds screen). No I/O, no DB.
 *
 * Rates live in an effective-dated table (`tds_section_rates`, migration 020): one row per
 * section × deductee type × period, in basis points (1% = 100 bp) so 0.1% (194Q) stays an
 * integer. The statutory sources for every seeded value are cited next to the seed in
 * src/main/db/migrations.ts (migration 020).
 */
import { formatPaise, roundToRupee } from './money'
import { fyOf } from './dates'
import type { PostingError } from './posting'

// ---------------------------------------------------------------------------------------------
// Deductee types
// ---------------------------------------------------------------------------------------------

/** Deductee classes the rate tables distinguish. 'other' covers AOP/BOI/trust/local authority/
 *  AJP/government — every status the contractor rate (1% vs 2%) does not single out. */
export const DEDUCTEE_TYPES = ['individual_huf', 'company', 'firm', 'other'] as const
export type DeducteeType = (typeof DEDUCTEE_TYPES)[number]
/** A rate row may apply to one deductee type or to every type ('any'). */
export type RateDeducteeType = DeducteeType | 'any'

export const DEDUCTEE_TYPE_LABELS: Record<RateDeducteeType, string> = {
  individual_huf: 'Individual / HUF',
  company: 'Company',
  firm: 'Firm / LLP',
  other: 'Other (AOP, BOI, trust, …)',
  any: 'Any deductee'
}

/**
 * Deductee type from the PAN's fourth character (holder status). Source: Income Tax Department,
 * "Permanent Account Number (PAN)" — the fourth character denotes the status of the holder
 * (P individual, H HUF, C company, F firm/LLP, A AOP, T trust, B BOI, L local authority,
 * J artificial juridical person, G government). See the citation block in migration 020.
 * Returns null when there is no PAN or the character is not a known status.
 */
export function deducteeTypeFromPan(pan: string | null | undefined): DeducteeType | null {
  if (!pan || !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return null
  switch (pan[3]) {
    case 'P':
    case 'H':
      return 'individual_huf'
    case 'C':
      return 'company'
    case 'F':
      return 'firm'
    case 'A':
    case 'T':
    case 'B':
    case 'L':
    case 'J':
    case 'G':
      return 'other'
    default:
      return null
  }
}

/** The ledger's explicit deductee type wins; otherwise it is read off the PAN. */
export function resolveDeducteeType(explicit: DeducteeType | null | undefined, pan: string | null | undefined): DeducteeType | null {
  return explicit ?? deducteeTypeFromPan(pan)
}

// ---------------------------------------------------------------------------------------------
// Rate rows, certificates, rate selection
// ---------------------------------------------------------------------------------------------

export interface TdsRateRow {
  id: number
  sectionId: number
  /** ISO date, inclusive. */
  effectiveFrom: string
  /** ISO date, inclusive; null = open-ended. */
  effectiveTo: string | null
  deducteeType: RateDeducteeType
  /** Basis points: 100 = 1%. */
  rateBp: number
  /** Paise; 0 = no single-transaction threshold. */
  thresholdSinglePaise: number
  /** Paise; 0 = no aggregate threshold. */
  thresholdAnnualPaise: number
  /** Period the aggregate threshold is measured over: the financial year (most sections) or
   *  the calendar month (rent u/s 194-I from 1 Apr 2025 — "per month or part of a month"). */
  thresholdBasis: 'fy' | 'month'
  /** TDS applies only to the part of the period aggregate above the aggregate threshold
   *  (194Q: "a sum exceeding fifty lakh rupees"), not to the whole base. */
  thresholdExcessOnly: boolean
  /** Return section / payment code for this period (26Q "94C", Form 140 "1024"); null = none. */
  returnCode: string | null
  /** Rate when the deductee has no PAN (s.206AA / its Act-2025 equivalent), basis points. The
   *  effective no-PAN rate is the higher of this and the section rate. */
  noPanRateBp: number
  /** Citation (statute / notification + URL + date accessed) for this row; null for user rows. */
  source: string | null
}

/** Lower/nil deduction certificate (s.197 of the 1961 Act) issued to a deductee. */
export interface TdsCertificate {
  id: number
  ledgerId: number
  /** Section the certificate covers; null = every section for this deductee. */
  sectionId: number | null
  certificateNo: string
  rateBp: number
  validFrom: string
  validTo: string
  /** Amount (paise) the certificate covers; null = no cap. */
  capPaise: number | null
}

/** The rate row in force for `deducteeType` on `dateISO`: an exact deductee-type row first, then
 *  an 'any' row. A party with no known type (no PAN, none set) only matches 'any' rows; when a
 *  section has none, the HIGHEST type-specific rate in force is used — deducting short is the
 *  costly mistake (s.201 default), deducting at the higher rate is recoverable by the deductee. */
export function rateRowOn(rows: readonly TdsRateRow[], dateISO: string, deducteeType: DeducteeType | null): TdsRateRow | null {
  const inForce = rows.filter((r) => r.effectiveFrom <= dateISO && (r.effectiveTo == null || dateISO <= r.effectiveTo))
  // Latest-starting row wins if two overlap (a user-added row layered over a seeded one).
  const latest = (list: TdsRateRow[]): TdsRateRow | null =>
    list.length === 0 ? null : [...list].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id - a.id)[0]!
  if (deducteeType) {
    const exact = latest(inForce.filter((r) => r.deducteeType === deducteeType))
    if (exact) return exact
  }
  const any = latest(inForce.filter((r) => r.deducteeType === 'any'))
  if (any) return any
  if (deducteeType) return null
  return [...inForce].sort((a, b) => b.rateBp - a.rateBp || b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null
}

export interface CertificateUse {
  certificate: TdsCertificate
  /** Base already deducted under this certificate (other vouchers), paise. */
  consumedPaise: number
}

export interface ApplicableRate {
  /** The rate row in force (thresholds come from here). */
  row: TdsRateRow
  /** Rate applied to the base (or to the part beyond the certificate cap), basis points. */
  rateBp: number
  /** 'section' = the table rate; 'no_pan' = the higher no-PAN rate; 'certificate' = s.197. */
  basis: 'section' | 'no_pan' | 'certificate'
  certificateId: number | null
  /** Certificate rate and how much of the base it still covers (null = whole base / no cap). */
  certificateRateBp: number | null
  certificateRemainingPaise: number | null
}

/**
 * Rate that applies to a deduction. Order: no PAN → the higher of the section rate and the
 * no-PAN rate (a certificate cannot help — s.197 certificates are issued against a PAN, and
 * s.206AA overrides "anything contained in any other provision"); a certificate valid on the
 * date for this section with cap left → its rate; otherwise the table rate. Null when the
 * section has no rate in force on that date for that deductee type.
 */
export function applicableRate(
  section: { id: number; rates: readonly TdsRateRow[] },
  dateISO: string,
  deducteeType: DeducteeType | null,
  hasPan: boolean,
  certificate?: CertificateUse | null
): ApplicableRate | null {
  const row = rateRowOn(section.rates, dateISO, deducteeType)
  if (!row) return null
  const base: ApplicableRate = {
    row, rateBp: row.rateBp, basis: 'section', certificateId: null, certificateRateBp: null, certificateRemainingPaise: null
  }
  if (!hasPan) {
    return row.noPanRateBp > row.rateBp ? { ...base, rateBp: row.noPanRateBp, basis: 'no_pan' } : base
  }
  const c = certificate?.certificate
  if (c && (c.sectionId == null || c.sectionId === section.id) && c.validFrom <= dateISO && dateISO <= c.validTo) {
    const remaining = c.capPaise == null ? null : Math.max(0, c.capPaise - certificate!.consumedPaise)
    if (remaining == null || remaining > 0) {
      return { ...base, basis: 'certificate', certificateId: c.id, certificateRateBp: c.rateBp, certificateRemainingPaise: remaining }
    }
  }
  return base
}

/**
 * The deduction, rounded to the nearest whole rupee (half up). Source: s.288B of the 1961 Act
 * rounds tax "payable" to the nearest ten rupees, but TDS is deducted/reported to the rupee —
 * see the rounding citation in migration 020. Surcharge and cess are never added: for resident
 * payees other than salary the TDS rates in force are not increased by surcharge or cess (same
 * citation block). Only the part of the base still covered by a capped certificate gets the
 * certificate rate; the excess goes at the table rate.
 */
export function computeTdsPaise(basePaise: number, rate: Pick<ApplicableRate, 'rateBp' | 'basis' | 'certificateRateBp' | 'certificateRemainingPaise'>): number {
  if (basePaise <= 0) return 0
  if (rate.basis === 'certificate' && rate.certificateRateBp != null) {
    const covered = rate.certificateRemainingPaise == null ? basePaise : Math.min(basePaise, rate.certificateRemainingPaise)
    const excess = basePaise - covered
    return roundToRupee(Math.round((covered * rate.certificateRateBp) / 10000) + Math.round((excess * rate.rateBp) / 10000))
  }
  return roundToRupee(Math.round((basePaise * rate.rateBp) / 10000))
}

/**
 * Legacy single-rate helper (percent), kept for callers that predate the rate table. Without a
 * PAN the higher of the section rate and 20% applies.
 */
export function computeTds(ratePercent: number, basePaise: number, panAvailable: boolean): number {
  const effectiveRate = panAvailable ? ratePercent : Math.max(ratePercent, 20)
  return roundToRupee(Math.round((basePaise * effectiveRate) / 100))
}

/**
 * Part of this transaction's base the rate applies to. Normally the whole base; for an
 * excess-only row (194Q) only what lifts the period aggregate above the aggregate threshold:
 * prior 40L + this 20L against 50L → 10L.
 */
export function taxableBase(row: Pick<TdsRateRow, 'thresholdExcessOnly' | 'thresholdAnnualPaise'>, basePaise: number, priorPeriodBasePaise: number): number {
  if (!row.thresholdExcessOnly || row.thresholdAnnualPaise <= 0) return basePaise
  const above = (x: number): number => Math.max(0, x - row.thresholdAnnualPaise)
  return above(priorPeriodBasePaise + basePaise) - above(priorPeriodBasePaise)
}

/** The deduction the rate table yields: rate (or certificate) on the taxable part of the base. */
export function expectedTdsPaise(rate: ApplicableRate, basePaise: number, priorPeriodBasePaise: number): number {
  return computeTdsPaise(taxableBase(rate.row, basePaise, priorPeriodBasePaise), rate)
}

// ---------------------------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------------------------

export interface TdsThresholds {
  /** Single-transaction threshold, paise. 0 = no single-transaction threshold. */
  thresholdSingle: number
  /** Aggregate threshold, paise. 0 = no aggregate threshold. */
  thresholdAnnual: number
}

/**
 * Whether this deduction becomes applicable under either threshold. The statute's test is
 * "exceeds" (a payment exactly at the limit is not liable), so both comparisons are strict. A
 * section with both thresholds at 0 (none configured) is always applicable. `periodBaseSoFarPaise`
 * is the sum of prior base amounts in the same aggregation period, *excluding* this transaction.
 */
export function thresholdCrossed(thresholds: TdsThresholds, basePaise: number, periodBaseSoFarPaise: number): boolean {
  const { thresholdSingle, thresholdAnnual } = thresholds
  if (thresholdSingle <= 0 && thresholdAnnual <= 0) return true
  const singleCrossed = thresholdSingle > 0 && basePaise > thresholdSingle
  const annualCrossed = thresholdAnnual > 0 && periodBaseSoFarPaise + basePaise > thresholdAnnual
  return singleCrossed || annualCrossed
}

export interface ThresholdStatus {
  crossed: boolean
  /** Which test tripped (single wins when both do); 'none' = no thresholds configured. */
  reason: 'single' | 'aggregate' | 'none' | 'below'
  /** Aggregate including this transaction, paise. */
  aggregatePaise: number
  period: { from: string; to: string }
}

/** Period an aggregate threshold is measured over for a date: the FY, or the calendar month. */
export function thresholdPeriod(basis: 'fy' | 'month', dateISO: string): { from: string; to: string } {
  if (basis === 'month') {
    const [y, m] = dateISO.split('-').map(Number) as [number, number]
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const mm = String(m).padStart(2, '0')
    return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` }
  }
  const fy = fyOf(dateISO)
  return { from: fy.from, to: fy.to }
}

export function thresholdStatus(row: TdsRateRow, dateISO: string, basePaise: number, priorPeriodBasePaise: number): ThresholdStatus {
  const period = thresholdPeriod(row.thresholdBasis, dateISO)
  const aggregatePaise = priorPeriodBasePaise + basePaise
  const t = { thresholdSingle: row.thresholdSinglePaise, thresholdAnnual: row.thresholdAnnualPaise }
  if (t.thresholdSingle <= 0 && t.thresholdAnnual <= 0) return { crossed: true, reason: 'none', aggregatePaise, period }
  if (t.thresholdSingle > 0 && basePaise > t.thresholdSingle) return { crossed: true, reason: 'single', aggregatePaise, period }
  if (t.thresholdAnnual > 0 && aggregatePaise > t.thresholdAnnual) return { crossed: true, reason: 'aggregate', aggregatePaise, period }
  return { crossed: false, reason: 'below', aggregatePaise, period }
}

// ---------------------------------------------------------------------------------------------
// Act references
// ---------------------------------------------------------------------------------------------

/** Date the Income-tax Act, 2025 replaces the 1961 Act (see the citation in migration 020). */
export const IT_ACT_2025_FROM = '2026-04-01'

/** The section reference to print for a deduction on `dateISO`: the 1961 code before the new
 *  Act's commencement, the Act-2025 reference from it (falling back to the 1961 code when no
 *  mapping is recorded). */
export function sectionReferenceOn(
  section: { code: string; legacyCode: string | null; newReference: string | null },
  dateISO: string
): string {
  if (dateISO >= IT_ACT_2025_FROM && section.newReference) return section.newReference
  return section.legacyCode ?? section.code
}

// ---------------------------------------------------------------------------------------------
// Quarters
// ---------------------------------------------------------------------------------------------

export interface TdsQuarter {
  q: 1 | 2 | 3 | 4
  /** e.g. "Q1 FY2025-26" */
  label: string
  /** Calendar year the containing FY starts in. */
  fyStartYear: number
  from: string
  to: string
}

/** Indian TDS quarters: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar (of fyStartYear + 1). */
export function tdsQuarterOf(dateISO: string): TdsQuarter {
  const fy = fyOf(dateISO)
  const month = Number(dateISO.split('-')[1])
  if (month >= 4 && month <= 6) {
    return { q: 1, label: `Q1 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear}-04-01`, to: `${fy.startYear}-06-30` }
  }
  if (month >= 7 && month <= 9) {
    return { q: 2, label: `Q2 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear}-07-01`, to: `${fy.startYear}-09-30` }
  }
  if (month >= 10 && month <= 12) {
    return { q: 3, label: `Q3 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear}-10-01`, to: `${fy.startYear}-12-31` }
  }
  return { q: 4, label: `Q4 FY${fy.label}`, fyStartYear: fy.startYear, from: `${fy.startYear + 1}-01-01`, to: `${fy.startYear + 1}-03-31` }
}

/** Bounds of quarter `q` of the FY starting `fyStartYear`. */
export function tdsQuarterBounds(fyStartYear: number, q: 1 | 2 | 3 | 4): { from: string; to: string } {
  const { from, to } = tdsQuarterOf(q === 4 ? `${fyStartYear + 1}-01-15` : `${fyStartYear}-${String(q * 3 + 1).padStart(2, '0')}-15`)
  return { from, to }
}

// ---------------------------------------------------------------------------------------------
// Validation (saveVoucher)
// ---------------------------------------------------------------------------------------------

export interface TdsEntryToValidate {
  sectionId: number
  baseAmount: number
  tdsAmount: number
  isManual: boolean
}

export interface TdsSectionFacts {
  code: string
  /** Deduction the rate table yields for this entry (computed by the caller with
   *  applicableRate + computeTdsPaise); null = no rate in force on the voucher date. */
  expectedTdsPaise: number | null
}

/**
 * Checks a voucher's TDS entries against its own lines. Per entry: the section exists, there is
 * a party, 0 < tds ≤ base, and (unless the entry is marked manual) tds equals the rate table's
 * figure. Per section: the voucher credits ledgers tagged as that section's TDS payable
 * (`payableLedgerTagMap`: ledger id → section id) by exactly the entries' total — or, when
 * every entry for that section is manual, by something.
 */
export function validateTdsEntries(
  voucher: { partyLedgerId: number | null; lines: readonly { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] },
  entries: readonly TdsEntryToValidate[],
  payableLedgerTagMap: ReadonlyMap<number, number>,
  sectionFacts: (entry: TdsEntryToValidate) => TdsSectionFacts | null
): PostingError[] {
  const errors: PostingError[] = []
  if (entries.length === 0) return errors
  if (voucher.partyLedgerId == null) {
    errors.push({ code: 'tds_no_party', message: 'A TDS deduction needs a party (the deductee) on the voucher' })
  }
  const bySection = new Map<number, { code: string; total: number; allManual: boolean }>()
  for (const e of entries) {
    const facts = sectionFacts(e)
    if (!facts) {
      errors.push({ code: 'tds_unknown_section', message: 'Unknown TDS section' })
      continue
    }
    if (!Number.isSafeInteger(e.baseAmount) || !Number.isSafeInteger(e.tdsAmount) || e.baseAmount <= 0 || e.tdsAmount <= 0) {
      errors.push({ code: 'tds_bad_amount', message: `TDS u/s ${facts.code}: base and deduction must be positive` })
      continue
    }
    if (e.tdsAmount > e.baseAmount) {
      errors.push({ code: 'tds_exceeds_base', message: `TDS u/s ${facts.code} cannot exceed its base amount` })
    }
    if (!e.isManual) {
      if (facts.expectedTdsPaise == null) {
        errors.push({
          code: 'tds_no_rate',
          message: `No TDS rate is in force for section ${facts.code} on this date — add one under TDS › Sections, or mark the deduction manual`
        })
      } else if (facts.expectedTdsPaise !== e.tdsAmount) {
        errors.push({
          code: 'tds_amount_mismatch',
          message: `TDS u/s ${facts.code} should be ${rupees(facts.expectedTdsPaise)} on a base of ${rupees(e.baseAmount)}, not ${rupees(e.tdsAmount)} — re-apply TDS or mark the deduction manual`
        })
      }
    }
    const g = bySection.get(e.sectionId) ?? { code: facts.code, total: 0, allManual: true }
    g.total += e.tdsAmount
    g.allManual = g.allManual && e.isManual
    bySection.set(e.sectionId, g)
  }
  for (const [sectionId, g] of bySection) {
    const credited = voucher.lines
      .filter((l) => l.drCr === 'cr' && payableLedgerTagMap.get(l.ledgerId) === sectionId)
      .reduce((s, l) => s + l.amount, 0)
    if (g.allManual) {
      if (credited <= 0) {
        errors.push({ code: 'tds_no_payable_line', message: `TDS u/s ${g.code} needs a credit to that section's TDS payable ledger` })
      }
    } else if (credited !== g.total) {
      errors.push({
        code: credited === 0 ? 'tds_no_payable_line' : 'tds_payable_mismatch',
        message:
          credited === 0
            ? `TDS u/s ${g.code} needs a credit of ${rupees(g.total)} to that section's TDS payable ledger`
            : `The TDS payable ${g.code} credit (${rupees(credited)}) must equal the deduction (${rupees(g.total)})`
      })
    }
  }
  return errors
}

const rupees = (paise: number): string => formatPaise(paise, { symbol: true })
