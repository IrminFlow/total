/**
 * Withholding at source — the rate / threshold / quarter / validation machinery that TDS
 * (src/shared/tds.ts, tax DEDUCTED by us as payer) and TCS (src/shared/tcs.ts, tax COLLECTED by
 * us as seller, WP 3.3) share. Pure: no I/O, no DB. The kind-specific rules (who the party is,
 * which lines the amount comes out of, the base, the forms) stay in tds.ts / tcs.ts; everything
 * here is identical under both chapters of the Act:
 *
 *  - an effective-dated rate table (`tds_section_rates`, migration 020; TCS rows from migration
 *    027 share it): one row per section × party type × period, in basis points (1% = 100 bp);
 *  - party type from the PAN's fourth character, or set on the ledger;
 *  - a no-PAN higher rate per row (s.206AA for TDS, s.206CC for TCS — see the citations next to
 *    each seed in src/main/db/migrations.ts);
 *  - a lower-rate certificate (s.197 TDS / s.206C(9) TCS) with an optional cap;
 *  - single-transaction and aggregate thresholds over the FY (or calendar month) with a strict
 *    "exceeds" test, and excess-only rows (194Q);
 *  - rounding to the rupee; the Indian quarter calendar; Act references by date;
 *  - save-time validation of a voucher's entries against its own lines.
 *
 * The names in tds.ts (rateRowOn, computeTdsPaise, tdsQuarterOf, validateTdsEntries, …) are kept
 * as re-exports / thin wrappers so every TDS caller and test is unchanged by this extraction.
 */
import { formatPaise, roundToRupee } from './money'
import { fyOf } from './dates'
import type { PostingError } from './posting'

// ---------------------------------------------------------------------------------------------
// Party types (deductee / collectee)
// ---------------------------------------------------------------------------------------------

/** Party classes the rate tables distinguish. 'other' covers AOP/BOI/trust/local authority/
 *  AJP/government — every status the contractor rate (1% vs 2%) does not single out. */
export const DEDUCTEE_TYPES = ['individual_huf', 'company', 'firm', 'other'] as const
export type DeducteeType = (typeof DEDUCTEE_TYPES)[number]
/** A rate row may apply to one party type or to every type ('any'). */
export type RateDeducteeType = DeducteeType | 'any'

/**
 * Party type from the PAN's fourth character (holder status). Source: Income Tax Department,
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

/** The ledger's explicit party type wins; otherwise it is read off the PAN. */
export function resolveDeducteeType(explicit: DeducteeType | null | undefined, pan: string | null | undefined): DeducteeType | null {
  return explicit ?? deducteeTypeFromPan(pan)
}

/** Return "party type code" shared by Form 26Q and Form 27EQ (Protean file formats, cited in
 *  migrations 020 / 027): '01' company, '02' other than company; '' unknown. */
export function partyCodeForReturn(type: string | null): string {
  if (type === 'company') return '01'
  if (type === 'individual_huf' || type === 'firm' || type === 'other') return '02'
  return ''
}

// ---------------------------------------------------------------------------------------------
// Rate rows, certificates, rate selection
// ---------------------------------------------------------------------------------------------

export interface WithholdingRateRow {
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
  /** The rate applies only to the part of the period aggregate above the aggregate threshold
   *  (194Q: "a sum exceeding fifty lakh rupees"), not to the whole base. */
  thresholdExcessOnly: boolean
  /** Return section / payment code for this period (26Q "94C", Form 140 "1024", 27EQ "6CE");
   *  null = none. */
  returnCode: string | null
  /** Rate when the party has no PAN (s.206AA / s.206CC / their Act-2025 equivalents), basis
   *  points. The effective no-PAN rate is the higher of this and the section rate (TCS: also
   *  twice the section rate — see applicableRate's `noPanMultiple`). */
  noPanRateBp: number
  /** TCS: the base includes the GST charged on the invoice (migration 027 cites why per
   *  section). Absent / false for TDS (CBDT Circular 23/2017: GST shown separately is excluded). */
  baseIncludesGst?: boolean
  /** Citation (statute / notification + URL + date accessed) for this row; null for user rows. */
  source: string | null
}

