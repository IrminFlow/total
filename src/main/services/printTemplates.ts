import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { DEFAULT_INVOICE_CONFIG, mergeInvoiceConfig, type InvoiceConfig } from '@shared/invoiceConfig'
import {
  applyLegacyConfig,
  BUILT_IN_DEFAULTS,
  BUILT_IN_IDS,
  exportTemplateJson,
  INVOICE_SHAPED_KINDS,
  isBuiltInId,
  legacyConfigToTemplate,
  MAX_CUSTOM_TEMPLATES,
  parseStore,
  parseTemplateImport,
  pdfOptionsFor,
  PRINT_DOC_KINDS,
  PRINT_DOC_KIND_LABELS,
  PRINT_TEMPLATES_META_KEY,
  printKindForVoucherKind,
  printTemplateSchema,
  templateToLegacyConfig,
  type PrintDocKind,
  type PrintTemplate,
  type PrintTemplateStore,
  type TemplateList,
  type TemplateSummary
} from '@shared/printTemplates'
import { renderDocument, type InvoiceAuditTrail, type PrintDocument, type VoucherDocLine } from '@shared/print/render'
import { sampleDocument } from '@shared/print/sample'
import { extractEdocInvoices } from './edocs'
import { ledgerStatement } from './reports'
import { NOT_DELETED } from './vouchers'
import { writeAudit } from './audit'
import { htmlToPdf, writeExportPdf } from './pdf'
import { plexFontFaceCss } from './printFonts'
import { companyExportsDir } from '../paths'

/**
 * Print templates service (WP 1.10c). Storage: one JSON document per company in `meta` under
 * PRINT_TEMPLATES_META_KEY ('printTemplates') — same pattern as the legacy invoice config
 * (`meta.invoice`); no schema migration. Built-ins live in code; the store holds customised copies
 * of built-ins (same id) and user templates, plus the default template id per document kind.
 *
 * Classic and the legacy config: until Classic is customised in the designer it is DERIVED from
 * `meta.invoice` (legacyConfigToTemplate — lossless), so a company that never opens the designer
 * prints exactly as before. Whenever Classic is saved, `meta.invoice` is rewritten from it too, so
 * the old `config:invoice:*` channels and older app builds keep seeing the same settings.
 */

const LEGACY_KEY = 'invoice'

function readMeta(db: DB, key: string): unknown {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

function writeMeta(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value)
  )
}

const readStore = (db: DB): PrintTemplateStore => parseStore(readMeta(db, PRINT_TEMPLATES_META_KEY))
const writeStore = (db: DB, store: PrintTemplateStore): void => writeMeta(db, PRINT_TEMPLATES_META_KEY, store)

/** Never dump a logo's base64 payload into the audit trail — just its size. */
function redact(t: PrintTemplate | null): unknown {
  if (!t) return null
  return { ...t, header: { ...t.header, logoDataUrl: t.header.logoDataUrl ? `[logo ${t.header.logoDataUrl.length} chars]` : null } }
}

// ---------------------------------------------------------------- legacy config bridge

export function legacyInvoiceConfig(db: DB): InvoiceConfig {
  return mergeInvoiceConfig(readMeta(db, LEGACY_KEY))
}

/** `config:invoice:get` — the Classic template seen through the old InvoiceConfig shape. */
export function getLegacyConfigView(db: DB): InvoiceConfig {
  const override = readStore(db).templates.find((t) => t.id === 'classic')
  return override ? templateToLegacyConfig(override) : legacyInvoiceConfig(db)
}

/** `config:invoice:set` — writes the legacy key and, when Classic has been customised, folds the
 *  change into that customised copy (keeping its template-only settings). */
export function setLegacyConfig(db: DB, cfg: InvoiceConfig): void {
  const store = readStore(db)
  const i = store.templates.findIndex((t) => t.id === 'classic')
  if (i >= 0) {
    store.templates[i] = applyLegacyConfig(store.templates[i]!, cfg)
    writeStore(db, store)
  }
  writeMeta(db, LEGACY_KEY, cfg)
}

// ---------------------------------------------------------------- CRUD

function builtInTemplate(db: DB, store: PrintTemplateStore, id: (typeof BUILT_IN_IDS)[number]): PrintTemplate {
  const override = store.templates.find((t) => t.id === id)
  if (override) return override
  return id === 'classic' ? legacyConfigToTemplate(legacyInvoiceConfig(db)) : BUILT_IN_DEFAULTS[id]
}

function findTemplate(db: DB, store: PrintTemplateStore, id: string): PrintTemplate | null {
  if (isBuiltInId(id)) return builtInTemplate(db, store, id)
  return store.templates.find((t) => t.id === id) ?? null
}

