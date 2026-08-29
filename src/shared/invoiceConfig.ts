import { z } from "zod";

/**
 * Company-wide invoice print customization (Tally's F12 invoice print config, roughly). Stored
 * per company in `meta` under key 'invoice'. Consumed by src/main/services/invoice.ts.
 */
export interface InvoiceBankDetails {
  name: string;
  account: string;
  ifsc: string;
  branch: string;
}

export interface InvoiceUpiDetails {
  vpa: string;
  payeeName: string;
}

export type InvoiceLabelLanguage = "en" | "hi" | "mr" | "gu" | "ta";

export interface InvoiceConfig {
  title: string;
  /** data: URL (PNG/JPEG), capped at ~200KB base64. Null = no logo. */
  logoDataUrl: string | null;
  declaration: string;
  bankDetails: InvoiceBankDetails | null;
  /** Optional customer-payment QR. This is separate from the invoice verification/IRN QR. */
  upiDetails: InvoiceUpiDetails | null;
  paymentInstructions: string;
  signatory: string;
  terms: string;
  showHsn: boolean;
  showDiscount: boolean;
  /** One PDF page rendered per label, e.g. ['Original for Recipient', 'Duplicate for Transporter']. */
  copyLabels: string[];
  /** Verification QR near the title — the NIC-signed IRN QR when an e-invoice IRN exists, else a
   *  plain (unsigned) JSON summary of the invoice essentials. See src/shared/einvoiceQr.ts. */
  showQr: boolean;
  /** Adds a "Barcode" column when at least one line item carries a stored barcode. */
  showItemBarcode: boolean;
  /** Footer line "Entered by X · Altered by Y" sourced from the voucher's audit trail (first
   *  create + latest update user) — lane Q, task Q1 #91. Off by default. */
  showEnteredBy: boolean;
  /** Customer-facing labels only. Company names, item text and accounting values stay verbatim. */
  labelLanguage: InvoiceLabelLanguage;
}

export const DEFAULT_INVOICE_CONFIG: InvoiceConfig = {
  title: "TAX INVOICE",
  logoDataUrl: null,
  declaration:
    "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
  bankDetails: null,
  upiDetails: null,
  paymentInstructions: "",
  signatory: "Authorised Signatory",
  terms: "",
  showHsn: true,
  showDiscount: false,
  copyLabels: ["Original for Recipient"],
  showQr: true,
  showItemBarcode: false,
  showEnteredBy: false,
  labelLanguage: "en",
};

/** ~200KB of base64 (280,000 chars covers 200KB with base64's ~4/3 expansion plus headroom). */
const MAX_LOGO_DATA_URL_LEN = 280_000;

function validLogoImageDataUrl(value: string): boolean {
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  try {
    const bytes = globalThis.atob(match[2]!);
    const mime = match[1]!.toLowerCase();
    if (mime === "png")
      return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes.charCodeAt(index) === byte);
    if (mime === "jpeg")
      return bytes.length >= 3 && bytes.charCodeAt(0) === 0xff && bytes.charCodeAt(1) === 0xd8 && bytes.charCodeAt(2) === 0xff;
    return bytes.length >= 12 && bytes.slice(0, 4) === "RIFF" && bytes.slice(8, 12) === "WEBP";
  } catch {
    return false;
  }
}

const bankDetailsSchema = z.object({
  name: z.string().trim().max(120),
  account: z.string().trim().max(40),
  ifsc: z.string().trim().max(20),
  branch: z.string().trim().max(120),
});

const upiDetailsSchema = z.object({
  vpa: z.string().trim().min(5).max(255).regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/, "Enter a valid UPI ID"),
  payeeName: z.string().trim().min(2).max(80),
});

export const invoiceConfigSchema = z.object({
  title: z.string().trim().min(1).max(80),
  logoDataUrl: z
    .string()
    .max(MAX_LOGO_DATA_URL_LEN, "Logo image is too large (max ~200KB)")
    .refine(validLogoImageDataUrl, "Logo must be a valid PNG, JPEG or WebP image data URL")
    .nullable(),
  declaration: z.string().trim().max(1000),
  bankDetails: bankDetailsSchema.nullable(),
  upiDetails: upiDetailsSchema.nullable().default(null),
  paymentInstructions: z.string().trim().max(1000).default(""),
  signatory: z.string().trim().max(80),
  terms: z.string().trim().max(2000),
  showHsn: z.boolean(),
  showDiscount: z.boolean(),
  copyLabels: z.array(z.string().trim().min(1).max(40)).min(1).max(3),
  showQr: z.boolean(),
  showItemBarcode: z.boolean(),
  // .default(false) so configs saved before this field existed still parse as-is.
  showEnteredBy: z.boolean().default(false),
  labelLanguage: z.enum(["en", "hi", "mr", "gu", "ta"]).default("en"),
});

/** Every field optional — for previewing unsaved edits. The renderer's draft form state is
 *  always a full InvoiceConfig, but callers (and the invoice:previewHtml IPC payload) only need
 *  to promise a subset; the service layer merges whatever's given over the *saved* config, not
 *  the hard defaults, so an omitted field falls back to what's on disk. */
export const invoiceConfigPartialSchema = invoiceConfigSchema.partial();

/** Merge a partial/unknown-shaped object over the defaults, then validate. Never throws — falls
 *  back to all-defaults if the merged shape still doesn't validate. */
export function mergeInvoiceConfig(partial: unknown): InvoiceConfig {
  const obj =
    partial && typeof partial === "object"
      ? (partial as Record<string, unknown>)
      : {};
  const merged = { ...DEFAULT_INVOICE_CONFIG, ...obj };
  const parsed = invoiceConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...DEFAULT_INVOICE_CONFIG };
}
