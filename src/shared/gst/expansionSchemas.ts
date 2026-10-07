/**
 * Zod schemas for the WP 3.4 GST-expansion IPC payloads and meta-stored settings (kept apart
 * from shared/schemas.ts so the parallel Phase 3 branches don't collide in one file).
 */
import { z } from 'zod'
import { isoDate } from '../schemas'

const paise = z.number().int().safe()
const id = z.number().int().positive()
const period = z.string().regex(/^\d{6}$/, 'Expected MMYYYY')
const heads = z.object({ igst: paise.default(0), cgst: paise.default(0), sgst: paise.default(0), cess: paise.default(0) })

/** GSTR-2B matcher tolerances (meta `gst.recon2b.tolerances`). */
export const recon2bTolerancesSchema = z.object({
  amountPaise: z.number().int().min(0).max(1_000_000).default(100),
  amountPct: z.number().min(0).max(10).default(0),
  dateDays: z.number().int().min(0).max(90).default(7),
  fuzzyNumbers: z.boolean().default(true)
})
export type Recon2bTolerancesInput = z.infer<typeof recon2bTolerancesSchema>

export const imsActionSchema = z.enum(['accept', 'reject', 'pending'])

/** One IMS decision to store (or clear, with action null). */
export const imsDecisionSchema = z.object({
  supplierGstin: z.string().trim().min(1).max(20),
  docType: z.enum(['INV', 'CN', 'DN']),
  docNo: z.string().trim().min(1).max(40),
  docDate: isoDate,
  action: imsActionSchema.nullable(),
  note: z.string().trim().max(200).nullable().default(null),
  voucherId: id.nullable().default(null),
  value: paise.nullable().default(null),
  taxable: paise.nullable().default(null),
  igst: paise.nullable().default(null),
  cgst: paise.nullable().default(null),
  sgst: paise.nullable().default(null),
  cess: paise.nullable().default(null)
})
export type ImsDecisionInput = z.infer<typeof imsDecisionSchema>

export const imsSetSchema = z.object({ period, decisions: z.array(imsDecisionSchema).min(1).max(5000) })

export const fyStartSchema = z.object({ fyStartYear: z.number().int().min(2017).max(2100) })

export const itc04QuerySchema = z.object({
  fyStartYear: z.number().int().min(2017).max(2100),
  kind: z.enum(['H1', 'H2', 'FY']),
  /** Override the turnover-derived periodicity. */
  periodicity: z.enum(['half_yearly', 'annual']).optional()
})

/** User-entered rule 42 / 43 facts for one period (meta `gst.itcRev.inputs.<MMYYYY>`). */
export const itcReversalInputsSchema = z.object({
  /** T1 — inputs / input services used exclusively for non-business purposes. */
  T1: heads.default({}),
  /** T2 — used exclusively for exempt supplies. */
  T2: heads.default({}),
  /** T4 — used exclusively for taxable (incl. zero-rated) supplies. */
  T4: heads.default({}),
  /** Inputs partly used for non-business purposes (D2 = 5% of C2). */
  nonBusiness: z.boolean().default(false),
  /** Capital-goods vouchers used EXCLUSIVELY for taxable supplies (left out of rule 43's Tc). */
  exclusiveCapitalGoods: z.array(id).max(5000).default([]),
  /** Include the rule 42 annual true-up of the period's FY in this proposal. */
  includeTrueUp: z.boolean().default(false),
  /** Expense the s.17(5) credit booked in input-tax ledgers in the journal. */
  expenseBlocked: z.boolean().default(true)
})
export type ItcReversalInputs = z.infer<typeof itcReversalInputsSchema>

export const itcReversalQuerySchema = z.object({ from: isoDate, to: isoDate, period, inputs: itcReversalInputsSchema.optional() })

export const selfInvoiceGenerateSchema = z.object({ voucherId: id, date: isoDate.optional() })

/** Self-invoice series settings (meta `gst.selfInvoice.series`). */
export const selfInvoiceSeriesSchema = z.object({
  /** Letters, digits, '-' and '/' only (rule 46(b)); the FY and a 4-digit serial follow. */
  prefix: z.string().trim().max(6).regex(/^[A-Za-z0-9/-]*$/, 'Letters, digits, “-” and “/” only').default('SI/')
})
export type SelfInvoiceSeries = z.infer<typeof selfInvoiceSeriesSchema>
