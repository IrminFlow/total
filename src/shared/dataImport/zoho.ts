/**
 * Zoho Books importer profiles (WP 6.3). Zoho's "Export data" / Backup writes one CSV/XLS(X) per
 * module; line-level modules (invoices, bills, journals, payments) carry ONE ROW PER LINE with the
 * document's header fields repeated on every row.
 *
 * SOURCES (header strings):
 *  - Zoho's own pages describe the export / import wizards but do not list columns:
 *    https://www.zoho.com/in/books/help/import-export/export.html ·
 *    https://www.zoho.com/in/books/help/import-export/import.html ·
 *    https://www.zoho.com/books/help/import-export/backup-your-data.html ·
 *    https://www.zoho.com/in/books/help/migration/migrating-to-zoho-books-from-other-software.html
 *  - The GST field names and values ARE on an official page (verbatim): "GST Treatment",
 *    "GST Identification Number (GSTIN)", "Place of Supply" (state code, e.g. "TN"),
 *    "Intra State Tax Name" / "Inter State Tax Name", "Item Tax"; tax names GST0…GST28 and
 *    IGST0…IGST28 — https://www.zoho.com/in/books/kb/gst/gst-import-format.html
 *  - The module header rows below are verbatim from a real Zoho Books backup recorded in
 *    https://github.com/epritesh/order-suggest/blob/main/data_schema/DATA_SCHEMA.md and the
 *    same names in SimpleAccounts' Zoho migration map
 *    https://github.com/SimpleAccounts/SimpleAccounts-UAE/blob/master/apps/backend/src/main/resources/migration/zoho_v3.4.xml
 *    (third-party, real exports — not Zoho documentation). India-only line columns "CGST",
 *    "SGST", "IGST", "HSN/SAC" are from Indian export parsers (e.g.
 *    https://github.com/susantasarkarin/torpedo_v1/blob/main/backend/seed_invoices_csv.py).
 *
 * UNVERIFIED (handled defensively, listed in the profile so the wizard shows it):
 *  - "PAN Number" / "Place Of Contact" on contacts; "Intra/Inter State Tax Rate" on items.
 *  - Whether "Is Inclusive Tax" = true means Item Total includes tax (treated as yes).
 *  - Vendor payment "Bill Amount" being the amount applied to that bill.
 *  - The export date format (follows the organisation's setting): auto-detected, dd-mm-yyyy
 *    first; switch the wizard's date order for mm/dd organisations.
 */
import type { DateOrder } from './values'
import { parseDate, parseGstin, parseInt0, parseMoney, parsePan, parsePercent, parseQty, parseSignedMoney, parseState } from './values'
import type { FieldDef, ItemRow, LedgerRow, MappedRecord, RowError, TargetRows, VoucherDraft } from './targets'
import { buildInvoiceVoucher, type InvoiceIn, type InvoiceLineIn } from './invoiceBuild'

export interface ProfileContext {
  dateOrder: DateOrder
  companyStateCode: string
}

const f = (key: string, label: string, aliases: string[] = [], required = false): FieldDef => ({ key, label, aliases, required })

/** Zoho account types → Total groups. Zoho's list: https://www.zoho.com/in/books/help/chart-of-accounts/
 *  (account types); the mapping is Total's judgement — Zoho has no Tally-style groups. */
export const ZOHO_ACCOUNT_TYPE_GROUPS: Record<string, string> = {
  'other asset': 'Current Assets',
  'other current asset': 'Current Assets',
  cash: 'Cash-in-Hand',
  bank: 'Bank Accounts',
  'fixed asset': 'Fixed Assets',
  stock: 'Stock-in-Hand',
  'payment clearing': 'Current Assets',
  'payment clearing account': 'Current Assets',
  'input tax': 'Duties & Taxes',
  'output tax': 'Duties & Taxes',
  'overseas tax payable': 'Duties & Taxes',
  'other current liability': 'Current Liabilities',
  'credit card': 'Current Liabilities',
  'long term liability': 'Loans (Liability)',
  'other liability': 'Current Liabilities',
  equity: 'Capital Account',
  income: 'Sales Accounts',
  'other income': 'Indirect Incomes',
  expense: 'Indirect Expenses',
  'cost of goods sold': 'Direct Expenses',
  'other expense': 'Indirect Expenses',
  'accounts receivable': 'Sundry Debtors',
  'accounts payable': 'Sundry Creditors'
}

