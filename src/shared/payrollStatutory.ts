/**
 * Payroll statutory engine (WP 3.7): EPF / EPS / EDLI / EPFO admin charges, ESI with
 * contribution-period stickiness, professional tax by state slab, salary TDS projection (old and
 * new regime, s.192 of the Income-tax Act 1961 to FY 2025-26, s.392 of the Income-tax Act 2025
 * from FY 2026-27), and compute-only gratuity / bonus helpers. Pure: no I/O. Integer paise in and
 * out; rates in basis points (1200 = 12%).
 *
 * Rates, ceilings and PT slabs are DATA (statutory_rates, migration 029 — every seeded row cites
 * its source there); the defaults below are the same figures, used when a caller has no rate rows
 * (pure tests, the legacy computeMonthlyPay call shape). Income-tax slabs are effective-dated by
 * financial year in INCOME_TAX_YEARS below, each with its citation.
 *
 * SOURCES — see SOURCES_WP37 (all accessed 2026-10-07); UNVERIFIED items are listed in
 * UNVERIFIED_WP37 and repeated in the WP 3.7 report. Statutory-rate rows cite their sources in
 * migration 029 under the same keys.
 */

/** Citations used in this file (key → URL + what was read). Accessed 2026-10-07. */
export const SOURCES_WP37: Record<string, string> = {
  EPFS52: 'EPF Scheme 1952 (archived official PDF) paras 26A, 29, 38 — https://web.archive.org/web/2024id_/https://www.epfindia.gov.in/site_docs/PDFs/Downloads_PDFs/EPFScheme.pdf',
  EPFS26: 'EPF Scheme 2026, G.S.R. 525(E) 29-6-2026 paras 9(4), 18, 19, 20, 28, 29 — https://egazette.gov.in/WriteReadData/2026/273957.pdf',
  EPS26: 'EPS 2026, G.S.R. 527(E) 29-6-2026 paras 4, 7 — https://egazette.gov.in/WriteReadData/2026/273951.pdf',
  SO5109: 'S.O. 5109(E) 17-9-2026, EPF wage ceiling Rs 25,000 — https://egazette.gov.in/WriteReadData/2026/276299.pdf',
  EPFRATE: 'EPFO Present Rates of Contribution (EDLI 0.5%, admin 0.5% min Rs 500) — https://web.archive.org/web/2024id_/https://www.epfindia.gov.in/site_docs/PDFs/MiscPDFs/ContributionRate.pdf',
  ECR: 'EPFO Introduction - ECR Version II (11 fields, whole numbers) — https://web.archive.org/web/2024id_/https://www.epfindia.gov.in/site_docs/PDFs/EPFOUnifiedPortal/Introduction_ECR2.0.pdf',
  COSS: 'Code on Social Security 2020 ss.2(88), 2(89), 16, 53, 164 — https://prsindia.org/files/bills_acts/acts_parliament/2020/Code%20On%20Social%20Security,%202020.pdf ; in force 21-11-2025 (S.O. 5319(E)) per https://www.indiacode.nic.in/bitstream/123456789/16823/1/aA2020-36.pdf',
  'ESIC-W': 'ESIC circular 11-12-2025: s.2(88) wages for ESI from 21-11-2025 — https://esic.gov.in/attachments/circularfile/New_wage_definition_u_s_2_88_of_The_Code_on_Social_Security_2020_1765902209.pdf',
  SSR26: 'Social Security (Central) Rules 2026, G.S.R. 344(E) 8-5-2026, rule 19 — https://egazette.gov.in/WriteReadData/2026/272366.pdf',
  'ESIC-C': 'ESIC contribution page (rates, Rs 176, contribution periods, 15-day due date) — https://esic.gov.in/contribution',
  FA25: 'Finance Act 2025 ss.2, 20 (87A), 25 (115BAC(1A)), First Schedule Part III — https://egazette.gov.in/WriteReadData/2025/262125.pdf',
  ACT25: 'Income-tax Act 2025 ss.1(3), 11 + Sch. III Sl.11, 19, 22, 123, 124, 126, 156, 202, 392, 516 — https://egazette.gov.in/WriteReadData/2025/265620.pdf',
  FA26: 'Finance Act 2026 s.3 + First Schedule Part III (rates for TDS in FY 2026-27, surcharge, 4% cess) — https://egazette.gov.in/WriteReadData/2026/271439.pdf',
  R26: 'Income-tax Rules 2026, G.S.R. 198(E) 20-3-2026 — rules 204, 205, 215 (Form 130), 218 (deposit), 219 (Form 138), 279 (HRA cities) — https://egazette.gov.in/WriteReadData/2026/271092.pdf',
  F24Q: 'Protean Form 24Q Regular Q4 file format v7.5 (27-05-2025), Annexure 2 section codes — https://tinpan.proteantech.in/downloads/e-tds/File_Format_24Q_Regular_Q4_Version_7.5_27052025_201112.xls',
  CoW: 'Code on Wages 2019 s.26 (bonus), s.69 (repeals the Payment of Bonus Act), in force 21-11-2025 — https://www.indiacode.nic.in/bitstream/123456789/15793/1/aA2019-29.pdf',
  BONUS15: 'Payment of Bonus (Amendment) Act 2015 (s.2(13) Rs 21,000, s.12 Rs 7,000 or minimum wage) — https://prsindia.org/files/bills_acts/bills_parliament/2015/Payment_of_Bonus_Act,_2015.pdf'
}

