// Taxes (WP 9.9, plan 2026-10-13 §2.2 Taxes, §3 "GST answer"): the shapes `simple:taxes` returns
// and the pure rules behind them. Read-only over the existing services (services/simpleTaxes.ts):
//   GST collected / on purchases / to pay   gst.gstr3b() for the period — its outward tax, net
//                                           eligible credit and cash payable after set-off, never
//                                           recomputed (the same sums dashboard.dashGst makes)
//   awaiting confirmation                   the stored GSTR-2B statements (WP 5.5) through the WP
//                                           3.4 matcher (Home's rule: missingInPortal)
//   due dates                               shared/gst/filing.ts (rule 61 / 62, Notification
//                                           83/2020-CT — cited there)
//   step 1 missing bills                    assistants.closeChecklist (the month-end checks)
//   step 2 supplier bills                   assistants.gst2bMismatches (the WP 5.5 categories)
//   step 3 files                            the export snapshots gst:exportGstr1 / 3B write
//   step 5 "I've filed"                     company meta `gstFiled` (below) — the WP 5.5 marks
//                                           table (assistant_marks) has a CHECK on its assistant
//                                           and keeps only a note + a time, so an ARN and the
//                                           filing date per return live here, audited as a
//                                           company update like meta gstProfile
//   TDS / TCS                               the tagged payable ledgers, FIFO (closeChecklist's
//                                           withholdingUnpaid), deposit dates rule 30(2) /
//                                           tcsDepositDueDate
// Total prepares; the user files (plan §1 principle 10) — nothing here files anything.

import { z } from 'zod'
import type { CloseCheckKey } from '../closeChecklist'
import type { MismatchCategory } from '../gst/mismatch2b'
import type { GstFilingFrequency } from '../gst/filing'

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

export const taxesQuerySchema = z.object({ period: ym.optional(), today: iso.optional() }).strict()

/** A GST period, named by its last month ('YYYY-MM'): a month, or (quarterly filer) the quarter
 *  ending in that month. `soFar`: it is still running, so the figures run to today. */
export interface GstPeriod {
  period: string
  from: string
  to: string
  quarterly: boolean
  soFar: boolean
}

/** The three figures (plan §3 "GST answer"), paise. */
export interface GstFigures {
  /** GST charged on sales: 3.1(a)–(c), zero-rated included; reverse charge NOT included. */
  collected: number
  /** GST you owe under reverse charge (3.1(d)) — said separately, only when there is some. */
  reverseCharge: number
  /** GST on purchases you can set against it: 3B's net eligible credit (4A − 4B). */
  onPurchases: number
  /** Of that, booked but not yet confirmed in GSTR-2B (checked months only). */
  awaiting: number
  /** none = no GSTR-2B imported for any month of the period ("not checked yet"). */
  checked: 'none' | 'some' | 'all'
  /** Cash to pay after the credit is used: 3B's netPayable + rcmPayable. */
  toPay: number
  /** WP 10.2 — the parts of `toPay` as gstr3b() returns them: the tax on sales left after the
   *  credit is used (netPayable) and the reverse charge (rcmPayable, always cash). toPay =
   *  cashOnSales + rcmCash. */
  cashOnSales: number
  rcmCash: number
  /** Of the credit, what the set-off used against the tax on sales (collected − cashOnSales) and
   *  what is left over for the next return (onPurchases − creditUsed). */
  creditUsed: number
  creditLeft: number
}

/**
 * WP 10.2 review — of the credit, what the set-off used against the tax on sales and what is left
 * for the next return. gstr3b()'s set-off turns a head whose sales tax is NEGATIVE (a month of
 * returns) into extra credit; that is not GST paid on purchases, so neither part may go below zero
 * or past the credit itself. Pure.
 */
export function creditParts(collected: number, cashOnSales: number, onPurchases: number): { creditUsed: number; creditLeft: number } {
  const creditUsed = Math.min(Math.max(0, collected - cashOnSales), Math.max(0, onPurchases))
  return { creditUsed, creditLeft: Math.max(0, onPurchases - creditUsed) }
}