const g = (r: MappedRecord, k: string): string => (r.values[k] ?? '').trim()

function val<T>(errors: RowError[], line: number, field: string, p: { ok: T } | { error: string }): T | null {
  if ('error' in p) {
    errors.push({ line, field, message: p.error })
    return null
  }
  return p.ok
}

/** "IGST18" → 18; "GST 18 (18 %)" → 18; "" → null. */
export function zohoTaxRate(name: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%?\s*\)?\s*$/.exec(name.trim())
  return m ? Number(m[1]) : null
}

// ---------- masters ----------

export const ZOHO_ACCOUNT_FIELDS: FieldDef[] = [
  f('name', 'Account Name', [], true),
  f('code', 'Account Code', ['Account #']),
  f('type', 'Account Type', [], true),
  f('parent', 'Parent Account'),
  f('status', 'Account Status', ['Status'])
]

function zohoAccounts(records: MappedRecord[]): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const rows: LedgerRow[] = []
  for (const r of records) {
    const name = g(r, 'name')
    if (!name) continue
    const type = g(r, 'type').toLowerCase()
    const group = ZOHO_ACCOUNT_TYPE_GROUPS[type]
    if (!group) {
      errors.push({ line: r.line, field: 'type', message: `Unknown Zoho account type "${g(r, 'type')}"` })
      continue
    }
    // Receivable / payable control accounts are per-contact ledgers in Total — skip the control.
    if (type === 'accounts receivable' || type === 'accounts payable') continue
    rows.push({
      line: r.line, name, group, opening: null, gstin: null, stateCode: null, pan: null, creditDays: null, creditLimit: null,
      address: null, taxType: type === 'input tax' || type === 'output tax' ? taxTypeFromName(name) : null, gstRate: null, hsn: null
    })
  }
  return { result: { target: 'ledgers', rows }, errors }
}

function taxTypeFromName(name: string): LedgerRow['taxType'] {
  const n = name.toUpperCase()
  if (n.includes('CESS')) return 'cess'
  if (n.includes('IGST')) return 'igst'
  if (n.includes('CGST')) return 'cgst'
  if (n.includes('SGST') || n.includes('UTGST')) return 'sgst'
  return null
}

export const ZOHO_CONTACT_FIELDS: FieldDef[] = [
  f('name', 'Display Name', ['Contact Name'], true),
  f('company', 'Company Name'),
  f('contactType', 'Contact Type'),
  f('gstTreatment', 'GST Treatment'),
  f('gstin', 'GST Identification Number (GSTIN)', ['GSTIN', 'GST Number']),
  f('state', 'Place Of Supply', ['Place of Supply', 'Place Of Contact', 'Source of Supply', 'Billing State']),
  f('pan', 'PAN Number', ['PAN']),
  f('paymentTerms', 'Payment Terms'),
  f('creditLimit', 'Credit Limit'),
  f('opening', 'Opening Balance'),
  f('address', 'Billing Address'),
  f('city', 'Billing City'),
  f('pin', 'Billing Code')
]