export function getTemplate(db: DB, id: string): PrintTemplate {
  const t = findTemplate(db, readStore(db), id)
  if (!t) throw new Error('Print template not found')
  return t
}

function effectiveDefaults(db: DB, store: PrintTemplateStore): Record<PrintDocKind, string> {
  const out = {} as Record<PrintDocKind, string>
  for (const kind of PRINT_DOC_KINDS) {
    const id = store.defaults[kind]
    const t = id ? findTemplate(db, store, id) : null
    out[kind] = t && t.kinds.includes(kind) ? t.id : 'classic'
  }
  return out
}

export function listTemplates(db: DB): TemplateList {
  const store = readStore(db)
  const summary = (t: PrintTemplate, customised: boolean): TemplateSummary => ({
    id: t.id, name: t.name, builtIn: t.builtIn, style: t.style, kinds: [...t.kinds], customised
  })
  const builtIns = BUILT_IN_IDS.map((id) => summary(builtInTemplate(db, store, id), store.templates.some((t) => t.id === id)))
  const custom = store.templates.filter((t) => !isBuiltInId(t.id)).map((t) => summary(t, false))
  return { templates: [...builtIns, ...custom], defaults: effectiveDefaults(db, store) }
}

function newId(store: PrintTemplateStore): string {
  for (;;) {
    const id = `tpl-${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`
    if (!store.templates.some((t) => t.id === id)) return id
  }
}

function persist(db: DB, store: PrintTemplateStore, t: PrintTemplate, before: PrintTemplate | null): PrintTemplate {
  const i = store.templates.findIndex((x) => x.id === t.id)
  if (i >= 0) store.templates[i] = t
  else store.templates.push(t)
  writeStore(db, store)
  if (t.id === 'classic') writeMeta(db, LEGACY_KEY, templateToLegacyConfig(t))
  writeAudit(db, 'company', 0, 'update', { printTemplate: redact(before) }, { printTemplate: redact(t) })
  return t
}

/** Create or update. Built-in ids save a customised copy; other ids must already exist (use
 *  createTemplate/duplicate/import for new ones) unless `allowCreate`. */
export function saveTemplate(db: DB, input: unknown, allowCreate = false): PrintTemplate {
  const parsed = printTemplateSchema.parse(input)
  const store = readStore(db)
  const builtIn = isBuiltInId(parsed.id)
  const before = findTemplate(db, store, parsed.id)
  if (!builtIn && !before) {
    if (!allowCreate) throw new Error('Print template not found')
    if (store.templates.filter((t) => !isBuiltInId(t.id)).length >= MAX_CUSTOM_TEMPLATES) {
      throw new Error(`At most ${MAX_CUSTOM_TEMPLATES} custom templates per company`)
    }
  }
  return persist(db, store, { ...parsed, builtIn }, before)
}

export function duplicateTemplate(db: DB, id: string): PrintTemplate {
  const store = readStore(db)
  const src = findTemplate(db, store, id)
  if (!src) throw new Error('Print template not found')
  const copy = { ...src, id: newId(store), name: `${src.name} copy`.slice(0, 60), builtIn: false }
  return saveTemplate(db, copy, true)
}

export function deleteTemplate(db: DB, id: string): void {
  if (isBuiltInId(id)) throw new Error('Built-in templates cannot be deleted — duplicate or reset them instead')
  const store = readStore(db)
  const before = store.templates.find((t) => t.id === id)
  if (!before) throw new Error('Print template not found')
  store.templates = store.templates.filter((t) => t.id !== id)
  for (const k of Object.keys(store.defaults) as PrintDocKind[]) if (store.defaults[k] === id) delete store.defaults[k]
  writeStore(db, store)
  writeAudit(db, 'company', 0, 'delete', { printTemplate: redact(before) }, null)
}

/** Drop a built-in's customisations. Classic also resets the legacy invoice config. */
export function resetTemplate(db: DB, id: string): PrintTemplate {
  if (!isBuiltInId(id)) throw new Error('Only built-in templates can be reset')
  const store = readStore(db)
  const before = findTemplate(db, store, id)
  store.templates = store.templates.filter((t) => t.id !== id)
  writeStore(db, store)
  if (id === 'classic') writeMeta(db, LEGACY_KEY, DEFAULT_INVOICE_CONFIG)
  const after = BUILT_IN_DEFAULTS[id]
  writeAudit(db, 'company', 0, 'update', { printTemplate: redact(before) }, { printTemplate: redact(after) })
  return after
}

