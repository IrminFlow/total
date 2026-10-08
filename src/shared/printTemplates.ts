import { z } from 'zod'
import { DOC_DATE_FORMATS } from './dates'
import { DEFAULT_INVOICE_CONFIG, type InvoiceConfig } from './invoiceConfig'

/**
 * Print templates (WP 1.10c) — the model behind Settings → Invoice templates. Pure + Zod-validated.
 *
 * A PrintTemplate describes HOW a printed document looks (page, header, party block, line-table
 * columns, totals, footer, e-invoice block, formats, typography). The ONE renderer that turns a
 * template + document data into self-contained HTML is src/shared/print/render.ts — used by the
 * real PDF path and the designer's live preview alike.
 *
 * Storage (src/main/services/printTemplates.ts): per company, in `meta` under PRINT_TEMPLATES_META_KEY
 * as a versioned PrintTemplateStore JSON. Built-in templates live in code; the store only holds
 * customised copies of them (reset = drop the copy) plus user templates. The Classic built-in is
 * derived from the legacy `meta.invoice` InvoiceConfig until it is first customised, so existing
 * companies print exactly as before (legacyConfigToTemplate is lossless — templateToLegacyConfig
 * round-trips it; see printTemplates.test.ts).
 *
 * Versioning: every leaf has a .default(), so a template stored by an older build (missing newer
 * fields) still parses; `schemaVersion` is bumped only for breaking reshapes, with an upgrade step
 * in parseStoredTemplate.
 */

export const PRINT_TEMPLATE_SCHEMA_VERSION = 1
export const PRINT_TEMPLATES_META_KEY = 'printTemplates'

// ---------------------------------------------------------------- document kinds

/** Document kinds a template can apply to. Extensible: append new kinds at the end (stored
 *  templates keep parsing — titles default per kind). `delivery_challan` prints delivery notes
 *  and `goods_receipt` receipt notes (WP 2.5b); `quotation`, `sales_order` and `purchase_order`
 *  print the trade documents (WP 2.5c). */
export const PRINT_DOC_KINDS = [
  'sales', 'credit_note', 'debit_note', 'purchase', 'receipt', 'payment', 'journal', 'contra',
  'delivery_challan', 'quotation', 'goods_receipt', 'sales_order', 'purchase_order',
  // WP 3.4 — the reverse-charge self-invoice (s.31(3)(f) CGST Act) raised on a purchase from an
  // unregistered supplier; printed from services/gstRcm.ts, not from a voucher kind.
  'self_invoice',
  // WP 4.2 — receivables: the statement of account and the payment-reminder letter. Party
  // documents, not vouchers (printed by services/receivables.ts); never a voucher kind's form.
  'statement', 'reminder'
] as const
export type PrintDocKind = (typeof PRINT_DOC_KINDS)[number]
export const printDocKindSchema = z.enum(PRINT_DOC_KINDS)

/** Kinds rendered with the item-table (invoice) layout; the rest print as an accounting voucher
 *  (particulars / debit / credit). */
export const INVOICE_SHAPED_KINDS: readonly PrintDocKind[] = [
  'sales', 'credit_note', 'debit_note', 'delivery_challan', 'quotation', 'goods_receipt', 'sales_order', 'purchase_order', 'self_invoice'
]
/** Kinds not printable yet (the designer hides them). Empty since WP 2.5c made quotations live. */
export const PHASE2_KINDS: readonly PrintDocKind[] = []
/** Stock notes (WP 2.5b): goods only — no tax-invoice wording, no outstanding, no IRN / bank QR. */
export const STOCK_NOTE_PRINT_KINDS: readonly PrintDocKind[] = ['delivery_challan', 'goods_receipt']
/** Quotations and orders (WP 2.5c): commercial documents, not tax documents — no IRN / payment QR,
 *  no outstanding, no invoice declaration; validity / expected date and the document's terms print. */
export const TRADE_DOC_PRINT_KINDS: readonly PrintDocKind[] = ['quotation', 'sales_order', 'purchase_order']
/** WP 4.2: party documents — the statement of account and the reminder letter (no items, no tax). */
export const PARTY_DOC_PRINT_KINDS: readonly PrintDocKind[] = ['statement', 'reminder']