export interface GstDue {
  gstr1: string
  gstr3b: string
  /** The 3B date is the earlier 22nd because the state is in neither entry of rule 61's Table. */
  gstr3bUnverified: boolean
  /** Quarterly filers: the PMT-06 dates for the quarter's first two months (rule 61(3)). */
  pmt06: string[]
}

export interface MissingBillsItem {
  key: Extract<CloseCheckKey, 'drafts' | 'unbilled_goods' | 'negative_stock'>
  count: number
}

/** The close checks that mean "a bill may be missing" (step 1). */
export const MISSING_BILL_CHECKS: readonly MissingBillsItem['key'][] = ['unbilled_goods', 'negative_stock', 'drafts']

export interface SupplierBillsMonth {
  month: string
  /** A GSTR-2B statement is stored for the month. */
  imported: boolean
  /** Bills found on both sides. */
  matched: number
  /** Open (unresolved) mismatches by category, with the tax on them. */
  categories: { category: MismatchCategory; count: number; tax: number }[]
}

export const GST_FORMS = ['gstr1', 'gstr3b'] as const
export type GstForm = (typeof GST_FORMS)[number]

export interface GstFiledEntry {
  /** Acknowledgement reference number from the portal, as typed (upper-cased). */
  arn: string
  /** The date the user says it was filed. */
  date: string
  by: string | null
  /** When it was recorded (ISO timestamp). */
  at: string
}

export type GstFiledPeriod = Partial<Record<GstForm, GstFiledEntry>>

/** The company meta key of the "I've filed" marks. */
export const GST_FILED_META_KEY = 'gstFiled'

/** meta `gstFiled`: { 'YYYY-MM' (the period's last month): { gstr1?, gstr3b? } }. */
export type GstFiledMeta = Record<string, GstFiledPeriod>

const filedEntrySchema = z.object({ arn: z.string(), date: iso, by: z.string().nullable(), at: z.string() }).strict()
const filedMetaSchema = z.record(ym, z.object({ gstr1: filedEntrySchema.optional(), gstr3b: filedEntrySchema.optional() }).strict())

/** Stored value → marks; missing or malformed = none. Never throws. */
export function normalizeGstFiled(raw: unknown): GstFiledMeta {
  const p = filedMetaSchema.safeParse(raw)
  return p.success ? (p.data as GstFiledMeta) : {}
}

/**
 * An ARN as the portal shows it: letters and digits only (spaces / dashes typed in are dropped),
 * 10 to 20 of them. The portal's exact format is not checked (UNVERIFIED: GSTN's ARN layout was
 * not read in an official text), so this only stops obvious slips.
 */
export function normalizeArn(text: string): string | null {
  const s = text.replace(/[\s-]/g, '').toUpperCase()
  return /^[A-Z0-9]{10,20}$/.test(s) ? s : null
}

export const gstFiledInputSchema = z
  .object({
    period: ym,
    form: z.enum(GST_FORMS),
    /** null clears the mark. */
    arn: z.string().trim().max(40).nullable(),
    date: iso.optional()
  })
  .strict()
export type GstFiledInput = z.infer<typeof gstFiledInputSchema>

export interface TaxesWithholding {
  kind: 'tds' | 'tcs'
  /** Deducted (TDS) / collected (TCS) this month so far, all payable ledgers. */
  thisMonth: number
  /** The deposit date for this month's deductions. */
  thisMonthDue: string
  /** Still unpaid, oldest first (FIFO against every payment up to today). */
  unpaid: { month: string | null; amount: number; dueDate: string | null; late: boolean }[]
  totalUnpaid: number
  /** WP 10.2 — of `totalUnpaid`, the part already past its due date. */
  lateUnpaid: number
}

export interface CompositionDue {
  /** CMP-08: the quarter it covers and its date (rule 62(1)(i)). */
  cmp08: { from: string; to: string; due: string }
  /** GSTR-4: the FY and its date (rule 62(1)(ii) + proviso). */
  gstr4: { fyLabel: string; due: string }
}