/** Lower/nil rate certificate issued to a party: s.197 (TDS) / s.206C(9) (TCS). */
export interface WithholdingCertificate {
  id: number
  ledgerId: number
  /** Section the certificate covers; null = every section of that kind for this party. */
  sectionId: number | null
  certificateNo: string
  rateBp: number
  validFrom: string
  validTo: string
  /** Amount (paise) the certificate covers; null = no cap. */
  capPaise: number | null
}

/** The rate row in force for `deducteeType` on `dateISO`: an exact party-type row first, then
 *  an 'any' row. A party with no known type (no PAN, none set) only matches 'any' rows; when a
 *  section has none, the HIGHEST type-specific rate in force is used — withholding short is the
 *  costly mistake (s.201 / s.206C(6A) default), withholding at the higher rate is recoverable. */
export function rateRowOn<R extends WithholdingRateRow>(rows: readonly R[], dateISO: string, deducteeType: DeducteeType | null): R | null {
  const inForce = rows.filter((r) => r.effectiveFrom <= dateISO && (r.effectiveTo == null || dateISO <= r.effectiveTo))
  // Latest-starting row wins if two overlap (a user-added row layered over a seeded one).
  const latest = (list: R[]): R | null =>
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
  certificate: WithholdingCertificate
  /** Base already withheld under this certificate (other vouchers), paise. */
  consumedPaise: number
}

export interface ApplicableRate {
  /** The rate row in force (thresholds come from here). */
  row: WithholdingRateRow
  /** Rate applied to the base (or to the part beyond the certificate cap), basis points. */
  rateBp: number
  /** 'section' = the table rate; 'no_pan' = the higher no-PAN rate; 'certificate' = lower-rate
   *  certificate. */
  basis: 'section' | 'no_pan' | 'certificate'
  certificateId: number | null
  /** Certificate rate and how much of the base it still covers (null = whole base / no cap). */
  certificateRateBp: number | null
  certificateRemainingPaise: number | null
}

/**
 * Rate that applies. Order: no PAN → the higher of the section rate, the row's no-PAN rate and
 * (`noPanMultiple`, TCS s.206CC(1)(i): "twice the rate specified") a multiple of the section
 * rate, capped at `noPanCapBp` (s.206CC proviso: "shall not exceed twenty per cent") — a
 * certificate cannot help (certificates are issued against a PAN, and ss.206AA/206CC
 * override "anything contained in any other provision"); a certificate valid on the date for
 * this section with cap left → its rate; otherwise the table rate. Null when the section has no
 * rate in force on that date for that party type.
 */
