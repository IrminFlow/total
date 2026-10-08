/**
 * Books export (WP 6.3, System → Export): the whole company as ONE .xlsx — a Manifest sheet
 * (format, books schema version, company, books-from, database version, row counts) and a sheet
 * per entity in the column layout of @shared/dataImport/books.ts, so the same workbook imports
 * back through the wizard (into this company or a new one). Two "(info)" sheets — GST lines and
 * stock as on the export date — are computed figures for people, never imported.
 *
 * Every figure comes from the source of truth at export time: voucher lines, inventory lines and
 * bill refs of live (not binned) vouchers; stock through the valuation pass (stockSummary).
 * Not carried (listed in the Manifest so nobody is surprised): line links between orders,
 * challans and invoices; cost-centre allocations; serial numbers; manufacture / job-work facts
 * (those vouchers re-import as plain stock journals); attachments.
 */
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { XlsxCell, XlsxSheet } from '@shared/xlsx/writer'
import { BOOKS_FORMAT, BOOKS_SCHEMA_VERSION, BOOKS_SHEETS, MANIFEST_SHEET, booksHeader, type BooksSheetDef } from '@shared/dataImport/books'
import { todayISO } from '@shared/dates'
import { stockSummary } from './stockAnalysis'

type Row = Record<string, XlsxCell>

function sheetFor(def: BooksSheetDef, rows: Row[]): XlsxSheet {
  return {
    name: def.sheet,
    columns: def.columns.map((c) => ({ header: booksHeader(def, c.field), kind: c.kind, ...(c.decimals !== undefined ? { decimals: c.decimals } : {}) })),
    rows: rows.map((r) => def.columns.map((c) => r[c.field] ?? null))
  }
}

const def = (sheet: string): BooksSheetDef => BOOKS_SHEETS.find((d) => d.sheet === sheet)!
const yes = (v: number | boolean): string | null => (v ? 'Yes' : null)

export interface BooksExportResult {
  sheets: XlsxSheet[]
  counts: Record<string, number>
}