/** Points read only from secondary sources / not found in the official text (the report repeats them). */
export const UNVERIFIED_WP37: string[] = [
  'EPF: the September-2026 split-month proration of the wage ceiling (EPFO FAQ hosted off-site)',
  'EPF: the admin-charge notification number (S.O. 2011(E) 21-5-2018); EDLI Scheme 2026 rate notification',
  'ECR: the "#~#" field separator (the official ECR document lists the fields, not the delimiter)',
  'ESI: the legal basis under the Code of the Rs 21,000 / Rs 25,000 ceilings, the Rs 176 exemption and the stay-covered-to-the-end-of-the-contribution-period rule (ESIC still applies them)',
  'ESI: the ESIC portal monthly upload template columns',
  'PT: WB 2014 schedule and the final 1-10-2026 notification; TN (Chennai) half-yearly slabs; AP; MP; every state due date except Telangana',
  'Income tax 1961 texts (ss.16, 80C, 80CCD, 80D, 10(13A), rule 2A, 24(b), 87A old-regime clause, 192, 288A/288B) — the 2025-Act equivalents carry the same figures',
  'Salary TDS rounded to the nearest rupee (practice; s.516 rounds amounts payable to Rs 10)',
  'Form 16 Part B row list under the 1962 Rules (Form 130 Part C rows are verified)',
  'Gratuity: the Rs 20 lakh ceiling under the Code; Bonus: the Rs 21,000 / Rs 7,000 figures under the Code on Wages'
]

// ---------------------------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------------------------

/** `amountPaise × bp / 10000`, rounded to the nearest whole rupee, half up. EPF Scheme 2026 para
 *  18(5): "Each contribution shall be calculated to the nearest rupee, with fifty paise or more to
 *  be counted as the next higher rupee and fraction of a rupee less than fifty paise to be
 *  ignored" [EPFS26]; EPS 2026 para 4(3) [EPS26]; formerly EPF Scheme 1952 para 29 [EPFS52]. */
export function bpRupeeHalfUp(amountPaise: number, bp: number): number {
  if (amountPaise <= 0 || bp <= 0) return 0
  // Integer maths: amountPaise × bp is at most ~1e12 for any realistic wage — exact in a double.
  const num = amountPaise * bp // paise × 10000
  return Math.floor((num + 500_000) / 1_000_000) * 100
}

/** `amountPaise × bp / 10000`, rounded UP to the next whole rupee — Social Security (Central)
 *  Rules 2026 rule 19(1): "(rounded to the next higher rupee)" [SSR26]. */
export function bpRupeeUp(amountPaise: number, bp: number): number {
  if (amountPaise <= 0 || bp <= 0) return 0
  const num = amountPaise * bp
  return Math.ceil(num / 1_000_000) * 100
}

/** Nearest multiple of ₹10, half up: total income and any amount payable — 2025 Act s.516
 *  (paise dropped, then the nearest ₹10) [ACT25]; 1961 ss.288A / 288B (UNVERIFIED). */
export function roundTenRupees(paise: number): number {
  if (paise <= 0) return 0
  return Math.floor((paise + 500) / 1000) * 1000
}

/** Nearest rupee, half up (salary TDS per month — practice; UNVERIFIED in the statute). */
export function roundRupee(paise: number): number {
  if (paise <= 0) return 0
  return Math.floor((paise + 50) / 100) * 100
}

// ---------------------------------------------------------------------------------------------
// Wages under the Code on Social Security 2020 (s.2(88)) — from 21-11-2025 for EPF and ESI
// ---------------------------------------------------------------------------------------------

export interface WageComponent {
  amountPaise: number
  /** true: part of "wages" (basic, DA, retaining allowance, any allowance not excluded);
   *  false: an excluded item (HRA, conveyance, overtime, commission, bonus …). */
  inWages: boolean
}

/**
 * s.2(88) wages: the components that are wages, plus — first proviso — whatever the excluded
 * items exceed one-half (`excludedCapBp` = 5000) of all remuneration by, "deemed to be
 * remuneration and ... added in wages" [COSS s.2(88)]. ESIC applies the same definition from
 * 21-11-2025 [ESIC-W]; the EPF Scheme 2026 para 18(2) contributes on "wages" [EPFS26].
 */
export function codeWages(components: readonly WageComponent[], excludedCapBp = 5000): number {
  let wages = 0
  let excluded = 0
  for (const c of components) {
    if (c.amountPaise <= 0) continue
    if (c.inWages) wages += c.amountPaise
    else excluded += c.amountPaise
  }
  const total = wages + excluded
  const cap = Math.floor((total * excludedCapBp) / 10000)
  return excluded > cap ? wages + (excluded - cap) : wages
}

/** Day-weighted wage ceiling for a month whose ceiling changes mid-month (17-9-2026: ₹15,000 →
 *  ₹25,000): Σ ceiling × days in force ÷ days in the month, rupee-rounded. The EPFO wage-ceiling
 *  FAQ illustrates this proration (UNVERIFIED source — see UNVERIFIED_WP37). */
export function weightedCeiling(spans: readonly { days: number; ceilingPaise: number }[]): number {
  const days = spans.reduce((s, x) => s + x.days, 0)
  if (days <= 0) return 0
  return roundRupee(spans.reduce((s, x) => s + x.ceilingPaise * x.days, 0) / days)
}

// ---------------------------------------------------------------------------------------------
// EPF / EPS / EDLI / admin charges
// ---------------------------------------------------------------------------------------------

export interface PfRates {
  /** Employee share (s.6 EPF Act) — 1200. */
  eeRateBp: number
  /** Employer share — 1200 (EPS 8.33% + EPF 3.67%). */
  erRateBp: number
  /** EPS out of the employer share (EPS 1995 para 3(2)) — 833. */
  epsRateBp: number
  /** EDLI (EDLI Scheme 1976 para 8 / s.6C) — 50. */
  edliRateBp: number
  /** EPFO administrative charges on EPF wages — 50. */
  adminRateBp: number
  /** Statutory wage ceiling — ₹15,000 to 16-9-2026, ₹25,000 from 17-9-2026 [SO5109]. */
  ceilingPaise: number
  /** Minimum administrative charges per establishment per month (applied at run level). */
  adminMinPaise: number
}

