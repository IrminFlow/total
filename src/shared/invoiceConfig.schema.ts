import { z } from 'zod'
import { isValidVpa } from './upi'
import { DEFAULT_INVOICE_CONFIG, MAX_LOGO_DATA_URL_LEN, type InvoiceConfig } from './invoiceConfig'
import { DEFAULT_INVOICE_TEMPLATE } from './invoiceTemplates'

/**
 * Validation for the invoice layout — main's half. Split from `invoiceConfig.ts` so the renderer
 * can read the defaults without pulling zod in behind them; see that file's header.
 */
const bankDetailsSchema = z.object({
  name: z.string().trim().max(120),
  account: z.string().trim().max(40),
  ifsc: z.string().trim().max(20),
  branch: z.string().trim().max(120)
})

export const invoiceConfigSchema = z.object({
  title: z.string().trim().min(1).max(80),
  logoDataUrl: z
    .string()
    .max(MAX_LOGO_DATA_URL_LEN, 'Logo image is too large (max ~200KB)')
    .regex(/^data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/i, 'Logo must be an image data URL')
    .nullable(),
  declaration: z.string().trim().max(1000),
  bankDetails: bankDetailsSchema.nullable(),
  signatory: z.string().trim().max(80),
  terms: z.string().trim().max(2000),
  showHsn: z.boolean(),
  showDiscount: z.boolean(),
  copyLabels: z.array(z.string().trim().min(1).max(40)).min(1).max(3),
  showQr: z.boolean(),
  showItemBarcode: z.boolean(),
  // .default(false) so configs saved before this field existed still parse as-is.
  showEnteredBy: z.boolean().default(false),
  // Shape-checked, not existence-checked: a typo in a VPA does not bounce, so the only local
  // check possible is that it looks like one at all. See src/shared/upi.ts.
  upiVpa: z
    .string()
    .trim()
    .max(80)
    .nullable()
    .default(null)
    .refine((v) => v === null || v === '' || isValidVpa(v), 'Not a UPI address (name@handle)')
    .transform((v) => (v === '' ? null : v)),
  signatureDataUrl: z
    .string()
    .max(MAX_LOGO_DATA_URL_LEN, 'Signature image is too large (max ~200KB)')
    .regex(/^data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/i, 'Signature must be an image data URL')
    .nullable()
    .default(null),
  // Partial by design: a kind with no entry falls back to the general terms rather than to blank,
  // so configuring one document's terms never silently clears the others'.
  termsByKind: z
    .object({
      sales: z.string().trim().max(2000).optional(),
      credit_note: z.string().trim().max(2000).optional(),
      debit_note: z.string().trim().max(2000).optional()
    })
    .default({}),
  // All four .default() so a config saved before these fields existed still parses, and an
  // upgrade never restyles stationery that was already in use.
  template: z.enum(['classic', 'modern', 'compact']).default(DEFAULT_INVOICE_TEMPLATE),
  language: z.enum(['none', 'hi', 'mr']).default('none'),
  thermalWidthMm: z.union([z.literal(58), z.literal(80)]).default(80),
  thermalShowTax: z.boolean().default(true)
})

/** Every field optional — for previewing unsaved edits. The renderer's draft form state is
 *  always a full InvoiceConfig, but callers (and the invoice:previewHtml IPC payload) only need
 *  to promise a subset; the service layer merges whatever's given over the *saved* config, not
 *  the hard defaults, so an omitted field falls back to what's on disk. */
export const invoiceConfigPartialSchema = invoiceConfigSchema.partial()

/** Merge a partial/unknown-shaped object over the defaults, then validate. Never throws — falls
 *  back to all-defaults if the merged shape still doesn't validate. */
export function mergeInvoiceConfig(partial: unknown): InvoiceConfig {
  const obj = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {}
  const merged = { ...DEFAULT_INVOICE_CONFIG, ...obj }
  const parsed = invoiceConfigSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...DEFAULT_INVOICE_CONFIG }
}
