/**
 * Import targets (WP 6.3): what the wizard can create, the canonical fields of each, and the pure
 * parse from mapped cell text to canonical rows with row-level errors. The field LABELS double as
 * the column headers of the Books export workbook (books.ts), so a Total export maps itself.
 *
 * Nothing here touches the database: name → id resolution, duplicate detection and the posting
 * rules run in the main process (services/dataImport.ts), through the existing services.
 */
import type { VoucherKind } from '../domain'
import {
  parseBool, parseDate, parseDrCr, parseGstin, parseHsn, parseInt0, parseMoney, parsePan, parsePercent, parseQty,
  parseSignedMoney, parseState, parseText, type DateOrder, type Parsed
} from './values'

export const TARGET_IDS = [
  'groups', 'ledgers', 'parties', 'units', 'stockGroups', 'godowns', 'items', 'batches', 'priceLists',
  'openings', 'stockOpenings', 'voucherTypes', 'vouchers', 'tradeDocs', 'bank'
] as const
export type TargetId = (typeof TARGET_IDS)[number]

export interface FieldDef {
  key: string
  label: string
  required?: boolean
  /** Extra header spellings recognised by auto-detect (the label always is). */
  aliases?: string[]
  hint?: string
}

export interface TargetDef {
  id: TargetId
  label: string
  section: 'Masters' | 'Balances' | 'Transactions'
  description: string
  fields: FieldDef[]
  /** Duplicates are matched on this (case-insensitive). */
  matchOn: string
}

export interface RowError {
  /** Source row (1-based spreadsheet row / CSV line). */
  line: number
  field?: string
  message: string
}

/** One source row's mapped cell texts, by field key ('' when unmapped / blank). */
export interface MappedRecord {
  line: number
  values: Record<string, string>
}

// ---------- canonical rows ----------

export interface GroupRow { line: number; name: string; parent: string }
export interface LedgerRow {
  line: number; name: string; group: string | null; opening: number | null; gstin: string | null; stateCode: string | null
  pan: string | null; creditDays: number | null; creditLimit: number | null; address: string | null
  taxType: 'cgst' | 'sgst' | 'igst' | 'cess' | null; gstRate: number | null; hsn: string | null
  /** parties only: customer / vendor (decides the default group). */
  partyType?: 'customer' | 'vendor' | null
}
export interface UnitRow { line: number; name: string; symbol: string | null; decimals: number | null; uqc: string | null }
export interface StockGroupRow { line: number; name: string; parent: string | null }
export interface GodownRow { line: number; name: string; address: string | null }
export interface ItemRow {
  line: number; name: string; group: string | null; unit: string | null; hsn: string | null; gstRate: number | null
  cessRate: number | null; openingQtyMilli: number | null; openingValue: number | null; openingRate: number | null
  mrpPaise: number | null; barcode: string | null; reorderLevelMilli: number | null
}
export interface BatchRow { line: number; item: string; name: string; mfgDate: string | null; expiryDate: string | null }
export interface PriceRow { line: number; level: string; item: string; rate: number; from: string | null; minQtyMilli: number | null }
export interface OpeningRow { line: number; ledger: string; opening: number }
export interface StockOpeningRow { line: number; item: string; qtyMilli: number; value: number | null; rate: number | null }
export interface VoucherTypeRow { line: number; name: string; kind: VoucherKind | null; prefix: string | null }
export interface BankRow { line: number; date: string; description: string; reference: string; deposit: number; withdrawal: number }

export interface VoucherDraftLedgerLine { line: number; ledger: string; drCr: 'dr' | 'cr'; amount: number }
export interface VoucherDraftItemLine {
  line: number; item: string; godown: string | null; batch: string | null; qtyMilli: number; ratePaise: number | null
  amount: number | null; direction: 'in' | 'out' | null
}
export interface VoucherDraftBill { line: number; kind: 'new' | 'against'; name: string; amount: number | null; dueDate: string | null }

/** A whole voucher assembled from one or more rows. */
export interface VoucherDraft {
  key: string
  lines: number[]
  typeName: string
  /** Kind when the type must be created (or the type column held a kind word). */
  kind: VoucherKind | null
  date: string
  number: string | null
  party: string | null
  narration: string | null
  reference: string | null
  ledgerLines: VoucherDraftLedgerLine[]
  items: VoucherDraftItemLine[]
  bills: VoucherDraftBill[]
  tds: { section: string; base: number; amount: number } | null
  tcs: { section: string; base: number; amount: number } | null
  posOverride: string | null
  currencyCode: string | null
  exchangeRate: number | null
  isOptional: boolean
  /** Post-dated: kept out of the books until its date (absent = no). */
  postDated?: boolean
  /** Source-specific warnings worth showing (e.g. a Zoho round-off folded into a ledger). */
  notes: string[]
}

export interface TradeDocDraft {
  key: string
  lines: number[]
  kind: 'quotation' | 'sales_order' | 'purchase_order'
  series: string | null
  date: string
  number: string | null
  party: string
  dueDate: string | null
  validUntil: string | null
  reference: string | null
  narration: string | null
  items: { line: number; item: string; godown: string | null; qtyMilli: number; ratePaise: number; discountPaise: number; amount: number; dueDate: string | null }[]
}

