import { z } from 'zod'

/**
 * Company-wide invoice print customization (Tally's F12 invoice print config, roughly). Stored
 * per company in `meta` under key 'invoice'. Consumed by src/main/services/invoice.ts.
 */
export interface InvoiceBankDetails {
  name: string
  account: string
  ifsc: string
  branch: string
}

export interface InvoiceConfig {
  title: string
  /** data: URL (PNG/JPEG), capped at ~200KB base64. Null = no logo. */
  logoDataUrl: string | null
  declaration: string
  bankDetails: InvoiceBankDetails | null
  signatory: string
  terms: string
  showHsn: boolean
  showDiscount: boolean
  /** One PDF page rendered per label, e.g. ['Original for Recipient', 'Duplicate for Transporter']. */
  copyLabels: string[]
}

export const DEFAULT_INVOICE_CONFIG: InvoiceConfig = {
  title: 'TAX INVOICE',
  logoDataUrl: null,
  declaration:
    'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
  bankDetails: null,
  signatory: 'Authorised Signatory',
  terms: '',
  showHsn: true,
  showDiscount: false,
  copyLabels: ['Original for Recipient']
}

/** ~200KB of base64 (280,000 chars covers 200KB with base64's ~4/3 expansion plus headroom). */
const MAX_LOGO_DATA_URL_LEN = 280_000

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
    .refine((s) => s.startsWith('data:image/'), 'Logo must be an image data URL')
    .nullable(),
  declaration: z.string().trim().max(1000),
  bankDetails: bankDetailsSchema.nullable(),
  signatory: z.string().trim().max(80),
  terms: z.string().trim().max(2000),
  showHsn: z.boolean(),
  showDiscount: z.boolean(),
  copyLabels: z.array(z.string().trim().min(1).max(40)).min(1).max(3)
})

/** Merge a partial/unknown-shaped object over the defaults, then validate. Never throws — falls
 *  back to all-defaults if the merged shape still doesn't validate. */
export function mergeInvoiceConfig(partial: unknown): InvoiceConfig {
  const obj = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {}
  const merged = { ...DEFAULT_INVOICE_CONFIG, ...obj }
  const parsed = invoiceConfigSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...DEFAULT_INVOICE_CONFIG }
}
