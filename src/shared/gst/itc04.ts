/**
 * GST ITC-04 (WP 3.4) — goods sent to / received back from job workers, built from the WP 2.4
 * job-work facts (`job_work_challans`, `job_work_losses`, the challans' own inventory lines).
 * Pure: the main process reads the facts (services/jobWork.ts itc04Data + the job-worker-godown
 * sales query in services/gstExpansion.ts) and this module shapes the return tables.
 *
 * Form, periodicity and due dates are sourced — see ITC04_RULES / GST_SOURCES in ./sources.ts:
 *  - rule 45(3) CGST Rules + FORM GST ITC-04 (Table 4 goods sent; Table 5A received back,
 *    5B sent on from the job worker to another job worker, 5C supplied from the job worker's
 *    premises);
 *  - periodicity per rule 45(3) with the "specified period" Notification 35/2021-CT added
 *    (from 01-10-2021): half-yearly (Apr–Sep by 25 Oct, Oct–Mar by 25 Apr) when aggregate
 *    turnover in the immediately preceding FY exceeds ₹5 crore, else the financial year (by
 *    25 Apr).
 *  - the form has no HSN column (UNVERIFIED 'itc04-hsn'); HSN is carried from the rule 55
 *    challan particulars for reference, and a missing one is only a warning.
 * Quantities are integer thousandths, money integer paise.
 */
import type { Itc04Data } from '../jobWork'
import { toUqc } from './uqc'
import { ITC04_RULES } from './sources'

export type Itc04Periodicity = 'half_yearly' | 'annual'
export type Itc04PeriodKind = 'H1' | 'H2' | 'FY'

export interface Itc04Period {
  fyStartYear: number
  kind: Itc04PeriodKind
  from: string
  to: string
  label: string
  /** ISO due date (rule 45(3) proviso). */
  dueDate: string
  /** Portal return-period code for the offline tool (MMYYYY of the last month): 092026 etc. */
  fp: string
}

/** Half-yearly when the preceding FY's aggregate turnover exceeds the sourced threshold. */
export function itc04Periodicity(aatoPaise: number): Itc04Periodicity {
  return aatoPaise > ITC04_RULES.halfYearlyAboveAatoPaise ? 'half_yearly' : 'annual'
}