export const PRINT_DOC_KIND_LABELS: Record<PrintDocKind, string> = {
  sales: 'Sales invoice',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
  purchase: 'Purchase voucher',
  receipt: 'Receipt voucher',
  payment: 'Payment voucher',
  journal: 'Journal voucher',
  contra: 'Contra voucher',
  delivery_challan: 'Delivery challan',
  quotation: 'Quotation',
  goods_receipt: 'Goods receipt note',
  sales_order: 'Sales order',
  purchase_order: 'Purchase order',
  self_invoice: 'Self invoice (reverse charge)',
  statement: 'Statement of account',
  reminder: 'Payment reminder'
}

export const DEFAULT_TITLES: Record<PrintDocKind, string> = {
  sales: 'TAX INVOICE',
  credit_note: 'CREDIT NOTE',
  debit_note: 'DEBIT NOTE',
  purchase: 'PURCHASE VOUCHER',
  receipt: 'RECEIPT',
  payment: 'PAYMENT VOUCHER',
  journal: 'JOURNAL VOUCHER',
  contra: 'CONTRA VOUCHER',
  delivery_challan: 'DELIVERY CHALLAN',
  quotation: 'QUOTATION',
  goods_receipt: 'GOODS RECEIPT NOTE',
  sales_order: 'SALES ORDER',
  purchase_order: 'PURCHASE ORDER',
  self_invoice: 'SELF INVOICE',
  statement: 'STATEMENT OF ACCOUNT',
  reminder: 'PAYMENT REMINDER'
}

/** Voucher kinds whose print kind has another name. */
const PRINT_KIND_OF_VOUCHER_KIND: Record<string, PrintDocKind> = {
  delivery_note: 'delivery_challan',
  receipt_note: 'goods_receipt'
}

/** Map a books voucher kind onto the print kind (null = not printable). */
export function printKindForVoucherKind(kind: string): PrintDocKind | null {
  if (PRINT_KIND_OF_VOUCHER_KIND[kind]) return PRINT_KIND_OF_VOUCHER_KIND[kind]!
  // The print kinds that are not voucher kinds are never matched by name.
  // Quotations and orders are trade documents, not vouchers (printed by loadTradeDocPrint).
  if (kind === 'delivery_challan' || kind === 'goods_receipt' || TRADE_DOC_PRINT_KINDS.includes(kind as PrintDocKind)) return null
  // A self-invoice is a separate document ON a purchase voucher, never the voucher's own form.
  if (kind === 'self_invoice') return null
  // WP 4.2: statements and reminders are party documents.
  if (PARTY_DOC_PRINT_KINDS.includes(kind as PrintDocKind)) return null
  return (PRINT_DOC_KINDS as readonly string[]).includes(kind) ? (kind as PrintDocKind) : null
}

/** Rule 55(2) CGST Rules: a delivery challan is prepared in triplicate. Used for the challan when
 *  the template still has the invoice's single default label. */
export const CHALLAN_COPY_LABELS = ['Original for Consignee', 'Duplicate for Transporter', 'Triplicate for Consigner'] as const

// ---------------------------------------------------------------- columns

export const PRINT_COLUMN_KEYS = [
  'sl', 'item', 'description', 'hsn', 'barcode', 'qty', 'unit', 'rate', 'discount', 'taxable',
  'gstRate', 'cgst', 'sgst', 'igst', 'cess', 'amount'
] as const
export type PrintColumnKey = (typeof PRINT_COLUMN_KEYS)[number]

export interface PrintColumnDef {
  /** Default header text. */
  label: string
  /** Designer-facing name (the header text is editable). */
  name: string
  align: 'l' | 'c' | 'r'
  /** Tabular/monospace number styling (`.num`). */
  num: boolean
  /** Default width in CSS px; null = take the remaining space. */
  width: number | null
}