function zohoContacts(records: MappedRecord[], forced: 'customer' | 'vendor' | null): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const rows: LedgerRow[] = []
  for (const r of records) {
    const name = g(r, 'name') || g(r, 'company')
    if (!name) continue
    const ctype = (g(r, 'contactType') || '').toLowerCase()
    const party: 'customer' | 'vendor' = forced ?? (ctype.includes('vendor') ? 'vendor' : 'customer')
    const gstin = val(errors, r.line, 'gstin', parseGstin(g(r, 'gstin')))
    const state = val(errors, r.line, 'state', parseState(g(r, 'state')))
    const pan = val(errors, r.line, 'pan', parsePan(g(r, 'pan')))
    const opening = val(errors, r.line, 'opening', parseMoney(g(r, 'opening')))
    const credit = val(errors, r.line, 'creditLimit', parseMoney(g(r, 'creditLimit')))
    // Payment Terms is the number of days (Payment Terms Label holds "Net 30").
    const terms = val(errors, r.line, 'paymentTerms', parseInt0(g(r, 'paymentTerms').replace(/^net\s*/i, ''), 3650))
    if (errors.some((e) => e.line === r.line)) continue
    const address = [g(r, 'address'), g(r, 'city'), g(r, 'pin')].filter(Boolean).join(', ') || null
    rows.push({
      line: r.line, name, group: party === 'vendor' ? 'Sundry Creditors' : 'Sundry Debtors',
      // A customer's opening is receivable (Dr); a vendor's payable (Cr).
      opening: opening === null ? null : party === 'vendor' ? -Math.abs(opening) : Math.abs(opening),
      gstin, stateCode: state ?? (gstin ? gstin.slice(0, 2) : null), pan: pan ?? (gstin ? gstin.slice(2, 12) : null),
      creditDays: terms, creditLimit: credit, address, taxType: null, gstRate: null, hsn: null, partyType: party
    })
  }
  return { result: { target: 'parties', rows }, errors }
}

export const ZOHO_ITEM_FIELDS: FieldDef[] = [
  f('name', 'Item Name', ['Name'], true),
  f('sku', 'SKU'),
  f('hsn', 'HSN/SAC', ['HSN Code', 'SAC']),
  f('unit', 'Usage unit', ['Unit Name', 'Unit']),
  f('rate', 'Rate', ['Selling Price']),
  f('purchaseRate', 'Purchase Rate'),
  f('taxPct', 'Tax Percentage', ['Intra State Tax Rate', 'Inter State Tax Rate']),
  f('taxName', 'Inter State Tax Name', ['Intra State Tax Name', 'Tax Name']),
  f('openingQty', 'Opening Stock'),
  f('openingValue', 'Opening Stock Value'),
  f('reorder', 'Reorder Point'),
  f('productType', 'Product Type', ['Item Type'])
]

function zohoItems(records: MappedRecord[]): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const rows: ItemRow[] = []
  for (const r of records) {
    const name = g(r, 'name')
    if (!name) continue
    const pct = g(r, 'taxPct') ? val(errors, r.line, 'taxPct', parsePercent(g(r, 'taxPct'))) : zohoTaxRate(g(r, 'taxName'))
    const qty = val(errors, r.line, 'openingQty', parseQty(g(r, 'openingQty')))
    const value = val(errors, r.line, 'openingValue', parseMoney(g(r, 'openingValue')))
    const reorder = val(errors, r.line, 'reorder', parseQty(g(r, 'reorder')))
    const hsnRaw = g(r, 'hsn').replace(/\.0+$/, '')
    if (errors.some((e) => e.line === r.line)) continue
    rows.push({
      line: r.line, name, group: null, unit: g(r, 'unit') || null, hsn: /^\d{4}(\d{2})?(\d{2})?$/.test(hsnRaw) ? hsnRaw : null,
      gstRate: pct, cessRate: null, openingQtyMilli: qty, openingValue: value, openingRate: null, mrpPaise: null,
      barcode: g(r, 'sku') || null, reorderLevelMilli: reorder
    })
  }
  return { result: { target: 'items', rows }, errors }
}

// ---------- invoices & bills ----------