export type TargetRows =
  | { target: 'groups'; rows: GroupRow[] }
  | { target: 'ledgers' | 'parties'; rows: LedgerRow[] }
  | { target: 'units'; rows: UnitRow[] }
  | { target: 'stockGroups'; rows: StockGroupRow[] }
  | { target: 'godowns'; rows: GodownRow[] }
  | { target: 'items'; rows: ItemRow[] }
  | { target: 'batches'; rows: BatchRow[] }
  | { target: 'priceLists'; rows: PriceRow[] }
  | { target: 'openings'; rows: OpeningRow[] }
  | { target: 'stockOpenings'; rows: StockOpeningRow[] }
  | { target: 'voucherTypes'; rows: VoucherTypeRow[] }
  | { target: 'vouchers'; rows: VoucherDraft[] }
  | { target: 'tradeDocs'; rows: TradeDocDraft[] }
  | { target: 'bank'; rows: BankRow[] }

// ---------- field catalogue ----------

const f = (key: string, label: string, opts: Omit<FieldDef, 'key' | 'label'> = {}): FieldDef => ({ key, label, ...opts })

const NAME = (aliases: string[] = []): FieldDef => f('name', 'Name', { required: true, aliases: ['name', ...aliases] })

const LEDGER_FIELDS: FieldDef[] = [
  NAME(['ledger name', 'ledger', 'account name', 'account', 'acc name', 'acc_name', 'particulars', 'display name']),
  f('group', 'Group', { aliases: ['under', 'group name', 'parent', 'parent group', 'account group', 'account type', 'acc group'] }),
  f('opening', 'Opening Balance', { aliases: ['opening', 'op bal', 'op. bal.', 'op. bal', 'opening bal', 'opening balance (dr +)', 'op balance'], hint: 'Dr positive; "1,000 Cr" or a Dr/Cr column also work' }),
  f('openingDrCr', 'Opening Dr/Cr', { aliases: ['dr/cr', 'drcr', 'op. bal. dr/cr', 'balance type', 'type of balance'] }),
  f('gstin', 'GSTIN', { aliases: ['gst no', 'gst number', 'gstin/uin', 'gst identification number (gstin)', 'gstno', 'gst in'] }),
  f('state', 'State', { aliases: ['state code', 'state name', 'place of supply', 'billing state'] }),
  f('pan', 'PAN', { aliases: ['pan no', 'pan number', 'it pan', 'itpan', 'income tax pan'] }),
  f('creditDays', 'Credit Days', { aliases: ['credit period', 'credit period days', 'payment terms', 'credit days for sale'] }),
  f('creditLimit', 'Credit Limit', { aliases: ['credit limit amount'] }),
  f('address', 'Address', { aliases: ['billing address', 'address1', 'address 1', 'address line 1'] }),
  f('taxType', 'Tax Type', { aliases: ['duty type', 'type of duty/tax', 'gst type'], hint: 'cgst / sgst / igst / cess — tax ledgers only' }),
  f('gstRate', 'GST Rate', { aliases: ['gst %', 'gst%', 'rate of tax', 'tax rate', 'percentage of calculation'] }),
  f('hsn', 'HSN', { aliases: ['hsn/sac', 'hsn code', 'sac'] })
]

const PARTY_FIELDS: FieldDef[] = [
  NAME(['party name', 'party', 'customer name', 'vendor name', 'supplier name', 'ledger name', 'account name', 'display name', 'company name']),
  ...LEDGER_FIELDS.filter((x) => x.key !== 'name' && x.key !== 'taxType' && x.key !== 'gstRate' && x.key !== 'hsn'),
  f('partyType', 'Party Type', { aliases: ['contact type', 'customer/vendor', 'type'], hint: 'customer or vendor — picks Sundry Debtors / Creditors when Group is blank' })
]

