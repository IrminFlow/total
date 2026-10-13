// Company mode model (WP 8.1, plan 2026-10-13 §2.1).
//
// Company meta `ui` = { mode, setup?, startedFresh?, language? }. **A missing (or unreadable)
// `ui` key means accountant** — that one rule covers every existing company and every backup,
// so nothing about them changes until the owner switches. Only the owner writes it (`ui:mode:set`,
// audited as a company update); setup (WP 8.3) fills `setup` / `startedFresh`; Settings →
// "How Total looks" writes `mode` and `language` (the company language `companyT` reads).
import { z } from 'zod'
import { LANGUAGES, type Language } from '../i18n'

export const UI_MODES = ['simple', 'accountant'] as const
export type UiMode = (typeof UI_MODES)[number]
export const DEFAULT_UI_MODE: UiMode = 'accountant'

/** The simple shell's sidebar (plan §2.2), in order — nine entries, ≤ 10 by design. */
export const SIMPLE_SECTION_IDS = ['home', 'sell', 'buy', 'money', 'stock', 'people', 'reports', 'taxes', 'settings'] as const
export type SimpleSectionId = (typeof SIMPLE_SECTION_IDS)[number]

export const UI_GST_ANSWERS = ['regular', 'composition', 'no', 'not_sure'] as const

export const uiSetupSchema = z.object({
  businessType: z.string().trim().min(1).max(40),
  gst: z.enum(UI_GST_ANSWERS),
  stock: z.boolean()
})

export const uiSettingsSchema = z.object({
  mode: z.enum(UI_MODES),
  setup: uiSetupSchema.optional(),
  startedFresh: z.boolean().optional(),
  language: z.enum(LANGUAGES).optional()
})
export type UiSettings = z.infer<typeof uiSettingsSchema>

/** `ui:mode:set` payload: the fields to change (merged over what is stored). */
export const uiPatchSchema = uiSettingsSchema.partial().strict()
export type UiPatch = z.infer<typeof uiPatchSchema>

/** Stored / sent value → settings. Missing, null, malformed or an unknown mode → accountant
 *  (the other fields are kept only when they validate). Never throws. */
export function normalizeUi(raw: unknown): UiSettings {
  const whole = uiSettingsSchema.safeParse(raw)
  if (whole.success) return whole.data
  const out: UiSettings = { mode: DEFAULT_UI_MODE }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (r.mode === 'simple' || r.mode === 'accountant') out.mode = r.mode
    const setup = uiSetupSchema.safeParse(r.setup)
    if (setup.success) out.setup = setup.data
    if (typeof r.startedFresh === 'boolean') out.startedFresh = r.startedFresh
    if (typeof r.language === 'string' && (LANGUAGES as readonly string[]).includes(r.language)) out.language = r.language as Language
  }
  return out
}

/** Stored settings with a patch applied (keys left undefined keep their stored value). */
export function applyUiPatch(current: UiSettings, patch: UiPatch): UiSettings {
  const next: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v
  return uiSettingsSchema.parse(next)
}