export const ZOHO_INVOICE_FIELDS: FieldDef[] = [
  f('docId', 'Invoice ID', ['Bill ID', 'CreditNotes ID', 'Credit Note ID']),
  f('date', 'Invoice Date', ['Bill Date', 'Credit Note Date', 'Date'], true),
  f('number', 'Invoice Number', ['Bill Number', 'Credit Note Number', 'Bill#'], true),
  f('status', 'Invoice Status', ['Bill Status', 'Credit Note Status', 'Status']),
  f('party', 'Customer Name', ['Vendor Name'], true),
  f('gstin', 'GST Identification Number (GSTIN)', ['GSTIN']),
  f('pos', 'Place of Supply', ['Place Of Supply', 'Source of Supply', 'Destination of Supply']),
  f('dueDate', 'Due Date'),
  f('inclusive', 'Is Inclusive Tax'),
  f('item', 'Item Name'),
  f('account', 'Account'),
  f('qty', 'Quantity'),
  f('price', 'Item Price', ['Rate']),
  f('itemTotal', 'Item Total', [], true),
  f('taxName', 'Item Tax', ['Tax Name']),
  f('taxPct', 'Item Tax %', ['Tax Percentage']),
  f('taxAmount', 'Item Tax Amount', ['Tax Amount']),
  f('cgst', 'CGST'),
  f('sgst', 'SGST'),
  f('igst', 'IGST'),
  f('cess', 'CESS', ['Cess']),
  f('shipping', 'Shipping Charge'),
  f('shippingAccount', 'Shipping Charge Account'),
  f('adjustment', 'Adjustment'),
  f('adjustmentAccount', 'Adjustment Account'),
  f('roundOff', 'Round Off'),
  f('total', 'Total'),
  f('notes', 'Notes', ['Vendor Notes']),
  f('reference', 'PurchaseOrder', ['Reference Number', 'Reference#'])
]

