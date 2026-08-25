/**
 * Invoice print templates (roadmap I-182, "two or three genuinely beautiful invoice templates").
 *
 * One HTML skeleton, three stylesheets. The markup `buildInvoiceHtml` emits is fixed — every
 * template styles the SAME class names — because an invoice is a statutory document before it is
 * a design: the blocks it must carry (supplier, recipient, HSN, tax split, signature) are
 * prescribed by rule 46 of the CGST Rules, and a template that could rearrange or drop them would
 * be a template that could produce an invalid invoice. So a template may change type, rule weight,
 * density and colour, and may not change what is on the page.
 *
 * Pure data — no DOM, no Electron — so one string feeds both the PDF renderer and the live
 * preview iframe in Settings, and a template can be diffed in a unit test.
 */

export type InvoiceTemplateId = 'classic' | 'modern' | 'compact'

export interface InvoiceTemplate {
  id: InvoiceTemplateId
  label: string
  /** One line, shown under the picker — what the template is FOR, not what it looks like. */
  description: string
}

export const INVOICE_TEMPLATES: InvoiceTemplate[] = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'Ruled boxes and heavy borders, the way a Tally invoice has always looked.'
  },
  {
    id: 'modern',
    label: 'Modern',
    description: 'Hairline rules and open space. Reads well on screen and as a PDF attachment.'
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Tighter type and rows, so an invoice with many lines still lands on one page.'
  }
]

export const DEFAULT_INVOICE_TEMPLATE: InvoiceTemplateId = 'classic'

/**
 * The original, byte for byte what the app printed before templates existed — so upgrading
 * cannot silently restyle anybody's stationery.
 */