export function setDefaultTemplate(db: DB, kind: PrintDocKind, id: string): TemplateList {
  const store = readStore(db)
  const t = findTemplate(db, store, id)
  if (!t) throw new Error('Print template not found')
  if (!t.kinds.includes(kind)) throw new Error(`"${t.name}" is not enabled for ${PRINT_DOC_KIND_LABELS[kind].toLowerCase()}s`)
  const before = store.defaults[kind] ?? 'classic'
  store.defaults[kind] = id
  writeStore(db, store)
  writeAudit(db, 'company', 0, 'update', { printDefault: { kind, id: before } }, { printDefault: { kind, id } })
  return listTemplates(db)
}

/**
 * The template a voucher of `kind` prints with: the kind's default, else Classic.
 * PHASE 2 HOOK — per-voucher override: look up `voucherId` here (e.g. a `printTemplate.voucher.<id>`
 * meta key or a vouchers column, assigned centrally) before falling back to the kind default.
 */
export function resolveTemplate(db: DB, kind: PrintDocKind, _voucherId?: number): PrintTemplate {
  const store = readStore(db)
  const id = effectiveDefaults(db, store)[kind]
  return findTemplate(db, store, id) ?? builtInTemplate(db, store, 'classic')
}

export function importTemplate(db: DB, jsonText: string): PrintTemplate {
  const t = parseTemplateImport(jsonText)
  const store = readStore(db)
  return saveTemplate(db, { ...t, id: newId(store), builtIn: false, name: t.name }, true)
}

export function exportTemplate(db: DB, slug: string, id: string): string {
  const t = getTemplate(db, id)
  const safe = t.name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || t.id
  const path = join(companyExportsDir(slug), `print-template-${safe}.json`)
  writeFileSync(path, exportTemplateJson(t), 'utf8')
  return path
}

// ---------------------------------------------------------------- document data

/** Zip inventory_lines.discount_paise onto the extracted e-doc items — same ORDER BY
 *  (line_order, id) as edocs.ts's item query, so index i lines up with index i. Discounts are a
 *  print concern: e-doc JSON taxable values are already post-discount by construction. */
export function attachDiscounts(db: DB, voucherId: number, items: { discountPaise?: number | null }[]): void {
  const rows = db
    .prepare('SELECT discount_paise AS d FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order, id')
    .all(voucherId) as { d: number }[]
  items.forEach((item, i) => {
    item.discountPaise = rows[i]?.d ?? 0
  })
}

/** First-create + latest-update user names from the voucher's audit trail (task Q1 #91). */
export function auditTrailFor(db: DB, voucherId: number): InvoiceAuditTrail {
  const entered = db
    .prepare("SELECT user_name AS u FROM audit_log WHERE entity = 'voucher' AND entity_id = ? AND action = 'create' ORDER BY id LIMIT 1")
    .get(voucherId) as { u: string | null } | undefined
  const altered = db
    .prepare("SELECT user_name AS u FROM audit_log WHERE entity = 'voucher' AND entity_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1")
    .get(voucherId) as { u: string | null } | undefined
  return { enteredBy: entered?.u ?? null, alteredBy: altered?.u ?? null }
}

function partyBalance(db: DB, partyId: number | null, date: string): number | null {
  if (!partyId) return null
  return ledgerStatement(db, partyId, date, date).closing
}

interface VoucherHead {
  id: number; number: string; date: string; kind: string; partyId: number | null; narration: string | null
  reference: string | null; instrumentNo: string | null; instrumentDate: string | null
  irn: string | null; ackNo: string | null; ackDate: string | null; ewbNo: string | null
}

function voucherHead(db: DB, voucherId: number): VoucherHead {
  const v = db
    .prepare(
      `SELECT v.id, v.number, v.date, vt.kind, v.party_ledger_id AS partyId, v.narration, v.reference,
              v.instrument_no AS instrumentNo, v.instrument_date AS instrumentDate,
              v.irn, v.irn_ack_no AS ackNo, v.irn_ack_date AS ackDate, v.ewb_no AS ewbNo
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE v.id = ? AND ${NOT_DELETED}`
    )
    .get(voucherId) as VoucherHead | undefined
  if (!v) throw new Error('Voucher not found')
  return v
}

/** Build the printable document for a voucher. `wantOutstanding` skips the balance query when the
 *  template won't print it. */