function zohoDocs(records: MappedRecord[], ctx: ProfileContext, kind: InvoiceIn['kind'], typeName: string): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const groups = new Map<string, MappedRecord[]>()
  for (const r of records) {
    if (!g(r, 'number') && !g(r, 'docId')) continue
    const key = g(r, 'docId') || `${g(r, 'number')}|${g(r, 'date')}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  const drafts: VoucherDraft[] = []
  for (const [key, rows] of groups) {
    const h = rows[0]!
    const status = g(h, 'status').toLowerCase()
    if (status === 'draft' || status === 'void') {
      errors.push({ line: h.line, message: `${g(h, 'number')} skipped: ${status} documents post nothing` })
      continue
    }
    const date = val(errors, h.line, 'date', parseDate(g(h, 'date'), ctx.dateOrder))
    const pos = val(errors, h.line, 'pos', parseState(g(h, 'pos')))
    const due = val(errors, h.line, 'dueDate', parseDate(g(h, 'dueDate'), ctx.dateOrder))
    const total = val(errors, h.line, 'total', parseMoney(g(h, 'total')))
    const inclusive = /^(true|yes|1)$/i.test(g(h, 'inclusive'))
    const lines: InvoiceLineIn[] = []
    let bad = !date
    for (const r of rows) {
      const m = (k: string): number | null => val(errors, r.line, k, parseMoney(g(r, k)))
      const itemTotal = m('itemTotal')
      const taxAmount = m('taxAmount')
      const qty = val(errors, r.line, 'qty', parseQty(g(r, 'qty')))
      const taxPct = val(errors, r.line, 'taxPct', parsePercent(g(r, 'taxPct')))
      if (itemTotal === null) {
        errors.push({ line: r.line, field: 'itemTotal', message: 'Item Total is missing' })
        bad = true
        continue
      }
      const taxable = inclusive && taxAmount !== null ? itemTotal - taxAmount : itemTotal
      lines.push({
        line: r.line, account: g(r, 'account') || null, item: g(r, 'item') || null, qtyMilli: qty, ratePaise: m('price'),
        taxable, cgst: m('cgst'), sgst: m('sgst'), igst: m('igst'), cess: m('cess'), taxAmount,
        taxRate: taxPct ?? zohoTaxRate(g(r, 'taxName')), taxName: g(r, 'taxName') || null
      })
    }
    if (bad || errors.some((e) => rows.some((r) => r.line === e.line))) continue
    const charges: InvoiceIn['charges'] = []
    const ship = val(errors, h.line, 'shipping', parseMoney(g(h, 'shipping')))
    if (ship) charges.push({ line: h.line, label: 'Shipping', account: g(h, 'shippingAccount') || null, amount: ship })
    const adj = val(errors, h.line, 'adjustment', parseSignedMoney(g(h, 'adjustment')))
    if (adj) charges.push({ line: h.line, label: 'Adjustment', account: g(h, 'adjustmentAccount') || null, amount: adj })
    const ro = val(errors, h.line, 'roundOff', parseSignedMoney(g(h, 'roundOff')))
    if (ro) charges.push({ line: h.line, label: 'Round off', account: '@@roundoff', amount: ro })
    const { draft, error } = buildInvoiceVoucher({
      key: `zoho:${typeName}:${key}`, kind, typeName, date: date!, number: g(h, 'number') || null, party: g(h, 'party'),
      reference: g(h, 'reference') || null, narration: g(h, 'notes') || null, placeOfSupply: pos, companyState: ctx.companyStateCode,
      lines, charges, total, dueDate: due, billRef: g(h, 'number') || null, godown: null
    })
    if (error) errors.push({ line: h.line, message: `${g(h, 'number')}: ${error}` })
    else if (draft) drafts.push({ ...draft, posOverride: pos && pos !== ctx.companyStateCode ? pos : null })
  }
  return { result: { target: 'vouchers', rows: drafts }, errors }
}

// ---------- payments ----------

export const ZOHO_PAYMENT_FIELDS: FieldDef[] = [
  f('paymentId', 'CustomerPayment ID', ['VendorPayment ID']),
  f('number', 'Payment Number', [], true),
  f('date', 'Date', ['Payment Date'], true),
  f('party', 'Customer Name', ['Vendor Name'], true),
  f('amount', 'Amount', [], true),
  f('account', 'Deposit To', ['Paid Through'], true),
  f('reference', 'Reference Number'),
  f('mode', 'Mode'),
  f('description', 'Description'),
  f('billNumber', 'Invoice Number', ['Bill Number']),
  f('applied', 'Amount Applied to Invoice', ['Bill Amount'])
]

function zohoPayments(records: MappedRecord[], ctx: ProfileContext, kind: 'receipt' | 'payment'): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const groups = new Map<string, MappedRecord[]>()
  for (const r of records) {
    if (!g(r, 'number') && !g(r, 'paymentId')) continue
    const key = g(r, 'paymentId') || `${g(r, 'number')}|${g(r, 'date')}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const drafts: VoucherDraft[] = []
  for (const [key, rows] of groups) {
    const h = rows[0]!
    const date = val(errors, h.line, 'date', parseDate(g(h, 'date'), ctx.dateOrder))
    const amount = val(errors, h.line, 'amount', parseMoney(g(h, 'amount')))
    if (!date || !amount || amount <= 0) {
      if (date && amount !== null) errors.push({ line: h.line, field: 'amount', message: 'Amount must be positive' })
      continue
    }
    const bills = rows
      .filter((r) => g(r, 'billNumber'))
      .map((r) => ({ line: r.line, kind: 'against' as const, name: g(r, 'billNumber'), amount: val(errors, r.line, 'applied', parseMoney(g(r, 'applied'))), dueDate: null }))
      .filter((b) => b.amount === null || b.amount > 0) as VoucherDraft['bills']
    // Zoho's "Unused Amount" (paid in excess of the invoices applied) stays on account as an
    // advance — a new reference named after the payment, so the bill refs equal the amount.
    const applied = bills.reduce((s, b) => s + (b.amount ?? 0), 0)
    if (bills.length && applied < amount) bills.push({ line: h.line, kind: 'new', name: `Advance ${g(h, 'number')}`, amount: amount - applied, dueDate: null })
    const partySide = kind === 'receipt' ? 'cr' : 'dr'
    drafts.push({
      key: `zoho:${kind}:${key}`, lines: rows.map((r) => r.line), typeName: kind === 'receipt' ? 'Receipt' : 'Payment', kind, date,
      number: g(h, 'number') || null, party: g(h, 'party'), narration: [g(h, 'mode'), g(h, 'description')].filter(Boolean).join(' — ') || null,
      reference: g(h, 'reference') || null,
      ledgerLines: [
        { line: h.line, ledger: g(h, 'account'), drCr: partySide === 'cr' ? 'dr' : 'cr', amount },
        { line: h.line, ledger: g(h, 'party'), drCr: partySide, amount }
      ],
      items: [], bills, tds: null, tcs: null, posOverride: null, currencyCode: null, exchangeRate: null, isOptional: false, notes: []
    })
  }
  return { result: { target: 'vouchers', rows: drafts }, errors }
}