export const PRINT_COLUMN_DEFS: Record<PrintColumnKey, PrintColumnDef> = {
  sl: { name: 'Serial no.', label: '#', align: 'c', num: false, width: 34 },
  item: { name: 'Item', label: 'Description', align: 'l', num: false, width: null },
  description: { name: 'Item description', label: 'Details', align: 'l', num: false, width: null },
  hsn: { name: 'HSN/SAC', label: 'HSN', align: 'c', num: true, width: 80 },
  barcode: { name: 'Barcode', label: 'Barcode', align: 'c', num: true, width: 100 },
  qty: { name: 'Quantity', label: 'Qty', align: 'r', num: true, width: 90 },
  unit: { name: 'Unit', label: 'Unit', align: 'c', num: false, width: 50 },
  rate: { name: 'Rate', label: 'Rate', align: 'r', num: true, width: 100 },
  discount: { name: 'Discount', label: 'Discount', align: 'r', num: true, width: 80 },
  taxable: { name: 'Taxable value', label: 'Amount', align: 'r', num: true, width: 110 },
  gstRate: { name: 'GST rate', label: 'GST', align: 'c', num: true, width: 60 },
  cgst: { name: 'CGST amount', label: 'CGST', align: 'r', num: true, width: 80 },
  sgst: { name: 'SGST amount', label: 'SGST', align: 'r', num: true, width: 80 },
  igst: { name: 'IGST amount', label: 'IGST', align: 'r', num: true, width: 80 },
  cess: { name: 'Cess amount', label: 'Cess', align: 'r', num: true, width: 70 },
  amount: { name: 'Line total (incl. tax)', label: 'Total', align: 'r', num: true, width: 110 }
}

export interface PrintColumn {
  key: PrintColumnKey
  label: string
  /** CSS px; null = auto (shares the remaining width). */
  width: number | null
  visible: boolean
}

// ---------------------------------------------------------------- template shape

export const PAGE_SIZES = ['A4', 'A5', 'Letter', 'Roll80'] as const
export type PageSize = (typeof PAGE_SIZES)[number]
/** Page dimensions in mm (portrait). Roll80 (WP 2.6) is 80 mm thermal roll paper: the PDF's
 *  height follows the content (pdfOptionsFor); 200 mm is the designer preview's sheet. */
export const PAGE_MM: Record<PageSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  Letter: { w: 215.9, h: 279.4 },
  Roll80: { w: 80, h: 200 }
}

/** 'receipt' (WP 2.6): the narrow till-receipt layout for thermal printers. */
export const PRINT_STYLES = ['classic', 'compact', 'modern', 'receipt'] as const
export type PrintStyle = (typeof PRINT_STYLES)[number]

export const FONT_FAMILIES = ['helvetica', 'plex-sans', 'plex-serif', 'system-sans', 'system-serif'] as const
export type FontFamilyKey = (typeof FONT_FAMILIES)[number]
export const FONT_LABELS: Record<FontFamilyKey, string> = {
  helvetica: 'Helvetica / Arial (Classic)',
  'plex-sans': 'IBM Plex Sans',
  'plex-serif': 'IBM Plex Serif',
  'system-sans': 'System sans-serif',
  'system-serif': 'System serif'
}
export const NUMBER_FONTS = ['mono', 'plex-mono', 'body'] as const
export type NumberFontKey = (typeof NUMBER_FONTS)[number]
export const NUMBER_FONT_LABELS: Record<NumberFontKey, string> = {
  mono: 'SF Mono / Menlo (Classic)',
  'plex-mono': 'IBM Plex Mono',
  body: 'Same as text (tabular figures)'
}

/** ~200KB of base64 — same cap as the legacy invoice config logo. */
const MAX_LOGO_DATA_URL_LEN = 280_000
const logoSchema = z
  .string()
  .max(MAX_LOGO_DATA_URL_LEN, 'Logo image is too large (max ~200KB)')
  .regex(/^data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+$/i, 'Logo must be an image data URL')
  .nullable()

const mm = z.number().min(0).max(40)
const text = (max: number, def: string) => z.string().trim().max(max).default(def)

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a 6-digit hex like #16181f')

