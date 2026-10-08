/** WP 4.2 — Zod payloads of the receivables channels (src/main/ipcReceivables.ts). */
import { z } from 'zod'
import { isoDate } from '../schemas'
import { REMINDER_CHANNELS } from './config'

const id = z.number().int().positive()
const paise = z.number().int().safe()

export const statementQuerySchema = z.object({ ledgerId: id, from: isoDate, to: isoDate }).refine((q) => q.from <= q.to, { message: 'From must be on or before To' })
export const statementsBulkSchema = z.object({
  from: isoDate,
  to: isoDate,
  /** Ask for a folder (main shows the picker); otherwise exports/statements-<to>/. */
  pickFolder: z.boolean().default(false),
  ledgerIds: z.array(id).max(5000).optional()
})
export const remindSchema = z.object({
  ledgerId: id,
  asOn: isoDate,
  channel: z.enum(REMINDER_CHANNELS).default('email'),
  /** Send even inside the "don't remind again within N days" window. */
  force: z.boolean().default(false)
})
export const remindBulkSchema = z.object({
  asOn: isoDate,
  ledgerIds: z.array(id).max(5000).optional(),
  channel: z.enum(REMINDER_CHANNELS).default('pdf')
})
export const reminderLogSchema = z.object({ from: isoDate, to: isoDate, ledgerId: id.optional() })
export const interestPreviewSchema = z.object({ asOn: isoDate, ledgerId: id.optional(), gstOnInterest: z.boolean().optional() })
export const postInterestSchema = z.object({
  asOn: isoDate,
  /** Debit note date (defaults to asOn). */
  date: isoDate.optional(),
  ledgerId: id,
  /** Bill keys (billKeyOf) to charge; absent = every chargeable bill of the party. */
  keys: z.array(z.string().max(120)).max(500).optional(),
  gstOnInterest: z.boolean().optional()
})
export const interestChargesSchema = z.object({ ledgerId: id.optional() })
export const setHoldSchema = z
  .object({ ledgerId: id, hold: z.boolean(), reason: z.string().trim().max(300).default('') })
  .refine((h) => !h.hold || h.reason.length > 0, { message: 'Give a reason for the credit hold', path: ['reason'] })
export const followupInputSchema = z.object({
  ledgerId: id,
  billVoucherId: id.nullable(),
  billRef: z.string().trim().min(1).max(80),
  date: isoDate,
  note: z.string().trim().max(1000).default(''),
  promisedDate: isoDate.nullable().default(null),
  promisedAmount: paise.positive().nullable().default(null)
}).refine((f) => f.note.length > 0 || f.promisedDate !== null, { message: 'Write a note or a promised date', path: ['note'] })
export type FollowupInput = z.input<typeof followupInputSchema>
export const followupsQuerySchema = z.object({ ledgerId: id.optional() })
export const collectionsSchema = z.object({ from: isoDate, to: isoDate })
export const topOverdueSchema = z.object({ asOn: isoDate, limit: z.number().int().min(1).max(500).default(25) })
export const creditOverrideSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason for the override').max(300) })
