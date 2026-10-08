// WP 5.4 — duplicate check for a captured bill. Pure; the service hands it the supplier's
// purchase vouchers (in the books) and the open capture drafts.
//
//   1. Same supplier + the same invoice number within the bill's financial year → `same_invoice`:
//      the draft is REFUSED (the bill is already booked, or already drafted from another file).
//      Invoice numbers compare normalised: case, spaces and separators ignored, leading zeros of
//      each number run dropped ("INV/2025-26/0042" = "inv-2025-26-42").
//   2. Same supplier + the same total within ±7 days → `same_amount`: the draft is made but
//      FLAGGED with a link to the existing voucher (two bills of one amount do happen).
import { addDaysISO, fyOf } from '../dates'

export interface DuplicateCandidate {
  /** A voucher in the books, or an open capture draft (voucherId null, captureItemId set). */
  voucherId: number | null
  captureItemId?: number | null
  number: string
  date: string
  partyLedgerId: number
  /** Supplier invoice numbers the voucher carries (bill-wise ref names, reference). */
  invoiceNos: string[]
  /** The amount credited to the supplier (paise). */
  total: number
}

export interface DuplicateHit {
  kind: 'same_invoice' | 'same_amount'
  voucherId: number | null
  captureItemId: number | null
  number: string
  date: string
  why: string
}

export const DUPLICATE_DAYS = 7

export function normaliseInvoiceNo(s: string): string {
  return (s.toUpperCase().match(/[A-Z]+|\d+/g) ?? []).map((run) => (/^\d+$/.test(run) ? run.replace(/^0+(?=\d)/, '') : run)).join('-')
}

/** An invoice number the rules can compare (one that normalises to nothing — "-", "/" — is not). */
export const invoiceNoComparable = (no: string | null | undefined): boolean => !!no && normaliseInvoiceNo(no) !== ''

export function findDuplicates(
  bill: {
    partyLedgerId: number
    /** Other party ledgers carrying the same GSTIN (one supplier booked under two names). */
    sameGstinLedgerIds?: readonly number[]
    invoiceNo: string | null
    date: string | null
    total: number | null
    /** Without a bill date the number is compared within today's FY and the previous one only. */
    today?: string
  },
  candidates: readonly DuplicateCandidate[]
): DuplicateHit[] {
  const out: DuplicateHit[] = []
  const parties = new Set([bill.partyLedgerId, ...(bill.sameGstinLedgerIds ?? [])])
  const mine = bill.invoiceNo ? normaliseInvoiceNo(bill.invoiceNo) : ''
  const fy = bill.date ? fyOf(bill.date) : null
  const window = !fy && bill.today ? { from: fyOf(`${Number(bill.today.slice(0, 4)) - 1}${bill.today.slice(4)}`).from, to: fyOf(bill.today).to } : null
  for (const c of candidates) {
    if (!parties.has(c.partyLedgerId)) continue
    const sameFy = fy ? c.date >= fy.from && c.date <= fy.to : window ? c.date >= window.from && c.date <= window.to : true
    if (mine && sameFy && c.invoiceNos.some((n) => n && normaliseInvoiceNo(n) === mine)) {
      out.push({
        kind: 'same_invoice', voucherId: c.voucherId, captureItemId: c.captureItemId ?? null, number: c.number, date: c.date,
        why: `${c.voucherId ? `Voucher ${c.number}` : `Capture item #${c.captureItemId}`} of ${c.date} already carries invoice ${bill.invoiceNo} from this supplier in the same financial year`
      })
      continue
    }
    if (bill.total != null && bill.date && c.total === bill.total && c.date >= addDaysISO(bill.date, -DUPLICATE_DAYS) && c.date <= addDaysISO(bill.date, DUPLICATE_DAYS)) {
      out.push({
        kind: 'same_amount', voucherId: c.voucherId, captureItemId: c.captureItemId ?? null, number: c.number, date: c.date,
        why: `${c.voucherId ? `Voucher ${c.number}` : `Capture item #${c.captureItemId}`} of ${c.date} is for the same amount from this supplier within ${DUPLICATE_DAYS} days`
      })
    }
  }
  // Refusals first.
  return out.sort((a, b) => (a.kind === b.kind ? a.date.localeCompare(b.date) : a.kind === 'same_invoice' ? -1 : 1))
}