export const TARGETS: Record<TargetId, TargetDef> = {
  groups: {
    id: 'groups', label: 'Account groups', section: 'Masters', matchOn: 'name',
    description: 'Sub-groups of the chart of accounts. Nature follows the parent group.',
    fields: [NAME(['group name', 'group']), f('parent', 'Under', { required: true, aliases: ['parent', 'parent group', 'under group', 'primary group'] })]
  },
  ledgers: {
    id: 'ledgers', label: 'Ledgers', section: 'Masters', matchOn: 'name',
    description: 'Any ledger with its group, opening balance and GST details.',
    fields: LEDGER_FIELDS
  },
  parties: {
    id: 'parties', label: 'Parties (customers & suppliers)', section: 'Masters', matchOn: 'name',
    description: 'Debtors and creditors with GSTIN, PAN, state and credit terms.',
    fields: PARTY_FIELDS
  },
  units: {
    id: 'units', label: 'Units of measure', section: 'Masters', matchOn: 'name',
    description: 'Units with decimals and the GST portal UQC.',
    fields: [NAME(['unit name', 'unit', 'uom']), f('symbol', 'Symbol', { aliases: ['unit symbol', 'short name'] }), f('decimals', 'Decimals', { aliases: ['decimal places', 'no. of decimal places'] }), f('uqc', 'UQC', { aliases: ['unit quantity code', 'gst uqc'] })]
  },
  stockGroups: {
    id: 'stockGroups', label: 'Stock groups', section: 'Masters', matchOn: 'name',
    description: 'Groups for stock items (nested by "Under").',
    fields: [NAME(['stock group', 'item group', 'group name']), f('parent', 'Under', { aliases: ['parent', 'parent group'] })]
  },
  godowns: {
    id: 'godowns', label: 'Godowns / locations', section: 'Masters', matchOn: 'name',
    description: 'Storage locations (Busy: material centres).',
    fields: [NAME(['godown', 'godown name', 'location', 'material centre', 'material center', 'mc name']), f('address', 'Address')]
  },
  items: {
    id: 'items', label: 'Stock items', section: 'Masters', matchOn: 'name',
    description: 'Items with unit, HSN, GST rate and opening stock.',
    fields: [
      NAME(['item name', 'item', 'stock item', 'product name', 'product']),
      f('group', 'Group', { aliases: ['stock group', 'item group', 'category', 'parent group'] }),
      f('unit', 'Unit', { aliases: ['uom', 'units', 'unit name', 'main unit', 'usage unit', 'base unit'] }),
      f('hsn', 'HSN', { aliases: ['hsn/sac', 'hsn code', 'hsn/sac code', 'sac'] }),
      f('gstRate', 'GST Rate', { aliases: ['gst%', 'gst rate %', 'tax rate', 'tax percentage', 'igst rate', 'gst %'] }),
      f('cessRate', 'Cess Rate', { aliases: ['cess %', 'cess'] }),
      f('openingQty', 'Opening Qty', { aliases: ['opening quantity', 'op. stock', 'op stock', 'opening stock', 'item opening quantity', 'op. qty'] }),
      f('openingValue', 'Opening Value', { aliases: ['opening amount', 'op. amount', 'opening stock value', 'item opening amount', 'op. value'] }),
      f('openingRate', 'Opening Rate', { aliases: ['rate per unit', 'opening rate per unit'] }),
      f('mrp', 'MRP', { aliases: ['max retail price'] }),
      f('barcode', 'Barcode', { aliases: ['sku', 'ean', 'upc'] }),
      f('reorderLevel', 'Reorder Level', { aliases: ['reorder point', 'min stock', 'minimum level'] })
    ]
  },
  batches: {
    id: 'batches', label: 'Batches', section: 'Masters', matchOn: 'name',
    description: 'Batch / lot numbers with manufacturing and expiry dates.',
    fields: [
      f('item', 'Item', { required: true, aliases: ['item name', 'stock item'] }),
      f('name', 'Batch', { required: true, aliases: ['batch name', 'batch no', 'lot', 'lot no'] }),
      f('mfgDate', 'Mfg Date', { aliases: ['manufacturing date', 'mfg. date'] }),
      f('expiryDate', 'Expiry Date', { aliases: ['expiry', 'exp date', 'exp. date', 'best before'] })
    ]
  },
  priceLists: {
    id: 'priceLists', label: 'Price lists', section: 'Masters', matchOn: 'item',
    description: 'Rates per price level and item, effective from a date.',
    fields: [
      f('level', 'Price Level', { required: true, aliases: ['price list', 'price level name', 'level'] }),
      f('item', 'Item', { required: true, aliases: ['item name', 'stock item'] }),
      f('rate', 'Rate', { required: true, aliases: ['price', 'selling price', 'sale price'] }),
      f('from', 'From Date', { aliases: ['effective from', 'applicable from', 'date'] }),
      f('minQty', 'Min Qty', { aliases: ['from qty', 'minimum quantity'] })
    ]
  },
  openings: {
    id: 'openings', label: 'Opening balances', section: 'Balances', matchOn: 'ledger',
    description: 'Ledger openings as on the books start, checked so Dr = Cr.',
    fields: [
      f('ledger', 'Ledger', { required: true, aliases: ['ledger name', 'name', 'account', 'account name', 'particulars'] }),
      f('opening', 'Opening Balance', { aliases: ['opening', 'balance', 'amount', 'closing balance'] }),
      f('drCr', 'Dr/Cr', { aliases: ['dr / cr', 'type'] }),
      f('debit', 'Debit', { aliases: ['dr', 'debit amount', 'dr amount'] }),
      f('credit', 'Credit', { aliases: ['cr', 'credit amount', 'cr amount'] })
    ]
  },
  stockOpenings: {
    id: 'stockOpenings', label: 'Opening stock', section: 'Balances', matchOn: 'item',
    description: 'Opening quantity and value per item (feeds the valuation pass).',
    fields: [
      f('item', 'Item', { required: true, aliases: ['item name', 'stock item', 'name'] }),
      f('qty', 'Quantity', { required: true, aliases: ['qty', 'opening qty', 'opening quantity', 'closing qty'] }),
      f('value', 'Value', { aliases: ['amount', 'opening value', 'closing value'] }),
      f('rate', 'Rate', { aliases: ['rate per unit', 'cost', 'unit cost'] })
    ]
  },
  voucherTypes: {
    id: 'voucherTypes', label: 'Voucher types', section: 'Masters', matchOn: 'name',
    description: 'Extra voucher types (numbering series) of a kind.',
    fields: [NAME(['voucher type', 'type name']), f('kind', 'Kind', { aliases: ['type of voucher', 'base type'] }), f('prefix', 'Prefix')]
  },
  vouchers: {
    id: 'vouchers', label: 'Vouchers', section: 'Transactions', matchOn: 'number',
    description: 'Journal, sales, purchase, receipt, payment (and other) vouchers — one row per ledger, item or bill line.',
    fields: [
      f('key', 'Voucher Key', { aliases: ['voucher id', 'vch key', 'entry id'], hint: 'Rows with the same key form one voucher. Without it: Type + Number + Date' }),
      f('type', 'Voucher Type', { aliases: ['type', 'vch type', 'voucher', 'vch/bill type'] }),
      f('date', 'Date', { aliases: ['voucher date', 'vch date', 'bill date', 'invoice date', 'voucher/bill date', 'vch/bill date', 'journal date'] }),
      f('number', 'Number', { aliases: ['voucher no', 'voucher number', 'vch no', 'vch no.', 'bill no', 'invoice no', 'invoice number', 'voucher/bill number', 'vch/bill no'] }),
      f('party', 'Party', { aliases: ['party name', 'party a/c', 'customer', 'customer name', 'vendor', 'vendor name', 'supplier'] }),
      f('narration', 'Narration', { aliases: ['remarks', 'notes', 'description', 'short narration'] }),
      f('reference', 'Reference', { aliases: ['ref', 'ref no', 'reference no', 'reference number', 'supplier invoice no'] }),
      f('ledger', 'Ledger', { aliases: ['account', 'account name', 'ledger name', 'particulars', 'by/to'] }),
      f('drCr', 'Dr/Cr', { aliases: ['dr / cr', 'debit/credit', 'side'] }),
      f('amount', 'Amount', { aliases: ['ledger amount', 'value'] }),
      f('debit', 'Debit', { aliases: ['dr amount', 'debit amount'] }),
      f('credit', 'Credit', { aliases: ['cr amount', 'credit amount'] }),
      f('item', 'Item', { aliases: ['item name', 'stock item', 'product'] }),
      f('godown', 'Godown', { aliases: ['material centre', 'material center', 'location', 'mat. centre', 'mat.centre'] }),
      f('batch', 'Batch', { aliases: ['batch no', 'lot'] }),
      f('qty', 'Quantity', { aliases: ['qty', 'billed qty', 'actual qty'] }),
      f('rate', 'Rate', { aliases: ['price', 'item rate', 'unit price'] }),
      f('itemAmount', 'Item Amount', { aliases: ['item value', 'taxable value', 'item total'] }),
      f('direction', 'Direction', { hint: 'in / out — defaults from the voucher kind' }),
      f('billRef', 'Bill Ref', { aliases: ['bill reference', 'bill ref no', 'ref. no', 'agst ref', 'against ref', 'invoice ref'] }),
      f('billKind', 'Bill Ref Type', { aliases: ['ref type', 'bill type', 'method of adj'], hint: 'new / against — defaults new on sales & purchase, against on receipts & payments' }),
      f('billAmount', 'Bill Amount', { aliases: ['bill ref amount'] }),
      f('dueDate', 'Due Date', { aliases: ['bill due date', 'due on'] }),
      f('tdsSection', 'TDS Section'), f('tdsBase', 'TDS Base'), f('tdsAmount', 'TDS Amount'),
      f('tcsSection', 'TCS Section'), f('tcsBase', 'TCS Base'), f('tcsAmount', 'TCS Amount'),
      f('placeOfSupply', 'Place of Supply', { aliases: ['pos'] }),
      f('currency', 'Currency', { aliases: ['currency code'] }),
      f('exchangeRate', 'Exchange Rate'),
      f('optional', 'Optional', { aliases: ['is optional', 'memorandum'] }),
      f('postDated', 'Post-dated', { aliases: ['post dated', 'pdc'] })
    ]
  },
  tradeDocs: {
    id: 'tradeDocs', label: 'Quotations & orders', section: 'Transactions', matchOn: 'number',
    description: 'Quotations, sales orders and purchase orders — one row per item line.',
    fields: [
      f('key', 'Document Key', { aliases: ['order key'] }),
      f('kind', 'Kind', { required: true, aliases: ['document kind', 'order type'], hint: 'quotation / sales_order / purchase_order' }),
      f('series', 'Series', { aliases: ['document type'] }),
      f('date', 'Date', { required: true, aliases: ['order date'] }),
      f('number', 'Number', { aliases: ['order no', 'order number'] }),
      f('party', 'Party', { required: true, aliases: ['party name', 'customer', 'vendor'] }),
      f('dueDate', 'Due Date', { aliases: ['delivery date', 'expected date'] }),
      f('validUntil', 'Valid Until'),
      f('reference', 'Reference'),
      f('narration', 'Narration'),
      f('item', 'Item', { required: true, aliases: ['item name', 'stock item'] }),
      f('godown', 'Godown'),
      f('qty', 'Quantity', { required: true, aliases: ['qty'] }),
      f('rate', 'Rate', { aliases: ['price'] }),
      f('discount', 'Discount'),
      f('amount', 'Amount', { aliases: ['item amount', 'value'] }),
      f('lineDueDate', 'Line Due Date')
    ]
  },
  bank: {
    id: 'bank', label: 'Bank statement lines', section: 'Transactions', matchOn: 'date',
    description: 'Statement rows handed to Banking to match and reconcile against the books.',
    fields: [
      f('date', 'Date', { required: true, aliases: ['txn date', 'transaction date', 'value date', 'posting date'] }),
      f('description', 'Description', { aliases: ['narration', 'particulars', 'remarks', 'details'] }),
      f('reference', 'Reference', { aliases: ['chq no', 'cheque no', 'chq./ref.no.', 'ref no', 'utr', 'reference no'] }),
      f('withdrawal', 'Withdrawal', { aliases: ['debit', 'withdrawal amt', 'withdrawal amount', 'dr', 'debit amount'] }),
      f('deposit', 'Deposit', { aliases: ['credit', 'deposit amt', 'deposit amount', 'cr', 'credit amount'] }),
      f('amount', 'Amount', { aliases: ['transaction amount'], hint: 'Signed: + deposit, − withdrawal (when there are no separate columns)' })
    ]
  }
}

