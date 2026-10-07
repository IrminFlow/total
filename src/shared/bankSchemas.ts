/** Zod schemas for the WP 4.1 banking IPC payloads (parsed in src/main/ipcBanking.ts). */
import { z } from 'zod'
import { DATE_FORMATS, DELIMITERS, ENCODINGS } from './bankFormats/types'
import { PAYMENT_FIELDS, type PaymentTemplate } from './bulkPayments'
import { isoDate } from './schemas'

const id = z.number().int().positive()
const col = z.number().int().min(0).max(200)

export const importProfileSchema = z.object({
  delimiter: z.enum(DELIMITERS),
  encoding: z.enum(ENCODINGS),
  headerRow: z.number().int().min(0).max(500),
  dateFormat: z.enum(DATE_FORMATS),
  dateCol: col,
  valueDateCol: col.nullable(),
  descCols: z.array(col).max(6),
  refCol: col.nullable(),
  amountMode: z.enum(['split', 'signed', 'flag']),
  debitCol: col.nullable(),
  creditCol: col.nullable(),
  amountCol: col.nullable(),
  flagCol: col.nullable(),
  balanceCol: col.nullable(),
  signedNegativeIsDeposit: z.boolean()
})

/** A statement file or pasted text. Files arrive base64 (binary-safe for .xlsx), capped at 15 MB. */
export const statementSourceSchema = z
  .object({
    fileName: z.string().max(255),
    base64: z.string().max(20_000_000).optional(),
    text: z.string().max(15_000_000).optional(),
    format: z.enum(['csv', 'xlsx', 'mt940', 'camt053', 'pasted']).optional(),
    profile: importProfileSchema.nullable().optional()
  })
  .refine((s) => s.base64 != null || s.text != null, { message: 'Give the file content or pasted text' })

export const matchOptionsSchema = z.object({
  amountTolerance: z.number().int().min(0).max(100_000_00).optional(),
  dateWindowDays: z.number().int().min(0).max(60).optional(),
  maxGroup: z.number().int().min(2).max(5).optional()
})

export const workspaceQuerySchema = z.object({
  bankLedgerId: id,
  importId: id.optional(),
  includeDone: z.boolean().optional(),
  options: matchOptionsSchema.optional(),
  minSuggestScore: z.number().min(0).max(1).optional()
})

export const confirmMatchesSchema = z.object({
  bankLedgerId: id,
  groups: z.array(z.object({ lineIds: z.array(id).min(1).max(20), voucherIds: z.array(id).min(1).max(20) })).min(1).max(500),
  tolerance: z.number().int().min(0).max(100_000_00).default(0)
})

export const createFromLinesSchema = z.object({
  bankLedgerId: id,
  items: z
    .array(
      z.object({
        lineId: id,
        ledgerId: id,
        partyLedgerId: id.nullable().optional(),
        voucherKind: z.enum(['payment', 'receipt', 'contra']).optional(),
        narration: z.string().max(1000).nullable().optional(),
        source: z.object({ kind: z.enum(['learned', 'rule']), ruleId: id }).nullable().optional()
      })
    )
    .min(1)
    .max(500)
})

export const learnedRuleEditSchema = z.object({
  status: z.enum(['candidate', 'accepted', 'ignored']).optional(),
  ledgerId: id.optional(),
  partyLedgerId: id.nullable().optional(),
  voucherKind: z.enum(['payment', 'receipt', 'contra', 'journal']).optional(),
  narrationTemplate: z.string().max(300).nullable().optional(),
  tokens: z.array(z.string().max(40)).max(12).optional()
})

export const chequeBookInputSchema = z.object({
  bankLedgerId: id,
  name: z.string().trim().max(60).default(''),
  fromNo: z.number().int().min(0).max(999_999_999),
  toNo: z.number().int().min(0).max(999_999_999),
  width: z.number().int().min(1).max(12).default(6),
  receivedOn: isoDate.nullable().default(null),
  active: z.boolean().default(true)
})

export const chequeStatusSchema = z.object({
  bankLedgerId: id,
  chequeId: id.nullable().optional(),
  number: z.string().trim().max(20).nullable().optional(),
  status: z.enum(['cancelled', 'stopped', 'issued']),
  note: z.string().trim().max(300).nullable().optional()
})

export const bounceSchema = z.object({
  voucherId: id,
  date: isoDate,
  charges: z.number().int().min(0).max(10_000_000_00),
  chargesLedgerId: id.nullable(),
  recoverChargesFromParty: z.boolean(),
  reason: z.string().trim().max(200)
})

export const bankDetailsSchema = z.object({
  accountNo: z.string().trim().max(34).nullable(),
  ifsc: z.string().trim().max(11).nullable(),
  accountName: z.string().trim().max(100).nullable(),
  email: z.string().trim().max(120).nullable()
})

export const paymentTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  delimiter: z.enum([',', '|', '\t', ';']),
  extension: z.enum(['csv', 'txt']),
  includeHeader: z.boolean(),
  headerLine: z.string().max(500).nullable(),
  columns: z
    .array(
      z.object({
        header: z.string().max(80),
        field: z.enum(PAYMENT_FIELDS),
        value: z.string().max(200).optional(),
        maxLength: z.number().int().min(1).max(500).nullable().optional()
      })
    )
    .min(1)
    .max(60),
  dateFormat: z.enum(['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DDMMYYYY', 'DD-MMM-YYYY']),
  amountFormat: z.enum(['rupees', 'rupees_int', 'paise']),
  quoteAll: z.boolean(),
  rtgsThreshold: z.number().int().min(0),
  corporateId: z.string().trim().max(40)
}) satisfies z.ZodType<PaymentTemplate>

export const exportBatchSchema = z.object({
  bankLedgerId: id,
  voucherIds: z.array(id).min(1).max(1000),
  templateKey: z.string().max(40),
  date: isoDate,
  corporateId: z.string().trim().max(40).nullable().optional(),
  remarks: z.string().trim().max(200).nullable().optional()
})
