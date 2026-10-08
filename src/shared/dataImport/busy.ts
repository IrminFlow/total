/**
 * Busy Accounting Software importer (WP 6.3).
 *
 * WHAT BUSY DOCUMENTS (official busy.in FAQs):
 *  - Excel import is a user-built mapping ("Administration > Data Export Import > Import Masters /
 *    Vouchers from MS Excel > Configure > Add Format"): there is NO fixed Excel header layout.
 *    https://busy.in/faqs/what-is-the-process-for-importing-data-from-excel-to-busy-answerid-55977/
 *  - The fields such a format maps: "Voucher series, Voucher/Bill Date, and Voucher/Bill Number …
 *    Sale/purchase Type, Party name, Material centre Name … Item Name, Quantity, Unit Name, and
 *    Price … separate columns for exclusive Tax" — https://busy.in/faqs/data-conversion/voucher-import-export/15/
 *  - Item masters: "item name, item group, tax category, Item opening quantity, Item opening
 *    amount"; account masters: account name, group ("Sundry Debtor"/"Sundry Creditor"), address…
 *    https://busy.in/faqs/data-conversion/master-import-export/2/
 *  - Sale types "L/GST-18%" (local, intra-state) and "I/GST-12%" (inter-state):
 *    https://busy.in/faqs/how-to-configure-taxes-discounts-etc-in-sales-transactions-answerid-59644/
 * So the Excel profiles below are WIZARD TEMPLATES built on those documented field names; the
 * exact header spellings are UNVERIFIED and the mapping step lets the user point each field at
 * the right column (and remembers it).
 *
 * BUSY XML ("Data Export (XML)"): a fixed structure, read here from real exports published in
 * https://github.com/varun0406/maxwell-toy (Masters.DAT, MCMPL_*_MSAll.DAT) — third-party samples,
 * not Busy documentation, so UNVERIFIED: root <BusyData>, sections AccountGroups / Accounts /
 * Items / Units / MaterialCenter / Sales / Purc / Rcpts / Pymts / Jrnls …; <Account> Name,
 * ParentGroup, OPBal (negative = Dr, inferred from the data: debtors negative, creditors
 * positive), Address/GSTNo/ITPAN/StateName, BillByBillDetail; <AccDetail> AccountName,
 * AmountType (1 = Dr, 2 = Cr per a third-party importer), AmtMainCur; dates dd-MM-yyyy.
 *
 * Default Busy account groups (from a real export, same repo) → Total's chart: BUSY_GROUP_MAP.
 */
import { collect, childText, parseXml, type XNode } from '../tally'
import type { DateOrder } from './values'
import { parseDate, parseGstin, parseMoney, parsePan, parseQty, parseSignedMoney, parseState } from './values'
import type { FieldDef, GodownRow, GroupRow, ItemRow, LedgerRow, MappedRecord, RowError, TargetRows, UnitRow, VoucherDraft } from './targets'
import { kindFromWord } from './targets'
import { buildInvoiceVoucher, type InvoiceLineIn } from './invoiceBuild'
import type { ProfileContext, SourceProfile } from './zoho'

/** Busy default groups → Total groups (Tally names). Busy names not listed pass through unchanged
 *  (most coincide with Tally's: Sundry Debtors, Duties & Taxes, …). */