export const VOUCHER_KIND_WORDS: Record<string, VoucherKind> = {
  journal: 'journal', jrnl: 'journal', jv: 'journal',
  sales: 'sales', sale: 'sales', invoice: 'sales', 'tax invoice': 'sales',
  purchase: 'purchase', bill: 'purchase', purc: 'purchase',
  receipt: 'receipt', rcpt: 'receipt', 'customer payment': 'receipt',
  payment: 'payment', pymt: 'payment', 'vendor payment': 'payment',
  contra: 'contra',
  'credit note': 'credit_note', credit_note: 'credit_note', 'sales return': 'credit_note', 'sale return': 'credit_note',
  'debit note': 'debit_note', debit_note: 'debit_note', 'purchase return': 'debit_note',
  'stock journal': 'stock_journal', stock_journal: 'stock_journal',
  'delivery note': 'delivery_note', delivery_note: 'delivery_note', 'receipt note': 'receipt_note', receipt_note: 'receipt_note'
}

/** A voucher-type cell's kind, when it names one ("Sales", "Sale Return", "credit_note"). */
export function kindFromWord(word: string): VoucherKind | null {
  const w = word.trim().toLowerCase().replace(/\s+/g, ' ')
  if (VOUCHER_KIND_WORDS[w]) return VOUCHER_KIND_WORDS[w]!
  for (const [k, v] of Object.entries(VOUCHER_KIND_WORDS)) if (k.length > 3 && w.includes(k)) return v
  return null
}

