import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { EdocInvoice } from '@shared/gst/edocs'
import { mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
import { applyLegacyConfig, legacyConfigToTemplate, pdfOptionsFor } from '@shared/printTemplates'
import { renderDocument, type InvoiceAuditTrail } from '@shared/print/render'
import { taxSummaryForInvoice, type TaxSummaryRow } from '@shared/print/taxSummary'
import { companyExportsDir } from '../paths'
import {
  documentHtml,
  documentPdf,
  getLegacyConfigView,
  getTemplate,
  loadPrintDocument,
  pdfFileName
} from './printTemplates'
import { htmlToPdf } from './pdf'

/**
 * Invoice printing entry points. Since WP 1.10c every printout goes through the print-template
 * renderer (src/shared/print/render.ts) with the document kind's default template — see
 * services/printTemplates.ts. These wrappers keep the original function names/IPC behaviour.
 */

export type { InvoiceAuditTrail }
export type HsnSummaryRow = TaxSummaryRow

/** Hardcoded so the print-config preview (invoice:previewHtml with no voucherId) works with zero
 *  vouchers in the books — mirrors the shape extractEdocInvoices produces for a real one. Exported
 *  for invoice.test.ts (buildInvoiceHtml is pure — no DB — so it's tested directly there). */
export const SAMPLE_INVOICE: EdocInvoice = {
  number: 'SAMPLE-1',
  date: '2025-04-01',
  partyName: 'Sample Buyer Pvt Ltd',
  partyGstin: '27AAAAA0000A1Z5',
  partyAddress: '123 Sample Street, Sample City',
  partyStateCode: '27',
  pos: '27',
  items: [
    {
      name: 'Sample product', hsn: '8471', qtyMilli: 2000, uqc: 'NOS',
      unitPricePaise: 500000, taxablePaise: 1000000, rate: 18, cessRate: 0,
      cgst: 90000, sgst: 90000, igst: 0, cess: 0, isService: false, barcode: 'SAMPLE-BC-001'
    }
  ],
  taxable: 1000000,
  cgst: 90000,
  sgst: 90000,
  igst: 0,
  cess: 0,
  roundOff: 0,
  total: 1180000,
  transporterId: null,
  vehicleNo: null,
  distanceKm: null,
  irn: null
}


/** HSN-wise tax summary (task Q2 #96) — now taxSummaryForInvoice(inv, 'hsn') in src/shared. */
export function hsnSummaryForInvoice(inv: EdocInvoice, supplyHint?: 'inter' | 'intra'): HsnSummaryRow[] {
  return taxSummaryForInvoice(inv, 'hsn', supplyHint)
}

/** Items per printed page before the Classic table splits with carried-forward/brought-forward
 *  subtotal rows (task Q2 #95) — the Classic template's table.carryForwardEvery default. */
export const INVOICE_ITEMS_PER_PAGE = 16

/** Legacy-config renderer: the config mapped onto the Classic template, then the one renderer.
 *  Pure — kept for callers/tests that hold an InvoiceConfig. */
export function buildInvoiceHtml(company: CompanyInfo, config: InvoiceConfig, inv: EdocInvoice, audit?: InvoiceAuditTrail): string {
  return renderDocument(legacyConfigToTemplate(config), { shape: 'invoice', kind: 'sales', company, invoice: inv, audit })
}

/** Printed HTML for a voucher with its kind's default template. */
export function invoiceHtml(db: DB, company: CompanyInfo, voucherId: number): { html: string; number: string } {
  const { html, number } = documentHtml(db, company, voucherId)
  return { html, number }
}

/** invoice:previewHtml (legacy channel) — the current (unsaved) legacy config, merged over the
 *  saved one and folded into the Classic template, against a real voucher or the sample invoice. */
export function invoicePreviewHtml(
  db: DB,
  company: CompanyInfo,
  voucherId?: number,
  configOverride?: Partial<InvoiceConfig>
): { html: string } {
  const saved = getLegacyConfigView(db)
  const config = configOverride ? mergeInvoiceConfig({ ...saved, ...configOverride }) : saved
  const template = applyLegacyConfig(getTemplate(db, 'classic'), config)
  if (voucherId != null) {
    return { html: renderDocument(template, loadPrintDocument(db, company, voucherId)) }
  }
  return { html: renderDocument(template, { shape: 'invoice', kind: 'sales', company, invoice: SAMPLE_INVOICE }) }
}

/** Render the voucher's document to a PDF in the company's exports folder. Returns the file path. */
export async function invoicePdf(db: DB, company: CompanyInfo, slug: string, voucherId: number): Promise<string> {
  return documentPdf(db, company, slug, voucherId)
}

/**
 * Batch invoice printing (task Q2 #98): renders each voucher's document sequentially (the pdf.ts
 * queue serializes the shared hidden window anyway) into ONE new exports subfolder. Deliberately
 * a folder of per-invoice PDFs, not a single merged file — merging would need a PDF library we
 * don't ship; a folder prints just as well and keeps each invoice individually shareable.
 * A voucher that fails to render fails the whole batch with a message naming the offender, so a
 * half-finished folder is never mistaken for a complete run.
 */
export async function invoicePdfBatch(
  db: DB,
  company: CompanyInfo,
  slug: string,
  voucherIds: number[]
): Promise<{ dir: string; paths: string[] }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(companyExportsDir(slug), `invoices-${stamp}`)
  mkdirSync(dir, { recursive: true })
  const paths: string[] = []
  for (const voucherId of voucherIds) {
    let rendered: ReturnType<typeof documentHtml>
    try {
      rendered = documentHtml(db, company, voucherId)
    } catch (err) {
      throw new Error(`Voucher #${voucherId}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const pdf = await htmlToPdf(rendered.html, pdfOptionsFor(rendered.template, { itemCount: rendered.itemCount }))
    // The voucher id keeps sanitised numbers unique: 'INV/25-26/001' vs 'INV-25-26/001', or a
    // sales invoice and another type sharing the same number, must never overwrite each other.
    const path = join(dir, pdfFileName(rendered.kind, rendered.number, voucherId))
    writeFileSync(path, pdf)
    paths.push(path)
  }
  return { dir, paths }
}