const titlesSchema = z.object(
  Object.fromEntries(PRINT_DOC_KINDS.map((k) => [k, z.string().trim().min(1).max(80).default(DEFAULT_TITLES[k])])) as {
    [K in PrintDocKind]: z.ZodDefault<z.ZodString>
  }
)

const columnSchema = z.object({
  key: z.enum(PRINT_COLUMN_KEYS),
  label: z.string().trim().max(30),
  width: z.number().int().min(20).max(400).nullable(),
  visible: z.boolean()
})

const bankSchema = z.object({
  name: z.string().trim().max(120),
  account: z.string().trim().max(40),
  ifsc: z.string().trim().max(20),
  branch: z.string().trim().max(120)
})

/** Normalise a column list: unknown/duplicate keys dropped, every known key present exactly once
 *  (missing ones appended hidden with their defaults) — so adding a column key later never breaks
 *  a stored template. */
export function normaliseColumns(cols: PrintColumn[]): PrintColumn[] {
  const seen = new Set<PrintColumnKey>()
  const out: PrintColumn[] = []
  for (const c of cols) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    out.push(c)
  }
  for (const key of PRINT_COLUMN_KEYS) {
    if (!seen.has(key)) out.push({ key, label: PRINT_COLUMN_DEFS[key].label, width: PRINT_COLUMN_DEFS[key].width, visible: false })
  }
  return out
}

export const printTemplateSchema = z.object({
  schemaVersion: z.literal(PRINT_TEMPLATE_SCHEMA_VERSION).default(PRINT_TEMPLATE_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'Template id must be lowercase letters, digits and dashes'),
  name: z.string().trim().min(1, 'Template name is required').max(60),
  builtIn: z.boolean().default(false),
  /** Visual style the renderer's CSS follows. */
  style: z.enum(PRINT_STYLES).default('classic'),
  kinds: z.array(printDocKindSchema).min(1, 'Pick at least one document kind').max(PRINT_DOC_KINDS.length).default(['sales', 'credit_note', 'debit_note']),
  page: z
    .object({
      size: z.enum(PAGE_SIZES).default('A4'),
      orientation: z.enum(['portrait', 'landscape']).default('portrait'),
      marginsMm: z
        .object({ top: mm.default(10), right: mm.default(10), bottom: mm.default(10), left: mm.default(10) })
        .default({}),
      /** "Page x of y" footer (drawn by the PDF engine in the bottom margin). */
      pageNumbers: z.boolean().default(true)
    })
    .default({}),
  header: z
    .object({
      showLogo: z.boolean().default(true),
      logoDataUrl: logoSchema.default(null),
      logoPosition: z.enum(['left', 'center', 'right']).default('left'),
      logoMaxHeightPx: z.number().int().min(20).max(160).default(60),
      logoMaxWidthPx: z.number().int().min(40).max(400).default(220),
      showAddress: z.boolean().default(true),
      showGstin: z.boolean().default(true),
      showState: z.boolean().default(true),
      showPan: z.boolean().default(false),
      showCin: z.boolean().default(false),
      cin: text(30, ''),
      showPhone: z.boolean().default(false),
      showEmail: z.boolean().default(false),
      showWebsite: z.boolean().default(false),
      website: text(120, ''),
      titles: titlesSchema.default({}),
      /** One printed copy per label, e.g. Original for Recipient / Duplicate for Transporter. */
      copyLabels: z.array(z.string().trim().min(1).max(40)).min(1).max(3).default(['Original for Recipient'])
    })
    .default({}),
  party: z
    .object({
      billToLabel: text(40, 'Billed to'),
      showAddress: z.boolean().default(true),
      showGstin: z.boolean().default(true),
      showState: z.boolean().default(false),
      showShipTo: z.boolean().default(false),
      shipToLabel: text(40, 'Shipped to'),
      showPlaceOfSupply: z.boolean().default(true),
      showVehicle: z.boolean().default(true)
    })
    .default({}),
  columns: z.array(columnSchema).max(40).default([]).transform(normaliseColumns),
  table: z
    .object({
      /** Items per printed page before a carried-forward/brought-forward subtotal split; 0 = let
       *  the print engine break the table naturally (header row still repeats). */
      carryForwardEvery: z.number().int().min(0).max(200).default(16)
    })
    .default({}),
  totals: z
    .object({
      taxSummary: z.enum(['hsn', 'rate', 'none']).default('hsn'),
      showRoundOff: z.boolean().default(true),
      showAmountInWords: z.boolean().default(true),
      /** Party's ledger balance as on the document date, under the total. */
      showOutstanding: z.boolean().default(false)
    })
    .default({}),
  footer: z
    .object({
      declaration: text(1000, DEFAULT_INVOICE_CONFIG.declaration),
      terms: text(2000, ''),
      bankDetails: bankSchema.nullable().default(null),
      showSignature: z.boolean().default(true),
      signatureLabel: text(80, 'Authorised Signatory'),
      showReceiverSignature: z.boolean().default(true),
      receiverLabel: text(60, "Receiver's signature"),
      showComputerGenerated: z.boolean().default(false),
      computerGeneratedText: text(160, 'This is a computer-generated document.'),
      showEnteredBy: z.boolean().default(false)
    })
    .default({}),
  einvoice: z
    .object({
      showQr: z.boolean().default(true),
      qrPlacement: z.enum(['header', 'footer']).default('header'),
      qrSizeMm: z.number().min(16).max(50).default(28),
      /** IRN / Ack no. / Ack date line when the voucher has been e-invoiced. */
      showIrn: z.boolean().default(true),
      /** e-Way bill number when one has been generated. */
      showEwb: z.boolean().default(true)
    })
    .default({}),
  formats: z
    .object({
      date: z.enum(DOC_DATE_FORMATS).default('dd-mmm-yy'),
      number: z.enum(['indian', 'plain']).default('indian'),
      currencySymbolOnTotal: z.boolean().default(true)
    })
    .default({}),
  typography: z
    .object({
      fontFamily: z.enum(FONT_FAMILIES).default('helvetica'),
      numberFont: z.enum(NUMBER_FONTS).default('mono'),
      baseFontPx: z.number().min(8).max(16).multipleOf(0.5).default(12),
      accent: hexColorSchema.default('#16181f')
    })
    .default({})
})