/** Goods move in on purchases, credit notes (sales returns) and GRNs; out on the rest. */
export function defaultDirection(kind: VoucherKind | null): 'in' | 'out' {
  return kind === 'purchase' || kind === 'credit_note' || kind === 'receipt_note' ? 'in' : 'out'
}

// ---------- parsing ----------

interface Ctx {
  rec: MappedRecord
  errors: RowError[]
  bad: boolean
  dateOrder: DateOrder
}

function take<T>(c: Ctx, key: string, parse: (raw: string) => Parsed<T>): T | null {
  const raw = c.rec.values[key] ?? ''
  const r = parse(raw)
  if ('error' in r) {
    c.errors.push({ line: c.rec.line, field: key, message: r.error })
    c.bad = true
    return null
  }
  return r.ok
}

function need(c: Ctx, key: string, label: string): string {
  const v = (c.rec.values[key] ?? '').trim()
  if (!v) {
    c.errors.push({ line: c.rec.line, field: key, message: `${label} is missing` })
    c.bad = true
  }
  return v
}

const text = (c: Ctx, key: string, max = 500): string | null => take(c, key, (r) => parseText(r, max))

function parseTaxType(raw: string): Parsed<LedgerRow['taxType']> {
  const t = raw.trim().toLowerCase()
  if (!t || t === 'others' || t === 'other' || t === 'none') return { ok: null }
  if (t.includes('cess')) return { ok: 'cess' }
  if (t.startsWith('cgst') || t === 'central tax') return { ok: 'cgst' }
  if (t.startsWith('sgst') || t.startsWith('utgst') || t === 'state tax') return { ok: 'sgst' }
  if (t.startsWith('igst') || t === 'integrated tax') return { ok: 'igst' }
  return { error: `Tax type "${raw}" is not CGST, SGST, IGST or Cess` }
}

function parsePartyType(raw: string): Parsed<'customer' | 'vendor' | null> {
  const t = raw.trim().toLowerCase()
  if (!t) return { ok: null }
  if (/customer|debtor|buyer|client|receivable/.test(t)) return { ok: 'customer' }
  if (/vendor|supplier|creditor|payable/.test(t)) return { ok: 'vendor' }
  return { error: `Party type "${raw}" is not customer or vendor` }
}

function ledgerRow(c: Ctx, party: boolean): LedgerRow {
  const name = need(c, 'name', 'Name')
  return {
    line: c.rec.line,
    name,
    group: text(c, 'group', 120),
    opening: take(c, 'opening', (r) => parseSignedMoney(r, c.rec.values.openingDrCr ?? '')),
    gstin: take(c, 'gstin', parseGstin),
    stateCode: take(c, 'state', parseState),
    pan: take(c, 'pan', parsePan),
    creditDays: take(c, 'creditDays', (r) => parseInt0(r.replace(/^net\s*/i, '').replace(/\s*days?$/i, ''), 3650)),
    creditLimit: take(c, 'creditLimit', parseMoney),
    address: text(c, 'address'),
    taxType: party ? null : take(c, 'taxType', parseTaxType),
    gstRate: party ? null : take(c, 'gstRate', (r) => parsePercent(r)),
    hsn: party ? null : take(c, 'hsn', parseHsn),
    ...(party ? { partyType: take(c, 'partyType', parsePartyType) } : {})
  }
}

function oneOf<T extends string>(raw: string, options: readonly T[], label: string): Parsed<T | null> {
  const t = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!t) return { ok: null }
  const hit = options.find((o) => o === t)
  return hit ? { ok: hit } : { error: `${label} "${raw}" is not one of ${options.join(', ')}` }
}

