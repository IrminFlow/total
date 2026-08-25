import { DEFAULT_INVOICE_TEMPLATE, type InvoiceTemplateId } from './invoiceTemplates'
import type { InvoiceLanguage } from './i18n/invoiceLabels'

/**
 * Zod-free on purpose. The settings screen reads `DEFAULT_INVOICE_CONFIG`, so a runtime import of
 * zod here lands the whole validator in a renderer chunk in order to describe an object the
 * renderer only ever reads. The schema and the merge are in `invoiceConfig.schema.ts`; main is
 * the only thing that needs them.
 *
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
export const MAX_LOGO_DATA_URL_LEN = 280_000
