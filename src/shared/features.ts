import { z } from 'zod'

/** Features hidden until used (the feature cleanup — see below). */
export const HIDEABLE_FEATURES = ['costCentres', 'cheques', 'interest', 'fixedAssets', 'tradeCycle', 'payrollStatutory'] as const
export type HideableFeature = (typeof HIDEABLE_FEATURES)[number]

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
  /** Stored but no longer read: foreign-currency invoicing went in the 1.0 cleanup (PR #195).
   *  Kept so stored features objects keep validating. */
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
  /** Hidden-until-used features the owner turned on through Settings → Features → More features
   *  (shown although the company has no data for them yet). ABSENT = none. */
  turnedOn?: HideableFeature[]
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
  manufacturing: z.boolean().optional(),
  turnedOn: z.array(z.enum(HIDEABLE_FEATURES)).optional()
})

/**
 * Merge a partial/unknown-shaped object (e.g. persisted JSON from an older build, or a corrupted
 * row) over the defaults, then validate. Never throws — falls back to all-defaults if the merged
 * shape still doesn't validate (a value of the wrong type, say).
 */
export function mergeFeatures(partial: unknown): CompanyFeatures {
  const obj = partial && typeof partial === 'object' ? { ...(partial as Record<string, unknown>) } : {}
  // `turnedOn` is read leniently: an entry a later build no longer knows (a removed feature) is
  // dropped — never the whole object, which would reset every other flag to the defaults.
  if ('turnedOn' in obj) {
    const known = Array.isArray(obj.turnedOn) ? obj.turnedOn.filter((h): h is HideableFeature => (HIDEABLE_FEATURES as readonly unknown[]).includes(h)) : null
    if (known) obj.turnedOn = known
    else delete obj.turnedOn
  }
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
// changed by this. The door back (review of #194): Settings → Features → "More features" lists
// the hidden ones; turning one on stores it in `turnedOn`, and a feature is shown when it has data
// OR is turned on.

/** config:features:get — the stored flags plus the hideable features this company has no data for. */
export type FeaturesView = CompanyFeatures & { unused?: HideableFeature[] }

/** The stored flags whose feature can be hidden — their Settings → Features card goes with it. */
export const FLAG_FEATURE: Partial<Record<keyof CompanyFeatures, HideableFeature>> = { costCentres: 'costCentres', orders: 'tradeCycle' }
const FLAG_OF: Partial<Record<HideableFeature, keyof CompanyFeatures>> = Object.fromEntries(Object.entries(FLAG_FEATURE).map(([k, h]) => [h, k]))

/** Split a features view into the stored flags (what config:features:set takes), the hidden set
 *  (`unused` — no data and not turned on) and the features with no data at all (`noData`). */
export function splitFeaturesView(v: FeaturesView): { stored: CompanyFeatures; unused: ReadonlySet<HideableFeature>; noData: ReadonlySet<HideableFeature> } {
  const { unused, ...stored } = v
  const noData = new Set(unused ?? [])
  const on = new Set(stored.turnedOn ?? [])
  return { stored, unused: new Set([...noData].filter((h) => !on.has(h))), noData }
}

/** A hidden feature's stored flag and what it needs, turned on with it. */
const TURN_ON: Partial<Record<HideableFeature, Partial<CompanyFeatures>>> = {
  costCentres: { costCentres: true },
  tradeCycle: { orders: true, inventory: true },
  payrollStatutory: { payroll: true }
}

/** The "More features" list: the hideable features with no data, except a flag feature already
 *  turned on (its own card is back in the main list). */
export interface MoreFeature { feature: HideableFeature; on: boolean }
export function moreFeatures(noData: ReadonlySet<HideableFeature>, stored: CompanyFeatures): MoreFeature[] {
  const on = new Set(stored.turnedOn ?? [])
  return HIDEABLE_FEATURES.filter((h) => noData.has(h) && !(on.has(h) && FLAG_OF[h])).map((h) => ({ feature: h, on: on.has(h) }))
}

export function turnOnFeature(stored: CompanyFeatures, h: HideableFeature): CompanyFeatures {
  const list = stored.turnedOn ?? []
  return { ...stored, ...TURN_ON[h], turnedOn: list.includes(h) ? list : [...list, h] }
}

export function turnOffFeature(stored: CompanyFeatures, h: HideableFeature): CompanyFeatures {
  return { ...stored, turnedOn: (stored.turnedOn ?? []).filter((x) => x !== h) }
}

/** A main-list flag turned off: a feature turned on through More that needs that flag (its own
 *  flag, or stock / payroll it needs) goes back to hidden too. */
export function flagTurnedOff(stored: CompanyFeatures, key: keyof CompanyFeatures): CompanyFeatures {
  const next = { ...stored, [key]: false }
  const list = stored.turnedOn ?? []
  const keep = list.filter((h) => FLAG_FEATURE[key] !== h && (TURN_ON[h] as Record<string, unknown> | undefined)?.[key] !== true)
  return keep.length === list.length ? next : { ...next, turnedOn: keep }
}

/** Whether a stored flag's Settings → Features card is shown (hidden with its feature). */
export const flagCardShown = (key: keyof CompanyFeatures, unused: ReadonlySet<HideableFeature>): boolean => {
  const h = FLAG_FEATURE[key]
  return !h || !unused.has(h)
}

/** What screens, the sidebar and the palette gate on: `effectiveFeatures`, with the flags of a
 *  hidden feature off (costCentres, orders ← tradeCycle) and one flag per
 *  hideable feature that has no stored flag of its own. `unused` absent = nothing hidden. */
export interface ScreenFeatures extends CompanyFeatures {
  manufacturing: boolean
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
    orders: stored.orders && used('tradeCycle'),
    fixedAssets: used('fixedAssets'),
    cheques: used('cheques'),
    interest: used('interest'),
    payrollStatutory: used('payrollStatutory')
  }
}