export const DEFAULT_PF_RATES: PfRates = {
  eeRateBp: 1200,
  erRateBp: 1200,
  epsRateBp: 833,
  edliRateBp: 50,
  adminRateBp: 50,
  ceilingPaise: 15_000_00,
  adminMinPaise: 500_00
}

export interface PfProfile {
  enabled: boolean
  /** Voluntary PF over and above the 12% (employee only; employer not bound) — bp of PF wages. */
  vpfRateBp: number
  /** Contribute on actual PF wages above the ceiling (EPF Scheme para 26A(2) joint option).
   *  EPS / EDLI stay capped at the ceiling regardless. */
  onFullWage: boolean
  /** Not an EPS member (joined on/after 1-9-2014 with pay above the ceiling — EPS para 6A — or
   *  aged 58+): the whole employer 12% goes to EPF. */
  epsEligible: boolean
}

export interface PfResult {
  /** EPF wages (capped unless onFullWage). */
  epfWage: number
  /** EPS / EDLI wages (always capped; EPS 0 when not an EPS member). */
  epsWage: number
  edliWage: number
  ee: number
  vpf: number
  er: number
  /** Part of the employer share remitted to EPS (A/c 10). */
  eps: number
  /** Employer EPF difference (A/c 1 employer side) = er − eps. */
  epfEr: number
  edli: number
  admin: number
}

const ZERO_PF: PfResult = { epfWage: 0, epsWage: 0, edliWage: 0, ee: 0, vpf: 0, er: 0, eps: 0, epfEr: 0, edli: 0, admin: 0 }

/** EPF contributions for one month. `pfWagesPaise` = basic + DA (+ retaining allowance) actually
 *  paid this month (s.2(b) / s.6). Each amount is rounded to the rupee [EPFS para 29]. */
export function computePf(pfWagesPaise: number, profile: PfProfile, rates: PfRates = DEFAULT_PF_RATES): PfResult {
  if (!profile.enabled || pfWagesPaise <= 0) return { ...ZERO_PF }
  const capped = Math.min(pfWagesPaise, rates.ceilingPaise)
  const epfWage = profile.onFullWage ? pfWagesPaise : capped
  const epsWage = profile.epsEligible ? capped : 0
  const edliWage = capped
  const ee = bpRupeeHalfUp(epfWage, rates.eeRateBp)
  const vpf = bpRupeeHalfUp(epfWage, profile.vpfRateBp)
  const er = bpRupeeHalfUp(epfWage, rates.erRateBp)
  const eps = Math.min(er, bpRupeeHalfUp(epsWage, rates.epsRateBp))
  return {
    epfWage, epsWage, edliWage, ee, vpf, er, eps, epfEr: er - eps,
    edli: bpRupeeHalfUp(edliWage, rates.edliRateBp),
    admin: bpRupeeHalfUp(epfWage, rates.adminRateBp)
  }
}

/** Run-level admin-charge top-up: EPFO charges at least `adminMinPaise` per establishment per
 *  month when there is at least one contributing member. Returns the extra to post (≥ 0). */
export function pfAdminTopUp(sumAdminPaise: number, members: number, rates: PfRates = DEFAULT_PF_RATES): number {
  if (members <= 0) return 0
  return Math.max(0, rates.adminMinPaise - sumAdminPaise)
}

/** Due date for EPF remittance of a wage month: within 15 days of the close of the month — EPF
 *  Scheme 2026 paras 20(1), 28(3) [EPFS26] (1952 para 38(1)). */
export function pfDueDate(month: string): string {
  return `${nextMonth(month)}-15`
}

// ---------------------------------------------------------------------------------------------
// ESI
// ---------------------------------------------------------------------------------------------

export interface EsiRates {
  /** Employee share 0.75% (SS (Central) Rules 2026 r.19(1)(b) [SSR26]; from 1-7-2019 [ESIC-C]) — 75. */
  eeRateBp: number
  /** Employer share 3.25% — 325. */
  erRateBp: number
  /** Coverage wage ceiling — ₹21,000 (ESIC practice [ESIC-C]; basis under the Code UNVERIFIED). */
  thresholdPaise: number
  /** Ceiling for employees with disability — ₹25,000. */
  disabledThresholdPaise: number
  /** Average daily wage at or below which the employee share is nil (employer still pays) — ₹176. */
  eeExemptDailyWagePaise: number
}

export const DEFAULT_ESI_RATES: EsiRates = {
  eeRateBp: 75,
  erRateBp: 325,
  thresholdPaise: 21_000_00,
  disabledThresholdPaise: 25_000_00,
  eeExemptDailyWagePaise: 176_00
}

/** ESI contribution periods: 1 April–30 September and 1 October–31 March [ESIC-C]; draft ESI
 *  (General) Regulations 2026 reg 5. */
export function esiContributionPeriod(month: string): { from: string; to: string; label: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  if (m >= 4 && m <= 9) return { from: `${y}-04`, to: `${y}-09`, label: `Apr–Sep ${y}` }
  const startY = m >= 10 ? y : y - 1
  return { from: `${startY}-10`, to: `${startY + 1}-03`, label: `Oct ${startY}–Mar ${startY + 1}` }
}

export interface EsiInput {
  enabled: boolean
  /** Full contracted monthly wages (coverage is judged on the rate of wages, not attendance). */
  contractedWagesPaise: number
  /** Wages actually paid this month (contributions are on these). */
  wagesPaise: number
  payableDays: number
  disabled: boolean
  /** Covered in an earlier month of the same contribution period — stays covered to its end
   *  even after crossing the ceiling (ESI (Central) Rules 1950 r.50 proviso; not found in the
   *  Code / 2026 Rules — UNVERIFIED, ESIC still applies it). */
  coveredEarlierInPeriod: boolean
}