// ---------- journals ----------

export const ZOHO_JOURNAL_FIELDS: FieldDef[] = [
  f('date', 'Journal Date', ['Date'], true),
  f('number', 'Journal Number', ['Journal#'], true),
  f('reference', 'Reference Number'),
  f('notes', 'Notes'),
  f('account', 'Account', [], true),
  f('debit', 'Debit', [], true),
  f('credit', 'Credit', [], true),
  f('contact', 'Contact Name'),
  f('description', 'Description'),
  f('status', 'Status')
]

function zohoJournals(records: MappedRecord[], ctx: ProfileContext): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const groups = new Map<string, MappedRecord[]>()
  for (const r of records) {
    if (!g(r, 'number')) continue
    const key = `${g(r, 'number')}|${g(r, 'date')}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const drafts: VoucherDraft[] = []
  for (const [key, rows] of groups) {
    const h = rows[0]!
    if (/draft/i.test(g(h, 'status'))) {
      errors.push({ line: h.line, message: `Journal ${g(h, 'number')} skipped: draft` })
      continue
    }
    const date = val(errors, h.line, 'date', parseDate(g(h, 'date'), ctx.dateOrder))
    if (!date) continue
    const ledgerLines: VoucherDraft['ledgerLines'] = []
    for (const r of rows) {
      const dr = val(errors, r.line, 'debit', parseMoney(g(r, 'debit'))) ?? 0
      const cr = val(errors, r.line, 'credit', parseMoney(g(r, 'credit'))) ?? 0
      const net = dr - cr
      if (net === 0) continue
      // Receivable / payable lines name the contact — that is the party ledger in Total.
      const acct = g(r, 'account')
      const ledger = /^accounts (receivable|payable)$/i.test(acct) && g(r, 'contact') ? g(r, 'contact') : acct
      ledgerLines.push({ line: r.line, ledger, drCr: net > 0 ? 'dr' : 'cr', amount: Math.abs(net) })
    }
    drafts.push({
      key: `zoho:journal:${key}`, lines: rows.map((r) => r.line), typeName: 'Journal', kind: 'journal', date, number: g(h, 'number'),
      party: null, narration: g(h, 'notes') || g(h, 'description') || null, reference: g(h, 'reference') || null, ledgerLines,
      items: [], bills: [], tds: null, tcs: null, posOverride: null, currencyCode: null, exchangeRate: null, isOptional: false, notes: []
    })
  }
  return { result: { target: 'vouchers', rows: drafts }, errors }
}

// ---------- registry ----------

export interface SourceProfile {
  id: string
  source: 'zoho' | 'busy'
  target: TargetRows['target']
  label: string
  fields: FieldDef[]
  /** Header names that make this profile much more likely (normalised compare). */
  signature: string[]
  citations: string[]
  unverified: string[]
  transform: (records: MappedRecord[], ctx: ProfileContext) => { result: TargetRows; errors: RowError[] }
}

const ZOHO_CITES = [
  'https://www.zoho.com/in/books/help/import-export/export.html',
  'https://www.zoho.com/in/books/kb/gst/gst-import-format.html',
  'https://github.com/epritesh/order-suggest/blob/main/data_schema/DATA_SCHEMA.md (real backup headers, third-party)'
]

export const ZOHO_PROFILES: SourceProfile[] = [
  {
    id: 'zoho:accounts', source: 'zoho', target: 'ledgers', label: 'Zoho Books — Chart of Accounts', fields: ZOHO_ACCOUNT_FIELDS,
    signature: ['Account ID', 'Account Type', 'Parent Account', 'Account Status'], citations: ZOHO_CITES,
    unverified: ['Account-type → group mapping is Total’s; parent accounts are not kept as sub-groups'],
    transform: (r) => zohoAccounts(r)
  },
  {
    id: 'zoho:contacts', source: 'zoho', target: 'parties', label: 'Zoho Books — Contacts (customers)', fields: ZOHO_CONTACT_FIELDS,
    signature: ['Display Name', 'Contact ID', 'Accounts Receivable', 'Customer Sub Type', 'GST Treatment'], citations: ZOHO_CITES,
    unverified: ['"PAN Number" and "Place Of Contact" column names'],
    transform: (r) => zohoContacts(r, null)
  },
  {
    id: 'zoho:vendors', source: 'zoho', target: 'parties', label: 'Zoho Books — Vendors', fields: ZOHO_CONTACT_FIELDS,
    signature: ['Display Name', 'Contact ID', 'Accounts Payable', 'Source of Supply'], citations: ZOHO_CITES,
    unverified: ['"PAN Number" column name'],
    transform: (r) => zohoContacts(r, 'vendor')
  },
  {
    id: 'zoho:items', source: 'zoho', target: 'items', label: 'Zoho Books — Items', fields: ZOHO_ITEM_FIELDS,
    signature: ['Item ID', 'Item Name', 'Usage unit', 'Opening Stock', 'Purchase Rate', 'Intra State Tax Name'], citations: ZOHO_CITES,
    unverified: ['"Intra/Inter State Tax Rate" columns (the "… Tax Name" ones are documented)'],
    transform: (r) => zohoItems(r)
  },
  {
    id: 'zoho:invoices', source: 'zoho', target: 'vouchers', label: 'Zoho Books — Invoices', fields: ZOHO_INVOICE_FIELDS,
    signature: ['Invoice ID', 'Invoice Number', 'Invoice Status', 'Item Tax %', 'Item Tax Amount'], citations: ZOHO_CITES,
    unverified: ['"Is Inclusive Tax" = true taken to mean Item Total includes tax', 'CESS column name'],
    transform: (r, ctx) => zohoDocs(r, ctx, 'sales', 'Sales')
  },
  {
    id: 'zoho:creditNotes', source: 'zoho', target: 'vouchers', label: 'Zoho Books — Credit notes', fields: ZOHO_INVOICE_FIELDS,
    signature: ['Credit Note Number', 'Credit Note Date', 'CreditNotes ID', 'Associated Invoice Number'], citations: ZOHO_CITES,
    unverified: ['Credit-note header names beyond Number/Date'],
    transform: (r, ctx) => zohoDocs(r, ctx, 'credit_note', 'Credit Note')
  },
  {
    id: 'zoho:bills', source: 'zoho', target: 'vouchers', label: 'Zoho Books — Bills', fields: ZOHO_INVOICE_FIELDS,
    signature: ['Bill ID', 'Bill Status', 'Accounts Payable', 'Bill Type'], citations: ZOHO_CITES,
    unverified: ['India-specific bill columns (Source of Supply, reverse charge)'],
    transform: (r, ctx) => zohoDocs(r, ctx, 'purchase', 'Purchase')
  },
  {
    id: 'zoho:customerPayments', source: 'zoho', target: 'vouchers', label: 'Zoho Books — Customer payments', fields: ZOHO_PAYMENT_FIELDS,
    signature: ['CustomerPayment ID', 'Deposit To', 'Amount Applied to Invoice', 'Invoice Payment Applied Date'], citations: ZOHO_CITES,
    unverified: ['Bank charges are not split out of the amount'],
    transform: (r, ctx) => zohoPayments(r, ctx, 'receipt')
  },
  {
    id: 'zoho:vendorPayments', source: 'zoho', target: 'vouchers', label: 'Zoho Books — Vendor payments', fields: ZOHO_PAYMENT_FIELDS,
    signature: ['VendorPayment ID', 'Paid Through', 'Bill Payment Applied Date'], citations: ZOHO_CITES,
    unverified: ['"Bill Amount" taken as the amount applied to that bill'],
    transform: (r, ctx) => zohoPayments(r, ctx, 'payment')
  },
  {
    id: 'zoho:journals', source: 'zoho', target: 'vouchers', label: 'Zoho Books — Journals', fields: ZOHO_JOURNAL_FIELDS,
    signature: ['Journal Number', 'Journal Date', 'Journal Type', 'Journal Number Prefix', 'Journal Created By'], citations: ZOHO_CITES,
    unverified: [],
    transform: (r, ctx) => zohoJournals(r, ctx)
  }
]