export const BUSY_GROUP_MAP: Record<string, string> = {
  'capital account': 'Capital Account',
  'reserves & surplus': 'Reserves & Surplus',
  'current assets': 'Current Assets',
  'cash-in-hand': 'Cash-in-Hand',
  'cash in hand': 'Cash-in-Hand',
  'bank accounts': 'Bank Accounts',
  'securities & deposits (asset)': 'Deposits (Asset)',
  'loans & advances (asset)': 'Loans & Advances (Asset)',
  'stock-in-hand': 'Stock-in-Hand',
  'sundry debtors': 'Sundry Debtors',
  'sundry debtor': 'Sundry Debtors',
  'current liabilities': 'Current Liabilities',
  'sundry creditors': 'Sundry Creditors',
  'sundry creditor': 'Sundry Creditors',
  'duties & taxes': 'Duties & Taxes',
  'provisions/expenses payable': 'Provisions',
  'fixed assets': 'Fixed Assets',
  investments: 'Investments',
  'loans (liability)': 'Loans (Liability)',
  'secured loans': 'Secured Loans',
  'unsecured loans': 'Unsecured Loans',
  'bank o/d account': 'Bank OD A/c',
  'pre-operative expenses': 'Misc. Expenses (ASSET)',
  // Busy's own P&L account lives here; Total has no P&L ledger group — its balance is retained
  // earnings, which the chart keeps under Reserves & Surplus.
  'profit & loss': 'Reserves & Surplus',
  'revenue accounts': 'Indirect Expenses',
  sale: 'Sales Accounts',
  sales: 'Sales Accounts',
  purchase: 'Purchase Accounts',
  'expenses (direct/mfg.)': 'Direct Expenses',
  'expenses (indirect/admn.)': 'Indirect Expenses',
  'income (direct/opr.)': 'Direct Incomes',
  'income (indirect)': 'Indirect Incomes',
  'suspense account': 'Suspense A/c',
  'branch/divisions': 'Branch / Divisions'
}

export function mapBusyGroup(name: string): string {
  return BUSY_GROUP_MAP[name.trim().toLowerCase()] ?? name.trim()
}

/** "GST 18%", "GST-18", "18%" → 18; "Exempt"/"Nil" → 0. */
export function busyTaxCategoryRate(cat: string): number | null {
  const t = cat.trim()
  if (!t) return null
  if (/exempt|nil|non[- ]?gst/i.test(t)) return 0
  const m = /(\d+(?:\.\d+)?)\s*%?/.exec(t)
  return m ? Number(m[1]) : null
}

/** Sale/purchase type: "L/GST-18%" → local 18; "I/GST-12%" → inter-state 12; item-wise / multirate → rate null. */
export function busySaleType(t: string): { inter: boolean | null; rate: number | null } {
  const s = t.trim().toUpperCase()
  const inter = s.startsWith('I/') ? true : s.startsWith('L/') ? false : null
  if (/ITEM|MULTI|INCL/.test(s)) return { inter, rate: null }
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(s)
  if (m) return { inter, rate: Number(m[1]) }
  if (/EXEMPT|NIL/.test(s)) return { inter, rate: 0 }
  return { inter, rate: null }
}

const f = (key: string, label: string, aliases: string[] = [], required = false): FieldDef => ({ key, label, aliases, required })
const g = (r: MappedRecord, k: string): string => (r.values[k] ?? '').trim()

function val<T>(errors: RowError[], line: number, field: string, p: { ok: T } | { error: string }): T | null {
  if ('error' in p) {
    errors.push({ line, field, message: p.error })
    return null
  }
  return p.ok
}

// ---------- Excel templates ----------

export const BUSY_ACCOUNT_FIELDS: FieldDef[] = [
  f('name', 'Name', ['Acc_name', 'Account Name', 'Acc Name', 'Name of Account'], true),
  f('alias', 'Alias'),
  f('group', 'Group', ['Account Group', 'Acc Group', 'ParentGroup', 'Parent Group', 'Under Group'], true),
  f('opening', 'Op. Bal.', ['Op. Bal', 'Opening Balance', 'OPBal', 'Op Bal (Rs.)']),
  f('drCr', 'Dr/Cr', ['Op. Bal. Dr/Cr', 'Balance Type']),
  f('gstin', 'GSTIN', ['GSTNo', 'GST No.', 'GST No']),
  f('pan', 'PAN', ['ITPAN', 'IT PAN', 'PAN No.']),
  f('state', 'State', ['StateName', 'State Name']),
  f('address1', 'Address 1', ['Address1', 'Address']),
  f('address2', 'Address 2', ['Address2']),
  f('address3', 'Address 3', ['Address3']),
  f('creditDays', 'Credit Days', ['CreditDaysForSale', 'Credit Days for Sale']),
  f('creditLimit', 'Credit Limit')
]