export interface EsiResult {
  covered: boolean
  ee: number
  er: number
  wages: number
}

export function computeEsi(input: EsiInput, rates: EsiRates = DEFAULT_ESI_RATES): EsiResult {
  if (!input.enabled) return { covered: false, ee: 0, er: 0, wages: 0 }
  const ceiling = input.disabled ? rates.disabledThresholdPaise : rates.thresholdPaise
  const covered = input.contractedWagesPaise <= ceiling || input.coveredEarlierInPeriod
  if (!covered) return { covered: false, ee: 0, er: 0, wages: 0 }
  const wages = input.wagesPaise
  const daily = input.payableDays > 0 ? wages / input.payableDays : 0
  const eeExempt = input.payableDays > 0 && daily <= rates.eeExemptDailyWagePaise
  return {
    covered: true,
    ee: eeExempt ? 0 : bpRupeeUp(wages, rates.eeRateBp),
    er: bpRupeeUp(wages, rates.erRateBp),
    wages
  }
}

/** ESI contributions are due within 15 days of the last day of the calendar month [ESIC-C]
 *  (ESI (General) Regulations 1950 reg. 31; draft 2026 reg 19). */
export function esiDueDate(month: string): string {
  return `${nextMonth(month)}-15`
}

// ---------------------------------------------------------------------------------------------
// Professional tax
// ---------------------------------------------------------------------------------------------

export type PtBasis = 'month' | 'half_year' | 'year'
export type Gender = 'male' | 'female' | 'other'

export interface PtSlab {
  /** Lower bound of the slab's salary (inclusive), paise, on the slab's basis. */
  fromPaise: number
  /** Upper bound (inclusive), paise; null = no ceiling. */
  toPaise: number | null
  /** Tax for one period of the basis, paise. */
  amountPaise: number
  basis: PtBasis
  /** 'any', or a gender the row is restricted to (Maharashtra's women's slab). */
  gender: 'any' | 'male' | 'female'
  /** Calendar month (1–12) in which `specialAmountPaise` replaces amountPaise (MH February ₹300). */
  specialMonth: number | null
  specialAmountPaise: number | null
}

/**
 * PT deducted for a wage month. Monthly slabs look up the month's gross. Half-yearly / annual
 * slabs (Tamil Nadu, Madhya Pradesh) project the period's salary from the month's gross and
 * spread the period tax evenly, rupee-rounded, with the remainder in the period's last month
 * (September / March for half-years, March for the year).
 */
export function computePt(slabs: readonly PtSlab[], monthlyGrossPaise: number, month: string, gender: Gender | null): number {
  if (slabs.length === 0 || monthlyGrossPaise <= 0) return 0
  const basis = slabs[0]!.basis
  const m = Number(month.slice(5, 7))
  const periodMonths = basis === 'month' ? 1 : basis === 'half_year' ? 6 : 12
  const income = monthlyGrossPaise * periodMonths
  // Slabs are matched on their upper bound only (the first slab, in ascending order, whose
  // ceiling covers the income) so a fractional-rupee salary between two printed bounds — ₹7,500.50
  // between "up to 7,500" and "7,501 to 10,000" — falls in the higher slab, never in a gap.
  const byCeiling = (a: PtSlab, b: PtSlab): number => (a.toPaise ?? Infinity) - (b.toPaise ?? Infinity)
  const pick = (rows: PtSlab[]): PtSlab | undefined => [...rows].sort(byCeiling).find((s) => s.toPaise == null || income <= s.toPaise)
  // A gender-specific table (Maharashtra's women's slab) replaces the general one for that gender.
  const own = gender ? slabs.filter((s) => s.gender === gender) : []
  const hit = own.length > 0 ? pick(own) : pick(slabs.filter((s) => s.gender === 'any'))
  if (!hit) return 0
  if (basis === 'month') return hit.specialMonth === m && hit.specialAmountPaise != null ? hit.specialAmountPaise : hit.amountPaise
  const per = Math.floor(hit.amountPaise / periodMonths / 100) * 100
  const last = basis === 'year' ? m === 3 : m === 9 || m === 3
  return last ? hit.amountPaise - per * (periodMonths - 1) : per
}

// ---------------------------------------------------------------------------------------------
// Salary TDS — projection and monthly spread
// ---------------------------------------------------------------------------------------------

export type TaxRegime = 'new' | 'old'
export type AgeBand = 'below60' | 'senior' | 'superSenior'

/** One slab: income above `fromPaise` (exclusive) taxed at `rateBp`. */
export interface TaxSlab {
  fromPaise: number
  rateBp: number
}

export interface RegimeRules {
  slabs: Record<AgeBand, TaxSlab[]>
  standardDeductionPaise: number
  /** Rebate: total income ≤ limit → rebate up to maxRebate; marginal relief above the limit when set. */
  rebate: { incomeLimitPaise: number; maxRebatePaise: number; marginalRelief: boolean }
  /** Surcharge bands on income above `abovePaise`. */
  surcharge: { abovePaise: number; rateBp: number }[]
  /** Chapter VI-A / s.10 exemptions allowed in this regime. */
  allowsDeductions: boolean
}

export interface IncomeTaxYear {
  fyStartYear: number
  act: '1961' | '2025'
  /** Salary TDS section reference for the year. */
  tdsSection: string
  cessBp: number
  regimes: Record<TaxRegime, RegimeRules>
  /** Section references printed on the workings (Form 16 / 24Q annexure II labels). */
  refs: {
    standardDeduction: string
    professionalTax: string
    hra: string
    rebate: string
    newRegime: string
    c80: string
    ccd1b: string
    d80: string
    hp24b: string
  }
  source: string
}