export function itc04Periods(fyStartYear: number, periodicity: Itc04Periodicity): Itc04Period[] {
  const y = fyStartYear
  const fyLabel = `${y}-${String((y + 1) % 100).padStart(2, '0')}`
  if (periodicity === 'annual') {
    return [{ fyStartYear: y, kind: 'FY', from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${fyLabel} (annual)`, dueDate: `${y + 1}-${ITC04_RULES.annualDue}`, fp: `03${y + 1}` }]
  }
  return [
    { fyStartYear: y, kind: 'H1', from: `${y}-04-01`, to: `${y}-09-30`, label: `Apr–Sep ${y}`, dueDate: `${y}-${ITC04_RULES.h1Due}`, fp: `09${y}` },
    { fyStartYear: y, kind: 'H2', from: `${y}-10-01`, to: `${y + 1}-03-31`, label: `Oct ${y}–Mar ${y + 1}`, dueDate: `${y + 1}-${ITC04_RULES.h2Due}`, fp: `03${y + 1}` }
  ]
}

interface JobWorker {
  /** Job worker's GSTIN, or null when unregistered (the State is then reported instead). */
  jwGstin: string | null
  jwStateCode: string | null
  jwName: string
  partyLedgerId: number | null
}

/** Table 4 — inputs / capital goods sent to the job worker. */
export interface Itc04SentRow extends JobWorker {
  voucherId: number
  challanNo: string
  challanDate: string
  stockItemId: number
  description: string
  hsn: string | null
  uqc: string
  qtyMilli: number
  taxableValuePaise: number
  goodsType: 'inputs' | 'capital_goods'
  /** Tax rates of the item (rule 45 challan particulars); integrated tax for inter-state
   *  movement, central + state tax intra-state. */
  igstRate: number
  cgstRate: number
  sgstRate: number
  cessRate: number
  natureOfProcessing: string | null
}

/** Table 5A — received back (processed: a job-work receipt; unprocessed: a return challan). */
export interface Itc04ReceivedRow extends JobWorker {
  voucherId: number
  kind: 'processed' | 'unprocessed'
  /** The job worker's challan under which the goods came back. */
  jwChallanNo: string | null
  jwChallanDate: string | null
  originalChallanNo: string | null
  originalChallanDate: string | null
  stockItemId: number | null
  description: string
  hsn: string | null
  uqc: string
  qtyMilli: number
  natureOfProcessing: string | null
  /** Losses and wastes (input UQC). */
  lossUqc: string | null
  lossQtyMilli: number
}

/** Table 5C — supplied directly from the job worker's premises (a sale out of a job-worker
 *  godown). */
export interface Itc04SuppliedRow extends JobWorker {
  voucherId: number
  invoiceNo: string
  invoiceDate: string
  stockItemId: number
  description: string
  hsn: string | null
  uqc: string
  qtyMilli: number
  taxableValuePaise: number
}

/** A sale whose stock left from a job-worker godown (main extracts these for 5C). */
export interface Itc04SupplyFact extends JobWorker {
  voucherId: number
  invoiceNo: string
  invoiceDate: string
  stockItemId: number
  itemName: string
  hsn: string | null
  unit: string
  qtyMilli: number
  amountPaise: number
}

export interface Itc04Issue {
  severity: 'blocking' | 'warning'
  message: string
  voucherIds: number[]
}

export interface Itc04Result {
  period: Itc04Period
  sent: Itc04SentRow[]
  received: Itc04ReceivedRow[]
  /** 5B — the books have no "sent on to another job worker" movement; always empty. */
  sentOn: never[]
  supplied: Itc04SuppliedRow[]
  issues: Itc04Issue[]
  totals: { sentQtyMilli: number; sentValuePaise: number; receivedQtyMilli: number; lossQtyMilli: number; suppliedQtyMilli: number }
}

/** Rate split for a movement: inter-state → IGST at the full rate, else CGST + SGST halves. */
export function itc04Rates(rate: number, interState: boolean): { igstRate: number; cgstRate: number; sgstRate: number } {
  return interState ? { igstRate: rate, cgstRate: 0, sgstRate: 0 } : { igstRate: 0, cgstRate: rate / 2, sgstRate: rate / 2 }
}

const uqcOf = (unit: string): string => {
  const m = toUqc(unit)
  return m.fallback ? unit.toUpperCase() : m.uqc
}

export interface Itc04BuildInput {
  period: Itc04Period
  data: Itc04Data & {
    /** Optional per-item tax facts (the WP 2.4 facts carry none); keyed by stock item id. */
    itemRates?: Record<number, { gstRate: number; cessRate: number }>
  }
  supplies: Itc04SupplyFact[]
  companyStateCode: string
}

export function buildItc04(input: Itc04BuildInput): Itc04Result {
  const { data, period, companyStateCode } = input
  const issues: Itc04Issue[] = []
  const missingHsn = new Set<number>()
  const noGstinNoState = new Set<number>()
  const checkHsn = (voucherId: number, hsn: string | null): void => {
    if (!hsn) missingHsn.add(voucherId)
  }
  const worker = (r: { jobWorkerName: string; gstin: string | null; stateCode: string | null; voucherId: number; partyLedgerId?: number | null }): JobWorker => {
    if (!r.gstin && !r.stateCode) noGstinNoState.add(r.voucherId)
    return { jwGstin: r.gstin, jwStateCode: r.gstin ? r.gstin.slice(0, 2) : r.stateCode, jwName: r.jobWorkerName, partyLedgerId: r.partyLedgerId ?? null }
  }
  const rateOf = (itemId: number): { gstRate: number; cessRate: number } => data.itemRates?.[itemId] ?? { gstRate: 0, cessRate: 0 }

  const sent: Itc04SentRow[] = data.sent.map((s) => {
    const jw = worker(s)
    checkHsn(s.voucherId, s.hsn)
    const r = rateOf(s.stockItemId)
    const inter = (jw.jwStateCode ?? companyStateCode) !== companyStateCode
    return {
      ...jw,
      voucherId: s.voucherId,
      challanNo: s.challanNo,
      challanDate: s.challanDate,
      stockItemId: s.stockItemId,
      description: s.itemName,
      hsn: s.hsn,
      uqc: uqcOf(s.unit),
      qtyMilli: s.qtyMilli,
      taxableValuePaise: s.taxableValuePaise,
      goodsType: s.goodsType,
      ...itc04Rates(r.gstRate, inter),
      cessRate: r.cessRate,
      natureOfProcessing: s.natureOfProcessing
    }
  })

  const received: Itc04ReceivedRow[] = []
  for (const r of data.received) {
    const jw = worker(r)
    if (!r.challanNo) issues.push({ severity: 'warning', message: `Job-work receipt ${r.voucherNumber}: the job worker's challan number is missing`, voucherIds: [r.voucherId] })
    if (!r.originalChallanNo) issues.push({ severity: 'warning', message: `Job-work receipt ${r.voucherNumber}: not linked to an original send challan`, voucherIds: [r.voucherId] })
    const base = {
      ...jw, voucherId: r.voucherId, kind: 'processed' as const, jwChallanNo: r.challanNo, jwChallanDate: r.challanDate,
      originalChallanNo: r.originalChallanNo, originalChallanDate: r.originalChallanDate, natureOfProcessing: r.natureOfProcessing
    }
    const losses = r.inputs.filter((i) => i.lossQtyMilli > 0)
    r.goods.forEach((g, i) => {
      checkHsn(r.voucherId, g.hsn)
      // Losses of the first lossy input ride on the first finished-goods row; any further lossy
      // inputs get their own loss-only rows below.
      const loss = i === 0 ? losses[0] : undefined
      received.push({
        ...base, stockItemId: g.stockItemId, description: g.itemName, hsn: g.hsn, uqc: uqcOf(g.unit), qtyMilli: g.qtyMilli,
        lossUqc: loss ? uqcOf(loss.unit) : null, lossQtyMilli: loss?.lossQtyMilli ?? 0
      })
    })
    for (const loss of losses.slice(r.goods.length > 0 ? 1 : 0)) {
      received.push({
        ...base, stockItemId: loss.stockItemId, description: `${loss.itemName} (losses and wastes)`, hsn: loss.hsn, uqc: uqcOf(loss.unit), qtyMilli: 0,
        lossUqc: uqcOf(loss.unit), lossQtyMilli: loss.lossQtyMilli
      })
    }
  }
  for (const r of data.returned) {
    const jw = worker(r)
    checkHsn(r.voucherId, r.hsn)
    if (!r.originalChallanNo) issues.push({ severity: 'warning', message: `Return challan ${r.challanNo ?? `#${r.voucherId}`}: not linked to an original send challan`, voucherIds: [r.voucherId] })
    received.push({
      ...jw, voucherId: r.voucherId, kind: 'unprocessed', jwChallanNo: r.challanNo, jwChallanDate: r.challanDate,
      originalChallanNo: r.originalChallanNo, originalChallanDate: r.originalChallanDate, stockItemId: r.stockItemId,
      description: r.itemName, hsn: r.hsn, uqc: uqcOf(r.unit), qtyMilli: r.qtyMilli, natureOfProcessing: r.natureOfProcessing,
      lossUqc: null, lossQtyMilli: 0
    })
  }

  const supplied: Itc04SuppliedRow[] = input.supplies.map((s) => {
    checkHsn(s.voucherId, s.hsn)
    return {
      jwGstin: s.jwGstin, jwStateCode: s.jwStateCode, jwName: s.jwName, partyLedgerId: s.partyLedgerId,
      voucherId: s.voucherId, invoiceNo: s.invoiceNo, invoiceDate: s.invoiceDate, stockItemId: s.stockItemId,
      description: s.itemName, hsn: s.hsn, uqc: uqcOf(s.unit), qtyMilli: s.qtyMilli, taxableValuePaise: s.amountPaise
    }
  })

  if (missingHsn.size) {
    issues.push({ severity: 'warning', message: `${missingHsn.size} challan(s) carry items without an HSN code (a rule 55 challan particular)`, voucherIds: [...missingHsn] })
  }
  if (noGstinNoState.size) {
    issues.push({ severity: 'blocking', message: `${noGstinNoState.size} challan(s): the job worker has neither a GSTIN nor a State — one is required`, voucherIds: [...noGstinNoState] })
  }
  return {
    period,
    sent,
    received,
    sentOn: [],
    supplied,
    issues,
    totals: {
      sentQtyMilli: sent.reduce((t, r) => t + r.qtyMilli, 0),
      sentValuePaise: sent.reduce((t, r) => t + r.taxableValuePaise, 0),
      receivedQtyMilli: received.reduce((t, r) => t + r.qtyMilli, 0),
      lossQtyMilli: received.reduce((t, r) => t + r.lossQtyMilli, 0),
      suppliedQtyMilli: supplied.reduce((t, r) => t + r.qtyMilli, 0)
    }
  }
}

// ---------- export ----------

const rupees = (paise: number): number => Math.round(paise) / 100
const qty3 = (milli: number): number => milli / 1000
const portalDate = (iso: string | null): string | null => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : null)

/**
 * ITC-04 JSON. The GSTN ITC-04 offline tool's import schema is NOT published as a document we
 * could cite (see UNVERIFIED in ./sources.ts), so this is the app's own structured layout,
 * mirroring the form's tables and columns one-to-one — use it with the offline tool's Excel
 * template, not as a direct portal upload.
 */
export function itc04Json(r: Itc04Result, gstin: string): Record<string, unknown> {
  const jw = (x: JobWorker) => ({ jw_gstin: x.jwGstin, jw_state: x.jwGstin ? null : x.jwStateCode, jw_name: x.jwName })
  return {
    format: 'total.itc04.v1',
    verified_against_offline_tool: false,
    gstin,
    fp: r.period.fp,
    period: { from: r.period.from, to: r.period.to, kind: r.period.kind },
    table4: r.sent.map((s) => ({
      ...jw(s), chnum: s.challanNo, chdt: portalDate(s.challanDate), goods_ty: s.goodsType === 'capital_goods' ? '8b' : '8a',
      desc: s.description, hsn: s.hsn, uqc: s.uqc, qty: qty3(s.qtyMilli), txval: rupees(s.taxableValuePaise),
      tx_i: s.igstRate, tx_c: s.cgstRate, tx_s: s.sgstRate, tx_cs: s.cessRate
    })),
    table5a: r.received.map((x) => ({
      ...jw(x), jw_chnum: x.jwChallanNo, jw_chdt: portalDate(x.jwChallanDate), o_chnum: x.originalChallanNo, o_chdt: portalDate(x.originalChallanDate),
      nat_jw: x.natureOfProcessing, desc: x.description, uqc: x.uqc, qty: qty3(x.qtyMilli), lw_uqc: x.lossUqc, lw_qty: qty3(x.lossQtyMilli),
      received_as: x.kind
    })),
    table5b: [],
    table5c: r.supplied.map((x) => ({
      ...jw(x), inum: x.invoiceNo, idt: portalDate(x.invoiceDate), desc: x.description, uqc: x.uqc, qty: qty3(x.qtyMilli), txval: rupees(x.taxableValuePaise)
    }))
  }
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvLine = (cells: unknown[]): string => cells.map(csvCell).join(',')

/** One CSV holding every table (a `Table` column first), column order as on the form. */
export function itc04Csv(r: Itc04Result): string {
  const lines: string[] = []
  lines.push(csvLine(['Table', 'GSTIN of job worker', 'State (if unregistered)', 'Job worker', 'Challan no.', 'Challan date', 'Original challan no.', 'Original challan date',
    'Description', 'HSN', 'UQC', 'Quantity', 'Taxable value', 'Type of goods', 'IGST %', 'CGST %', 'SGST %', 'Cess %', 'Nature of job work', 'Losses UQC', 'Losses qty']))
  for (const s of r.sent) {
    lines.push(csvLine(['4', s.jwGstin, s.jwGstin ? '' : s.jwStateCode, s.jwName, s.challanNo, s.challanDate, '', '', s.description, s.hsn, s.uqc, qty3(s.qtyMilli),
      rupees(s.taxableValuePaise).toFixed(2), s.goodsType === 'capital_goods' ? 'Capital goods' : 'Inputs', s.igstRate, s.cgstRate, s.sgstRate, s.cessRate, s.natureOfProcessing, '', '']))
  }
  for (const x of r.received) {
    lines.push(csvLine(['5A', x.jwGstin, x.jwGstin ? '' : x.jwStateCode, x.jwName, x.jwChallanNo, x.jwChallanDate, x.originalChallanNo, x.originalChallanDate, x.description,
      x.hsn, x.uqc, qty3(x.qtyMilli), '', x.kind === 'processed' ? 'Received after processing' : 'Returned unprocessed', '', '', '', '', x.natureOfProcessing, x.lossUqc, qty3(x.lossQtyMilli)]))
  }
  for (const x of r.supplied) {
    lines.push(csvLine(['5C', x.jwGstin, x.jwGstin ? '' : x.jwStateCode, x.jwName, x.invoiceNo, x.invoiceDate, '', '', x.description, x.hsn, x.uqc, qty3(x.qtyMilli),
      rupees(x.taxableValuePaise).toFixed(2), 'Supplied from job worker premises', '', '', '', '', '', '', '']))
  }
  return lines.join('\n')
}
