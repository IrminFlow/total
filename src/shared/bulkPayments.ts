/**
 * Bulk payment upload files (NEFT / RTGS) from payment vouchers (WP 4.1). Pure — the DB side is
 * src/main/services/bulkPayments.ts.
 *
 * Bank corporate-banking upload layouts are mostly NOT public: HDFC (ENet), ICICI (CIB) and SBI
 * (CINB / YONO Business) hand their bulk-upload templates to customers inside their portals, and
 * none of them publishes the column list on a public page we could cite. So the format is a
 * configurable column-mapping TEMPLATE the user builds from their bank's sample file (the
 * template editor in Banking → Bulk payments), with two starters:
 *  - "Union Bank of India — NEFT/RTGS (pipe TXT)", transcribed from the bank's public sample
 *    "Sample NEFT RTGS Fund Transfer File" (unionbankonline.co.in/InternetBankingProductDemos/
 *    BULK_NEFT_RTGS_DEMO/Sample_NEFT_RTGS_Fund_Transfer_File.pdf): a `FILEHDR|CORPORATE_ID|
 *    File_Serial_Number|Encryption_Required|Remarks` first line, then one `|`-separated record
 *    per payment — Payment Type (NEFT/RTGS) | Payee (debit) IFSC | Debit Account Number |
 *    Receiver IFSC | Beneficiary Account Number | Currency | Amount | TranRemarks (≤140) |
 *    Beneficiary Name (≤40) | UserEmailId (≤80) | UserMobileNumber (≤20).
 *  - "Generic NEFT/RTGS CSV" — a plain header + rows file to adapt.
 *  Both are starting points: check against your bank's current sample before the first upload.
 *
 * Rules cited:
 *  - RTGS minimum ₹2,00,000; NEFT has no minimum or maximum — SBI "FAQ RTGS NEFT"
 *    (sbi.bank.in/web/faq-s/faq-rtgs-neft), restating RBI's RTGS / NEFT system rules. The
 *    template's `rtgsThreshold` (default ₹2,00,000) picks RTGS at or above it, NEFT below.
 *  - IFSC: 11 characters — 4-letter bank code, a control character that is presently '0', then
 *    6 alphanumerics for the branch — same SBI FAQ.
 */

export const PAYMENT_FIELDS = [
  'payment_type', 'beneficiary_name', 'beneficiary_account', 'beneficiary_ifsc', 'beneficiary_email', 'amount', 'date',
  'debit_account', 'debit_ifsc', 'reference', 'narration', 'currency', 'serial', 'constant', 'blank'
] as const
export type PaymentField = (typeof PAYMENT_FIELDS)[number]

export const PAYMENT_FIELD_LABELS: Record<PaymentField, string> = {
  payment_type: 'Payment type (NEFT / RTGS)',
  beneficiary_name: 'Beneficiary name',
  beneficiary_account: 'Beneficiary account no.',
  beneficiary_ifsc: 'Beneficiary IFSC',
  beneficiary_email: 'Beneficiary e-mail',
  amount: 'Amount',
  date: 'Payment date',
  debit_account: 'Our (debit) account no.',
  debit_ifsc: 'Our branch IFSC',
  reference: 'Voucher number',
  narration: 'Narration / remarks',
  currency: 'Currency (INR)',
  serial: 'Serial no.',
  constant: 'Fixed text',
  blank: 'Empty'
}

export interface PaymentColumn {
  header: string
  field: PaymentField
  /** Fixed text for field 'constant'. */
  value?: string
  /** Truncate to this many characters (bank field limits). */
  maxLength?: number | null
}

export interface PaymentTemplate {
  name: string
  delimiter: ',' | '|' | '\t' | ';'
  extension: 'csv' | 'txt'
  /** Print `columns[].header` as the first record. */
  includeHeader: boolean
  /** Optional first line before the records, with {corporateId} {batchNo} {date} {count}
   *  {total} {remarks} placeholders (e.g. Union Bank's FILEHDR line). */
  headerLine: string | null
  columns: PaymentColumn[]
  dateFormat: 'DD/MM/YYYY' | 'DD-MM-YYYY' | 'YYYY-MM-DD' | 'DDMMYYYY' | 'DD-MMM-YYYY'
  /** 'rupees' = 1234.50 · 'rupees_int' = whole rupees (fails on paise) · 'paise' = 123450. */
  amountFormat: 'rupees' | 'rupees_int' | 'paise'
  quoteAll: boolean
  /** Paise. Payments at or above use RTGS, below NEFT. */
  rtgsThreshold: number
  /** Default corporate / client id printed in {corporateId}. */
  corporateId: string
}

