/**
 * Fixed-asset register (WP 3.6) — IPC input schemas and the row shapes main returns, shared by
 * main and renderer. The maths lives in ./depreciation.ts; the statutory sources are cited in
 * migration 026 (src/main/db/migrations.ts) and FIXED_ASSET_SOURCES below.
 */
import { z } from 'zod'
import { isoDate } from './schemas'
import type { DepMethod } from './depreciation'
import type { ItBlockResult } from './depreciation'

const id = z.number().int().positive()
const paise = z.number().int().safe()

export const DISPOSAL_KINDS = ['sale', 'scrap'] as const
export type DisposalKind = (typeof DISPOSAL_KINDS)[number]

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export const caClassInputSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  lifeMonths: z.number().int().min(1).max(1200),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().default(null),
  source: z.string().trim().max(1000).default('')
})
export type CaClassInput = z.input<typeof caClassInputSchema>

export const itBlockInputSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200)
})
export type ItBlockInput = z.input<typeof itBlockInputSchema>

export const itBlockRateInputSchema = z.object({
  blockId: id,
  effectiveFrom: isoDate,
  effectiveTo: isoDate.nullable().default(null),
  rateBp: z.number().int().min(0).max(10_000),
  additionalRateBp: z.number().int().min(0).max(10_000).default(0),
  act: z.enum(['1961', '2025']),
  sectionRef: z.string().trim().max(200).default(''),
  source: z.string().trim().max(1000).default('')
})
export type ItBlockRateInput = z.input<typeof itBlockRateInputSchema>

export const itBlockOpeningInputSchema = z.object({
  blockId: id,
  fyStartYear: z.number().int().min(1990).max(2100),
  openingWdv: paise.min(0),
  additionalBroughtForward: paise.min(0).default(0)
})
export type ItBlockOpeningInput = z.input<typeof itBlockOpeningInputSchema>

export const assetGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  caClassId: id.nullable().default(null),
  lifeMonths: z.number().int().min(1).max(1200),
  residualBp: z.number().int().min(0).max(10_000).default(500),
  method: z.enum(['slm', 'wdv']).default('slm'),
  itBlockId: id.nullable().default(null),
  assetLedgerId: id.nullable().default(null),
  accDepLedgerId: id.nullable().default(null),
  depExpenseLedgerId: id.nullable().default(null),
  postPerAsset: z.boolean().default(false)
})
export type AssetGroupInput = z.input<typeof assetGroupInputSchema>

export const fixedAssetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    assetGroupId: id,
    ledgerId: id,
    purchaseVoucherId: id.nullable().default(null),
    purchaseDate: isoDate,
    putToUseDate: isoDate,
    costPaise: paise.min(1),
    residualBp: z.number().int().min(0).max(10_000),
    lifeMonths: z.number().int().min(1).max(1200),
    method: z.enum(['slm', 'wdv']),
    itBlockId: id.nullable().default(null),
    itAdditionalEligible: z.boolean().default(false),
    location: z.string().trim().max(200).nullable().default(null),
    identifier: z.string().trim().max(200).nullable().default(null),
    accDepLedgerId: id.nullable().default(null),
    /** Accumulated depreciation brought in for an asset that predates the books, and the date it
     *  runs to (depreciation resumes the day after). */
    openingAccDepPaise: paise.min(0).default(0),
    openingAccDepAsOf: isoDate.nullable().default(null),
    /** Changing method / life / residual of an asset that has depreciation booked: the FY start the
     *  change applies from (prospective). Ignored when nothing changed. */
    changeEffectiveFrom: isoDate.nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null)
  })
  .refine((a) => a.putToUseDate >= a.purchaseDate, { message: 'Put-to-use date cannot be before the purchase date', path: ['putToUseDate'] })
  .refine((a) => a.method === 'slm' || a.residualBp > 0, { message: 'WDV needs a residual value above zero', path: ['residualBp'] })
  .refine((a) => a.openingAccDepPaise <= a.costPaise, { message: 'Opening accumulated depreciation cannot exceed the cost', path: ['openingAccDepPaise'] })
  .refine((a) => a.openingAccDepPaise === 0 || a.openingAccDepAsOf !== null, { message: 'Give the date the opening accumulated depreciation runs to', path: ['openingAccDepAsOf'] })
export type FixedAssetInput = z.input<typeof fixedAssetInputSchema>

export const assetAdditionInputSchema = z.object({
  assetId: id,
  date: isoDate,
  voucherId: id.nullable().default(null),
  amountPaise: paise.min(1),
  kind: z.enum(['addition', 'improvement']).default('improvement'),
  note: z.string().trim().max(500).nullable().default(null)
})
export type AssetAdditionInput = z.input<typeof assetAdditionInputSchema>

