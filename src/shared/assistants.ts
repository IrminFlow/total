/**
 * The assistants (WP 5.5) — shapes and IPC payload schemas shared by main and the renderer. The
 * engines are pure modules of their own: closeChecklist.ts, anomalies.ts, gst/mismatch2b.ts,
 * reportBuilder/nl.ts. Every assistant works without AI (the Assistants screen runs them
 * directly); with AI on, the same results come from the read tools close_checklist,
 * gst_2b_mismatches, find_anomalies and build_report, and the model only narrates them.
 */
import { z } from 'zod'
import type { Anomaly } from './anomalies'
import type { Mismatch, MismatchSummary } from './gst/mismatch2b'
import { CLOSE_CHECK_KEYS } from './closeChecklist'

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM')

export type AssistantKind = 'close' | 'anomaly' | 'gst2b'

/** Company settings for the assistants (meta key 'assistants'). */
export interface AssistantSettings {
  /** Weekly off days, 0 = Sunday … 6 = Saturday. */
  weekendDays: number[]
  /** Holidays (YYYY-MM-DD). */
  holidays: string[]
  duplicateWindowDays: number
  backdatedDays: number
  /** Paise. */
  roundMinPaise: number
  /** Thousandths of a standard deviation (3000 = 3σ). */
  zThresholdMilli: number
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  weekendDays: [0],
  holidays: [],
  duplicateWindowDays: 3,
  backdatedDays: 30,
  roundMinPaise: 1_00_000_00,
  zThresholdMilli: 3000
}

export const assistantSettingsSchema = z
  .object({
    weekendDays: z.array(z.number().int().min(0).max(6)).max(7),
    holidays: z.array(iso).max(400),
    duplicateWindowDays: z.number().int().min(0).max(60),
    backdatedDays: z.number().int().min(1).max(3650),
    roundMinPaise: z.number().int().min(100).max(1_000_000_000_00),
    zThresholdMilli: z.number().int().min(1000).max(20000)
  })
  .partial()
  .strict()

export const closeQuerySchema = z.object({ period: periodSchema })

export const closeMarkSchema = z.object({
  period: periodSchema,
  key: z.enum(CLOSE_CHECK_KEYS),
  /** null clears the mark. */
  status: z.enum(['done', 'na']).nullable(),
  note: z.string().trim().max(500).optional()
})

export const anomalyQuerySchema = z.object({ from: iso, to: iso, includeDismissed: z.boolean().optional() })

export const anomalyDismissSchema = z.object({
  key: z.string().trim().min(3).max(200),
  /** false restores a dismissed finding. */
  dismissed: z.boolean(),
  note: z.string().trim().max(500).optional()
})

/** A return period as the portal writes it (MMYYYY). */
export const gstPeriodSchema = z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/, 'Expected MMYYYY')

export const gst2bStoreSchema = z.object({
  /** A monthly 2B runs to a few MB even for large buyers; 20 MB is the cap. */
  jsonText: z.string().min(2).max(20_000_000, 'The GSTR-2B file is larger than 20 MB'),
  fileName: z.string().trim().max(200).optional(),
  /** The month the user imported it for (YYYY-MM) — used when the JSON carries no rtnprd. */
  period: periodSchema
})

export const gst2bQuerySchema = z.object({ period: periodSchema, includeResolved: z.boolean().optional() })

export const gst2bResolveSchema = z.object({
  period: periodSchema,
  key: z.string().trim().min(3).max(200),
  status: z.enum(['resolved', 'dismissed']).nullable(),
  note: z.string().trim().max(500).optional()
})

export const gst2bDraftSchema = z.object({ period: periodSchema, key: z.string().trim().min(3).max(200) })

export const nlReportSchema = z.object({ question: z.string().trim().min(2).max(500), from: iso, to: iso })

export interface AnomalyRow extends Anomaly {
  dismissed: { note: string | null; by: string | null; at: string } | null
}

export interface AnomalyReport {
  from: string
  to: string
  /** History looked at for the baselines (YYYY-MM-DD, inclusive). */
  historyFrom: string
  rows: AnomalyRow[]
  counts: { high: number; medium: number; low: number; dismissed: number }
  settings: AssistantSettings
}

export interface Gst2bStatementInfo {
  period: string
  fileName: string | null
  documents: number
  importedAt: string
  importedBy: string | null
}

export interface Gst2bMismatchReport {
  /** YYYY-MM. */
  period: string
  /** MMYYYY. */
  returnPeriod: string
  statement: Gst2bStatementInfo | null
  /** Parse warnings of the stored JSON. */
  errors: string[]
  matched: number
  summary: MismatchSummary[]
  rows: Mismatch[]
}

export interface NlReportPreview {
  ok: boolean
  title: string | null
  problems: string[]
}