export type SimpleTaxes =
  | { kind: 'unregistered'; today: string; withholding: TaxesWithholding[] }
  | { kind: 'composition'; today: string; composition: CompositionDue; withholding: TaxesWithholding[] }
  | {
      kind: 'regular'
      today: string
      filing: GstFilingFrequency
      period: GstPeriod
      /** The periods the picker offers (newest first), the default one included. */
      periods: GstPeriod[]
      figures: GstFigures
      due: GstDue
      missing: MissingBillsItem[]
      supplierBills: SupplierBillsMonth[]
      /** When the GSTR-1 / 3B file for the period was last prepared (export snapshot), or null. */
      prepared: Record<GstForm, string | null>
      /** Quarterly filers: Total prepares monthly files only (see the screen's note). */
      filesMonthly: boolean
      filed: GstFiledPeriod
      withholding: TaxesWithholding[]
    }

// ---------------------------------------------------------------- periods

const pad2 = (n: number): string => String(n).padStart(2, '0')
function addMonths(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  const idx = y * 12 + (mo - 1) + delta
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`
}
const monthEnd = (m: string): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return `${m}-${pad2(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`
}
/** The quarter's first month ('YYYY-MM') for any month of it (Indian FY quarters = calendar). */
export function quarterStart(m: string): string {
  const mo = Number(m.slice(5, 7))
  return addMonths(m, -((mo - 1) % 3))
}
const quarterEnd = (m: string): string => addMonths(quarterStart(m), 2)

/** The GST period named by `last` (a month; for a quarterly filer any month of the quarter is
 *  read as the quarter), as on `today`. Null when it starts after today. */
export function gstPeriodFor(last: string, filing: GstFilingFrequency, today: string): GstPeriod | null {
  const quarterly = filing === 'quarterly'
  const end = quarterly ? quarterEnd(last) : last
  const first = quarterly ? quarterStart(last) : last
  const from = `${first}-01`
  if (from > today) return null
  const fullTo = monthEnd(end)
  const soFar = fullTo > today
  return { period: end, from, to: soFar ? today : fullTo, quarterly, soFar }
}

/** The picker's periods, newest first: the running one and the `count` before it. */
export function gstPeriodChoices(filing: GstFilingFrequency, today: string, count = filing === 'quarterly' ? 4 : 6): GstPeriod[] {
  const step = filing === 'quarterly' ? 3 : 1
  const out: GstPeriod[] = []
  for (let i = 0; i <= count; i++) {
    const p = gstPeriodFor(addMonths(today.slice(0, 7), -i * step), filing, today)
    if (p) out.push(p)
  }
  return out
}

/** The next CMP-08 (the last quarter's, while its 18th is still ahead; else the running one) and
 *  the next GSTR-4 (last FY's while due, else this FY's), as on `today`. `due` functions are
 *  shared/gst/filing.ts's (passed in so this stays a pure rule). */
export function nextCompositionDue(
  today: string,
  cmp08Due: (quarterLastMonth: string) => string,
  gstr4Due: (fyStartYear: number) => string
): CompositionDue {
  const runningEnd = quarterEnd(today.slice(0, 7))
  const lastEnd = addMonths(runningEnd, -3)
  const qEnd = cmp08Due(lastEnd) >= today ? lastEnd : runningEnd
  const [y, m] = today.split('-').map(Number) as [number, number]
  const fyNow = m >= 4 ? y : y - 1
  const fy = gstr4Due(fyNow - 1) >= today ? fyNow - 1 : fyNow
  return {
    cmp08: { from: `${quarterStart(qEnd)}-01`, to: monthEnd(qEnd), due: cmp08Due(qEnd) },
    gstr4: { fyLabel: `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`, due: gstr4Due(fy) }
  }
}

/** The steps' state, for the progress line ("2 of 5 done"). Pure. */
export function stepsDone(t: Extract<SimpleTaxes, { kind: 'regular' }>): { missing: boolean; supplier: boolean; files: boolean; filed: boolean } {
  return {
    missing: t.missing.length === 0,
    supplier: t.supplierBills.length > 0 && t.supplierBills.every((m) => m.imported && m.categories.every((c) => c.count === 0)),
    files: t.prepared.gstr1 != null && t.prepared.gstr3b != null,
    filed: !!t.filed.gstr1 && !!t.filed.gstr3b
  }
}