const L = (lakh: number): number => lakh * 100_000_00

const OLD_SLABS_1961: Record<AgeBand, TaxSlab[]> = {
  below60: [{ fromPaise: L(2.5), rateBp: 500 }, { fromPaise: L(5), rateBp: 2000 }, { fromPaise: L(10), rateBp: 3000 }],
  senior: [{ fromPaise: L(3), rateBp: 500 }, { fromPaise: L(5), rateBp: 2000 }, { fromPaise: L(10), rateBp: 3000 }],
  superSenior: [{ fromPaise: L(5), rateBp: 2000 }, { fromPaise: L(10), rateBp: 3000 }]
}

const NEW_SLABS_FY25: TaxSlab[] = [
  { fromPaise: L(4), rateBp: 500 },
  { fromPaise: L(8), rateBp: 1000 },
  { fromPaise: L(12), rateBp: 1500 },
  { fromPaise: L(16), rateBp: 2000 },
  { fromPaise: L(20), rateBp: 2500 },
  { fromPaise: L(24), rateBp: 3000 }
]

const SURCHARGE_OLD = [
  { abovePaise: L(50), rateBp: 1000 },
  { abovePaise: L(100), rateBp: 1500 },
  { abovePaise: L(200), rateBp: 2500 },
  { abovePaise: L(500), rateBp: 3700 }
]
const SURCHARGE_NEW = SURCHARGE_OLD.slice(0, 3)

const REGIMES_FY25: Record<TaxRegime, RegimeRules> = {
  new: {
    slabs: { below60: NEW_SLABS_FY25, senior: NEW_SLABS_FY25, superSenior: NEW_SLABS_FY25 },
    standardDeductionPaise: 75_000_00,
    rebate: { incomeLimitPaise: L(12), maxRebatePaise: 60_000_00, marginalRelief: true },
    surcharge: SURCHARGE_NEW,
    allowsDeductions: false
  },
  old: {
    slabs: OLD_SLABS_1961,
    standardDeductionPaise: 50_000_00,
    rebate: { incomeLimitPaise: L(5), maxRebatePaise: 12_500_00, marginalRelief: false },
    surcharge: SURCHARGE_OLD,
    allowsDeductions: true
  }
}

/**
 * Income-tax rules by financial year (VERIFIED unless noted).
 * FY 2025-26 — Income-tax Act 1961 as amended by the Finance Act 2025 [FA25]: new-regime slabs
 *   s.115BAC(1A)(iii) (FA25 s.25); s.87A rebate ₹60,000 to ₹12 lakh (FA25 s.20; marginal-relief
 *   clause UNVERIFIED in the 1961 text); old-regime slabs First Schedule Part III Para A(I)-(III)
 *   (2.5L / 3L senior / 5L super-senior); surcharge 10/15/25/37% (new regime 25% cap) with
 *   marginal relief; 4% cess (FA25 s.2(11)/(12)). Standard deduction ₹75,000 / ₹50,000 s.16(ia)
 *   and the ₹12,500 old-regime rebate: same figures as the 2025 Act (1961 text UNVERIFIED).
 * FY 2026-27 — Income-tax Act 2025 [ACT25]: s.202(1) Table (same slabs), s.156(1) old rebate
 *   ₹12,500 to ₹5 lakh, s.156(2) new rebate ₹60,000 to ₹12 lakh with marginal relief, s.19(1)
 *   Table Sl.2 standard deduction, s.202(2)(a) exclusions in the new regime, s.392 salary TDS.
 *   Old-regime TDS rates, surcharge and the 4% cess come from the Finance Act 2026 s.3 + First
 *   Schedule Part III [FA26], which changes none of these figures.
 */
export const INCOME_TAX_YEARS: IncomeTaxYear[] = [
  {
    fyStartYear: 2025,
    act: '1961',
    tdsSection: '192',
    cessBp: 400,
    regimes: REGIMES_FY25,
    refs: {
      standardDeduction: 's.16(ia)', professionalTax: 's.16(iii)', hra: 's.10(13A)', rebate: 's.87A',
      newRegime: 's.115BAC(1A)', c80: 's.80C', ccd1b: 's.80CCD(1B)', d80: 's.80D', hp24b: 's.24(b)'
    },
    source: 'Income-tax Act 1961 as amended by Finance Act 2025 (https://egazette.gov.in/WriteReadData/2025/262125.pdf); accessed 2026-10-07'
  },
  {
    fyStartYear: 2026,
    act: '2025',
    tdsSection: '392',
    cessBp: 400,
    regimes: REGIMES_FY25,
    refs: {
      standardDeduction: 's.19(1) Table Sl.2', professionalTax: 's.19(1) Table Sl.1', hra: 's.11 + Sch. III Sl.11', rebate: 's.156',
      newRegime: 's.202(1)', c80: 's.123', ccd1b: 's.124(3)', d80: 's.126', hp24b: 's.22(1)(b)'
    },
    source: 'Income-tax Act 2025 (https://egazette.gov.in/WriteReadData/2025/265620.pdf) with rates per Finance Act 2026 (https://egazette.gov.in/WriteReadData/2026/271439.pdf); accessed 2026-10-07'
  }
]

/** The rules for a financial year: the year's own row, else the latest earlier one. */
export function incomeTaxYear(fyStartYear: number): IncomeTaxYear {
  const sorted = [...INCOME_TAX_YEARS].sort((a, b) => a.fyStartYear - b.fyStartYear)
  let pick = sorted[0]!
  for (const y of sorted) if (y.fyStartYear <= fyStartYear) pick = y
  return pick
}