function busyAccounts(records: MappedRecord[]): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const rows: LedgerRow[] = []
  for (const r of records) {
    const name = g(r, 'name')
    if (!name) continue
    const opening = val(errors, r.line, 'opening', parseSignedMoney(g(r, 'opening'), g(r, 'drCr')))
    const gstin = val(errors, r.line, 'gstin', parseGstin(g(r, 'gstin')))
    const pan = val(errors, r.line, 'pan', parsePan(g(r, 'pan')))
    const state = val(errors, r.line, 'state', parseState(g(r, 'state')))
    const limit = val(errors, r.line, 'creditLimit', parseMoney(g(r, 'creditLimit')))
    const days = g(r, 'creditDays') ? Number(g(r, 'creditDays')) : null
    if (days !== null && (!Number.isInteger(days) || days < 0)) errors.push({ line: r.line, field: 'creditDays', message: `Credit days "${g(r, 'creditDays')}" is not a whole number` })
    if (errors.some((e) => e.line === r.line)) continue
    rows.push({
      line: r.line, name, group: mapBusyGroup(g(r, 'group')), opening, gstin, stateCode: state ?? (gstin ? gstin.slice(0, 2) : null),
      pan: pan ?? (gstin ? gstin.slice(2, 12) : null), creditDays: days, creditLimit: limit,
      address: [g(r, 'address1'), g(r, 'address2'), g(r, 'address3')].filter(Boolean).join(', ') || null, taxType: null, gstRate: null, hsn: null
    })
  }
  return { result: { target: 'ledgers', rows }, errors }
}

export const BUSY_ITEM_FIELDS: FieldDef[] = [
  f('name', 'Item Name', ['Name', 'Item'], true),
  f('alias', 'Alias'),
  f('group', 'Item Group', ['Group', 'ParentGroup']),
  f('unit', 'Unit', ['Unit Name', 'Main Unit', 'MainUnit']),
  f('hsn', 'HSN Code', ['HSN', 'HSN/SAC Code', 'HSNCode']),
  f('taxCategory', 'Tax Category', ['Tax Cat.', 'GST Rate']),
  f('openingQty', 'Item Opening Quantity', ['Op. Stock', 'Opening Qty', 'OPStockInMainUnit', 'Op. Stock Qty']),
  f('openingValue', 'Item Opening Amount', ['Op. Amount', 'Opening Value', 'OPAmount', 'Op. Stock Value']),
  f('salePrice', 'Sale Price', ['Sales Price']),
  f('purchasePrice', 'Purchase Price', ['Purc. Price']),
  f('mrp', 'MRP')
]

function busyItems(records: MappedRecord[]): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const rows: ItemRow[] = []
  for (const r of records) {
    const name = g(r, 'name')
    if (!name) continue
    const qty = val(errors, r.line, 'openingQty', parseQty(g(r, 'openingQty')))
    const value = val(errors, r.line, 'openingValue', parseMoney(g(r, 'openingValue')))
    const mrp = val(errors, r.line, 'mrp', parseMoney(g(r, 'mrp')))
    const hsn = g(r, 'hsn').replace(/\.0+$/, '')
    if (hsn && !/^\d{4}(\d{2})?(\d{2})?$/.test(hsn)) errors.push({ line: r.line, field: 'hsn', message: `HSN "${hsn}" must be 4, 6 or 8 digits` })
    if (errors.some((e) => e.line === r.line)) continue
    rows.push({
      line: r.line, name, group: g(r, 'group') || null, unit: g(r, 'unit') || null, hsn: hsn || null, gstRate: busyTaxCategoryRate(g(r, 'taxCategory')),
      cessRate: null, openingQtyMilli: qty, openingValue: value, openingRate: null, mrpPaise: mrp, barcode: null, reorderLevelMilli: null
    })
  }
  return { result: { target: 'items', rows }, errors }
}