export const depreciationPeriodSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((p) => p.to >= p.from, { message: 'The period ends before it starts', path: ['to'] })

export const disposalInputSchema = z.object({
  assetId: id,
  date: isoDate,
  kind: z.enum(DISPOSAL_KINDS),
  proceedsPaise: paise.min(0),
  /** Cash / bank / buyer the proceeds are debited to; null only for a scrap with no proceeds. */
  considerationLedgerId: id.nullable().default(null),
  /** Charge depreciation from the last run up to the day before disposal in the same voucher. */
  chargeCatchUp: z.boolean().default(true),
  narration: z.string().trim().max(500).nullable().default(null)
})
export type DisposalInput = z.input<typeof disposalInputSchema>

export const scheduleQuerySchema = depreciationPeriodSchema
export const itStatementQuerySchema = z.object({ fyStartYear: z.number().int().min(1990).max(2100) })

// ---------------------------------------------------------------------------------------------
// Rows (what main returns)
// ---------------------------------------------------------------------------------------------

export interface CaClassRow {
  id: number
  code: string
  name: string
  lifeMonths: number
  effectiveFrom: string
  effectiveTo: string | null
  source: string
  isSeeded: boolean
}

export interface ItBlockRateRow {
  id: number
  blockId: number
  effectiveFrom: string
  effectiveTo: string | null
  rateBp: number
  additionalRateBp: number
  act: '1961' | '2025'
  sectionRef: string
  source: string
  isSeeded: boolean
}

export interface ItBlockRow {
  id: number
  code: string
  name: string
  isSeeded: boolean
  rates: ItBlockRateRow[]
  openings: { fyStartYear: number; openingWdv: number; additionalBroughtForward: number }[]
}

export interface AssetGroupRow {
  id: number
  name: string
  caClassId: number | null
  caClassName: string | null
  lifeMonths: number
  residualBp: number
  method: DepMethod
  itBlockId: number | null
  itBlockName: string | null
  assetLedgerId: number | null
  assetLedgerName: string | null
  accDepLedgerId: number | null
  accDepLedgerName: string | null
  depExpenseLedgerId: number | null
  depExpenseLedgerName: string | null
  postPerAsset: boolean
  assetCount: number
}

export interface AssetAdditionRow {
  id: number
  assetId: number
  date: string
  voucherId: number | null
  amountPaise: number
  kind: 'addition' | 'improvement'
  note: string | null
}

export type AssetStatus = 'active' | 'disposed'

export interface FixedAssetRow {
  id: number
  name: string
  assetGroupId: number
  groupName: string
  ledgerId: number
  ledgerName: string
  accDepLedgerId: number | null
  purchaseVoucherId: number | null
  /** The purchase voucher is in the bin — the register still holds the asset. */
  purchaseVoucherBinned: boolean
  purchaseDate: string
  putToUseDate: string
  costPaise: number
  residualBp: number
  lifeMonths: number
  method: DepMethod
  basisDate: string
  itBlockId: number | null
  itBlockName: string | null
  itAdditionalEligible: boolean
  location: string | null
  identifier: string | null
  openingAccDepPaise: number
  openingAccDepAsOf: string | null
  notes: string | null
  status: AssetStatus
  disposalDate: string | null
  disposalVoucherId: number | null
  disposalKind: DisposalKind | null
  disposalProceedsPaise: number | null
  /** As of the query's date: cost + additions, accumulated depreciation, carrying amount. */
  grossPaise: number
  accumulatedPaise: number
  carryingPaise: number
  /** Last day depreciation is booked for (null = none yet). */
  depreciatedThrough: string | null
  lifeEnd: string
  additions: AssetAdditionRow[]
}

export interface PurchaseCandidate {
  voucherId: number
  date: string
  number: string
  voucherTypeName: string
  partyLedgerId: number | null
  partyName: string | null
  /** Dr lines to ledgers under Fixed Assets that are not yet on the register. */
  lines: { ledgerId: number; ledgerName: string; amount: number; suggestedGroupId: number | null }[]
}

export interface DepreciationPreviewRow {
  assetId: number
  assetName: string
  groupId: number
  groupName: string
  method: DepMethod
  openingWdv: number
  additions: number
  depreciation: number
  closingWdv: number
  daysUsed: number
  fullyDepreciated: boolean
  ratePpb: number | null
}

export interface JournalPreviewLine {
  ledgerId: number | null
  /** Ledger name; a ledger that will be created at posting is named as it will be. */
  ledgerName: string
  drCr: 'dr' | 'cr'
  amount: number
  assetId: number | null
}