export type PrintTemplate = z.output<typeof printTemplateSchema>
export type PrintTemplateInput = z.input<typeof printTemplateSchema>

// ---------------------------------------------------------------- built-ins

export const BUILT_IN_IDS = ['classic', 'compact', 'modern', 'receipt-80mm'] as const
export type BuiltInId = (typeof BUILT_IN_IDS)[number]
export const isBuiltInId = (id: string): id is BuiltInId => (BUILT_IN_IDS as readonly string[]).includes(id)

const ALL_INVOICE_KINDS: PrintDocKind[] = ['sales', 'credit_note', 'debit_note']
const ALL_KINDS: PrintDocKind[] = [...PRINT_DOC_KINDS]

function cols(spec: [PrintColumnKey, Partial<Omit<PrintColumn, 'key'>>?][]): PrintColumn[] {
  return normaliseColumns(
    spec.map(([key, o]) => ({
      key,
      label: o?.label ?? PRINT_COLUMN_DEFS[key].label,
      width: o?.width === undefined ? PRINT_COLUMN_DEFS[key].width : o.width,
      visible: o?.visible ?? true
    }))
  )
}

/** Classic column set for a legacy config: today's order, widths and header texts exactly. */
function classicColumns(cfg: Pick<InvoiceConfig, 'showHsn' | 'showItemBarcode' | 'showDiscount'>): PrintColumn[] {
  return cols([
    ['sl'], ['item'], ['hsn', { visible: cfg.showHsn }], ['barcode', { visible: cfg.showItemBarcode }],
    ['qty'], ['rate'], ['discount', { visible: cfg.showDiscount }], ['gstRate'], ['taxable']
  ])
}