/** Slab tax on a total income (paise), unrounded rupee maths kept in paise. */
export function slabTax(incomePaise: number, slabs: readonly TaxSlab[]): number {
  let tax = 0
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i]!
    const upper = slabs[i + 1]?.fromPaise ?? Infinity
    if (incomePaise <= s.fromPaise) break
    tax += ((Math.min(incomePaise, upper) - s.fromPaise) * s.rateBp) / 10000
  }
  return Math.round(tax)
}

export interface TaxOnIncome {
  taxBeforeRebate: number
  rebate: number
  taxAfterRebate: number
  surcharge: number
  /** Marginal relief on surcharge already netted off `surcharge`. */
  cess: number
  /** Tax + surcharge + cess, rounded to ₹10. */
  total: number
}

/** Tax on a total income under a regime: slabs → rebate (with new-regime marginal relief) →
 *  surcharge (with marginal relief at each band) → cess → round to ₹10. */
export function taxOnTotalIncome(totalIncomePaise: number, regime: TaxRegime, age: AgeBand, year: IncomeTaxYear): TaxOnIncome {
  const r = year.regimes[regime]
  const slabs = r.slabs[age]
  const income = Math.max(0, totalIncomePaise)
  const before = slabTax(income, slabs)
  let rebate = 0
  if (income <= r.rebate.incomeLimitPaise) rebate = Math.min(before, r.rebate.maxRebatePaise)
  else if (r.rebate.marginalRelief) {
    // Tax payable may not exceed the income above the rebate limit (proviso to s.87A / s.156).
    const excess = income - r.rebate.incomeLimitPaise
    if (before > excess) rebate = before - excess
  }
  const afterRebate = before - rebate
  let surcharge = 0
  const band = [...r.surcharge].reverse().find((b) => income > b.abovePaise)
  if (band) {
    surcharge = Math.round((afterRebate * band.rateBp) / 10000)
    // Marginal relief: tax + surcharge may exceed the tax (+ surcharge of the band below) at the
    // band threshold by no more than the income above the threshold.
    const lower = [...r.surcharge].reverse().find((b) => b.abovePaise < band.abovePaise)
    const atThreshold = slabTax(band.abovePaise, slabs)
    const atThresholdTotal = atThreshold + (lower ? Math.round((atThreshold * lower.rateBp) / 10000) : 0)
    const cap = atThresholdTotal + (income - band.abovePaise)
    if (afterRebate + surcharge > cap) surcharge = Math.max(0, cap - afterRebate)
  }
  const cess = Math.round(((afterRebate + surcharge) * year.cessBp) / 10000)
  return { taxBeforeRebate: before, rebate, taxAfterRebate: afterRebate, surcharge, cess, total: roundTenRupees(afterRebate + surcharge + cess) }
}

/** Declaration sections the v1 projection understands (employee_tax_declarations.section). */
export const DECLARATION_SECTIONS = [
  '80C', '80CCD1B', '80D', '80D_PARENTS', '24B', 'RENT', 'OTHER_INCOME', 'PREV_SALARY', 'PREV_TDS', 'PREV_PT'
] as const
export type DeclarationSection = (typeof DECLARATION_SECTIONS)[number]

export const DECLARATION_LABELS: Record<DeclarationSection, string> = {
  '80C': '80C — PPF, ELSS, LIC, tuition, principal (employee PF counted automatically)',
  '80CCD1B': '80CCD(1B) — own NPS contribution',
  '80D': '80D — health insurance, self / family',
  '80D_PARENTS': '80D — health insurance, parents',
  '24B': '24(b) — home-loan interest (self-occupied)',
  RENT: 'Rent paid for the year (HRA exemption)',
  OTHER_INCOME: 'Other income declared (s.192(2B))',
  PREV_SALARY: 'Salary from previous employer this year (Form 12B)',
  PREV_TDS: 'TDS by previous employer this year (Form 12B)',
  PREV_PT: 'Professional tax by previous employer this year'
}

/** Caps (paise) per section, 2025 Act [ACT25]: s.123 ₹1,50,000 (80C); s.124(3) ₹50,000
 *  (80CCD(1B)); s.126 ₹25,000 self / family and ₹25,000 parents, ₹50,000 each for senior citizens
 *  (s.126(8)) (80D); s.22(1)(b)/(5) ₹2,00,000 self-occupied interest (24(b)). The 1961 sections
 *  carry the same figures (texts UNVERIFIED). Professional tax: s.19(1) Table Sl.1 / 1961
 *  s.16(iii), within the Article 276(2) ₹2,500 cap. */
export const DEDUCTION_CAPS = {
  c80: 1_50_000_00,
  ccd1b: 50_000_00,
  d80Below60: 25_000_00,
  d80Senior: 50_000_00,
  hp24b: 2_00_000_00,
  /** s.16(iii) / Article 276(2): professional tax deductible up to ₹2,500 a year. */
  pt: 2_500_00
} as const

export interface SalaryProjectionInput {
  fyStartYear: number
  regime: TaxRegime
  age: AgeBand
  metro: boolean
  /** Salary for the whole year, projected: paid so far + this month + contracted × months left. */
  grossPaise: number
  basicPaise: number
  hraPaise: number
  ptPaise: number
  /** Employee PF + VPF for the year (counts under 80C in the old regime). */
  employeePfPaise: number
  declarations: Partial<Record<DeclarationSection, number>>
}

