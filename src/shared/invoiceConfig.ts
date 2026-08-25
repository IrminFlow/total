import { z } from 'zod'
import { isValidVpa } from './upi'
import { DEFAULT_INVOICE_TEMPLATE, type InvoiceTemplateId } from './invoiceTemplates'
import type { InvoiceLanguage } from './i18n/invoiceLabels'

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
  /** Verification QR near the title — the NIC-signed IRN QR when an e-invoice IRN exists, else a
   *  plain (unsigned) JSON summary of the invoice essentials. See src/shared/einvoiceQr.ts. */
  showQr: boolean
  /** Adds a "Barcode" column when at least one line item carries a stored barcode. */
  showItemBarcode: boolean
  /** Footer line "Entered by X · Altered by Y" sourced from the voucher's audit trail (first
   *  create + latest update user) — lane Q, task Q1 #91. Off by default. */
  showEnteredBy: boolean
  /**
   * UPI virtual payment address the invoice's payment QR pays into. Null = no payment QR.
   *
   * An invoice that says what is owed and leaves the customer to type an account number into a
   * banking app gets paid late. A UPI QR turns "I'll transfer it" into a five-second act, and
   * this market pays by UPI more than by anything else.
   */
  upiVpa: string | null
  /**
   * Signature or stamp image, printed above the signatory line. data: URL, same cap as the logo.
   *
   * A scanned signature on an invoice is what most small businesses actually do, and the
   * alternative is printing every invoice to sign it by hand. Null = the blank space stays blank,
   * which is what a business that signs physically wants.
   */
  signatureDataUrl: string | null
  /**
   * Terms per voucher kind, overriding `terms`.
   *
   * A sales invoice says "payment due in 30 days"; a credit note saying that is nonsense, and a
   * purchase document has no business carrying our own terms at all. One block for every document
   * meant the block had to be generic enough to be useless.
   */
  termsByKind: Partial<Record<'sales' | 'credit_note' | 'debit_note', string>>
  /**
   * Which stylesheet the printed invoice uses. See src/shared/invoiceTemplates.ts — the markup is
   * identical across templates, so switching one can change how the document looks and never what
   * it says.
   */
  template: InvoiceTemplateId
  /**
   * A second language printed BESIDE each English label, never instead of it.
   *
   * Additive because the English text is what an officer reads and what the rules are written in;
   * a Devanagari-only invoice would be a worse document, not a more local one. 'none' is the
   * default, so an existing company's stationery does not change under it.
   */
  language: InvoiceLanguage
  /**
   * Paper width of the thermal receipt printer, in millimetres. 58 and 80 are the two rolls sold;
   * everything else is a special order. Only consulted by the receipt print, never by the A4 one.
   */
  thermalWidthMm: 58 | 80
  /**
   * Print the GST rate/tax split on the thermal receipt.
   *
   * A counter receipt is a tax invoice when it carries the supplier's GSTIN, the tax split and an
   * invoice number, and many shops want exactly that on the roll. Others want a short receipt and
   * hand a proper invoice separately. Defaults on, because dropping the tax split silently is the
   * failure that costs the customer their credit.
   */
  thermalShowTax: boolean
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
  copyLabels: ['Original for Recipient'],
  showQr: true,
  showItemBarcode: false,
  showEnteredBy: false,
  upiVpa: null,
  signatureDataUrl: null,
  termsByKind: {},
  template: DEFAULT_INVOICE_TEMPLATE,
  language: 'none',
  thermalWidthMm: 80,
  thermalShowTax: true
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