/** Mapped records → canonical rows for the generic (and Total books) profiles. */
export function parseTarget(target: TargetId, records: MappedRecord[], opts: { dateOrder?: DateOrder } = {}): { result: TargetRows; errors: RowError[] } {
  const errors: RowError[] = []
  const dateOrder = opts.dateOrder ?? 'dmy'
  const each = <T>(fn: (c: Ctx) => T): T[] => {
    const out: T[] = []
    for (const rec of records) {
      if (Object.values(rec.values).every((v) => !v || !v.trim())) continue // blank row
      const c: Ctx = { rec, errors, bad: false, dateOrder }
      const row = fn(c)
      if (!c.bad) out.push(row)
    }
    return out
  }
  const date = (c: Ctx, key: string): string | null => take(c, key, (r) => parseDate(r, c.dateOrder))

  switch (target) {
    case 'groups':
      return { result: { target, rows: each((c) => ({ line: c.rec.line, name: need(c, 'name', 'Name'), parent: need(c, 'parent', 'Under') })) }, errors }
    case 'ledgers':
    case 'parties':
      return { result: { target, rows: each((c) => ledgerRow(c, target === 'parties')) }, errors }
    case 'units':
      return {
        result: {
          target,
          rows: each((c) => ({
            line: c.rec.line, name: need(c, 'name', 'Name'), symbol: text(c, 'symbol', 12),
            decimals: take(c, 'decimals', (r) => parseInt0(r, 3)), uqc: text(c, 'uqc', 8)
          }))
        },
        errors
      }
    case 'stockGroups':
      return { result: { target, rows: each((c) => ({ line: c.rec.line, name: need(c, 'name', 'Name'), parent: text(c, 'parent', 120) })) }, errors }
    case 'godowns':
      return { result: { target, rows: each((c) => ({ line: c.rec.line, name: need(c, 'name', 'Name'), address: text(c, 'address') })) }, errors }
    case 'items':
      return {
        result: {
          target,
          rows: each((c) => {
            const row: ItemRow = {
              line: c.rec.line, name: need(c, 'name', 'Name'), group: text(c, 'group', 120), unit: text(c, 'unit', 60),
              hsn: take(c, 'hsn', parseHsn), gstRate: take(c, 'gstRate', (r) => parsePercent(r)), cessRate: take(c, 'cessRate', (r) => parsePercent(r, 300)),
              openingQtyMilli: take(c, 'openingQty', parseQty), openingValue: take(c, 'openingValue', parseMoney),
              openingRate: take(c, 'openingRate', parseMoney), mrpPaise: take(c, 'mrp', parseMoney), barcode: text(c, 'barcode', 64),
              reorderLevelMilli: take(c, 'reorderLevel', parseQty)
            }
            if ((row.openingQtyMilli ?? 0) < 0 || (row.openingValue ?? 0) < 0) {
              c.errors.push({ line: c.rec.line, field: 'openingQty', message: 'Opening stock cannot be negative' })
              c.bad = true
            }
            return row
          })
        },
        errors
      }
    case 'batches':
      return {
        result: { target, rows: each((c) => ({ line: c.rec.line, item: need(c, 'item', 'Item'), name: need(c, 'name', 'Batch'), mfgDate: date(c, 'mfgDate'), expiryDate: date(c, 'expiryDate') })) },
        errors
      }
    case 'priceLists':
      return {
        result: {
          target,
          rows: each((c) => {
            const rate = take(c, 'rate', parseMoney)
            if (rate === null && !c.bad) {
              c.errors.push({ line: c.rec.line, field: 'rate', message: 'Rate is missing' })
              c.bad = true
            }
            return { line: c.rec.line, level: need(c, 'level', 'Price level'), item: need(c, 'item', 'Item'), rate: rate ?? 0, from: date(c, 'from'), minQtyMilli: take(c, 'minQty', parseQty) }
          })
        },
        errors
      }
    case 'openings':
      return {
        result: {
          target,
          rows: each((c) => {
            const ledger = need(c, 'ledger', 'Ledger')
            const signed = take(c, 'opening', (r) => parseSignedMoney(r, c.rec.values.drCr ?? ''))
            const dr = take(c, 'debit', parseMoney)
            const cr = take(c, 'credit', parseMoney)
            const opening = signed ?? (dr ?? 0) - (cr ?? 0)
            return { line: c.rec.line, ledger, opening }
          })
        },
        errors
      }
    case 'stockOpenings':
      return {
        result: {
          target,
          rows: each((c) => {
            const qty = take(c, 'qty', parseQty)
            if (qty === null && !c.bad) {
              c.errors.push({ line: c.rec.line, field: 'qty', message: 'Quantity is missing' })
              c.bad = true
            } else if ((qty ?? 0) < 0) {
              c.errors.push({ line: c.rec.line, field: 'qty', message: 'Opening quantity cannot be negative' })
              c.bad = true
            }
            return { line: c.rec.line, item: need(c, 'item', 'Item'), qtyMilli: qty ?? 0, value: take(c, 'value', parseMoney), rate: take(c, 'rate', parseMoney) }
          })
        },
        errors
      }
    case 'voucherTypes':
      return {
        result: {
          target,
          rows: each((c) => {
            const name = need(c, 'name', 'Name')
            const kindRaw = c.rec.values.kind ?? ''
            const kind = kindRaw.trim() ? kindFromWord(kindRaw) : kindFromWord(name)
            if (kindRaw.trim() && !kind) {
              c.errors.push({ line: c.rec.line, field: 'kind', message: `Kind "${kindRaw}" is not a voucher kind` })
              c.bad = true
            }
            return { line: c.rec.line, name, kind, prefix: text(c, 'prefix', 20) }
          })
        },
        errors
      }
    case 'bank':
      return {
        result: {
          target,
          rows: each((c) => {
            const d = date(c, 'date')
            if (!d && !c.bad) {
              c.errors.push({ line: c.rec.line, field: 'date', message: 'Date is missing' })
              c.bad = true
            }
            const w = take(c, 'withdrawal', parseMoney)
            const dep = take(c, 'deposit', parseMoney)
            const amt = take(c, 'amount', parseMoney)
            let deposit = Math.abs(dep ?? 0)
            let withdrawal = Math.abs(w ?? 0)
            if (deposit === 0 && withdrawal === 0 && amt) {
              if (amt > 0) deposit = amt
              else withdrawal = -amt
            }
            if (deposit === 0 && withdrawal === 0 && !c.bad) {
              c.errors.push({ line: c.rec.line, field: 'amount', message: 'No deposit or withdrawal amount' })
              c.bad = true
            }
            return { line: c.rec.line, date: d ?? '', description: c.rec.values.description?.trim() ?? '', reference: c.rec.values.reference?.trim() ?? '', deposit, withdrawal }
          })
        },
        errors
      }
    case 'vouchers':
      return groupVoucherRecords(records, dateOrder, errors)
    case 'tradeDocs':
      return groupTradeDocRecords(records, dateOrder, errors)
  }
}