export function applicableRate(
  section: { id: number; rates: readonly WithholdingRateRow[] },
  dateISO: string,
  deducteeType: DeducteeType | null,
  hasPan: boolean,
  certificate?: CertificateUse | null,
  opts: { noPanMultiple?: number; noPanCapBp?: number } = {}
): ApplicableRate | null {
  const row = rateRowOn(section.rates, dateISO, deducteeType)
  if (!row) return null
  const base: ApplicableRate = {
    row, rateBp: row.rateBp, basis: 'section', certificateId: null, certificateRateBp: null, certificateRemainingPaise: null
  }
  if (!hasPan) {
    const raised = Math.max(row.noPanRateBp, opts.noPanMultiple ? row.rateBp * opts.noPanMultiple : 0)
    const noPan = Math.min(opts.noPanCapBp ?? 10000, raised)
    return noPan > row.rateBp ? { ...base, rateBp: noPan, basis: 'no_pan' } : base
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
 * The amount withheld, rounded to the nearest whole rupee (half up). Source: s.288B of the 1961
 * Act rounds tax "payable" to the nearest ten rupees, but TDS/TCS is deducted/collected and
 * reported to the rupee — see the rounding citation in migration 020. Surcharge and cess are
 * never added (resident payees / buyers; same citation block). Only the part of the base still
 * covered by a capped certificate gets the certificate rate; the excess goes at the table rate.
 */
export function computeWithholdingPaise(
  basePaise: number,
  rate: Pick<ApplicableRate, 'rateBp' | 'basis' | 'certificateRateBp' | 'certificateRemainingPaise'>
): number {
  if (basePaise <= 0) return 0
  if (rate.basis === 'certificate' && rate.certificateRateBp != null) {
    const covered = rate.certificateRemainingPaise == null ? basePaise : Math.min(basePaise, rate.certificateRemainingPaise)
    const excess = basePaise - covered
    return roundToRupee(Math.round((covered * rate.certificateRateBp) / 10000) + Math.round((excess * rate.rateBp) / 10000))
  }
  return roundToRupee(Math.round((basePaise * rate.rateBp) / 10000))
}

/**
 * Part of this transaction's base the rate applies to. Normally the whole base; for an
 * excess-only row (194Q) only what lifts the period aggregate above the aggregate threshold:
 * prior 40L + this 20L against 50L → 10L.
 */
export function taxableBase(row: Pick<WithholdingRateRow, 'thresholdExcessOnly' | 'thresholdAnnualPaise'>, basePaise: number, priorPeriodBasePaise: number): number {
  if (!row.thresholdExcessOnly || row.thresholdAnnualPaise <= 0) return basePaise
  const above = (x: number): number => Math.max(0, x - row.thresholdAnnualPaise)
  return above(priorPeriodBasePaise + basePaise) - above(priorPeriodBasePaise)
}

/** The amount the rate table yields: rate (or certificate) on the taxable part of the base. */
export function expectedWithholdingPaise(rate: ApplicableRate, basePaise: number, priorPeriodBasePaise: number): number {
  return computeWithholdingPaise(taxableBase(rate.row, basePaise, priorPeriodBasePaise), rate)
}

// ---------------------------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------------------------

export interface WithholdingThresholds {
  /** Single-transaction threshold, paise. 0 = no single-transaction threshold. */
  thresholdSingle: number
  /** Aggregate threshold, paise. 0 = no aggregate threshold. */
  thresholdAnnual: number
}

/**
 * Whether this transaction becomes liable under either threshold. The statute's test is
 * "exceeds" (an amount exactly at the limit is not liable), so both comparisons are strict. A
 * section with both thresholds at 0 (none configured) is always applicable. `periodBaseSoFarPaise`
 * is the sum of prior base amounts in the same aggregation period, *excluding* this transaction.
 */
export function thresholdCrossed(thresholds: WithholdingThresholds, basePaise: number, periodBaseSoFarPaise: number): boolean {
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

export function thresholdStatus(row: WithholdingRateRow, dateISO: string, basePaise: number, priorPeriodBasePaise: number): ThresholdStatus {
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

/** The section reference to print for an entry on `dateISO`: the 1961 code before the new
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

export interface WithholdingQuarter {
  q: 1 | 2 | 3 | 4
  /** e.g. "Q1 FY2025-26" */
  label: string
  /** Calendar year the containing FY starts in. */
  fyStartYear: number
  from: string
  to: string
}

/** Indian TDS/TCS quarters: Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar (of fyStartYear + 1). */
export function quarterOf(dateISO: string): WithholdingQuarter {
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
export function quarterBounds(fyStartYear: number, q: 1 | 2 | 3 | 4): { from: string; to: string } {
  const { from, to } = quarterOf(q === 4 ? `${fyStartYear + 1}-01-15` : `${fyStartYear}-${String(q * 3 + 1).padStart(2, '0')}-15`)
  return { from, to }
}

// ---------------------------------------------------------------------------------------------
// Interest helpers ("for every month or part of a month")
// ---------------------------------------------------------------------------------------------

/** Calendar months from `from` to `to`, both months counted; 0 when `to` is not after `from`
 *  (the way TRACES counts "month or part of a month" — see src/shared/tdsInterest.ts). */
export function monthsOrPart(from: string, to: string): number {
  if (to <= from) return 0
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  return ty * 12 + tm - (fy * 12 + fm) + 1
}

/** Simple interest at `rateBp` per month or part, rounded to the rupee. */
export function monthlyInterestPaise(amountPaise: number, rateBp: number, months: number): number {
  if (amountPaise <= 0 || months <= 0) return 0
  return roundToRupee(Math.round((amountPaise * rateBp * months) / 10000))
}

// ---------------------------------------------------------------------------------------------
// Validation (saveVoucher)
// ---------------------------------------------------------------------------------------------

export interface WithholdingEntryToValidate {
  sectionId: number
  baseAmount: number
  /** The amount withheld (TDS deducted / TCS collected), paise. */
  amount: number
  isManual: boolean
}

export interface WithholdingSectionFacts {
  code: string
  /** Amount the rate table yields for this entry (computed by the caller with applicableRate +
   *  computeWithholdingPaise); null = no rate in force on the voucher date. */
  expectedPaise: number | null
}

/** The words a kind's validation messages use (the TDS wording is the pre-WP-3.3 text verbatim). */
export interface WithholdingLabels {
  /** Error code prefix: 'tds' | 'tcs'. */
  prefix: string
  /** "TDS" / "TCS". */
  name: string
  /** "deduction" / "collection". */
  noun: string
  /** "the deductee" / "the buyer". */
  party: string
  /** "TDS › Sections" / "TCS › Sections". */
  sectionsScreen: string
}

/**
 * Checks a voucher's entries against its own lines. Per entry: the section exists, there is a
 * party, 0 < amount ≤ base, and (unless the entry is marked manual) the amount equals the rate
 * table's figure. Per section: the voucher credits ledgers tagged as that section's payable
 * ledger (`payableLedgerTagMap`: ledger id → section id) by exactly the entries' total — or,
 * when every entry for that section is manual, by something.
 */
export function validateWithholdingEntries(
  voucher: { partyLedgerId: number | null; lines: readonly { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[] },
  entries: readonly WithholdingEntryToValidate[],
  payableLedgerTagMap: ReadonlyMap<number, number>,
  sectionFacts: (entry: WithholdingEntryToValidate) => WithholdingSectionFacts | null,
  L: WithholdingLabels
): PostingError[] {
  const errors: PostingError[] = []
  if (entries.length === 0) return errors
  const code = (c: string): string => `${L.prefix}_${c}`
  if (voucher.partyLedgerId == null) {
    errors.push({ code: code('no_party'), message: `A ${L.name} ${L.noun} needs a party (${L.party}) on the voucher` })
  }
  const bySection = new Map<number, { code: string; total: number; allManual: boolean }>()
  for (const e of entries) {
    const facts = sectionFacts(e)
    if (!facts) {
      errors.push({ code: code('unknown_section'), message: `Unknown ${L.name} section` })
      continue
    }
    if (!Number.isSafeInteger(e.baseAmount) || !Number.isSafeInteger(e.amount) || e.baseAmount <= 0 || e.amount <= 0) {
      errors.push({ code: code('bad_amount'), message: `${L.name} u/s ${facts.code}: base and ${L.noun} must be positive` })
      continue
    }
    if (e.amount > e.baseAmount) {
      errors.push({ code: code('exceeds_base'), message: `${L.name} u/s ${facts.code} cannot exceed its base amount` })
    }
    if (!e.isManual) {
      if (facts.expectedPaise == null) {
        errors.push({
          code: code('no_rate'),
          message: `No ${L.name} rate is in force for section ${facts.code} on this date — add one under ${L.sectionsScreen}, or mark the ${L.noun} manual`
        })
      } else if (facts.expectedPaise !== e.amount) {
        errors.push({
          code: code('amount_mismatch'),
          message: `${L.name} u/s ${facts.code} should be ${rupees(facts.expectedPaise)} on a base of ${rupees(e.baseAmount)}, not ${rupees(e.amount)} — re-apply ${L.name} or mark the ${L.noun} manual`
        })
      }
    }
    const g = bySection.get(e.sectionId) ?? { code: facts.code, total: 0, allManual: true }
    g.total += e.amount
    g.allManual = g.allManual && e.isManual
    bySection.set(e.sectionId, g)
  }
  for (const [sectionId, g] of bySection) {
    const credited = voucher.lines
      .filter((l) => l.drCr === 'cr' && payableLedgerTagMap.get(l.ledgerId) === sectionId)
      .reduce((s, l) => s + l.amount, 0)
    if (g.allManual) {
      if (credited <= 0) {
        errors.push({ code: code('no_payable_line'), message: `${L.name} u/s ${g.code} needs a credit to that section's ${L.name} payable ledger` })
      }
    } else if (credited !== g.total) {
      errors.push({
        code: credited === 0 ? code('no_payable_line') : code('payable_mismatch'),
        message:
          credited === 0
            ? `${L.name} u/s ${g.code} needs a credit of ${rupees(g.total)} to that section's ${L.name} payable ledger`
            : `The ${L.name} payable ${g.code} credit (${rupees(credited)}) must equal the ${L.noun} (${rupees(g.total)})`
      })
    }
  }
  return errors
}

export const rupees = (paise: number): string => formatPaise(paise, { symbol: true })