export interface SalaryWorkings {
  fyStartYear: number
  act: '1961' | '2025'
  regime: TaxRegime
  gross: number
  /** Salary from the previous employer (Form 12B), included in gross. */
  previousEmployerSalary: number
  hraExemption: number
  standardDeduction: number
  professionalTax: number
  incomeFromSalary: number
  otherIncome: number
  housePropertyLoss: number
  grossTotalIncome: number
  deductions: { section: string; label: string; amount: number }[]
  deductionsTotal: number
  totalIncome: number
  taxOnIncome: TaxOnIncome
  /** Tax to be deducted by THIS employer for the year (= total − previous employer's TDS). */
  taxPayableByEmployer: number
  previousEmployerTds: number
}

/** Cities where the HRA exemption is 50% of salary (40% elsewhere): FY 2025-26 rule 2A of the
 *  1962 Rules (four cities — UNVERIFIED); from FY 2026-27 Income-tax Rules 2026 rule 279 [R26]. */
export function hraMetroCities(fyStartYear: number): string[] {
  const four = ['Delhi', 'Mumbai', 'Kolkata', 'Chennai']
  return fyStartYear >= 2026 ? [...four, 'Hyderabad', 'Pune', 'Ahmedabad', 'Bengaluru'] : four
}

/** HRA exemption, least of: HRA received; rent paid − 10% of salary; 50% (metro) / 40% of
 *  salary — salary = basic + DA (1961 s.10(13A) + rule 2A; 2025 Act s.11 + Schedule III Sl.11 +
 *  Rules 2026 rule 279 [ACT25][R26]). Old regime only (2025 s.202(2)(a)). */
export function hraExemption(hraPaise: number, rentPaise: number, basicPaise: number, metro: boolean): number {
  if (hraPaise <= 0 || rentPaise <= 0) return 0
  const rentLess = rentPaise - Math.round(basicPaise / 10)
  const cap = Math.round((basicPaise * (metro ? 50 : 40)) / 100)
  return Math.max(0, Math.min(hraPaise, rentLess, cap))
}

/** The year's salary workings — Form 16 Part B order. */
export function salaryWorkings(input: SalaryProjectionInput): SalaryWorkings {
  const year = incomeTaxYear(input.fyStartYear)
  const rules = year.regimes[input.regime]
  const d = input.declarations
  const prevSalary = d.PREV_SALARY ?? 0
  const prevPt = d.PREV_PT ?? 0
  const gross = input.grossPaise + prevSalary
  const old = rules.allowsDeductions
  const hra = old ? hraExemption(input.hraPaise, d.RENT ?? 0, input.basicPaise, input.metro) : 0
  const afterExemptions = gross - hra
  const standardDeduction = Math.min(rules.standardDeductionPaise, Math.max(0, afterExemptions))
  const professionalTax = old ? Math.min(DEDUCTION_CAPS.pt, input.ptPaise + prevPt) : 0
  const incomeFromSalary = Math.max(0, afterExemptions - standardDeduction - professionalTax)
  const otherIncome = d.OTHER_INCOME ?? 0
  const housePropertyLoss = old ? Math.min(DEDUCTION_CAPS.hp24b, d['24B'] ?? 0) : 0
  const grossTotalIncome = Math.max(0, incomeFromSalary + otherIncome - housePropertyLoss)
  const deductions: SalaryWorkings['deductions'] = []
  if (old) {
    const c80 = Math.min(DEDUCTION_CAPS.c80, (d['80C'] ?? 0) + input.employeePfPaise)
    if (c80 > 0) deductions.push({ section: year.refs.c80, label: 'Life insurance, PF, PPF, ELSS, tuition, principal', amount: c80 })
    const ccd = Math.min(DEDUCTION_CAPS.ccd1b, d['80CCD1B'] ?? 0)
    if (ccd > 0) deductions.push({ section: year.refs.ccd1b, label: 'Own contribution to NPS', amount: ccd })
    const selfCap = input.age === 'below60' ? DEDUCTION_CAPS.d80Below60 : DEDUCTION_CAPS.d80Senior
    const d80 = Math.min(selfCap, d['80D'] ?? 0) + Math.min(DEDUCTION_CAPS.d80Senior, d['80D_PARENTS'] ?? 0)
    if (d80 > 0) deductions.push({ section: year.refs.d80, label: 'Health insurance premium', amount: d80 })
  }
  const deductionsTotal = Math.min(grossTotalIncome, deductions.reduce((s, x) => s + x.amount, 0))
  const totalIncome = roundTenRupees(grossTotalIncome - deductionsTotal)
  const taxOnIncome = taxOnTotalIncome(totalIncome, input.regime, input.age, year)
  const previousEmployerTds = d.PREV_TDS ?? 0
  return {
    fyStartYear: input.fyStartYear, act: year.act, regime: input.regime,
    gross, previousEmployerSalary: prevSalary, hraExemption: hra, standardDeduction, professionalTax,
    incomeFromSalary, otherIncome, housePropertyLoss, grossTotalIncome, deductions, deductionsTotal, totalIncome,
    taxOnIncome,
    taxPayableByEmployer: Math.max(0, taxOnIncome.total - previousEmployerTds),
    previousEmployerTds
  }
}

/** Months of the financial year remaining from `month` (inclusive): April → 12, March → 1. */
export function monthsRemainingInFy(month: string): number {
  const m = Number(month.slice(5, 7))
  const idx = m >= 4 ? m - 4 : m + 8
  return 12 - idx
}

/**
 * This month's TDS: (annual tax − tax already deducted this year) ÷ months remaining including
 * this one, rounded to the rupee. 2025 Act s.392(1): deduct "at the average rate of income-tax"
 * on the estimated salary for the year; s.392(5)(c): later deductions may be increased or reduced
 * to adjust an excess or shortfall [ACT25] (1961 s.192(1), (3)). Never negative — an excess is
 * absorbed by later months, not refunded.
 */
export function monthlyTds(annualTaxPaise: number, deductedSoFarPaise: number, month: string): number {
  const remaining = monthsRemainingInFy(month)
  const due = annualTaxPaise - deductedSoFarPaise
  if (due <= 0) return 0
  return roundRupee(due / remaining)
}