export const BUSY_VOUCHER_FIELDS: FieldDef[] = [
  f('series', 'Vch Series', ['Voucher Series', 'Series']),
  f('date', 'Date', ['Voucher/Bill Date', 'Vch/Bill Date', 'Bill Date', 'Vch Date'], true),
  f('number', 'Vch/Bill No', ['Voucher/Bill Number', 'Vch/Bill No.', 'Bill No', 'Invoice No', 'Vch No']),
  f('type', 'Sale/Purc Type', ['Sale Type', 'Purchase Type', 'Sale/Purchase Type', 'Purc Type', 'Tax Type']),
  f('party', 'Party Name', ['Party', 'Party A/c', 'Account']),
  f('mc', 'Material Centre', ['Mat. Centre', 'Mat.Centre', 'MC', 'Material Center']),
  f('item', 'Item Name', ['Item'], true),
  f('qty', 'Quantity', ['Qty'], true),
  f('unit', 'Unit Name', ['Unit']),
  f('price', 'Price', ['Rate']),
  f('amount', 'Amount', ['Taxable Amt', 'Taxable Amount', 'Value']),
  f('igst', 'IGST', ['IGST Amt']),
  f('cgst', 'CGST', ['CGST Amt']),
  f('sgst', 'SGST', ['SGST Amt', 'SGST/UTGST']),
  f('narration', 'Narration', ['Remarks', 'Narration1']),
  f('billRef', 'Bill Ref', ['Ref. No', 'Ref No'])
]

/** Busy sales / purchase register rows (one per item; header on the first line only). */
function busyTrade(records: MappedRecord[], ctx: ProfileContext, kind: 'sales' | 'purchase'): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  type Doc = { head: MappedRecord; rows: MappedRecord[] }
  const docs: Doc[] = []
  let cur: Doc | null = null
  for (const r of records) {
    if (Object.values(r.values).every((v) => !v)) continue
    const headerish = g(r, 'date') || g(r, 'number') || g(r, 'party')
    if (headerish && (!cur || g(r, 'number') !== g(cur.head, 'number') || (g(r, 'date') && g(r, 'date') !== g(cur.head, 'date')))) {
      cur = { head: r, rows: [] }
      docs.push(cur)
    }
    if (!cur) {
      errors.push({ line: r.line, message: 'Item line before any voucher header (date / number / party)' })
      continue
    }
    cur.rows.push(r)
  }
  const drafts: VoucherDraft[] = []
  for (const d of docs) {
    const h = d.head
    const date = val(errors, h.line, 'date', parseDate(g(h, 'date'), ctx.dateOrder))
    if (!date) continue
    if (!g(h, 'party')) {
      errors.push({ line: h.line, field: 'party', message: 'Party Name is missing' })
      continue
    }
    const st = busySaleType(g(h, 'type'))
    const lines: InvoiceLineIn[] = []
    let bad = false
    for (const r of d.rows) {
      const m = (k: string): number | null => val(errors, r.line, k, parseMoney(g(r, k)))
      const qty = val(errors, r.line, 'qty', parseQty(g(r, 'qty')))
      const price = m('price')
      const amount = m('amount') ?? (qty !== null && price !== null ? Math.round((qty * price) / 1000) : null)
      if (amount === null) {
        errors.push({ line: r.line, field: 'amount', message: 'Amount (or quantity × price) is missing' })
        bad = true
        continue
      }
      const cgst = m('cgst')
      const sgst = m('sgst')
      const igst = m('igst')
      const explicit = cgst !== null || sgst !== null || igst !== null
      if (!explicit && st.rate === null) {
        errors.push({ line: r.line, message: `Sale type "${g(h, 'type')}" takes rates from item masters — add IGST/CGST/SGST amount columns` })
        bad = true
        continue
      }
      lines.push({
        line: r.line, account: null, item: g(r, 'item') || null, qtyMilli: qty, ratePaise: price, taxable: amount,
        cgst, sgst, igst, cess: null, taxAmount: null, taxRate: explicit ? null : st.rate,
        taxName: st.inter === true ? 'IGST' : st.inter === false ? 'GST' : null
      })
    }
    if (bad || lines.length === 0) continue
    const { draft, error } = buildInvoiceVoucher({
      key: `busy:${kind}:${g(h, 'series')}|${g(h, 'number')}|${date}`, kind, typeName: kind === 'sales' ? 'Sales' : 'Purchase', date,
      number: g(h, 'number') || null, party: g(h, 'party'), reference: null, narration: g(h, 'narration') || null,
      placeOfSupply: null, companyState: ctx.companyStateCode, lines, charges: [], total: null, dueDate: null,
      billRef: g(h, 'billRef') || g(h, 'number') || null, godown: g(h, 'mc') || null
    })
    if (error) errors.push({ line: h.line, message: error })
    else if (draft) drafts.push(draft)
  }
  return { result: { target: 'vouchers', rows: drafts }, errors }
}

