/**
 * Books export (WP 6.3, System → Export): the whole company as ONE .xlsx — a Manifest sheet
 * (format, books schema version, company, books-from, lock date, database version, row counts) and
 * a sheet per entity in the column layout of @shared/dataImport/books.ts, so the same workbook
 * imports back through the wizard (into this company or a new one). Two "(info)" sheets — GST lines
 * and stock as on the export date — are computed figures for people, never imported.
 *
 * Fidelity: readable columns for what people edit, and a "… (JSON)" cell per row with EVERY other
 * column the schema has (read with SELECT *, so a later migration's columns ride along by
 * themselves), foreign keys written as names / codes. Vouchers are written in id order with their
 * line uids, so line links (orders → challans → invoices, GRN → bill) are restored on import, and
 * each carries its Source ID so a re-import matches on it. Year-end closing journals carry their
 * flag (re-validated on import).
 *
 * Not carried (listed in the Manifest): manufacture / job-work facts (those vouchers re-import as
 * stock journals), payroll, fixed-asset registers, budgets, bank statements and rules, users,
 * attachments, audit trail, custom order series' numbering settings.
 */
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { XlsxCell, XlsxSheet } from '@shared/xlsx/writer'
import { BOOKS_FORMAT, BOOKS_SCHEMA_VERSION, BOOKS_SHEETS, MANIFEST_SHEET, booksHeader, type BooksSheetDef } from '@shared/dataImport/books'
import { todayISO } from '@shared/dates'
import { stockSummary } from './stockAnalysis'
import { getLockDate } from './vouchers'

type Row = Record<string, XlsxCell>
type DbRow = Record<string, unknown>

function sheetFor(def: BooksSheetDef, rows: Row[]): XlsxSheet {
  return {
    name: def.sheet,
    columns: def.columns.map((c) => ({ header: booksHeader(def, c.field), kind: c.kind, ...(c.decimals !== undefined ? { decimals: c.decimals } : {}) })),
    rows: rows.map((r) => def.columns.map((c) => r[c.field] ?? null))
  }
}

const def = (sheet: string): BooksSheetDef => BOOKS_SHEETS.find((d) => d.sheet === sheet)!
const yes = (v: unknown): string | null => (v ? 'Yes' : null)

export interface BooksExportResult {
  sheets: XlsxSheet[]
  counts: Record<string, number>
}