/**
 * Legacy InvoiceConfig → Classic template. Lossless: every config field lands in exactly one
 * template field (templateToLegacyConfig reverses it), and the Classic style renders it as the old
 * buildInvoiceHtml did. Credit/debit notes get their proper titles (the old renderer printed the
 * sales title on notes too — the one intentional change).
 */
export function legacyConfigToTemplate(cfg: InvoiceConfig): PrintTemplate {
  return printTemplateSchema.parse({
    id: 'classic',
    name: 'Classic',
    builtIn: true,
    style: 'classic',
    kinds: ALL_KINDS,
    header: {
      logoDataUrl: cfg.logoDataUrl,
      titles: { sales: cfg.title },
      copyLabels: cfg.copyLabels
    },
    columns: classicColumns(cfg),
    totals: { taxSummary: cfg.showHsn ? 'hsn' : 'none' },
    footer: {
      declaration: cfg.declaration,
      terms: cfg.terms,
      bankDetails: cfg.bankDetails,
      signatureLabel: cfg.signatory,
      showEnteredBy: cfg.showEnteredBy
    },
    einvoice: { showQr: cfg.showQr }
  } satisfies PrintTemplateInput)
}

const colVisible = (t: PrintTemplate, key: PrintColumnKey): boolean => t.columns.some((c) => c.key === key && c.visible)

/** Classic template → legacy InvoiceConfig, for the old `config:invoice:get` channel. */
export function templateToLegacyConfig(t: PrintTemplate): InvoiceConfig {
  return {
    title: t.header.titles.sales,
    logoDataUrl: t.header.logoDataUrl,
    declaration: t.footer.declaration,
    bankDetails: t.footer.bankDetails,
    signatory: t.footer.signatureLabel,
    terms: t.footer.terms,
    showHsn: colVisible(t, 'hsn'),
    showDiscount: colVisible(t, 'discount'),
    copyLabels: [...t.header.copyLabels],
    showQr: t.einvoice.showQr,
    showItemBarcode: colVisible(t, 'barcode'),
    showEnteredBy: t.footer.showEnteredBy
  }
}

/** Apply a legacy config write (`config:invoice:set`) onto the current Classic template, keeping
 *  every template-only setting the old config has no field for. */
export function applyLegacyConfig(t: PrintTemplate, cfg: InvoiceConfig): PrintTemplate {
  const columns = t.columns.map((c) =>
    c.key === 'hsn' ? { ...c, visible: cfg.showHsn }
      : c.key === 'discount' ? { ...c, visible: cfg.showDiscount }
        : c.key === 'barcode' ? { ...c, visible: cfg.showItemBarcode }
          : c
  )
  // The old config tied the HSN summary to the HSN column; a by-rate summary choice survives.
  const current = t.totals.taxSummary
  const taxSummary = cfg.showHsn ? (current === 'none' ? 'hsn' : current) : current === 'hsn' ? 'none' : current
  return printTemplateSchema.parse({
    ...t,
    header: { ...t.header, logoDataUrl: cfg.logoDataUrl, titles: { ...t.header.titles, sales: cfg.title }, copyLabels: [...cfg.copyLabels] },
    columns,
    totals: { ...t.totals, taxSummary },
    footer: {
      ...t.footer,
      declaration: cfg.declaration,
      terms: cfg.terms,
      bankDetails: cfg.bankDetails,
      signatureLabel: cfg.signatory,
      showEnteredBy: cfg.showEnteredBy
    },
    einvoice: { ...t.einvoice, showQr: cfg.showQr }
  })
}

export const CLASSIC_DEFAULT: PrintTemplate = legacyConfigToTemplate(DEFAULT_INVOICE_CONFIG)