export const BUSY_ACC_VOUCHER_FIELDS: FieldDef[] = [
  f('type', 'Vch Type', ['Voucher Type', 'Type'], true),
  f('date', 'Date', ['Vch Date', 'Voucher Date'], true),
  f('number', 'Vch No', ['Vch/Bill No', 'Voucher No']),
  f('account', 'Account', ['Account Name', 'Particulars'], true),
  f('drCr', 'Dr/Cr', ['D/C']),
  f('amount', 'Amount', []),
  f('debit', 'Debit', ['Dr Amt']),
  f('credit', 'Credit', ['Cr Amt']),
  f('narration', 'Short Narration', ['Narration']),
  f('billRef', 'Ref. No', ['Bill Ref', 'Against Ref']),
  f('billKind', 'Method', ['Ref Type', 'Method of Adj'])
]

/** Busy accounting vouchers (receipt / payment / journal / contra): one row per account line. */
function busyAccVouchers(records: MappedRecord[], ctx: ProfileContext): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const map = new Map<string, VoucherDraft>()
  let prev: VoucherDraft | null = null
  for (const r of records) {
    if (!g(r, 'account')) continue
    let d: VoucherDraft | null = null
    if (g(r, 'type') || g(r, 'date') || g(r, 'number')) {
      const date = val(errors, r.line, 'date', parseDate(g(r, 'date'), ctx.dateOrder))
      if (!date) continue
      const key = `busy:${g(r, 'type').toLowerCase()}|${g(r, 'number')}|${date}`
      d = map.get(key) ?? null
      if (!d) {
        d = {
          key, lines: [], typeName: g(r, 'type'), kind: kindFromWord(g(r, 'type')), date, number: g(r, 'number') || null, party: null,
          narration: g(r, 'narration') || null, reference: null, ledgerLines: [], items: [], bills: [], tds: null, tcs: null,
          posOverride: null, currencyCode: null, exchangeRate: null, isOptional: false, notes: []
        }
        map.set(key, d)
      }
    } else d = prev
    if (!d) {
      errors.push({ line: r.line, message: 'Account line before any voucher (type / date)' })
      continue
    }
    prev = d
    d.lines.push(r.line)
    const dr = val(errors, r.line, 'debit', parseMoney(g(r, 'debit'))) ?? 0
    const cr = val(errors, r.line, 'credit', parseMoney(g(r, 'credit'))) ?? 0
    let side: 'dr' | 'cr'
    let amount: number
    if (dr || cr) {
      side = dr - cr >= 0 ? 'dr' : 'cr'
      amount = Math.abs(dr - cr)
    } else {
      const a = val(errors, r.line, 'amount', parseSignedMoney(g(r, 'amount'), g(r, 'drCr'))) ?? 0
      side = a >= 0 ? 'dr' : 'cr'
      amount = Math.abs(a)
    }
    if (!amount) continue
    d.ledgerLines.push({ line: r.line, ledger: g(r, 'account'), drCr: side, amount })
    if (g(r, 'billRef')) d.bills.push({ line: r.line, kind: /new/i.test(g(r, 'billKind')) ? 'new' : 'against', name: g(r, 'billRef'), amount, dueDate: null })
  }
  return { result: { target: 'vouchers', rows: [...map.values()] }, errors }
}