export function buildBooksWorkbook(db: DB, info: CompanyInfo, appVersion: string, asOn: string = todayISO()): BooksExportResult {
  const all = <T = DbRow>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[]
  const names = (sql: string): Map<number, string> => new Map(all<{ id: number; n: string }>(sql).map((r) => [r.id, r.n]))
  const sectionCode = names('SELECT id, code AS n FROM tds_sections')
  const ledgerName = names('SELECT id, name AS n FROM ledgers')
  const levelName = names('SELECT id, name AS n FROM price_levels')
  const centreName = names('SELECT id, name AS n FROM cost_centres')
  const REFS: Record<string, Map<number, string>> = {
    tds_section_id: sectionCode, tds_payable_section_id: sectionCode, tds_default_section_id: sectionCode,
    tcs_section_id: sectionCode, tcs_payable_section_id: sectionCode, tcs_default_section_id: sectionCode,
    price_level_id: levelName, party_ledger_id: ledgerName
  }
  /** Every non-null column outside `exclude`, foreign keys as names. Null when nothing is left. */
  const extras = (row: DbRow, exclude: string[]): string | null => {
    const out: DbRow = {}
    for (const [k, v] of Object.entries(row)) {
      if (exclude.includes(k) || v === null || v === undefined || k.endsWith('_at') && k !== 'credit_hold_at') continue
      out[k] = REFS[k] ? (REFS[k]!.get(v as number) ?? null) : v
    }
    return Object.keys(out).length ? JSON.stringify(out) : null
  }

  const groups = all<{ name: string; parent: string | null }>(
    `SELECT g.name, p.name AS parent FROM groups g LEFT JOIN groups p ON p.id = g.parent_id WHERE g.is_system = 0 ORDER BY g.id`
  ).map((g) => ({ name: g.name, parent: g.parent }))

  const units = all<{ name: string; symbol: string; decimals: number; uqc: string }>('SELECT name, symbol, decimals, uqc FROM units ORDER BY id')

  const stockGroups = all<{ name: string; parent: string | null }>(
    'SELECT s.name, p.name AS parent FROM stock_groups s LEFT JOIN stock_groups p ON p.id = s.parent_id ORDER BY s.id'
  )

  const levels = all<{ name: string; inclusive_of_tax: number; is_default: number }>('SELECT name, inclusive_of_tax, is_default FROM price_levels ORDER BY id')
    .map((l) => ({ name: l.name, inclusive: yes(l.inclusive_of_tax), isDefault: yes(l.is_default) }))

  const godowns = all<{ name: string; address: string | null; kind: string; party: string | null }>(
    'SELECT g.name, g.address, g.kind, l.name AS party FROM godowns g LEFT JOIN ledgers l ON l.id = g.party_ledger_id ORDER BY g.id'
  ).map((g) => ({ name: g.name, address: g.address, kind: g.kind === 'own' ? null : g.kind, party: g.party }))

  const LEDGER_CANON = ['id', 'name', 'group_id', 'is_system', 'opening_balance', 'gstin', 'state_code', 'pan', 'credit_days', 'credit_limit', 'address', 'tax_type', 'gst_rate', 'hsn']
  const ledgers = all<DbRow & { grp: string }>('SELECT l.*, g.name AS grp FROM ledgers l JOIN groups g ON g.id = l.group_id ORDER BY l.id').map((l) => ({
    name: l.name as string, group: l.grp, opening: (l.opening_balance as number) || null, gstin: l.gstin as string | null, state: l.state_code as string | null,
    pan: l.pan as string | null, creditDays: l.credit_days as number | null, creditLimit: l.credit_limit as number | null, address: l.address as string | null,
    taxType: l.tax_type as string | null, gstRate: l.gst_rate as number | null, hsn: l.hsn as string | null, more: extras(l, [...LEDGER_CANON, 'grp'])
  }))

  const ITEM_CANON = ['id', 'name', 'group_id', 'unit_id', 'hsn', 'gst_rate', 'cess_rate', 'opening_qty_milli', 'opening_value', 'mrp_paise', 'barcode', 'reorder_level_milli']
  const items = all<DbRow & { grp: string | null; unit: string }>(
    `SELECT s.*, g.name AS grp, u.name AS unit FROM stock_items s JOIN units u ON u.id = s.unit_id LEFT JOIN stock_groups g ON g.id = s.group_id ORDER BY s.id`
  ).map((s) => ({
    name: s.name as string, group: s.grp, unit: s.unit, hsn: s.hsn as string | null, gstRate: s.gst_rate as number | null, cessRate: s.cess_rate as number | null,
    openingQty: (s.opening_qty_milli as number) || null, openingValue: (s.opening_value as number) || null, mrp: s.mrp_paise as number | null,
    barcode: s.barcode as string | null, reorderLevel: s.reorder_level_milli as number | null, more: extras(s, [...ITEM_CANON, 'grp', 'unit'])
  }))

  const batches = all<{ item: string; name: string; mfg_date: string | null; expiry_date: string | null }>(
    'SELECT s.name AS item, b.name, b.mfg_date, b.expiry_date FROM batches b JOIN stock_items s ON s.id = b.stock_item_id ORDER BY b.id'
  ).map((b) => ({ item: b.item, name: b.name, mfgDate: b.mfg_date, expiryDate: b.expiry_date }))

  const prices = all<{ level: string; item: string; rate: number; effective_from: string; min_qty_milli: number; effective_to: string | null; discount_bp: number; currency: string }>(
    `SELECT l.name AS level, s.name AS item, r.rate, r.effective_from, r.min_qty_milli, r.effective_to, r.discount_bp, r.currency
       FROM price_list_rates r JOIN price_levels l ON l.id = r.price_level_id JOIN stock_items s ON s.id = r.stock_item_id ORDER BY r.id`
  ).map((p) => ({
    level: p.level, item: p.item, rate: p.rate, from: p.effective_from, minQty: p.min_qty_milli || null,
    more: p.effective_to || p.discount_bp || p.currency !== 'INR' ? JSON.stringify({ effective_to: p.effective_to, discount_bp: p.discount_bp, currency: p.currency }) : null
  }))

  const voucherTypes = all<{ name: string; kind: string; prefix: string; numbering: string; suffix: string; pad_width: number; restart_fy: number }>(
    'SELECT name, kind, prefix, numbering, suffix, pad_width, restart_fy FROM voucher_types WHERE is_system = 0 ORDER BY id'
  ).map((v) => ({ name: v.name, kind: v.kind, prefix: v.prefix || null, more: JSON.stringify({ numbering: v.numbering, suffix: v.suffix, pad_width: v.pad_width, restart_fy: v.restart_fy }) }))

  const centres = all<{ name: string; parent: string | null; active: number }>(
    'SELECT c.name, p.name AS parent, c.active FROM cost_centres c LEFT JOIN cost_centres p ON p.id = c.parent_id ORDER BY c.id'
  ).map((c) => ({ name: c.name, parent: c.parent, active: c.active ? null : 'No' }))

  // ---------- links (by target line uid) ----------
  const linkOf = new Map(
    all<{ to_line_uid: string; from_line_uid: string; link_type: string }>('SELECT to_line_uid, from_line_uid, link_type FROM line_links').map((l) => [l.to_line_uid, { from_line_uid: l.from_line_uid, link_type: l.link_type }])
  )

  // ---------- orders (before vouchers: challans and invoices draw on them) ----------
  const DOC_CANON = ['id', 'doc_type_id', 'number', 'date', 'party_ledger_id', 'valid_until', 'due_date', 'reference', 'narration', 'deleted_at']
  const docs = all<DbRow & { kind: string; series: string; party: string }>(
    `SELECT d.*, t.kind, t.name AS series, p.name AS party FROM trade_docs d JOIN trade_doc_types t ON t.id = d.doc_type_id
       JOIN ledgers p ON p.id = d.party_ledger_id WHERE d.deleted_at IS NULL ORDER BY d.id`
  )
  const docLines = all<DbRow & { doc_id: number; item: string; godown: string | null }>(
    `SELECT l.*, s.name AS item, g.name AS godown FROM trade_doc_lines l JOIN stock_items s ON s.id = l.stock_item_id
       LEFT JOIN godowns g ON g.id = l.godown_id ORDER BY l.doc_id, l.line_order, l.id`
  )
  const docRows: Row[] = []
  for (const d of docs) {
    const head: Row = {
      key: `D${d.id}`, kind: d.kind, series: d.series, date: d.date as string, number: d.number as string, party: d.party, dueDate: d.due_date as string | null,
      validUntil: d.valid_until as string | null, reference: d.reference as string | null, narration: d.narration as string | null, sourceId: `D${d.id}`,
      dmore: extras(d, [...DOC_CANON, 'kind', 'series', 'party'])
    }
    for (const l of docLines.filter((x) => x.doc_id === d.id)) {
      const link = linkOf.get(l.line_uid as string)
      docRows.push({
        ...head, item: l.item, godown: l.godown, qty: l.qty_milli as number, rate: l.rate_paise as number, discount: (l.discount_paise as number) || null,
        amount: l.amount as number, lineDueDate: l.due_date as string | null,
        lmore: JSON.stringify({ line_uid: l.line_uid, ...(l.description ? { description: l.description } : {}), ...(link ? { link } : {}) })
      })
    }
  }

  // ---------- vouchers: id order; one row per ledger line, then item lines, then bill refs ----------
  const VOUCHER_CANON = ['id', 'voucher_type_id', 'date', 'number', 'party_ledger_id', 'narration', 'reference', 'pos_override', 'currency_code', 'exchange_rate', 'is_optional', 'post_dated', 'deleted_at', 'type', 'party']
  const vouchers = all<DbRow & { type: string; party: string | null }>(
    `SELECT v.*, vt.name AS type, p.name AS party FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id WHERE v.deleted_at IS NULL ORDER BY v.id`
  )
  const byVoucher = <T extends { voucher_id: number }>(rows: T[]): Map<number, T[]> => {
    const m = new Map<number, T[]>()
    for (const r of rows) m.set(r.voucher_id, [...(m.get(r.voucher_id) ?? []), r])
    return m
  }
  const lines = byVoucher(all<{ voucher_id: number; id: number; ledger: string; dr_cr: string; amount: number; bank_date: string | null }>(
    `SELECT vl.voucher_id, vl.id, l.name AS ledger, vl.dr_cr, vl.amount, vl.bank_date FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       JOIN vouchers v ON v.id = vl.voucher_id WHERE v.deleted_at IS NULL ORDER BY vl.voucher_id, vl.line_order, vl.id`
  ))
  const allocs = new Map<number, { centre: string; amount: number }[]>()
  for (const a of all<{ voucher_line_id: number; cost_centre_id: number; amount: number }>('SELECT voucher_line_id, cost_centre_id, amount FROM voucher_line_cost_allocations ORDER BY id')) {
    allocs.set(a.voucher_line_id, [...(allocs.get(a.voucher_line_id) ?? []), { centre: centreName.get(a.cost_centre_id)!, amount: a.amount }])
  }
  const inv = byVoucher(all<{
    voucher_id: number; item: string; godown: string | null; batch: string | null; qty_milli: number; rate_paise: number; amount: number; direction: string
    discount_paise: number; serials: string | null; line_uid: string | null; moves_stock: number; is_absolute: number
  }>(
    `SELECT il.voucher_id, s.name AS item, g.name AS godown, b.name AS batch, il.qty_milli, il.rate_paise, il.amount, il.direction,
            il.discount_paise, il.serials, il.line_uid, il.moves_stock, il.is_absolute
       FROM inventory_lines il JOIN stock_items s ON s.id = il.stock_item_id LEFT JOIN godowns g ON g.id = il.godown_id
       LEFT JOIN batches b ON b.id = il.batch_id JOIN vouchers v ON v.id = il.voucher_id WHERE v.deleted_at IS NULL ORDER BY il.voucher_id, il.line_order, il.id`
  ))
  const bills = byVoucher(all<{ voucher_id: number; kind: string; name: string; amount: number; due_date: string | null }>(
    'SELECT br.voucher_id, br.kind, br.name, br.amount, br.due_date FROM bill_refs br JOIN vouchers v ON v.id = br.voucher_id WHERE v.deleted_at IS NULL ORDER BY br.id'
  ))
  const wh = byVoucher(all<{ voucher_id: number; code: string; kind: 'tds' | 'tcs'; base_amount: number; tds_amount: number; is_manual: number }>(
    'SELECT e.voucher_id, s.code, s.kind, e.base_amount, e.tds_amount, e.is_manual FROM tds_entries e JOIN tds_sections s ON s.id = e.section_id'
  ))
  const tradeFacts = new Map(all<{ voucher_id: number; purpose: string; closed_at: string | null; close_reason: string | null }>('SELECT * FROM trade_voucher_details').map((t) => [t.voucher_id, t]))
  const voucherRows: Row[] = []
  for (const v of vouchers) {
    const vm: DbRow = JSON.parse(extras(v, VOUCHER_CANON) ?? '{}')
    const t = tradeFacts.get(v.id as number)
    if (t) Object.assign(vm, { 'trade.purpose': t.purpose }, t.closed_at ? { 'trade.closed_at': t.closed_at, 'trade.close_reason': t.close_reason } : {})
    for (const w of wh.get(v.id as number) ?? []) vm[`${w.kind}.is_manual`] = w.is_manual
    const head: Row = {
      key: `V${v.id}`, type: v.type, date: v.date as string, number: v.number as string, party: v.party, narration: v.narration as string | null,
      reference: v.reference as string | null, placeOfSupply: v.pos_override as string | null, currency: v.currency_code as string | null,
      exchangeRate: v.exchange_rate as number | null, optional: yes(v.is_optional), postDated: yes(v.post_dated), sourceId: `V${v.id}`,
      vmore: Object.keys(vm).length ? JSON.stringify(vm) : null
    }
    for (const w of wh.get(v.id as number) ?? []) {
      head[`${w.kind}Section`] = w.code
      head[`${w.kind}Base`] = w.base_amount
      head[`${w.kind}Amount`] = w.tds_amount
    }
    const rows: Row[] = []
    for (const l of lines.get(v.id as number) ?? []) {
      const lm: DbRow = {}
      if (l.bank_date) lm.bank_date = l.bank_date
      if (allocs.has(l.id)) lm.cost_allocations = allocs.get(l.id)
      rows.push({ ledger: l.ledger, drCr: l.dr_cr === 'dr' ? 'Dr' : 'Cr', amount: l.amount, lmore: Object.keys(lm).length ? JSON.stringify(lm) : null })
    }
    for (const i of inv.get(v.id as number) ?? []) {
      const link = i.line_uid ? linkOf.get(i.line_uid) : undefined
      const lm: DbRow = {
        ...(i.line_uid ? { line_uid: i.line_uid } : {}), ...(i.discount_paise ? { discount_paise: i.discount_paise } : {}),
        ...(i.serials ? { serials: JSON.parse(i.serials) } : {}), ...(i.moves_stock === 0 ? { moves_stock: 0 } : {}),
        ...(i.is_absolute ? { is_absolute: 1 } : {}), ...(link ? { link } : {})
      }
      rows.push({
        item: i.item, godown: i.godown, batch: i.batch, qty: i.qty_milli, rate: i.rate_paise, itemAmount: i.amount, direction: i.direction,
        lmore: Object.keys(lm).length ? JSON.stringify(lm) : null
      })
    }
    for (const b of bills.get(v.id as number) ?? []) rows.push({ billRef: b.name, billKind: b.kind, billAmount: b.amount, dueDate: b.due_date })
    if (rows.length === 0) rows.push({})
    // Header fields on every row: the sheet sorts and filters safely, and any row identifies its voucher.
    for (const r of rows) voucherRows.push({ ...head, ...r })
  }

  const sheets: XlsxSheet[] = []
  const counts: Record<string, number> = {}
  const push = (name: string, rows: Row[]): void => {
    counts[name] = rows.length
    sheets.push(sheetFor(def(name), rows))
  }
  push('Groups', groups)
  push('Units', units)
  push('Stock Groups', stockGroups)
  push('Price Levels', levels)
  push('Ledgers', ledgers)
  push('Godowns', godowns)
  push('Stock Items', items)
  push('Batches', batches)
  push('Price Lists', prices)
  push('Voucher Types', voucherTypes)
  push('Cost Centres', centres)
  push('Orders', docRows)
  push('Vouchers', voucherRows)

  // ---------- (info) sheets ----------
  const gst = all<{ id: number; date: string; number: string; type: string; party: string | null; gstin: string | null; ledger: string; tax_type: string; dr_cr: string; amount: number }>(
    `SELECT v.id, v.date, v.number, vt.name AS type, p.name AS party, p.gstin, l.name AS ledger, l.tax_type, vl.dr_cr, vl.amount
       FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id
      WHERE l.tax_type IS NOT NULL AND v.deleted_at IS NULL AND v.is_optional = 0 ORDER BY v.date, v.id, vl.id`
  )
  sheets.push({
    name: 'GST (info)',
    columns: [
      { header: 'Voucher Key', kind: 'text' }, { header: 'Date', kind: 'date' }, { header: 'Number', kind: 'text' }, { header: 'Voucher Type', kind: 'text' },
      { header: 'Party', kind: 'text' }, { header: 'Party GSTIN', kind: 'text' }, { header: 'Tax Ledger', kind: 'text' }, { header: 'Tax', kind: 'text' },
      { header: 'Dr/Cr', kind: 'text' }, { header: 'Amount', kind: 'money' }
    ],
    rows: gst.map((g) => [`V${g.id}`, g.date, g.number, g.type, g.party, g.gstin, g.ledger, g.tax_type.toUpperCase(), g.dr_cr === 'dr' ? 'Dr' : 'Cr', g.amount])
  })
  const stock = stockSummary(db, asOn)
  sheets.push({
    name: 'Stock (info)',
    preamble: [`Stock as on ${asOn} (valued by the inventory pass)`],
    columns: [
      { header: 'Item', kind: 'text' }, { header: 'Unit', kind: 'text' }, { header: 'Opening Qty', kind: 'qty' }, { header: 'Opening Value', kind: 'money' },
      { header: 'Inward Qty', kind: 'qty' }, { header: 'Outward Qty', kind: 'qty' }, { header: 'Closing Qty', kind: 'qty' }, { header: 'Closing Value', kind: 'money' }
    ],
    rows: stock.map((s) => ({
      cells: [s.name, s.unitSymbol, s.openingQtyMilli, s.openingValue, s.inwardQtyMilli, s.outwardQtyMilli, s.closingQtyMilli, s.closingValue],
      qtyDecimals: { 2: s.decimals, 4: s.decimals, 5: s.decimals, 6: s.decimals }
    }))
  })
  counts['GST (info)'] = gst.length
  counts['Stock (info)'] = stock.length

  const dbVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0
  const manifest: [string, string][] = [
    ['format', BOOKS_FORMAT],
    ['schemaVersion', String(BOOKS_SCHEMA_VERSION)],
    ['company', info.name],
    ['gstin', info.gstin ?? ''],
    ['stateCode', info.stateCode],
    ['booksFrom', String(info.booksFrom)],
    ['lockDate', getLockDate(db) ?? ''],
    ['exportedAt', new Date().toISOString()],
    ['asOn', asOn],
    ['app', 'Total'],
    ['appVersion', appVersion],
    ['databaseVersion', String(dbVersion)],
    ...Object.entries(counts).map(([k, n]) => [`rows: ${k}`, String(n)] as [string, string]),
    ['notCarried', 'manufacture and job-work details (re-import as stock journals); payroll; fixed-asset registers; budgets; bank statements and rules; users; attachments; the audit trail; numbering settings of custom order series'],
    ['readMe', 'Import this workbook with System → Import (it is recognised automatically). Sheets marked (info) are computed and never imported. "… (JSON)" cells carry the fields without a column of their own — edit with care.']
  ]
  sheets.unshift({ name: MANIFEST_SHEET, columns: [{ header: 'Key', kind: 'text', width: 22 }, { header: 'Value', kind: 'text', width: 90 }], rows: manifest })
  return { sheets, counts }
}
