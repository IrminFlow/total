/**
 * Scheduled report packs (WP 6.2) — pure: the pack definition schema, the built-in report list
 * and the "is it due?" rule the main-process scheduler applies when the company opens (and hourly
 * while it stays open). There is no background daemon: a pack whose time passed while the app was
 * closed runs ONCE on the next open, however many periods it missed.
 */
import { z } from 'zod'

export const BUILTIN_PACK_REPORTS = {
  trialBalance: 'Trial balance',
  profitLoss: 'Profit & Loss',
  balanceSheet: 'Balance sheet',
  receivables: 'Outstanding receivables',
  payables: 'Outstanding payables',
  gstSummary: 'GST summary',
  ratios: 'Ratios',
  dayBook: 'Day book'
} as const
export type BuiltinPackReport = keyof typeof BUILTIN_PACK_REPORTS
export const BUILTIN_PACK_KEYS = Object.keys(BUILTIN_PACK_REPORTS) as BuiltinPackReport[]

export const PACK_PERIOD_RULES = ['lastMonth', 'lastQuarter', 'fyToDate'] as const
export type PackPeriodRule = (typeof PACK_PERIOD_RULES)[number]
export const PACK_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type PackFrequency = (typeof PACK_FREQUENCIES)[number]
/** XLSX: the shared workbook writer (WP 6.3) — amounts as numbers (src/shared/xlsx/display.ts). */
export const PACK_FORMATS = ['pdf', 'csv', 'xlsx'] as const
export type PackFormat = (typeof PACK_FORMATS)[number]

export const packReportRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), key: z.enum(BUILTIN_PACK_KEYS as [BuiltinPackReport, ...BuiltinPackReport[]]) }),
  z.object({ kind: z.literal('saved'), id: z.number().int().positive() })
])
export type PackReportRef = z.infer<typeof packReportRefSchema>

export const packInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the pack a name').max(80),
  reports: z.array(packReportRefSchema).min(1, 'Add at least one report').max(30),
  periodRule: z.enum(PACK_PERIOD_RULES),
  frequency: z.enum(PACK_FREQUENCIES),
  formats: z.array(z.enum(PACK_FORMATS)).min(1, 'Pick at least one format').max(PACK_FORMATS.length),
  /** Absolute folder; null = <company>/exports/packs. */
  outputDir: z
    .string()
    .trim()
    .max(1000)
    .refine((s) => s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s), 'Choose an absolute folder')
    .nullable()
    .default(null),
  active: z.boolean().default(true)
})
export type PackInput = z.output<typeof packInputSchema>
export type PackInputPayload = z.input<typeof packInputSchema>

export interface ReportPack extends PackInput {
  id: number
  lastRunAt: string | null
  createdAt: string
  /** When the scheduler will next run it (ISO date), for the list. */
  nextDue: string
}

export interface PackRun {
  id: number
  packId: number
  trigger: 'schedule' | 'manual'
  startedAt: string
  finishedAt: string | null
  periodFrom: string
  periodTo: string
  status: 'ok' | 'partial' | 'failed'
  outputDir: string | null
  files: string[]
  error: string | null
}

export const PACK_PERIOD_LABELS: Record<PackPeriodRule, string> = {
  lastMonth: 'Last month',
  lastQuarter: 'Last quarter',
  fyToDate: 'Financial year to date'
}
export const PACK_FREQUENCY_LABELS: Record<PackFrequency, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or an ISO string → epoch ms. */
export function parseStamp(s: string): number {
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
}

const DAY = 86_400_000

/**
 * When a pack is next due after `baseline` (its last run, or its creation): daily — the next
 * calendar day; weekly — seven days on; monthly — the 1st of the next month. UTC calendar.
 */
export function nextDueAt(frequency: PackFrequency, baseline: string): number {
  const t = parseStamp(baseline)
  const d = new Date(t)
  if (frequency === 'daily') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  if (frequency === 'weekly') return t + 7 * DAY
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/** Whether an active pack should run at `now` (missed periods collapse into one run). */
export function packDue(pack: { active: boolean; frequency: PackFrequency; lastRunAt: string | null; createdAt: string }, now: Date): boolean {
  if (!pack.active) return false
  const baseline = pack.lastRunAt ?? pack.createdAt
  const t = parseStamp(baseline)
  // A last run "in the future" (the clock was set back, or bad data) must not stall the pack
  // until then — treat it as due. An unreadable stamp is due too.
  if (Number.isNaN(t) || t > now.getTime()) return true
  return now.getTime() >= nextDueAt(pack.frequency, baseline)
}
