/**
 * Job work (WP 2.4) — shared shapes and the pure ageing maths behind "Material at job workers".
 * See src/main/services/jobWork.ts for the flows. Quantities in thousandths, money in paise.
 */

export type JobWorkKind = 'send' | 'receive' | 'return'

/** A job_work_challans row (migration 023). */
export interface JobWorkChallan {
  voucherId: number
  kind: JobWorkKind
  /** The job worker's godown. */
  godownId: number
  partyLedgerId: number
  /** receive / return: the JOB WORKER's challan number and date (a send challan's are the
   *  voucher's own number and date, so these stay null). */
  challanNo: string | null
  challanDate: string | null
  natureOfProcessing: string | null
  goodsType: 'inputs' | 'capital_goods'
  /** receive / return: the send challan the goods come back against. */
  originalChallanVoucherId: number | null
}

/** Whole days from `from` to `to` (ISO dates; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}

/**
 * The inward lots still on hand after `consumedMilli` left, oldest consumed first (FIFO). Lots
 * keep their own date; a partly consumed lot keeps the remainder. Input lots in date order.
 */
export function ageLots(lots: readonly { date: string; qtyMilli: number }[], consumedMilli: number): { date: string; qtyMilli: number }[] {
  let left = Math.max(0, consumedMilli)
  const out: { date: string; qtyMilli: number }[] = []
  for (const l of lots) {
    if (left >= l.qtyMilli) {
      left -= l.qtyMilli
      continue
    }
    out.push({ date: l.date, qtyMilli: l.qtyMilli - left })
    left = 0
  }
  return out
}

/** One row of "Material at job workers". */
export interface JobWorkPendingRow {
  godownId: number
  godownName: string
  partyLedgerId: number | null
  partyName: string
  stockItemId: number
  itemName: string
  unitSymbol: string
  decimals: number
  /** At the job worker as on the date. */
  qtyMilli: number
  valuePaise: number
  /** Date of the oldest lot still there. */
  oldestDate: string | null
  ageDays: number | null
  /** Of qtyMilli: lots older than the pending threshold. */
  pendingQtyMilli: number
  pendingValuePaise: number
}

interface Itc04Party {
  jobWorkerName: string
  gstin: string | null
  stateCode: string | null
}
interface Itc04Item {
  stockItemId: number
  itemName: string
  hsn: string | null
  unit: string
  qtyMilli: number
}

/** ITC-04 source facts (WP 3.4 formats the return from these). */
export interface Itc04Data {
  sent: (Itc04Party & Itc04Item & {
    voucherId: number
    challanNo: string
    challanDate: string
    taxableValuePaise: number
    goodsType: 'inputs' | 'capital_goods'
    natureOfProcessing: string | null
  })[]
  received: (Itc04Party & {
    voucherId: number
    voucherNumber: string
    voucherDate: string
    challanNo: string | null
    challanDate: string | null
    originalChallanNo: string | null
    originalChallanDate: string | null
    natureOfProcessing: string | null
    goods: Itc04Item[]
    inputs: (Itc04Item & { lossQtyMilli: number })[]
  })[]
  returned: (Itc04Party & Itc04Item & {
    voucherId: number
    challanNo: string | null
    challanDate: string | null
    originalChallanNo: string | null
    originalChallanDate: string | null
    natureOfProcessing: string | null
  })[]
}
