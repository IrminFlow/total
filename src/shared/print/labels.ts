// WP 10.4: the words a printed document says around the figures, so a simple-mode company that
// works in Hindi or Hinglish gets its bills, statements and reminders in that language.
//
// `ENGLISH_PRINT_LABELS` are the renderer's own literals (render.ts used them inline before) — the
// default, so every print that is not localised is byte-identical to before. `printLabelsFor(t)`
// builds the localised set from the `simple.print.*` catalogue keys; `localiseTemplate` swaps the
// template's own words (titles, column heads, footer labels, declaration) ONLY where the owner
// kept the default English — a customised label prints as they wrote it.
//
// Not translated, on purpose: the legal titles a GST print must carry (TAX INVOICE, BILL OF SUPPLY
// — CGST rules 46 / 49 name them in English), the rule 5(1)(f) composition declaration, the tax
// names (GSTIN, HSN, CGST, SGST, IGST) and everything the user typed (names, items, terms).
import { amountInWords } from '../money'
import type { Translate } from '../i18n'
import { DEFAULT_INVOICE_CONFIG } from '../invoiceConfig'
import { DEFAULT_TITLES, PRINT_COLUMN_DEFS, type PrintColumnKey, type PrintDocKind, type PrintTemplate } from '../printTemplates'

/** A label around a value: what comes before it and after it (Hindi puts words after names). */
export interface Around {
  before: string
  after: string
}

export interface PrintLabels {
  unregistered: string
  phone: string
  /** "For <b>Company</b>" above the signature. */
  sigFor: Around
  enteredBy: string
  alteredBy: string
  balanceOutstanding: string
  dr: string
  cr: string
  broughtForward: string
  carriedForward: string
  taxRate: string
  gstRate: string
  taxable: string
  cess: string
  cessWord: string
  roundOff: string
  bankDetails: string
  account: string
  termsAndConditions: string
  remarks: string
  terms: string
  declaration: string
  valueInWords: string
  amountInWords: string
  cashSale: string
  state: string
  no: string
  date: string
  against: string
  dated: string
  placeOfSupply: string
  vehicle: string
  taxableValue: string
  total: string
  valueOfGoods: string
  /** The meta-block label per document kind (only the kinds a simple company prints change). */
  docLabel: Partial<Record<PrintDocKind, string>>
  statementFor: string
  period: string
  periodTo: string
  opening: string
  closing: string
  particulars: string
  debit: string
  credit: string
  /** WP 10.4 review: a statement for a SUPPLIER — their bills are the credit column, what was
   *  paid them the debit one, an unapplied amount is an advance paid (customer = the default). */
  supplierStatement?: { debit: string; credit: string; unadjusted: string }
  /** The debit / credit heads of a receipt / payment print's lines (not a statement's). */
  lineDebit: string
  lineCredit: string
  /** Caption under the bill's verification QR code. */
  verificationQr: string
  balance: string
  openingBalance: string
  totalsClosing: string
  openBillsAsOn: Around
  noOpenBills: string
  unadjusted: string
  ageingHead: string
  over90: string
  totalDue: string
  bank: string
  bill: string
  billDate: string
  dueDate: string
  overdue: string
  billAmount: string
  pending: string
  daysShort: string
  to: string
  /** Receipt / payment prints (voucher shape). */
  partyLabel: Partial<Record<PrintDocKind, string>>
  party: string
  ref: string
  chequeUtr: string
  note: string
  amount: string
  /** Amount in words in the document's language. */
  words: (paise: number) => string
}