/** Rows → vouchers. Rows sharing a key (or Type + Number + Date) form one voucher; a row whose
 *  key, type, number and date are ALL blank continues the voucher above it (Busy / Excel style:
 *  the header fields appear on the first line only). */
function groupVoucherRecords(records: MappedRecord[], dateOrder: DateOrder, errors: RowError[]): { result: TargetRows; errors: RowError[] } {
  const drafts = new Map<string, VoucherDraft>()
  const order: VoucherDraft[] = []
  const badKeys = new Set<string>()
  let prev: VoucherDraft | null = null
  for (const rec of records) {
    const v = rec.values
    if (Object.values(v).every((x) => !x || !x.trim())) continue
    const c: Ctx = { rec, errors, bad: false, dateOrder }
    const g = (k: string): string => (v[k] ?? '').trim()
    const continuation = !g('key') && !g('type') && !g('number') && !g('date')
    let d: VoucherDraft
    if (continuation) {
      if (!prev) {
        errors.push({ line: rec.line, message: 'Line has no voucher (type, date or number) and nothing above it to belong to' })
        continue
      }
      d = prev
    } else {
      const date = take(c, 'date', (r) => parseDate(r, dateOrder))
      const typeName = g('type')
      const key = g('key') || `${typeName.toLowerCase()}|${g('number').toLowerCase()}|${date ?? g('date')}`
      const existing = drafts.get(key)
      if (existing) d = existing
      else {
        if (!date && !c.bad) {
          errors.push({ line: rec.line, field: 'date', message: 'Date is missing' })
          c.bad = true
        }
        if (!typeName) {
          errors.push({ line: rec.line, field: 'type', message: 'Voucher type is missing' })
          c.bad = true
        }
        d = {
          key, lines: [], typeName, kind: kindFromWord(typeName), date: date ?? '', number: g('number') || null,
          party: g('party') || null, narration: g('narration') || null, reference: g('reference') || null,
          ledgerLines: [], items: [], bills: [], tds: null, tcs: null,
          posOverride: take(c, 'placeOfSupply', parseState), currencyCode: g('currency') ? g('currency').toUpperCase() : null,
          exchangeRate: g('exchangeRate') ? Number(g('exchangeRate')) || null : null,
          isOptional: take(c, 'optional', parseBool) ?? false, postDated: take(c, 'postDated', parseBool) ?? false, notes: []
        }
        drafts.set(key, d)
        order.push(d)
        if (c.bad) badKeys.add(key)
      }
      if (existing && date && existing.date && date !== existing.date && g('key')) {
        errors.push({ line: rec.line, field: 'date', message: `Date differs from the voucher's first line (${existing.date})` })
        badKeys.add(key)
      }
      if (!d.party && g('party')) d.party = g('party')
      if (!d.narration && g('narration')) d.narration = g('narration')
    }
    prev = d
    d.lines.push(rec.line)
    // Ledger part
    if (g('ledger')) {
      const signedAmt = take(c, 'amount', (r) => parseSignedMoney(r))
      const side = take(c, 'drCr', parseDrCr)
      const dr = take(c, 'debit', parseMoney)
      const cr = take(c, 'credit', parseMoney)
      let drCr: 'dr' | 'cr' | null = null
      let amount = 0
      if ((dr ?? 0) !== 0 || (cr ?? 0) !== 0) {
        const net = (dr ?? 0) - (cr ?? 0)
        drCr = net >= 0 ? 'dr' : 'cr'
        amount = Math.abs(net)
      } else if (signedAmt !== null) {
        drCr = side ?? (signedAmt >= 0 ? 'dr' : 'cr')
        amount = Math.abs(signedAmt)
      }
      if (!drCr || amount === 0) {
        if (!c.bad) errors.push({ line: rec.line, field: 'amount', message: `Ledger "${g('ledger')}" has no amount` })
        badKeys.add(d.key)
      } else d.ledgerLines.push({ line: rec.line, ledger: g('ledger'), drCr, amount })
    }
    // Item part
    if (g('item')) {
      const qty = take(c, 'qty', parseQty)
      const rate = take(c, 'rate', parseMoney)
      const amt = take(c, 'itemAmount', parseMoney)
      const dir = g('direction').toLowerCase()
      if (dir && dir !== 'in' && dir !== 'out') {
        errors.push({ line: rec.line, field: 'direction', message: `Direction "${g('direction')}" is not in or out` })
        badKeys.add(d.key)
      }
      if (qty === null || qty <= 0) {
        if (!c.bad) errors.push({ line: rec.line, field: 'qty', message: `Item "${g('item')}" needs a positive quantity` })
        badKeys.add(d.key)
      } else {
        d.items.push({
          line: rec.line, item: g('item'), godown: g('godown') || null, batch: g('batch') || null, qtyMilli: qty, ratePaise: rate,
          amount: amt ?? (rate !== null ? Math.round((qty * rate) / 1000) : null), direction: dir === 'in' || dir === 'out' ? dir : null
        })
      }
    }
    // Bill part
    if (g('billRef')) {
      const kindRaw = g('billKind').toLowerCase()
      const kind: 'new' | 'against' =
        /agst|against|adj/.test(kindRaw) ? 'against' : /new/.test(kindRaw) ? 'new' : d.kind === 'receipt' || d.kind === 'payment' ? 'against' : 'new'
      d.bills.push({ line: rec.line, kind, name: g('billRef'), amount: take(c, 'billAmount', parseMoney), dueDate: take(c, 'dueDate', (r) => parseDate(r, dateOrder)) })
    }
    // TDS / TCS
    for (const w of ['tds', 'tcs'] as const) {
      if (g(`${w}Section`)) {
        const base = take(c, `${w}Base`, parseMoney)
        const amt = take(c, `${w}Amount`, parseMoney)
        if (base && amt) d[w] = { section: g(`${w}Section`), base, amount: amt }
      }
    }
    if (c.bad) badKeys.add(d.key)
  }
  for (const d of order) {
    if (badKeys.has(d.key)) continue
    if (d.ledgerLines.length === 0 && d.items.length === 0) {
      errors.push({ line: d.lines[0]!, message: `Voucher ${d.number ?? d.key} has no ledger or item lines` })
      badKeys.add(d.key)
    }
  }
  return { result: { target: 'vouchers', rows: order.filter((d) => !badKeys.has(d.key)) }, errors }
}

