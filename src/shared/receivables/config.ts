/**
 * WP 4.2 — the company's receivables settings (Settings → Receivables), stored as one JSON
 * document in `meta` under RECEIVABLES_META_KEY. Every leaf has a default, so a document saved by
 * an older build still parses.
 */
import { z } from 'zod'

export const RECEIVABLES_META_KEY = 'receivables'

export const REMINDER_BUCKETS = ['gentle', 'firm', 'final'] as const
export type ReminderBucket = (typeof REMINDER_BUCKETS)[number]
export const REMINDER_BUCKET_LABELS: Record<ReminderBucket, string> = { gentle: 'Gentle', firm: 'Firm', final: 'Final' }

export const REMINDER_CHANNELS = ['email', 'pdf', 'print', 'phone', 'other'] as const
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number]

/** Merge fields every template understands (documented in Settings beside the editors). */
export const MERGE_FIELDS = [
  ['party', "The party's name"],
  ['company', 'Your company name'],
  ['amount', 'Overdue amount (₹)'],
  ['total', 'Total outstanding (₹)'],
  ['oldestBill', 'Oldest overdue bill number'],
  ['oldestBillDate', 'Its bill date'],
  ['days', 'Days the oldest bill is overdue'],
  ['asOn', 'The as-on date'],
  ['bills', 'One line per overdue bill'],
  ['from', 'Statement period start'],
  ['to', 'Statement period end'],
  ['closing', 'Statement closing balance (₹)']
] as const
export type MergeField = (typeof MERGE_FIELDS)[number][0]

const text = (max: number, def: string) => z.string().max(max).default(def)

const letterSchema = (subject: string, body: string) =>
  z.object({ subject: text(200, subject), body: text(4000, body) }).default({})

export const DEFAULT_REMINDERS: Record<ReminderBucket, { subject: string; body: string }> = {
  gentle: {
    subject: 'Friendly reminder: {amount} due to {company}',
    body:
      'Dear {party},\n\nThis is a friendly reminder that the following bills are now past their due date:\n\n{bills}\n\n' +
      'Overdue amount: {amount}\n\nIf you have already sent the payment, thank you — please ignore this note. Otherwise we ' +
      'would be grateful if you could arrange it at your convenience.\n\nRegards,\n{company}'
  },
  firm: {
    subject: 'Second reminder: {amount} overdue — {company}',
    body:
      'Dear {party},\n\nOur records show the following bills still unpaid, the oldest ({oldestBill} of {oldestBillDate}) now ' +
      '{days} days overdue:\n\n{bills}\n\nOverdue amount: {amount}\n\nPlease arrange payment within 7 days, or let us know ' +
      'if there is any query on these bills.\n\nRegards,\n{company}'
  },
  final: {
    subject: 'Final notice: {amount} overdue — {company}',
    body:
      'Dear {party},\n\nDespite our earlier reminders the following bills remain unpaid, the oldest {days} days past due:\n\n' +
      '{bills}\n\nOverdue amount: {amount}\n\nUnless payment reaches us within 7 days we will have to stop further supplies ' +
      'on credit and charge interest on the overdue amount as per our terms.\n\nRegards,\n{company}'
  }
}

export const DEFAULT_STATEMENT_EMAIL = {
  subject: 'Statement of account {from} to {to} — {company}',
  body:
    'Dear {party},\n\nPlease find attached your statement of account for {from} to {to}. The balance as on {to} is ' +
    '{closing}.\n\nKindly let us know of any difference.\n\nRegards,\n{company}'
}

export const receivablesConfigSchema = z.object({
  statementEmail: letterSchema(DEFAULT_STATEMENT_EMAIL.subject, DEFAULT_STATEMENT_EMAIL.body),
  /** Printed under the statement's ageing summary. */
  paymentRequest: text(400, 'Kindly remit the balance due to the bank account below, quoting the bill numbers.'),
  reminders: z
    .object({
      gentle: letterSchema(DEFAULT_REMINDERS.gentle.subject, DEFAULT_REMINDERS.gentle.body),
      firm: letterSchema(DEFAULT_REMINDERS.firm.subject, DEFAULT_REMINDERS.firm.body),
      final: letterSchema(DEFAULT_REMINDERS.final.subject, DEFAULT_REMINDERS.final.body)
    })
    .default({}),
  /** A party whose oldest overdue bill is at least this many days overdue gets the firm / final letter. */
  firmFromDays: z.number().int().min(1).max(365).default(31),
  finalFromDays: z.number().int().min(2).max(730).default(61),
  /** Don't send a party another reminder within this many days of the last one (0 = no limit). */
  minDaysBetweenReminders: z.number().int().min(0).max(90).default(7),
  interest: z
    .object({
      /** Base name of the interest income ledger (Indirect Incomes); a "@ 18%" suffix per GST rate. */
      ledgerName: z.string().trim().min(1).max(80).default('Interest on Overdue Bills'),
      /** sources.ts 'cgst-15-2-d' / 'cgst-12-6': GST on the debit note by default. */
      gstOnInterest: z.boolean().default(true),
      /** Charges below this (paise) are left out of a posting. */
      minimumPaise: z.number().int().min(0).max(100_000_00).default(100)
    })
    .default({})
}).refine((c) => c.finalFromDays > c.firmFromDays, { message: 'The final letter must start after the firm one', path: ['finalFromDays'] })

export type ReceivablesConfig = z.output<typeof receivablesConfigSchema>
export type ReceivablesConfigInput = z.input<typeof receivablesConfigSchema>

export const DEFAULT_RECEIVABLES_CONFIG: ReceivablesConfig = receivablesConfigSchema.parse({})

/** Parse a stored document, falling back to the defaults when it is beyond repair. */
export function parseReceivablesConfig(raw: unknown): ReceivablesConfig {
  const r = receivablesConfigSchema.safeParse(raw ?? {})
  return r.success ? r.data : DEFAULT_RECEIVABLES_CONFIG
}