const CLASSIC_CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.45 'Helvetica Neue', Arial, sans-serif; color: #16181f; }
    .num { font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    .copy { padding: 28px; page-break-after: always; }
    .copy:last-child { page-break-after: auto; }
    .copy-label { text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 6px; }
    .sheet { border: 1.5px solid #16181f; position: relative; }
    .head { display: flex; justify-content: space-between; border-bottom: 1.5px solid #16181f; padding: 14px 16px; }
    h1 { font-size: 20px; letter-spacing: 0.02em; }
    .tag { text-align: right; font-size: 11px; }
    .tag b { font-size: 14px; letter-spacing: 0.12em; }
    /* Statutory endorsements. Rule 5(1)(f) wants the composition line at the TOP of the
       document, so this sits directly under the header band and above the party block. */
    .endorse { padding: 6px 16px; border-bottom: 1.5px solid #16181f; font-size: 10.5px;
               font-weight: 600; letter-spacing: 0.02em; }
    .meta { display: flex; border-bottom: 1.5px solid #16181f; }
    .meta > div { flex: 1; padding: 10px 16px; }
    .meta > div + div { border-left: 1px solid #16181f; }
    .lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 2px; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #16181f; padding: 7px 8px; text-align: left; background: #f2f2ee; }
    table.items td { padding: 6px 8px; border-bottom: 1px dotted #999; vertical-align: top; }
    table.items.page-split { page-break-after: always; }
    table.items tr.cf td { font-weight: 700; border-bottom: 1px solid #16181f; }
    table.hsn { width: 100%; border-collapse: collapse; border-top: 1.5px solid #16181f; }
    table.hsn th { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #16181f; padding: 5px 8px; text-align: left; background: #f2f2ee; }
    table.hsn td { padding: 4px 8px; border-bottom: 1px dotted #999; }
    .audit-foot { padding: 4px 16px; border-top: 1px solid #16181f; font-size: 9px; color: #555; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; border-top: 1.5px solid #16181f; }
    .words { flex: 1; padding: 10px 16px; border-right: 1px solid #16181f; }
    /* The payment QR sits beside the totals, not next to the verification QR in the header:
       one says the document is genuine, the other collects money, and putting them together
       invites scanning the wrong one. */
    /* Behind the content, not over it: a watermark that obscures the figures makes the document
       unreadable, and the point is that it cannot be mistaken for the real thing — not that it
       cannot be read. Anchored by the position: relative on .sheet above. */
    .watermark {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 96px; font-weight: 700; letter-spacing: 0.2em; color: rgba(187, 68, 51, 0.08);
      transform: rotate(-24deg); pointer-events: none; z-index: 0;
    }
    .tot-wrap { display: flex; align-items: flex-start; gap: 14px; }
    .upi { text-align: center; }
    .upi-cap { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #555; margin-top: 2px; }
    .upi-vpa { font-size: 8.5px; color: #555; }
    table.tot { width: 260px; border-collapse: collapse; }
    table.tot td { padding: 5px 12px; }
    table.tot tr.grand td { border-top: 1px solid #16181f; border-bottom: 3px double #16181f; font-weight: 700; font-size: 13px; }
    .sig { display: flex; justify-content: space-between; padding: 26px 16px 12px; border-top: 1.5px solid #16181f; font-size: 11px; }
    .sig .for { text-align: right; }
`

/**
 * Modern: the same document with the ink taken out of it.
 *
 * The heavy cage around every block is a dot-matrix inheritance — it is there because a ribbon
 * printer could not render a hairline at all. A PDF can, and a document that is mostly emailed
 * reads better with its structure carried by space and one accent rule than by boxes. Type sizes
 * are NOT reduced: the figures still have to survive a photocopy of a fax.
 */
const MODERN_CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 12px/1.5 'Helvetica Neue', Arial, sans-serif; color: #1c1e26; }
    .num { font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
    .copy { padding: 30px; page-break-after: always; }
    .copy:last-child { page-break-after: auto; }
    .copy-label { text-align: right; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.14em; color: #8a8f9c; margin-bottom: 10px; }
    .sheet { border: 0; position: relative; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1c1e26; padding: 0 0 16px; }
    h1 { font-size: 23px; font-weight: 600; letter-spacing: -0.01em; }
    .tag { text-align: right; font-size: 11px; }
    .tag b { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: #8a8f9c; font-weight: 600; }
    .endorse { padding: 8px 0; border-bottom: 1px solid #e3e4e8; font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em; }
    .meta { display: flex; border-bottom: 1px solid #e3e4e8; }
    .meta > div { flex: 1; padding: 14px 0; }
    .meta > div + div { border-left: 0; padding-left: 24px; }
    .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; color: #8a8f9c; margin-bottom: 3px; }
    table.items { width: 100%; border-collapse: collapse; margin-top: 4px; }
    table.items th { font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; color: #8a8f9c; border-bottom: 1px solid #1c1e26; padding: 9px 8px 6px; text-align: left; background: transparent; }
    table.items td { padding: 8px; border-bottom: 1px solid #eeeff2; vertical-align: top; }
    table.items.page-split { page-break-after: always; }
    table.items tr.cf td { font-weight: 600; border-bottom: 1px solid #1c1e26; color: #8a8f9c; }
    table.hsn { width: 100%; border-collapse: collapse; border-top: 1px solid #e3e4e8; margin-top: 14px; }
    table.hsn th { font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; color: #8a8f9c; border-bottom: 1px solid #e3e4e8; padding: 7px 8px 5px; text-align: left; background: transparent; }
    table.hsn td { padding: 5px 8px; border-bottom: 1px solid #f4f5f7; }
    .audit-foot { padding: 6px 0 0; border-top: 1px solid #eeeff2; font-size: 9px; color: #8a8f9c; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; border-top: 1px solid #1c1e26; margin-top: 4px; gap: 28px; }
    .words { flex: 1; padding: 14px 0; border-right: 0; }
    .watermark {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 96px; font-weight: 700; letter-spacing: 0.2em; color: rgba(187, 68, 51, 0.08);
      transform: rotate(-24deg); pointer-events: none; z-index: 0;
    }
    .tot-wrap { display: flex; align-items: flex-start; gap: 14px; padding-top: 14px; }
    .upi { text-align: center; }
    .upi-cap { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #8a8f9c; margin-top: 3px; }
    .upi-vpa { font-size: 8.5px; color: #8a8f9c; }
    table.tot { width: 260px; border-collapse: collapse; }
    table.tot td { padding: 5px 0 5px 12px; }
    table.tot tr.grand td { border-top: 1px solid #1c1e26; border-bottom: 0; font-weight: 700; font-size: 15px; padding-top: 8px; }
    .sig { display: flex; justify-content: space-between; padding: 30px 0 0; border-top: 1px solid #eeeff2; margin-top: 18px; font-size: 11px; }
    .sig .for { text-align: right; }
`

/**
 * Compact: the same document, one type step down and one row of padding out.
 *
 * The reason is not aesthetic. A page break in the middle of a delivery is a second sheet handed
 * to the customer and a second sheet the transporter has to keep, so a wholesaler billing twenty
 * lines wants them on one page more than they want white space. Rules stay dark and figures stay
 * tabular: density must not cost legibility, or the saving is paid back at the counter when
 * somebody misreads a quantity.
 */
const COMPACT_CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font: 10.5px/1.32 'Helvetica Neue', Arial, sans-serif; color: #16181f; }
    .num { font-variant-numeric: tabular-nums; font-family: 'SF Mono', Menlo, monospace; font-size: 10px; }
    .copy { padding: 16px; page-break-after: always; }
    .copy:last-child { page-break-after: auto; }
    .copy-label { text-align: right; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 4px; }
    .sheet { border: 1px solid #16181f; position: relative; }
    .head { display: flex; justify-content: space-between; border-bottom: 1px solid #16181f; padding: 8px 10px; }
    h1 { font-size: 15px; letter-spacing: 0.01em; }
    .tag { text-align: right; font-size: 10px; }
    .tag b { font-size: 12px; letter-spacing: 0.1em; }
    .endorse { padding: 4px 10px; border-bottom: 1px solid #16181f; font-size: 9.5px; font-weight: 600; }
    .meta { display: flex; border-bottom: 1px solid #16181f; }
    .meta > div { flex: 1; padding: 6px 10px; }
    .meta > div + div { border-left: 1px solid #16181f; }
    .lbl { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.08em; color: #555; margin-bottom: 1px; }
    table.items { width: 100%; border-collapse: collapse; }
    table.items th { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #16181f; padding: 4px 6px; text-align: left; background: #f2f2ee; }
    table.items td { padding: 3px 6px; border-bottom: 1px dotted #aaa; vertical-align: top; }
    table.items.page-split { page-break-after: always; }
    table.items tr.cf td { font-weight: 700; border-bottom: 1px solid #16181f; }
    table.hsn { width: 100%; border-collapse: collapse; border-top: 1px solid #16181f; }
    table.hsn th { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #16181f; padding: 3px 6px; text-align: left; background: #f2f2ee; }
    table.hsn td { padding: 2px 6px; border-bottom: 1px dotted #aaa; }
    .audit-foot { padding: 3px 10px; border-top: 1px solid #16181f; font-size: 8.5px; color: #555; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    .r { text-align: right; } .c { text-align: center; }
    .bottom { display: flex; border-top: 1px solid #16181f; }
    .words { flex: 1; padding: 6px 10px; border-right: 1px solid #16181f; }
    .watermark {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 80px; font-weight: 700; letter-spacing: 0.2em; color: rgba(187, 68, 51, 0.08);
      transform: rotate(-24deg); pointer-events: none; z-index: 0;
    }
    .tot-wrap { display: flex; align-items: flex-start; gap: 10px; }
    .upi { text-align: center; }
    .upi-cap { font-size: 8px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin-top: 1px; }
    .upi-vpa { font-size: 8px; color: #555; }
    table.tot { width: 220px; border-collapse: collapse; }
    table.tot td { padding: 3px 8px; }
    table.tot tr.grand td { border-top: 1px solid #16181f; border-bottom: 3px double #16181f; font-weight: 700; font-size: 11.5px; }
    .sig { display: flex; justify-content: space-between; padding: 16px 10px 8px; border-top: 1px solid #16181f; font-size: 10px; }
    .sig .for { text-align: right; }
`

/**
 * The stylesheet for a template.
 *
 * An unknown id falls back to Classic rather than throwing. A config file written by a later
 * version of the app must still print, and printing yesterday's stationery is a better failure
 * than printing nothing at the moment somebody needs the invoice.
 */
export function invoiceTemplateCss(id: InvoiceTemplateId | string): string {
  switch (id) {
    case 'modern':
      return MODERN_CSS
    case 'compact':
      return COMPACT_CSS
    default:
      return CLASSIC_CSS
  }
}

/**
 * Every class name the invoice skeleton uses.
 *
 * Exported so a test can prove each template styles all of them: a template that forgets
 * `.endorse` silently drops a statutory line (the composition-dealer declaration, say) off the
 * printed page, and nobody notices until an officer does.
 */
export const INVOICE_TEMPLATE_CLASSES = [
  'num',
  'copy',
  'copy-label',
  'sheet',
  'head',
  'tag',
  'endorse',
  'meta',
  'lbl',
  'items',
  'hsn',
  'audit-foot',
  'bottom',
  'words',
  'watermark',
  'tot-wrap',
  'upi',
  'upi-cap',
  'upi-vpa',
  'tot',
  'sig'
] as const