function groupTradeDocRecords(records: MappedRecord[], dateOrder: DateOrder, errors: RowError[]): { result: TargetRows; errors: RowError[] } {
  const docs = new Map<string, TradeDocDraft>()
  const bad = new Set<string>()
  for (const rec of records) {
    const v = rec.values
    if (Object.values(v).every((x) => !x || !x.trim())) continue
    const c: Ctx = { rec, errors, bad: false, dateOrder }
    const g = (k: string): string => (v[k] ?? '').trim()
    const kind = take(c, 'kind', (r) => oneOf(r, ['quotation', 'sales_order', 'purchase_order'] as const, 'Kind'))
    const date = take(c, 'date', (r) => parseDate(r, dateOrder))
    const key = g('key') || `${kind}|${g('number').toLowerCase()}|${date}`
    let d = docs.get(key)
    if (!d) {
      if (!kind || !date || !g('party')) {
        if (!c.bad) errors.push({ line: rec.line, message: 'Kind, date and party are required on a document’s first line' })
        bad.add(key)
      }
      d = {
        key, lines: [], kind: kind ?? 'sales_order', series: g('series') || null, date: date ?? '', number: g('number') || null, party: g('party'),
        dueDate: take(c, 'dueDate', (r) => parseDate(r, dateOrder)), validUntil: take(c, 'validUntil', (r) => parseDate(r, dateOrder)),
        reference: g('reference') || null, narration: g('narration') || null, items: []
      }
      docs.set(key, d)
    }
    d.lines.push(rec.line)
    const qty = take(c, 'qty', parseQty)
    const rate = take(c, 'rate', parseMoney)
    const discount = take(c, 'discount', parseMoney) ?? 0
    const amount = take(c, 'amount', parseMoney)
    if (!g('item') || !qty || qty <= 0) {
      if (!c.bad) errors.push({ line: rec.line, message: 'Each line needs an item and a positive quantity' })
      bad.add(key)
      continue
    }
    const ratePaise = rate ?? (amount !== null ? Math.round(((amount + discount) * 1000) / qty) : 0)
    d.items.push({
      line: rec.line, item: g('item'), godown: g('godown') || null, qtyMilli: qty, ratePaise, discountPaise: discount,
      amount: amount ?? Math.round((qty * ratePaise) / 1000) - discount, dueDate: take(c, 'lineDueDate', (r) => parseDate(r, dateOrder))
    })
    if (c.bad) bad.add(key)
  }
  return { result: { target: 'tradeDocs', rows: [...docs.values()].filter((d) => !bad.has(d.key)) }, errors }
}