export const RTGS_MIN_PAISE = 2_00_000_00

export const BUILTIN_PAYMENT_TEMPLATES: (PaymentTemplate & { key: string; source: string })[] = [
  {
    key: 'unionbank-neft-rtgs',
    name: 'Union Bank of India — NEFT/RTGS (pipe TXT)',
    source: 'Union Bank of India public sample: unionbankonline.co.in/InternetBankingProductDemos/BULK_NEFT_RTGS_DEMO/Sample_NEFT_RTGS_Fund_Transfer_File.pdf',
    delimiter: '|',
    extension: 'txt',
    includeHeader: false,
    headerLine: 'FILEHDR|{corporateId}|{batchNo}|N|{remarks}',
    columns: [
      { header: 'Payment Type', field: 'payment_type', maxLength: 4 },
      { header: 'Payee IFSC Code', field: 'debit_ifsc', maxLength: 11 },
      { header: 'Debit Account Number', field: 'debit_account', maxLength: 24 },
      { header: 'Receiver IFSC Code', field: 'beneficiary_ifsc', maxLength: 12 },
      { header: 'Beneficiary Account Number', field: 'beneficiary_account', maxLength: 24 },
      { header: 'Transaction Currency', field: 'currency', maxLength: 3 },
      { header: 'Transaction Amount', field: 'amount', maxLength: 14 },
      { header: 'TranRemarks', field: 'narration', maxLength: 140 },
      { header: 'Beneficiary Customer Name', field: 'beneficiary_name', maxLength: 40 },
      { header: 'UserEmailId', field: 'beneficiary_email', maxLength: 80 },
      { header: 'UserMobileNumber', field: 'blank', maxLength: 20 }
    ],
    dateFormat: 'DD/MM/YYYY',
    amountFormat: 'rupees',
    quoteAll: false,
    rtgsThreshold: RTGS_MIN_PAISE,
    corporateId: ''
  },
  {
    key: 'generic-csv',
    name: 'Generic NEFT/RTGS CSV',
    source: 'Starter layout — adapt to your bank’s sample file (HDFC / ICICI / SBI corporate templates are not public)',
    delimiter: ',',
    extension: 'csv',
    includeHeader: true,
    headerLine: null,
    columns: [
      { header: 'Payment Type', field: 'payment_type' },
      { header: 'Beneficiary Name', field: 'beneficiary_name', maxLength: 40 },
      { header: 'Beneficiary Account No', field: 'beneficiary_account' },
      { header: 'IFSC', field: 'beneficiary_ifsc' },
      { header: 'Amount', field: 'amount' },
      { header: 'Value Date', field: 'date' },
      { header: 'Debit Account No', field: 'debit_account' },
      { header: 'Customer Reference', field: 'reference', maxLength: 20 },
      { header: 'Remarks', field: 'narration', maxLength: 30 },
      { header: 'Beneficiary Email', field: 'beneficiary_email' }
    ],
    dateFormat: 'DD/MM/YYYY',
    amountFormat: 'rupees',
    quoteAll: false,
    rtgsThreshold: RTGS_MIN_PAISE,
    corporateId: ''
  }
]

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

/** Plain-language problems with a beneficiary's bank details (empty = fine). */
export function beneficiaryProblems(b: { accountNo: string | null; ifsc: string | null; accountName: string | null }): string[] {
  const out: string[] = []
  const acc = (b.accountNo ?? '').replace(/\s/g, '')
  if (!acc) out.push('no account number')
  else if (!/^[0-9A-Za-z]{6,34}$/.test(acc)) out.push('account number should be 6–34 letters/digits')
  const ifsc = (b.ifsc ?? '').trim().toUpperCase()
  if (!ifsc) out.push('no IFSC')
  else if (!IFSC_RE.test(ifsc)) out.push('IFSC must be 11 characters: 4 letters, 0, then 6 letters/digits')
  if (!(b.accountName ?? '').trim()) out.push('no beneficiary name')
  return out
}