export const ENGLISH_PRINT_LABELS: PrintLabels = {
  unregistered: 'Unregistered',
  phone: 'Ph',
  sigFor: { before: 'For ', after: '' },
  enteredBy: 'Entered by',
  alteredBy: 'Altered by',
  balanceOutstanding: 'Balance outstanding',
  dr: 'Dr',
  cr: 'Cr',
  broughtForward: 'Brought forward',
  carriedForward: 'Carried forward',
  taxRate: 'Rate',
  gstRate: 'GST rate',
  taxable: 'Taxable',
  cess: 'Cess',
  cessWord: 'cess',
  roundOff: 'Round off',
  bankDetails: 'Bank details',
  account: 'A/c',
  termsAndConditions: 'Terms & conditions',
  remarks: 'Remarks',
  terms: 'Terms',
  declaration: 'Declaration',
  valueInWords: 'Value in words',
  amountInWords: 'Amount in words',
  cashSale: 'Cash sale',
  state: 'State',
  no: 'No',
  date: 'Date',
  against: 'Against',
  dated: 'dt',
  placeOfSupply: 'Place of supply',
  vehicle: 'Vehicle',
  taxableValue: 'Taxable value',
  total: 'Total',
  valueOfGoods: 'Value of goods',
  docLabel: {},
  statementFor: 'Statement for',
  period: 'Period',
  periodTo: 'to',
  opening: 'Opening',
  closing: 'Closing',
  particulars: 'Particulars',
  debit: 'Debit',
  credit: 'Credit',
  lineDebit: 'Debit',
  lineCredit: 'Credit',
  verificationQr: 'Verification QR',
  balance: 'Balance',
  openingBalance: 'Opening balance',
  totalsClosing: 'Totals / closing balance',
  openBillsAsOn: { before: 'Open bills as on ', after: '' },
  noOpenBills: 'No open bills.',
  unadjusted: 'Unadjusted receipts (on account)',
  ageingHead: 'Ageing (days overdue)',
  over90: 'Over 90',
  totalDue: 'Total due',
  bank: 'Bank',
  bill: 'Bill',
  billDate: 'Bill date',
  dueDate: 'Due date',
  overdue: 'Overdue',
  billAmount: 'Bill amount',
  pending: 'Pending',
  daysShort: 'd',
  to: 'To',
  partyLabel: {},
  party: 'Party',
  ref: 'Ref',
  chequeUtr: 'Cheque/UTR',
  note: 'Narration',
  amount: 'Amount',
  words: (paise) => amountInWords(paise)
}

const MARK = '\u0000'
/** A message with one `{name}` / `{date}` slot → what comes before and after the value. */
function around(text: string): Around {
  const i = text.indexOf(MARK)
  return i < 0 ? { before: `${text} `, after: '' } : { before: text.slice(0, i), after: text.slice(i + 1) }
}

/** The labels in `t`'s language (`t` from `companyT` / `translator`). */
export function printLabelsFor(t: Translate): PrintLabels {
  const lang = t.lang
  return {
    unregistered: t('simple.print.unregistered'),
    phone: t('simple.print.phone'),
    sigFor: around(t('simple.print.for', { name: MARK })),
    enteredBy: t('simple.print.enteredBy'),
    alteredBy: t('simple.print.alteredBy'),
    balanceOutstanding: t('simple.print.balanceOutstanding'),
    dr: t('simple.print.dr'),
    cr: t('simple.print.cr'),
    broughtForward: t('simple.print.broughtForward'),
    carriedForward: t('simple.print.carriedForward'),
    taxRate: t('simple.print.taxRate'),
    gstRate: t('simple.print.gstRate'),
    taxable: t('simple.print.taxable'),
    cess: t('simple.print.cess'),
    cessWord: t('simple.print.cessWord'),
    roundOff: t('simple.print.roundOff'),
    bankDetails: t('simple.print.bankDetails'),
    account: t('simple.print.account'),
    termsAndConditions: t('simple.print.termsAndConditions'),
    remarks: t('simple.print.remarks'),
    terms: t('simple.print.terms'),
    declaration: t('simple.print.declaration'),
    valueInWords: t('simple.print.valueInWords'),
    amountInWords: t('simple.print.amountInWords'),
    cashSale: t('simple.print.cashSale'),
    state: t('simple.print.state'),
    no: t('simple.print.no'),
    date: t('simple.print.date'),
    against: t('simple.print.against'),
    dated: t('simple.print.dated'),
    placeOfSupply: t('simple.print.placeOfSupply'),
    vehicle: t('simple.print.vehicle'),
    taxableValue: t('simple.print.taxableValue'),
    total: t('simple.print.total'),
    valueOfGoods: t('simple.print.valueOfGoods'),
    docLabel: {
      sales: t('simple.print.doc.sales'),
      credit_note: t('simple.print.doc.creditNote'),
      debit_note: t('simple.print.doc.debitNote'),
      receipt: t('simple.print.doc.receipt'),
      payment: t('simple.print.doc.payment')
    },
    statementFor: t('simple.print.statementFor'),
    period: t('simple.print.period'),
    periodTo: t('simple.print.periodTo'),
    opening: t('simple.print.opening'),
    closing: t('simple.print.closing'),
    particulars: t('simple.print.details'),
    debit: t('simple.print.debit'),
    credit: t('simple.print.credit'),
    supplierStatement: { debit: t('simple.print.credit'), credit: t('simple.print.debit'), unadjusted: t('simple.print.unadjustedPaid') },
    lineDebit: t('simple.print.lineDebit'),
    lineCredit: t('simple.print.lineCredit'),
    verificationQr: t('simple.print.verificationQr'),
    balance: t('simple.print.balance'),
    openingBalance: t('simple.print.openingBalance'),
    totalsClosing: t('simple.print.totalsClosing'),
    openBillsAsOn: around(t('simple.print.openBillsAsOn', { date: MARK })),
    noOpenBills: t('simple.print.noOpenBills'),
    unadjusted: t('simple.print.unadjusted'),
    ageingHead: t('simple.print.lateHead'),
    over90: t('simple.print.over90'),
    totalDue: t('simple.print.totalDue'),
    bank: t('simple.print.bank'),
    bill: t('simple.print.bill'),
    billDate: t('simple.print.billDate'),
    dueDate: t('simple.print.dueDate'),
    overdue: t('simple.print.overdue'),
    billAmount: t('simple.print.billAmount'),
    pending: t('simple.print.pending'),
    daysShort: t('simple.print.daysShort'),
    to: t('simple.print.to'),
    partyLabel: { receipt: t('simple.print.receivedFrom'), payment: t('simple.print.paidTo') },
    party: t('simple.print.party'),
    ref: t('simple.print.ref'),
    chequeUtr: t('simple.print.chequeUtr'),
    note: t('simple.print.note'),
    amount: t('simple.print.amount'),
    words: (paise) => amountInWords(paise, lang)
  }
}