export const COMPACT_DEFAULT: PrintTemplate = printTemplateSchema.parse({
  id: 'compact',
  name: 'Compact',
  builtIn: true,
  style: 'compact',
  kinds: ALL_KINDS,
  page: { marginsMm: { top: 8, right: 8, bottom: 10, left: 8 } },
  header: { logoMaxHeightPx: 40, logoMaxWidthPx: 160, showPhone: true, showEmail: true },
  party: { showState: true },
  columns: cols([
    ['sl', { width: 24 }], ['item'], ['hsn', { width: 56 }], ['qty', { width: 50 }], ['unit', { width: 38 }],
    ['rate', { width: 80 }], ['discount', { width: 72 }], ['taxable', { label: 'Taxable', width: 86 }],
    ['gstRate', { width: 40 }], ['amount', { width: 90 }]
  ]),
  table: { carryForwardEvery: 0 },
  totals: { taxSummary: 'rate' },
  footer: { showComputerGenerated: true },
  einvoice: { qrSizeMm: 22 },
  typography: { fontFamily: 'plex-sans', numberFont: 'plex-mono', baseFontPx: 10, accent: '#222222' }
} satisfies PrintTemplateInput)

export const MODERN_DEFAULT: PrintTemplate = printTemplateSchema.parse({
  id: 'modern',
  name: 'Modern',
  builtIn: true,
  style: 'modern',
  kinds: ALL_KINDS,
  page: { marginsMm: { top: 12, right: 12, bottom: 14, left: 12 } },
  header: { logoPosition: 'left', showPhone: true, showEmail: true, showPan: true },
  party: { showState: true, showShipTo: true },
  columns: cols([
    ['sl', { width: 30 }], ['item', { label: 'Item' }], ['hsn', { label: 'HSN/SAC', width: 70 }], ['qty', { width: 70 }],
    ['rate', { width: 84 }], ['discount', { width: 70 }], ['gstRate', { width: 48 }],
    ['taxable', { label: 'Taxable', width: 96 }]
  ]),
  table: { carryForwardEvery: 0 },
  totals: { taxSummary: 'rate' },
  footer: { showComputerGenerated: true },
  einvoice: { qrPlacement: 'footer', qrSizeMm: 26 },
  formats: { date: 'd mmmm yyyy' },
  typography: { fontFamily: 'plex-sans', numberFont: 'body', baseFontPx: 11, accent: '#1f4f78' }
} satisfies PrintTemplateInput)

/** WP 2.6 — "Receipt 80mm": the counter bill on 80 mm thermal roll paper (72 mm printable).
 *  Sales only; item / qty × rate / amount, the GST lines, round off, total and the payments. */
export const RECEIPT_80MM_DEFAULT: PrintTemplate = printTemplateSchema.parse({
  id: 'receipt-80mm',
  name: 'Receipt 80mm',
  builtIn: true,
  style: 'receipt',
  kinds: ['sales'],
  page: { size: 'Roll80', marginsMm: { top: 3, right: 4, bottom: 4, left: 4 }, pageNumbers: false },
  header: { showLogo: true, logoMaxHeightPx: 36, logoMaxWidthPx: 140, logoPosition: 'center', showPhone: true, copyLabels: ['Customer copy'] },
  party: { showAddress: false, showPlaceOfSupply: false, showVehicle: false },
  columns: cols([['item'], ['qty'], ['rate'], ['discount'], ['taxable', { label: 'Amount' }]]),
  table: { carryForwardEvery: 0 },
  totals: { taxSummary: 'rate', showAmountInWords: false },
  footer: {
    declaration: '', showSignature: false, showReceiverSignature: false, showComputerGenerated: true,
    computerGeneratedText: 'Thank you. Please visit again.'
  },
  einvoice: { showQr: false, showIrn: true, showEwb: false },
  formats: { date: 'dd-mmm-yy', currencySymbolOnTotal: true },
  typography: { fontFamily: 'system-sans', numberFont: 'body', baseFontPx: 9, accent: '#000000' }
} satisfies PrintTemplateInput)

export const BUILT_IN_DEFAULTS: Record<BuiltInId, PrintTemplate> = {
  classic: CLASSIC_DEFAULT,
  compact: COMPACT_DEFAULT,
  modern: MODERN_DEFAULT,
  'receipt-80mm': RECEIPT_80MM_DEFAULT
}

// ---------------------------------------------------------------- store

