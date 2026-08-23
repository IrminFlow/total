import { z } from 'zod'

/**
 * Company-wide feature toggles (Tally's F11 "features") — gate renderer affordances only.
 * Data already entered stays valid and every report keeps reading it regardless of these flags;
 * flipping a toggle never mutates books. Stored per company in `meta` under key 'features'.
 */
export interface CompanyFeatures {
  inventory: boolean
  billWise: boolean
  costCentres: boolean
  tds: boolean
  multiCurrency: boolean
  payroll: boolean
  /** Turn negative-stock save warnings into hard blocks. */
  preventNegativeStock: boolean
  /** Batch/lot tracking on inventory lines. */
  batches: boolean
  /** Turn credit-limit save warnings into hard blocks. */
  enforceCreditLimit: boolean
  /**
   * The in-app AI assistant. OFF by default and gated in main as well as the renderer: Total's
   * promise is that it works entirely offline with no account, and that stays literally true
   * for anyone who never turns this on. Nothing under services/ai is even imported until it is.
   */
  ai: boolean
}

export const DEFAULT_FEATURES: CompanyFeatures = {
  inventory: true,
  billWise: true,
  costCentres: true,
  tds: true,
  multiCurrency: true,
  payroll: true,
  preventNegativeStock: false,
  batches: false,
  enforceCreditLimit: false,
  ai: false
}

export const featuresSchema = z.object({
  inventory: z.boolean(),
  billWise: z.boolean(),
  costCentres: z.boolean(),
  tds: z.boolean(),
  multiCurrency: z.boolean(),
  payroll: z.boolean(),
  preventNegativeStock: z.boolean(),
  batches: z.boolean(),
  enforceCreditLimit: z.boolean(),
  ai: z.boolean()
})

/**
 * Merge a partial/unknown-shaped object (e.g. persisted JSON from an older build, or a corrupted
 * row) over the defaults, then validate. Never throws — falls back to all-defaults if the merged
 * shape still doesn't validate (a value of the wrong type, say).
 */
export function mergeFeatures(partial: unknown): CompanyFeatures {
  const obj = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {}
  const merged = { ...DEFAULT_FEATURES, ...obj }
  const parsed = featuresSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...DEFAULT_FEATURES }
}