export interface DepreciationPreview {
  from: string
  to: string
  fyStartYear: number
  rows: DepreciationPreviewRow[]
  journal: JournalPreviewLine[]
  total: number
  /** Why the period can't be posted (already posted, locked, closed, nothing to charge). */
  blocked: string | null
  /** The live run this period overlaps, when that is the reason. */
  existingRun: { runId: number; voucherId: number; from: string; to: string } | null
}

export interface DepreciationRunRow {
  id: number
  fyStartYear: number
  periodFrom: string
  periodTo: string
  basis: 'companies_act' | 'income_tax'
  voucherId: number | null
  voucherNumber: string | null
  /** The run's voucher is in the bin (or purged): the run no longer counts. */
  voided: boolean
  assetId: number | null
  assetName: string | null
  postedAt: string
  total: number
  lineCount: number
}

export interface DisposalPreview {
  assetId: number
  date: string
  gross: number
  accumulatedBooked: number
  catchUp: number
  catchUpFrom: string | null
  carrying: number
  proceeds: number
  profit: number
  journal: JournalPreviewLine[]
  blocked: string | null
}

export interface ScheduleGroupRow extends ScheduleTotalsLike {
  groupId: number
  groupName: string
  assetCount: number
}

export interface ScheduleTotalsLike {
  grossOpening: number
  grossAdditions: number
  grossDisposals: number
  grossClosing: number
  accOpening: number
  accCharge: number
  accDisposals: number
  accClosing: number
  netOpening: number
  netClosing: number
}

export interface ScheduleAssetRow extends ScheduleTotalsLike {
  assetId: number
  assetName: string
  groupId: number
}

export interface ScheduleReconRow {
  ledgerId: number
  ledgerName: string
  role: 'asset' | 'accumulated_depreciation'
  /** Register figure (gross for asset ledgers; accumulated depreciation as a positive number). */
  register: number
  /** Ledger closing balance (dr-positive for asset ledgers; credit balance as positive for
   *  accumulated depreciation). */
  ledger: number
  difference: number
}

export interface AssetSchedule {
  from: string
  to: string
  groups: ScheduleGroupRow[]
  assets: ScheduleAssetRow[]
  totals: ScheduleTotalsLike
  reconciliation: ScheduleReconRow[]
}

export interface ItStatementBlockRow extends ItBlockResult {
  blockId: number
  blockCode: string
  blockName: string
  rateBp: number
  additionalRateBp: number
  act: '1961' | '2025' | null
  sectionRef: string
  rateSource: string
  /** Opening WDV came from: the user's entry for this FY, the previous FY's computed closing, or nothing (0). */
  openingSource: 'entered' | 'carried' | 'none'
  assetCount: number
}

export interface ItStatement {
  fyStartYear: number
  blocks: ItStatementBlockRow[]
  /** Assets without an IT block — left out of the statement. */
  unassignedAssets: { assetId: number; name: string }[]
}

export interface DepreciationYearStatus {
  fyStartYear: number
  /** Assets in service at some point in the FY. */
  assetsInService: number
  /** Last day of the FY covered by a live run (null = no run in the FY). */
  coveredThrough: string | null
  /** Depreciation for the FY has not been run up to 31 March. */
  missing: boolean
}

// ---------------------------------------------------------------------------------------------
// Sources (also cited in the migration-026 seed comments) — shown in Groups & blocks.
// ---------------------------------------------------------------------------------------------

export const FIXED_ASSET_SOURCES: { key: string; title: string; url: string }[] = [
  {
    key: 'SCH2',
    title: 'Companies Act, 2013 — Schedule II (useful lives to compute depreciation), as amended',
    url: 'https://www.mca.gov.in/content/dam/mca/pdf/CompaniesAct2013.pdf'
  },
  {
    key: 'IT61',
    title: 'Income-tax Act, 1961 — s.32 and New Appendix I to the Income-tax Rules, 1962 (FY 2025-26 and earlier)',
    url: 'https://incometaxindia.gov.in/Pages/acts/income-tax-act.aspx'
  },
  {
    key: 'IT25',
    title: 'Income-tax Act, 2025 — depreciation (block of assets), in force from 1 April 2026',
    url: 'https://incometaxindia.gov.in/Pages/acts/income-tax-act.aspx'
  }
]

/** Basis points → "5.00%". */
export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`
}

/** Months → "10 years" / "3 years 6 months" / "18 months". */
export function formatLife(months: number): string {
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0) return `${m} month${m === 1 ? '' : 's'}`
  return `${y} year${y === 1 ? '' : 's'}${m ? ` ${m} month${m === 1 ? '' : 's'}` : ''}`
}