/** The kinds a simple company prints whose (non-legal) titles are localised. */
const TITLE_KEY: readonly [PrintDocKind, Parameters<Translate>[0]][] = [
  ['credit_note', 'simple.print.title.creditNote'],
  ['debit_note', 'simple.print.title.debitNote'],
  ['receipt', 'simple.print.title.receipt'],
  ['payment', 'simple.print.title.payment'],
  ['statement', 'simple.print.title.statement'],
  ['reminder', 'simple.print.title.reminder']
]
const COLUMN_KEY: Record<PrintColumnKey, Parameters<Translate>[0]> = {
  sl: 'simple.print.col.sl',
  item: 'simple.print.col.item',
  description: 'simple.print.col.description',
  hsn: 'simple.print.col.hsn',
  barcode: 'simple.print.col.barcode',
  qty: 'simple.print.col.qty',
  unit: 'simple.print.col.unit',
  rate: 'simple.print.col.rate',
  discount: 'simple.print.col.discount',
  taxable: 'simple.print.col.taxable',
  gstRate: 'simple.print.col.gstRate',
  cgst: 'simple.print.col.cgst',
  sgst: 'simple.print.col.sgst',
  igst: 'simple.print.col.igst',
  cess: 'simple.print.col.cess',
  amount: 'simple.print.col.amount'
}
const DEFAULT_SIGNATURE = 'Authorised Signatory'
const DEFAULT_RECEIVER = "Receiver's signature"
const DEFAULT_COPY = 'Original for Recipient'
const DEFAULT_CG = 'This is a computer-generated document.'

/** The template with its default English words in `t`'s language; anything the owner changed
 *  stays as written. Pure — main applies it only for a simple company in Hindi / Hinglish. */
export function localiseTemplate(template: PrintTemplate, t: Translate): PrintTemplate {
  const keep = (value: string, def: string, local: string): string => (value === def ? local : value)
  const titles = { ...template.header.titles }
  for (const [k, key] of TITLE_KEY) titles[k] = keep(titles[k], DEFAULT_TITLES[k], t(key))
  // A Hindi print can't write English month names (04-Sep-26 in a Hindi bill): a format with
  // month NAMES prints as day / month / year digits instead (what Hindi bills use). Hinglish reads
  // Latin script, so it keeps the owner's format. (WP 10.4 review)
  const monthNames = /mmm/.test(template.formats.date)
  const formats = t.lang === 'hi' && monthNames ? { ...template.formats, date: 'dd/mm/yyyy' as const } : template.formats
  return {
    ...template,
    formats,
    header: {
      ...template.header,
      titles,
      copyLabels: template.header.copyLabels.map((l) => keep(l, DEFAULT_COPY, t('simple.print.copyOriginal')))
    },
    party: {
      ...template.party,
      billToLabel: keep(template.party.billToLabel, 'Billed to', t('simple.print.billedTo')),
      shipToLabel: keep(template.party.shipToLabel, 'Shipped to', t('simple.print.shippedTo'))
    },
    columns: template.columns.map((c) => ({ ...c, label: keep(c.label, PRINT_COLUMN_DEFS[c.key].label, t(COLUMN_KEY[c.key])) })),
    footer: {
      ...template.footer,
      declaration: keep(template.footer.declaration, DEFAULT_INVOICE_CONFIG.declaration, t('simple.print.declarationText')),
      signatureLabel: keep(template.footer.signatureLabel, DEFAULT_SIGNATURE, t('simple.print.signature')),
      receiverLabel: keep(template.footer.receiverLabel, DEFAULT_RECEIVER, t('simple.print.receiver')),
      computerGeneratedText: keep(template.footer.computerGeneratedText, DEFAULT_CG, t('simple.print.computerGenerated'))
    }
  }
}