/** template:list row. */
export interface TemplateSummary {
  id: string
  name: string
  builtIn: boolean
  style: PrintStyle
  kinds: PrintDocKind[]
  /** Built-in with saved customisations (Reset is meaningful). */
  customised: boolean
}

export interface TemplateList {
  templates: TemplateSummary[]
  /** Effective default template id for every kind (Classic when unset). */
  defaults: Record<PrintDocKind, string>
}

export const MAX_CUSTOM_TEMPLATES = 20

export const printTemplateStoreSchema = z.object({
  version: z.literal(1).default(1),
  /** Customised built-ins (same id as the built-in) + user templates. */
  templates: z.array(z.unknown()).default([]),
  /** Default template id per document kind; a missing kind falls back to Classic. */
  defaults: z.record(z.string(), z.string()).default({})
})
export interface PrintTemplateStore {
  version: 1
  templates: PrintTemplate[]
  defaults: Partial<Record<PrintDocKind, string>>
}

/** Parse one stored template, tolerating older shapes (defaults fill missing fields). Returns null
 *  when it's beyond repair — the store drops it rather than failing every print. */
export function parseStoredTemplate(raw: unknown): PrintTemplate | null {
  const r = printTemplateSchema.safeParse(raw)
  return r.success ? r.data : null
}

export function parseStore(raw: unknown): PrintTemplateStore {
  const r = printTemplateStoreSchema.safeParse(raw ?? {})
  const base = r.success ? r.data : { version: 1 as const, templates: [], defaults: {} }
  const templates = base.templates.map(parseStoredTemplate).filter((t): t is PrintTemplate => t !== null)
  const defaults: Partial<Record<PrintDocKind, string>> = {}
  for (const [k, v] of Object.entries(base.defaults)) {
    if ((PRINT_DOC_KINDS as readonly string[]).includes(k) && typeof v === 'string') defaults[k as PrintDocKind] = v
  }
  return { version: 1, templates, defaults }
}

/** Import a template from exported JSON: validated, given a fresh id, never built-in. */
export const templateExportSchema = z.object({
  format: z.literal('total-print-template'),
  version: z.number().int(),
  template: z.unknown()
})

export function exportTemplateJson(t: PrintTemplate): string {
  return JSON.stringify({ format: 'total-print-template', version: PRINT_TEMPLATE_SCHEMA_VERSION, template: t }, null, 2)
}

/** Parse exported JSON (or a bare template object) into a template; throws a readable error. */
export function parseTemplateImport(jsonText: string): PrintTemplate {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    throw new Error('Not a JSON file')
  }
  const wrapped = templateExportSchema.safeParse(raw)
  const candidate = wrapped.success ? wrapped.data.template : raw
  const r = printTemplateSchema.safeParse(candidate)
  if (!r.success) throw new Error(`Not a valid print template: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return r.data
}

/** Roll paper height for a receipt (mm): a fixed head/foot plus a band per item line — the
 *  thermal printer cuts after the content, so a generous estimate only feeds blank paper. */
export function rollHeightMm(itemCount: number): number {
  return Math.min(2000, 120 + 10 * Math.max(1, itemCount))
}

/** PDF engine options for a template (consumed by src/main/services/pdf.ts). Roll80 becomes a
 *  custom 80 mm page (INCHES, as printToPDF takes custom sizes) as tall as the content needs. */
export function pdfOptionsFor(t: PrintTemplate, opts: { itemCount?: number } = {}): {
  pageSize: Exclude<PageSize, 'Roll80'> | { width: number; height: number }
  landscape: boolean
  marginsMm: { top: number; right: number; bottom: number; left: number }
  pageNumbers: boolean
} {
  const pageSize = t.page.size === 'Roll80' ? { width: 80 / 25.4, height: rollHeightMm(opts.itemCount ?? 1) / 25.4 } : t.page.size
  return {
    pageSize, landscape: t.page.size !== 'Roll80' && t.page.orientation === 'landscape', marginsMm: { ...t.page.marginsMm },
    pageNumbers: t.page.size !== 'Roll80' && t.page.pageNumbers
  }
}
