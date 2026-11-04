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
  /** TCS on sales (WP 3.3): the invoice / receipt banner and the TCS screen (the banner only
   *  appears for buyers, goods or sales ledgers flagged with a TCS section). */
  tcs: boolean
  multiCurrency: boolean
  payroll: boolean
  /** Turn negative-stock save warnings into hard blocks. */
  preventNegativeStock: boolean
  /** Batch/lot tracking on inventory lines. */
  batches: boolean
  /** Turn credit-limit save warnings into hard blocks. */
  enforceCreditLimit: boolean
  /** Orders & challans (WP 2.5): delivery challans, goods receipt notes and their pending
   *  reports in the sidebar. Needs inventory. Off by default (design §9 Q14). */
  orders: boolean
  /** WP 8.3: manufacturing (made goods) screens. ABSENT = follows inventory (every company before
   *  WP 8.3, and DEFAULT_FEATURES, which does not carry it); the setup wizard writes it explicitly
   *  (on only for a manufacturer that keeps stock). Read it through `effectiveFeatures`. */
  manufacturing?: boolean
}

export const DEFAULT_FEATURES: CompanyFeatures = {
  inventory: true,
  billWise: true,
  costCentres: true,
  tds: true,
  tcs: true,
  multiCurrency: true,
  payroll: true,
  preventNegativeStock: false,
  batches: false,
  enforceCreditLimit: false,
  orders: false
}

export const featuresSchema = z.object({
  inventory: z.boolean(),
  billWise: z.boolean(),
  costCentres: z.boolean(),
  tds: z.boolean(),
  tcs: z.boolean(),
  multiCurrency: z.boolean(),
  payroll: z.boolean(),
  preventNegativeStock: z.boolean(),
  batches: z.boolean(),
  enforceCreditLimit: z.boolean(),
  orders: z.boolean(),
  manufacturing: z.boolean().optional()
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

/** The flags screens gate on: `manufacturing` resolved (absent = on, and never without
 *  inventory). Use this — not the stored object — wherever a screen or entry is shown or hidden. */
export function effectiveFeatures(f: CompanyFeatures): CompanyFeatures & { manufacturing: boolean } {
  return { ...f, manufacturing: f.inventory && f.manufacturing !== false }
}

// ---------------------------------------------------------------- features hidden until used
//
// The feature cleanup hides these for a company that has none of their data (main computes
// `unused` — services/featureUsage.ts — and returns it with the stored flags on
// config:features:get). Hidden = no sidebar / palette / simple entry, no Settings → Features card
// and none of the in-form affordances the matching flag gates; every report keeps reading the
// data exactly as before, and a company with data keeps everything. The stored flags are never
// changed by this.
export const HIDEABLE_FEATURES = ['forex', 'costCentres', 'cheques', 'interest', 'fixedAssets', 'tradeCycle', 'payrollStatutory'] as const
export type HideableFeature = (typeof HIDEABLE_FEATURES)[number]

/** config:features:get — the stored flags plus the hideable features this company has no data for. */
export type FeaturesView = CompanyFeatures & { unused?: HideableFeature[] }

/** The stored flags whose feature can be hidden — their Settings → Features card goes with it. */
export const FLAG_FEATURE: Partial<Record<keyof CompanyFeatures, HideableFeature>> = { costCentres: 'costCentres', multiCurrency: 'forex', orders: 'tradeCycle' }

/** Split a features view into the stored flags (what config:features:set takes) and the hidden set. */
export function splitFeaturesView(v: FeaturesView): { stored: CompanyFeatures; unused: ReadonlySet<HideableFeature> } {
  const { unused, ...stored } = v
  return { stored, unused: new Set(unused ?? []) }
}

/** Whether a stored flag's Settings → Features card is shown (hidden with its feature). */
export const flagCardShown = (key: keyof CompanyFeatures, unused: ReadonlySet<HideableFeature>): boolean => {
  const h = FLAG_FEATURE[key]
  return !h || !unused.has(h)
}

/** What screens, the sidebar and the palette gate on: `effectiveFeatures`, with the flags of a
 *  hidden feature off (costCentres, multiCurrency ← forex, orders ← tradeCycle) and one flag per
 *  hideable feature that has no stored flag of its own. `unused` absent = nothing hidden. */
export interface ScreenFeatures extends CompanyFeatures {
  manufacturing: boolean
  forex: boolean
  fixedAssets: boolean
  cheques: boolean
  interest: boolean
  payrollStatutory: boolean
}

export function screenFeatures(f: FeaturesView): ScreenFeatures {
  const { stored, unused } = splitFeaturesView(f)
  const used = (h: HideableFeature): boolean => !unused.has(h)
  return {
    ...effectiveFeatures(stored),
    costCentres: stored.costCentres && used('costCentres'),
    multiCurrency: stored.multiCurrency && used('forex'),
    orders: stored.orders && used('tradeCycle'),
    forex: used('forex'),
    fixedAssets: used('fixedAssets'),
    cheques: used('cheques'),
    interest: used('interest'),
    payrollStatutory: used('payrollStatutory')
  }
}