export function loadPrintDocument(db: DB, company: CompanyInfo, voucherId: number, wantOutstanding = true): PrintDocument {
  const head = voucherHead(db, voucherId)
  const kind = printKindForVoucherKind(head.kind)
  if (!kind) throw new Error('This voucher type has no printed form')
  const outstandingPaise = wantOutstanding ? partyBalance(db, head.partyId, head.date) : null
  if (INVOICE_SHAPED_KINDS.includes(kind)) {
    const [inv] = extractEdocInvoices(db, company, '0000-01-01', '9999-12-31', voucherId)
    if (!inv) throw new Error('Invoice not found (optional or post-dated vouchers are not printed)')
    attachDiscounts(db, voucherId, inv.items)
    return {
      shape: 'invoice', kind, company, invoice: inv, audit: auditTrailFor(db, voucherId), outstandingPaise,
      einvoice: { irn: head.irn, ackNo: head.ackNo, ackDate: head.ackDate, ewbNo: head.ewbNo }
    }
  }
  const lines = db
    .prepare(
      `SELECT l.id AS ledgerId, l.name AS ledgerName, vl.dr_cr AS drCr, vl.amount
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
    )
    .all(voucherId) as (VoucherDocLine & { ledgerId: number })[]
  // Party: the voucher's party ledger, else the counter-party side of a receipt/payment.
  const partyId =
    head.partyId ??
    (kind === 'receipt' ? lines.find((l) => l.drCr === 'cr')?.ledgerId : kind === 'payment' ? lines.find((l) => l.drCr === 'dr')?.ledgerId : undefined) ??
    null
  const party = partyId
    ? (db.prepare('SELECT name, address, gstin FROM ledgers WHERE id = ?').get(partyId) as { name: string; address: string | null; gstin: string | null } | undefined)
    : undefined
  return {
    shape: 'voucher',
    kind,
    company,
    voucher: {
      number: head.number,
      date: head.date,
      partyName: party?.name ?? null,
      partyAddress: party?.address ?? null,
      partyGstin: party?.gstin ?? null,
      lines: lines.map(({ ledgerName, drCr, amount }) => ({ ledgerName, drCr, amount })),
      narration: head.narration,
      reference: head.reference,
      instrumentNo: head.instrumentNo,
      instrumentDate: head.instrumentDate,
      total: lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
    },
    audit: auditTrailFor(db, voucherId),
    outstandingPaise: wantOutstanding ? partyBalance(db, partyId, head.date) : null
  }
}

const RENDER_OPTS = { fontFaceCss: plexFontFaceCss }

/** The real-print HTML for a voucher with its kind's default template. */
export function documentHtml(
  db: DB,
  company: CompanyInfo,
  voucherId: number,
  templateOverride?: PrintTemplate
): { html: string; number: string; kind: PrintDocKind; template: PrintTemplate } {
  const head = voucherHead(db, voucherId)
  const kind = printKindForVoucherKind(head.kind)
  if (!kind) throw new Error('This voucher type has no printed form')
  const template = templateOverride ?? resolveTemplate(db, kind, voucherId)
  const doc = loadPrintDocument(db, company, voucherId, template.totals.showOutstanding)
  return { html: renderDocument(template, doc, RENDER_OPTS), number: head.number, kind, template }
}

export const pdfFileName = (kind: PrintDocKind, number: string, voucherId?: number): string => {
  const safe = number.replace(/[^a-zA-Z0-9-_]/g, '_')
  const prefix = kind === 'sales' ? 'invoice' : kind.replace(/_/g, '-')
  return `${prefix}-${safe}${voucherId != null ? `-v${voucherId}` : ''}.pdf`
}

export async function documentPdf(db: DB, company: CompanyInfo, slug: string, voucherId: number): Promise<string> {
  const { html, number, kind, template } = documentHtml(db, company, voucherId)
  return writeExportPdf(slug, pdfFileName(kind, number), html, pdfOptionsFor(template))
}

export async function documentPdfBuffer(db: DB, company: CompanyInfo, voucherId: number): Promise<{ pdf: Buffer; number: string; kind: PrintDocKind }> {
  const { html, number, kind, template } = documentHtml(db, company, voucherId)
  return { pdf: await htmlToPdf(html, pdfOptionsFor(template)), number, kind }
}

/** Designer preview: the (unsaved) template on a real voucher or the built-in sample. */
export function templatePreviewHtml(
  db: DB,
  company: CompanyInfo,
  template: PrintTemplate,
  opts: { voucherId?: number; kind?: PrintDocKind } = {}
): { html: string } {
  const doc = opts.voucherId != null ? loadPrintDocument(db, company, opts.voucherId) : sampleDocument(company, opts.kind ?? template.kinds[0] ?? 'sales')
  return { html: renderDocument(template, doc, RENDER_OPTS) }
}

/** "Print test page": the template on the sample document, as a PDF in exports/. */
export async function templateTestPdf(db: DB, company: CompanyInfo, slug: string, template: PrintTemplate, kind?: PrintDocKind): Promise<string> {
  const { html } = templatePreviewHtml(db, company, template, { kind })
  return writeExportPdf(slug, `print-test-${template.id}.pdf`, html, pdfOptionsFor(template))
}
