/**
 * Company-wide feature toggles (Tally's F11 "features") — gate renderer affordances only.
 *
 * Deliberately zod-free, and this file is where that costs something to keep: the schema and the
 * merge live next door in `features.schema.ts` because `useFeatures` is on every screen, so
 * whatever this module imports lands in the renderer's ENTRY chunk — the bytes read before
 * anything is on screen. Importing zod here put the whole validator in front of every user for
 * the sake of a ten-key object of booleans that the renderer only ever reads.
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