export function buildBooksWorkbook(db: DB, info: CompanyInfo, appVersion: string, asOn: string = todayISO()): BooksExportResult {
  const all = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[]

  const groups = all<{ name: string; parent: string | null }>(
    `SELECT g.name, p.name AS parent FROM groups g LEFT JOIN groups p ON p.id = g.parent_id WHERE g.is_system = 0 ORDER BY g.id`
  ).map((g) => ({ name: g.name, parent: g.parent }))

  const units = all<{ name: string; symbol: string; decimals: number; uqc: string }>('SELECT name, symbol, decimals, uqc FROM units ORDER BY id')

  const stockGroups = all<{ name: string; parent: string | null }>(
    'SELECT s.name, p.name AS parent FROM stock_groups s LEFT JOIN stock_groups p ON p.id = s.parent_id ORDER BY s.id'
  )

  const godowns = all<{ name: string; address: string | null }>('SELECT name, address FROM godowns ORDER BY id')

  const ledgers = all<{
    name: string; grp: string; opening_balance: number; gstin: string | null; state_code: string | null; pan: string | null
    credit_days: number | null; credit_limit: number | null; address: string | null; tax_type: string | null; gst_rate: number | null; hsn: string | null
  }>(
    `SELECT l.name, g.name AS grp, l.opening_balance, l.gstin, l.state_code, l.pan, l.credit_days, l.credit_limit, l.address, l.tax_type, l.gst_rate, l.hsn
       FROM ledgers l JOIN groups g ON g.id = l.group_id ORDER BY l.id`
  ).map((l) => ({
    name: l.name, group: l.grp, opening: l.opening_balance || null, gstin: l.gstin, state: l.state_code, pan: l.pan,
    creditDays: l.credit_days, creditLimit: l.credit_limit, address: l.address, taxType: l.tax_type, gstRate: l.gst_rate, hsn: l.hsn
  }))

  const items = all<{
    name: string; grp: string | null; unit: string; hsn: string | null; gst_rate: number | null; cess_rate: number | null
    opening_qty_milli: number; opening_value: number; mrp_paise: number | null; barcode: string | null; reorder_level_milli: number | null
  }>(
    `SELECT s.name, g.name AS grp, u.name AS unit, s.hsn, s.gst_rate, s.cess_rate, s.opening_qty_milli, s.opening_value, s.mrp_paise, s.barcode, s.reorder_level_milli
       FROM stock_items s JOIN units u ON u.id = s.unit_id LEFT JOIN stock_groups g ON g.id = s.group_id ORDER BY s.id`
  ).map((s) => ({
    name: s.name, group: s.grp, unit: s.unit, hsn: s.hsn, gstRate: s.gst_rate, cessRate: s.cess_rate, openingQty: s.opening_qty_milli || null,
    openingValue: s.opening_value || null, mrp: s.mrp_paise, barcode: s.barcode, reorderLevel: s.reorder_level_milli
  }))

  const batches = all<{ item: string; name: string; mfg_date: string | null; expiry_date: string | null }>(
    'SELECT s.name AS item, b.name, b.mfg_date, b.expiry_date FROM batches b JOIN stock_items s ON s.id = b.stock_item_id ORDER BY b.id'
  ).map((b) => ({ item: b.item, name: b.name, mfgDate: b.mfg_date, expiryDate: b.expiry_date }))

  const prices = all<{ level: string; item: string; rate: number; effective_from: string; min_qty_milli: number }>(
    `SELECT l.name AS level, s.name AS item, r.rate, r.effective_from, r.min_qty_milli
       FROM price_list_rates r JOIN price_levels l ON l.id = r.price_level_id JOIN stock_items s ON s.id = r.stock_item_id
      WHERE r.currency = 'INR' ORDER BY r.id`
  ).map((p) => ({ level: p.level, item: p.item, rate: p.rate, from: p.effective_from, minQty: p.min_qty_milli || null }))

  const voucherTypes = all<{ name: string; kind: string; prefix: string }>('SELECT name, kind, prefix FROM voucher_types WHERE is_system = 0 ORDER BY id').map((v) => ({ ...v, prefix: v.prefix || null }))

  // ---------- vouchers: one row per ledger line, then item lines, then bill refs ----------
  type V = {
    id: number; type: string; date: string; number: string; party: string | null; narration: string | null; reference: string | null
    pos_override: string | null; currency_code: string | null; exchange_rate: number | null; is_optional: number; post_dated: number
  }
  const vouchers = all<V>(
    `SELECT v.id, vt.name AS type, v.date, v.number, p.name AS party, v.narration, v.reference, v.pos_override, v.currency_code, v.exchange_rate,
            v.is_optional, v.post_dated
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id LEFT JOIN ledgers p ON p.id = v.party_ledger_id
      WHERE v.deleted_at IS NULL ORDER BY v.date, v.id`
  )
  const byVoucher = <T extends { voucher_id: number }>(rows: T[]): Map<number, T[]> => {
    const m = new Map<number, T[]>()
    for (const r of rows) m.set(r.voucher_id, [...(m.get(r.voucher_id) ?? []), r])
    return m
  }
  const lines = byVoucher(all<{ voucher_id: number; ledger: string; dr_cr: string; amount: number }>(
    `SELECT vl.voucher_id, l.name AS ledger, vl.dr_cr, vl.amount FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
       JOIN vouchers v ON v.id = vl.voucher_id WHERE v.deleted_at IS NULL ORDER BY vl.id`
  ))
  const inv = byVoucher(all<{ voucher_id: number; item: string; godown: string | null; batch: string | null; qty_milli: number; rate_paise: number; amount: number; direction: string }>(
    `SELECT il.voucher_id, s.name AS item, g.name AS godown, b.name AS batch, il.qty_milli, il.rate_paise, il.amount, il.direction
       FROM inventory_lines il JOIN stock_items s ON s.id = il.stock_item_id LEFT JOIN godowns g ON g.id = il.godown_id
       LEFT JOIN batches b ON b.id = il.batch_id JOIN vouchers v ON v.id = il.voucher_id WHERE v.deleted_at IS NULL ORDER BY il.id`
  ))
  const bills = byVoucher(all<{ voucher_id: number; kind: string; name: string; amount: number; due_date: string | null }>(
    'SELECT br.voucher_id, br.kind, br.name, br.amount, br.due_date FROM bill_refs br JOIN vouchers v ON v.id = br.voucher_id WHERE v.deleted_at IS NULL ORDER BY br.id'
  ))
  const wh = byVoucher(all<{ voucher_id: number; code: string; kind: 'tds' | 'tcs'; base_amount: number; tds_amount: number }>(
    'SELECT e.voucher_id, s.code, s.kind, e.base_amount, e.tds_amount FROM tds_entries e JOIN tds_sections s ON s.id = e.section_id'
  ))
  const voucherRows: Row[] = []
  for (const v of vouchers) {
    const head: Row = {
      key: `V${v.id}`, type: v.type, date: v.date, number: v.number, party: v.party, narration: v.narration, reference: v.reference,
      placeOfSupply: v.pos_override, currency: v.currency_code, exchangeRate: v.exchange_rate, optional: yes(v.is_optional), postDated: yes(v.post_dated)
    }
    for (const w of wh.get(v.id) ?? []) {
      head[`${w.kind}Section`] = w.code
      head[`${w.kind}Base`] = w.base_amount
      head[`${w.kind}Amount`] = w.tds_amount
    }
    const rows: Row[] = []
    for (const l of lines.get(v.id) ?? []) rows.push({ ledger: l.ledger, drCr: l.dr_cr === 'dr' ? 'Dr' : 'Cr', amount: l.amount })
    for (const i of inv.get(v.id) ?? []) {
      rows.push({ item: i.item, godown: i.godown, batch: i.batch, qty: i.qty_milli, rate: i.rate_paise, itemAmount: i.amount, direction: i.direction })
    }
    for (const b of bills.get(v.id) ?? []) rows.push({ billRef: b.name, billKind: b.kind, billAmount: b.amount, dueDate: b.due_date })
    if (rows.length === 0) rows.push({})
    // Header fields on every row: the sheet sorts and filters safely, and any row identifies its voucher.
    for (const r of rows) voucherRows.push({ ...head, ...r })
  }

  // ---------- orders ----------
  const docRows: Row[] = all<{
    id: number; kind: string; series: string; date: string; number: string; party: string; due_date: string | null; valid_until: string | null
    reference: string | null; narration: string | null; item: string; godown: string | null; qty_milli: number; rate_paise: number; discount_paise: number
    amount: number; line_due: string | null
  }>(
    `SELECT d.id, t.kind, t.name AS series, d.date, d.number, p.name AS party, d.due_date, d.valid_until, d.reference, d.narration,
            s.name AS item, g.name AS godown, l.qty_milli, l.rate_paise, l.discount_paise, l.amount, l.due_date AS line_due
       FROM trade_docs d JOIN trade_doc_types t ON t.id = d.doc_type_id JOIN ledgers p ON p.id = d.party_ledger_id
       JOIN trade_doc_lines l ON l.doc_id = d.id JOIN stock_items s ON s.id = l.stock_item_id LEFT JOIN godowns g ON g.id = l.godown_id
      WHERE d.deleted_at IS NULL ORDER BY d.date, d.id, l.line_order, l.id`
  ).map((d) => ({
    key: `D${d.id}`, kind: d.kind, series: d.series, date: d.date, number: d.number, party: d.party, dueDate: d.due_date, validUntil: d.valid_until,
    reference: d.reference, narration: d.narration, item: d.item, godown: d.godown, qty: d.qty_milli, rate: d.rate_paise, discount: d.discount_paise || null,
    amount: d.amount, lineDueDate: d.line_due
  }))

  const sheets: XlsxSheet[] = []
  const counts: Record<string, number> = {}
  const push = (name: string, rows: Row[]): void => {
    counts[name] = rows.length
    sheets.push(sheetFor(def(name), rows))
  }
  push('Groups', groups)
  push('Units', units)
  push('Stock Groups', stockGroups)
  push('Godowns', godowns)
  push('Ledgers', ledgers)
  push('Stock Items', items)
  push('Batches', batches)
  push('Price Lists', prices)
  push('Voucher Types', voucherTypes)
  push('Vouchers', voucherRows)
  push('Orders', docRows)

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
    ['exportedAt', new Date().toISOString()],
    ['asOn', asOn],
    ['app', 'Total'],
    ['appVersion', appVersion],
    ['databaseVersion', String(dbVersion)],
    ...Object.entries(counts).map(([k, n]) => [`rows: ${k}`, String(n)] as [string, string]),
    ['notCarried', 'line links between orders / challans / invoices; cost-centre allocations; serial numbers; manufacture and job-work details; attachments'],
    ['readMe', 'Import this workbook with System → Import (it is recognised automatically). Sheets marked (info) are computed and never imported.']
  ]
  sheets.unshift({ name: MANIFEST_SHEET, columns: [{ header: 'Key', kind: 'text', width: 22 }, { header: 'Value', kind: 'text', width: 90 }], rows: manifest })
  return { sheets, counts }
}
