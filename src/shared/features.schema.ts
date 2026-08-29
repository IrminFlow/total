import { z } from 'zod'
import { DEFAULT_FEATURES, type CompanyFeatures } from './features'

/**
 * Validation for the feature toggles — main's half.
 *
 * Split from `features.ts` for one reason: `DEFAULT_FEATURES` is read by `useFeatures`, which is
 * on every screen and therefore in the renderer's entry chunk. A runtime `import { z }` in that
 * module put zod in front of every user at startup to validate a ten-key object of booleans that
 * only the main process ever writes.
 */
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