/** Age band on the last day of the financial year (old-regime slabs depend on it). */
export function ageBand(dob: string | null, fyStartYear: number): AgeBand {
  if (!dob) return 'below60'
  const end = `${fyStartYear + 1}-03-31`
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number]
  const [ey, em, ed] = end.split('-').map(Number) as [number, number, number]
  let age = ey - by
  if (em < bm || (em === bm && ed < bd)) age--
  return age >= 80 ? 'superSenior' : age >= 60 ? 'senior' : 'below60'
}

/** Salary TDS deposit due date: 7th of the following month; March deductions by 30 April —
 *  Income-tax Rules 2026 rule 218 [R26] (1962 Rules rule 30, same dates — UNVERIFIED). */
export function tdsDueDate(month: string): string {
  if (month.slice(5, 7) === '03') return `${month.slice(0, 4)}-04-30`
  return `${nextMonth(month)}-07`
}

// ---------------------------------------------------------------------------------------------
// Gratuity and bonus — compute-only helpers (no posting)
// ---------------------------------------------------------------------------------------------

export interface GratuityInput {
  /** Last drawn monthly wages = basic + DA, paise. */
  monthlyWagesPaise: number
  /** Service in completed years plus months. */
  years: number
  months: number
  /** Seasonal establishments compute 7 days per season — not modelled. */
  ceilingPaise?: number
  /** Minimum continuous service (5 years; waived on death, disablement or expiry of a fixed-term
   *  contract — CoSS s.53(1)). */
  minYears?: number
  deathOrDisablement?: boolean
  /** Fixed-term employee: pro rata, no five-year minimum (CoSS s.53(1)-(2)). */
  fixedTerm?: boolean
}

export const GRATUITY_CEILING_PAISE = 20_00_000_00

/** Gratuity — Code on Social Security 2020 s.53, in force 21-11-2025 (replacing Payment of
 *  Gratuity Act 1972 s.4) [COSS]: 15 days' wages (last drawn s.2(88) wages) for every completed
 *  year of service or part in excess of six months; monthly-rated: monthly wages ÷ 26 × 15
 *  (Explanation 3); five years' continuous service, waived on death / disablement / fixed-term
 *  expiry (s.53(1)); ceiling "as notified" (s.53(3)) — ₹20 lakh (S.O. 1420(E) 29-3-2018 under
 *  PGA s.4(3); its status under the Code UNVERIFIED). Compute-only. Rupee-rounded. */
export function gratuity(input: GratuityInput): { eligible: boolean; serviceYears: number; amountPaise: number } {
  const minYears = input.minYears ?? 5
  const serviceYears = input.years + (input.months > 6 ? 1 : 0)
  const eligible = !!input.deathOrDisablement || !!input.fixedTerm || input.years >= minYears
  if (!eligible) return { eligible, serviceYears, amountPaise: 0 }
  const raw = (input.monthlyWagesPaise * 15 * serviceYears) / 26
  return { eligible, serviceYears, amountPaise: Math.min(input.ceilingPaise ?? GRATUITY_CEILING_PAISE, roundRupee(raw)) }
}

export interface BonusInput {
  /** Salary or wage per month (basic + DA), paise — one entry per month worked in the year. */
  monthlySalariesPaise: number[]
  /** Bonus rate, bp: 833 minimum (s.10) … 2000 maximum (s.31A / s.11). */
  rateBp?: number
  /** Eligibility ceiling (s.2(13)) ₹21,000 a month. */
  eligibilityCeilingPaise?: number
  /** Calculation ceiling (s.12) ₹7,000 or the scheduled minimum wage, whichever higher. */
  calcCeilingPaise?: number
  minimumWagePaise?: number
  /** Worked at least 30 days in the accounting year (s.8). */
  workingDays: number
}

export const BONUS_MIN_BP = 833
/** Code on Wages s.26(1): "eight and one-third per cent ... or one hundred rupees, whichever is higher". */
export const BONUS_MIN_AMOUNT_PAISE = 100_00
export const BONUS_MAX_BP = 2000

/** Bonus — Code on Wages 2019 s.26, in force 21-11-2025 and repealing the Payment of Bonus Act
 *  (s.69) [CoW]: 30 days' work; minimum 8.33% or ₹100 whichever higher, maximum 20%; the wage
 *  limit and calculation ceiling "as notified" — taken as the 2015 amendment's ₹21,000 (s.2(13))
 *  and ₹7,000 or the minimum wage whichever higher (s.12) [BONUS15] (status under the Code
 *  UNVERIFIED). Compute-only. */
export function bonus(input: BonusInput): { eligible: boolean; basePaise: number; amountPaise: number } {
  const ceiling = input.eligibilityCeilingPaise ?? 21_000_00
  const calcCap = Math.max(input.calcCeilingPaise ?? 7_000_00, input.minimumWagePaise ?? 0)
  const rate = Math.min(BONUS_MAX_BP, Math.max(BONUS_MIN_BP, input.rateBp ?? BONUS_MIN_BP))
  const eligible = input.workingDays >= 30 && input.monthlySalariesPaise.some((s) => s <= ceiling)
  if (!eligible) return { eligible, basePaise: 0, amountPaise: 0 }
  const base = input.monthlySalariesPaise.filter((s) => s <= ceiling).reduce((s, x) => s + Math.min(x, calcCap), 0)
  return { eligible, basePaise: base, amountPaise: Math.max(BONUS_MIN_AMOUNT_PAISE, roundRupee((base * rate) / 10000)) }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/** Financial-year start of a 'YYYY-MM' wage month. */
export function fyStartOfMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m >= 4 ? y : y - 1
}