const BUSY_CITES = [
  'https://busy.in/faqs/what-is-the-process-for-importing-data-from-excel-to-busy-answerid-55977/',
  'https://busy.in/faqs/data-conversion/voucher-import-export/15/',
  'https://busy.in/faqs/data-conversion/master-import-export/2/',
  'https://busy.in/faqs/how-to-configure-taxes-discounts-etc-in-sales-transactions-answerid-59644/'
]
const BUSY_EXCEL_UNVERIFIED = 'Busy has no fixed Excel headers (the user designs the format); the column names here follow Busy’s documented field names — check the mapping'

export const BUSY_PROFILES: SourceProfile[] = [
  {
    id: 'busy:accounts', source: 'busy', target: 'ledgers', label: 'Busy — Account masters', fields: BUSY_ACCOUNT_FIELDS,
    signature: ['Acc_name', 'Op. Bal.', 'GSTNo', 'ITPAN'], citations: BUSY_CITES,
    unverified: [BUSY_EXCEL_UNVERIFIED, 'A bare opening amount is read Dr-positive unless a Dr/Cr column is mapped'],
    transform: (r) => busyAccounts(r)
  },
  {
    id: 'busy:items', source: 'busy', target: 'items', label: 'Busy — Item masters', fields: BUSY_ITEM_FIELDS,
    signature: ['Item Opening Quantity', 'Item Opening Amount', 'Tax Category', 'Item Group'], citations: BUSY_CITES,
    unverified: [BUSY_EXCEL_UNVERIFIED, 'Tax category read as a GST rate ("GST 18%" → 18)'],
    transform: (r) => busyItems(r)
  },
  {
    id: 'busy:sales', source: 'busy', target: 'vouchers', label: 'Busy — Sales vouchers (item lines)', fields: BUSY_VOUCHER_FIELDS,
    signature: ['Sale Type', 'Vch Series', 'Material Centre', 'Voucher/Bill Number', 'Voucher/Bill Date'], citations: BUSY_CITES,
    unverified: [BUSY_EXCEL_UNVERIFIED, 'Item-wise / multi-rate sale types need IGST/CGST/SGST amount columns'],
    transform: (r, ctx) => busyTrade(r, ctx, 'sales')
  },
  {
    id: 'busy:purchases', source: 'busy', target: 'vouchers', label: 'Busy — Purchase vouchers (item lines)', fields: BUSY_VOUCHER_FIELDS,
    signature: ['Purchase Type', 'Purc Type', 'Vch Series', 'Material Centre'], citations: BUSY_CITES,
    unverified: [BUSY_EXCEL_UNVERIFIED, 'Item-wise / multi-rate purchase types need IGST/CGST/SGST amount columns'],
    transform: (r, ctx) => busyTrade(r, ctx, 'purchase')
  },
  {
    id: 'busy:accVouchers', source: 'busy', target: 'vouchers', label: 'Busy — Receipt / payment / journal vouchers', fields: BUSY_ACC_VOUCHER_FIELDS,
    signature: ['Vch Type', 'Short Narration'], citations: BUSY_CITES,
    unverified: [BUSY_EXCEL_UNVERIFIED],
    transform: (r, ctx) => busyAccVouchers(r, ctx)
  }
]

// ---------- Busy XML ----------

export interface BusyXmlImport {
  groups: GroupRow[]
  ledgers: LedgerRow[]
  units: UnitRow[]
  godowns: GodownRow[]
  items: ItemRow[]
  vouchers: VoucherDraft[]
  warnings: string[]
}

/** True when the text is a Busy XML export (root <BusyData>). */
export function isBusyXml(text: string): boolean {
  return /<BusyData[\s>]/.test(text.slice(0, 2000))
}