export interface PaymentRow {
  voucherId: number
  voucherNumber: string
  date: string
  amount: number
  beneficiaryName: string
  accountNo: string
  ifsc: string
  email: string
  narration: string
}

export interface BatchContext {
  debitAccount: string
  debitIfsc: string
  corporateId: string
  batchNo: number
  date: string
  remarks: string
}

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export function formatPaymentDate(iso: string, f: PaymentTemplate['dateFormat']): string {
  const [y, m, d] = iso.split('-') as [string, string, string]
  switch (f) {
    case 'YYYY-MM-DD': return iso
    case 'DD-MM-YYYY': return `${d}-${m}-${y}`
    case 'DDMMYYYY': return `${d}${m}${y}`
    case 'DD-MMM-YYYY': return `${d}-${MON[Number(m) - 1]}-${y}`
    default: return `${d}/${m}/${y}`
  }
}

export function formatPaymentAmount(paise: number, f: PaymentTemplate['amountFormat']): string {
  if (f === 'paise') return String(paise)
  if (f === 'rupees_int') {
    if (paise % 100 !== 0) throw new Error(`This template takes whole rupees — ₹${(paise / 100).toFixed(2)} has paise`)
    return String(paise / 100)
  }
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`
}

export const paymentTypeFor = (paise: number, threshold: number): 'NEFT' | 'RTGS' => (paise >= threshold ? 'RTGS' : 'NEFT')

/** Make a value safe for an unquoted delimited bank file: no delimiter, no line breaks, no
 *  leading formula characters. */
function clean(v: string, delimiter: string, quoteAll: boolean): string {
  let s = v.replace(/[\r\n]+/g, ' ').replace(/^[=+@]+/, '').trim()
  if (quoteAll) return `"${s.replace(/"/g, '""')}"`
  s = s.split(delimiter).join(' ')
  return s
}

/** Render the upload file. Throws on a template that can't express a row (e.g. paise into a
 *  whole-rupee column). */
export function renderPaymentFile(t: PaymentTemplate, rows: PaymentRow[], ctx: BatchContext): string {
  const out: string[] = []
  const total = rows.reduce((s, r) => s + r.amount, 0)
  if (t.headerLine && t.headerLine.trim()) {
    out.push(
      t.headerLine
        .replace(/\{corporateId\}/g, ctx.corporateId)
        .replace(/\{batchNo\}/g, String(ctx.batchNo))
        .replace(/\{date\}/g, formatPaymentDate(ctx.date, t.dateFormat))
        .replace(/\{count\}/g, String(rows.length))
        .replace(/\{total\}/g, formatPaymentAmount(total, t.amountFormat === 'rupees_int' ? 'rupees' : t.amountFormat))
        .replace(/\{remarks\}/g, ctx.remarks)
    )
  }
  if (t.includeHeader) out.push(t.columns.map((c) => clean(c.header, t.delimiter, t.quoteAll)).join(t.delimiter))
  rows.forEach((r, i) => {
    const cells = t.columns.map((c) => {
      let v = ''
      switch (c.field) {
        case 'payment_type': v = paymentTypeFor(r.amount, t.rtgsThreshold); break
        case 'beneficiary_name': v = r.beneficiaryName; break
        case 'beneficiary_account': v = r.accountNo.replace(/\s/g, ''); break
        case 'beneficiary_ifsc': v = r.ifsc.toUpperCase(); break
        case 'beneficiary_email': v = r.email; break
        case 'amount': v = formatPaymentAmount(r.amount, t.amountFormat); break
        case 'date': v = formatPaymentDate(r.date, t.dateFormat); break
        case 'debit_account': v = ctx.debitAccount.replace(/\s/g, ''); break
        case 'debit_ifsc': v = ctx.debitIfsc.toUpperCase(); break
        case 'reference': v = r.voucherNumber; break
        case 'narration': v = r.narration; break
        case 'currency': v = 'INR'; break
        case 'serial': v = String(i + 1); break
        case 'constant': v = c.value ?? ''; break
        case 'blank': v = ''; break
      }
      if (c.maxLength && v.length > c.maxLength) v = v.slice(0, c.maxLength)
      return clean(v, t.delimiter, t.quoteAll)
    })
    out.push(cells.join(t.delimiter))
  })
  return out.join('\r\n') + '\r\n'
}