const busyVchSections: Record<string, { kind: VoucherDraft['kind']; typeName: string }> = {
  Sales: { kind: 'sales', typeName: 'Sales' },
  Purc: { kind: 'purchase', typeName: 'Purchase' },
  Purchases: { kind: 'purchase', typeName: 'Purchase' },
  SlRts: { kind: 'credit_note', typeName: 'Credit Note' },
  PrRts: { kind: 'debit_note', typeName: 'Debit Note' },
  Rcpts: { kind: 'receipt', typeName: 'Receipt' },
  Pymts: { kind: 'payment', typeName: 'Payment' },
  Jrnls: { kind: 'journal', typeName: 'Journal' },
  Contras: { kind: 'contra', typeName: 'Contra' },
  DrNotes: { kind: 'debit_note', typeName: 'Debit Note' },
  CrNotes: { kind: 'credit_note', typeName: 'Credit Note' }
}

/** Parse a Busy XML export into canonical rows (UNVERIFIED layout — see the file header). */
export function parseBusyXml(xml: string, dateOrder: DateOrder = 'dmy'): BusyXmlImport {
  const root = parseXml(xml)
  const out: BusyXmlImport = { groups: [], ledgers: [], units: [], godowns: [], items: [], vouchers: [], warnings: [] }
  const t = (n: XNode, tag: string): string => childText(n, tag).trim()
  const amount = (s: string): number => {
    const p = parseMoney(s)
    return 'ok' in p && p.ok !== null ? p.ok : 0
  }
  let line = 0
  for (const grp of collect(root, 'AccountGroup')) {
    line++
    const name = t(grp, 'Name')
    if (!name || BUSY_GROUP_MAP[name.toLowerCase()]) continue // a default group: already in Total's chart
    const parent = t(grp, 'ParentGroup')
    out.groups.push({ line, name, parent: parent ? mapBusyGroup(parent) : 'Suspense A/c' })
  }
  for (const a of collect(root, 'Account')) {
    line++
    const name = t(a, 'Name')
    if (!name) continue
    const addr = a.children.find((c) => c.tag === 'Address')
    const gst = addr ? t(addr, 'GSTNo') : ''
    const g2 = parseGstin(gst)
    const st = addr ? parseState(t(addr, 'StateName')) : { ok: null }
    const pan = addr ? parsePan(t(addr, 'ITPAN')) : { ok: null }
    const op = amount(t(a, 'OPBal'))
    out.ledgers.push({
      line, name, group: mapBusyGroup(t(a, 'ParentGroup') || 'Suspense Account'),
      // Busy XML: negative = Dr (like Tally) — flip to Total's Dr-positive.
      opening: op ? -op : null,
      gstin: 'ok' in g2 ? g2.ok : null, stateCode: 'ok' in st ? st.ok : null, pan: 'ok' in pan ? pan.ok : null,
      creditDays: t(a, 'CreditDaysForSale') ? Number(t(a, 'CreditDaysForSale')) || null : null, creditLimit: null,
      address: addr ? [t(addr, 'Address1'), t(addr, 'Address2'), t(addr, 'Address3'), t(addr, 'Address4')].filter(Boolean).join(', ') || null : null,
      taxType: ((): LedgerRow['taxType'] => {
        const tt = t(a, 'TaxType').toUpperCase()
        if (tt.startsWith('CGST')) return 'cgst'
        if (tt.startsWith('SGST')) return 'sgst'
        if (tt.startsWith('IGST')) return 'igst'
        if (tt.includes('CESS')) return 'cess'
        return null
      })(),
      gstRate: null, hsn: null
    })
    if ('error' in g2 && gst) out.warnings.push(`Account "${name}": ${g2.error} — GSTIN left blank`)
  }
  for (const u of collect(root, 'Unit')) {
    line++
    const name = t(u, 'Name')
    if (name) out.units.push({ line, name, symbol: name.slice(0, 12), decimals: null, uqc: null })
  }
  for (const mc of collect(root, 'MaterialCentre').concat(collect(root, 'MaterialCenter').filter((n) => n.children.length > 0 && t(n, 'Name')))) {
    line++
    const name = t(mc, 'Name')
    if (name && !out.godowns.some((gd) => gd.name === name)) out.godowns.push({ line, name, address: null })
  }
  for (const it of collect(root, 'Item')) {
    line++
    const name = t(it, 'Name')
    if (!name) continue
    const q = parseQty(t(it, 'OPStockInMainUnit'))
    const v = Math.abs(amount(t(it, 'OPAmount')))
    out.items.push({
      line, name, group: t(it, 'ParentGroup') || null, unit: t(it, 'MainUnit') || null, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 'ok' in q && q.ok !== null ? Math.abs(q.ok) : null, openingValue: v || null, openingRate: null, mrpPaise: null,
      barcode: null, reorderLevelMilli: null
    })
  }
  for (const [section, meta] of Object.entries(busyVchSections)) {
    for (const sec of collect(root, section)) {
      for (const v of sec.children) {
        line++
        const dateP = parseDate(t(v, 'Date'), dateOrder)
        const date = 'ok' in dateP ? dateP.ok : null
        if (!date) {
          out.warnings.push(`${meta.typeName} ${t(v, 'VchNo')} skipped: bad date "${t(v, 'Date')}"`)
          continue
        }
        const ledgerLines: VoucherDraft['ledgerLines'] = []
        const bills: VoucherDraft['bills'] = []
        for (const e of collect(v, 'AccDetail')) {
          const acc = t(e, 'AccountName')
          const amt = Math.abs(amount(t(e, 'AmtMainCur') || t(e, 'Amount')))
          const at = t(e, 'AmountType')
          if (!acc || !amt) continue
          const drCr: 'dr' | 'cr' = at === '1' || /^d/i.test(at) ? 'dr' : 'cr'
          ledgerLines.push({ line, ledger: acc, drCr, amount: amt })
          for (const br of collect(e, 'BillRef').concat(collect(e, 'BillReference'))) {
            const ref = t(br, 'RefNo')
            if (ref) bills.push({ line, kind: t(br, 'Method') === '1' || /new/i.test(t(br, 'Method')) ? 'new' : 'against', name: ref, amount: Math.abs(amount(t(br, 'Value1'))) || null, dueDate: null })
          }
        }
        const items: VoucherDraft['items'] = []
        for (const it of collect(v, 'ItemDetail')) {
          const q = parseQty(t(it, 'Qty'))
          const qty = 'ok' in q && q.ok ? Math.abs(q.ok) : 0
          if (!t(it, 'ItemName') || !qty) continue
          const amt = Math.abs(amount(t(it, 'Amt')))
          items.push({
            line, item: t(it, 'ItemName'), godown: t(it, 'MC') || null, batch: null, qtyMilli: qty, ratePaise: Math.abs(amount(t(it, 'Price'))) || null,
            amount: amt || null, direction: meta.kind === 'purchase' || meta.kind === 'credit_note' ? 'in' : 'out'
          })
        }
        if (ledgerLines.length === 0) {
          out.warnings.push(`${meta.typeName} ${t(v, 'VchNo') || date} skipped: no account entries (AccEntries) in the export`)
          continue
        }
        out.vouchers.push({
          key: `busyxml:${section}:${t(v, 'VchSeriesName')}|${t(v, 'VchNo')}|${date}`, lines: [line], typeName: meta.typeName, kind: meta.kind, date,
          number: t(v, 'VchNo') || null, party: t(v, 'MasterName1') || null,
          narration: (() => {
            const o = v.children.find((c) => c.tag === 'VchOtherInfoDetails')
            return o ? [t(o, 'Narration1'), t(o, 'Narration2')].filter(Boolean).join(' ') || null : null
          })(),
          reference: null, ledgerLines, items, bills, tds: null, tcs: null, posOverride: null, currencyCode: null, exchangeRate: null,
          isOptional: false, notes: []
        })
      }
    }
  }
  return out
}
