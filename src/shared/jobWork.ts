/**
 * Job work: stock sent out for processing, and what comes back (roadmap E #127).
 *
 * Checked against the codebase first: there is no job-work service and no ITC-04 anywhere in this
 * app. Roadmap D #89 ("Delivery challan and job-work challan (ITC-04)") is still open, so this is
 * the STOCK half being built first — the movement, the pending balance and the section 143 clock
 * — with the data shaped so that the return in #89 can be produced from it rather than from a
 * second set of tables.
 *
 * The accounting fact that drives the whole design: **sending goods for job work is not a sale.**
 * Title never leaves the principal. Nothing is bought, nothing is sold, no money moves, and no
 * ledger is touched — exactly like a godown transfer, which is why this is recorded as one. The
 * goods move to the job worker's premises and stay on the principal's books, which is also what
 * makes them appear in the principal's closing stock, where they belong.
 *
 * The statutory fact that makes it more than a transfer: **section 143 of the CGST Act, 2017**
 * puts a clock on it. Inputs must come back within ONE YEAR of being sent out, capital goods
 * within THREE YEARS (moulds, dies, jigs, fixtures and tools are excluded from the clock by the
 * proviso to 143(3)/(4) and are not counted here). If they do not, section 143(3)/(4) deems the
 * goods to have been SUPPLIED to the job worker on the day they were sent — a tax liability,
 * backdated, with interest running from that day.
 *
 * Checked against the bare Act as at August 2026. The extension of the period by the Commissioner
 * under the proviso to 143(1) is not modelled: it is granted case by case, and a due date that
 * silently moved because the app assumed an extension would be worse than one that is early.
 *
 * That deemed-supply date is the reason the clock is computed here rather than left to a report:
 * the number a principal needs is not "what is out" but "what is out and about to become a
 * supply", and the two are different questions with different due dates on the same challan.
 */

import { addDays, addMonths, daysBetween } from './dates'

/** What was sent. The clock differs, so the classification is part of the challan, not a guess. */
export type JobWorkGoodsType = 'input' | 'capital'

/** Months allowed by section 143 before the goods are deemed supplied. */
export const JOB_WORK_MONTHS: Record<JobWorkGoodsType, number> = {
  input: 12,
  capital: 36
}

/**
 * The last day the goods may come back.
 *
 * Section 9 of the General Clauses Act, 1897: a period reckoned "from" a day excludes that day. So
 * one year from 15 March 2025 runs to 15 March 2026 inclusive, and the deemed supply falls on the
 * 16th. `addMonths` clamps rather than overflowing, so goods sent on 31 March are due back on 31
 * March and not on 1 April — a day that matters when it is the difference between compliant and
 * a backdated liability.
 */
export function returnDueDate(sentOn: string, goodsType: JobWorkGoodsType): string {
  return addMonths(sentOn, JOB_WORK_MONTHS[goodsType])
}

/** The date the supply is DEEMED to have happened when the goods do not come back: the day they
 *  were sent out, not the day the clock ran out (section 143(3)). Interest runs from here. */
export function deemedSupplyDate(sentOn: string): string {
  return sentOn
}

export type JobWorkState = 'closed' | 'open' | 'due-soon' | 'overdue'

/** How near the deadline counts as "due soon". A month is enough notice to chase a job worker. */
export const DUE_SOON_DAYS = 30

export interface JobWorkLineFacts {
  stockItemId: number
  name: string
  unitSymbol?: string
  sentQtyMilli: number
  /** Everything received back against this line so far, including scrap and waste. */
  returnedQtyMilli: number
}

export interface JobWorkLineStatus extends JobWorkLineFacts {
  pendingQtyMilli: number
}

export interface JobWorkStatus {
  dueDate: string
  /** Negative once the date has passed. */
  daysLeft: number
  state: JobWorkState
  pendingQtyMilli: number
  lines: JobWorkLineStatus[]
  /** Set only when the clock has run out: the date the supply is deemed to have happened. */
  deemedSupplyOn: string | null
}

/**
 * Where a challan stands on `asOn`.
 *
 * Closed beats overdue, deliberately and in that order. A challan whose goods all came back on
 * time is not overdue on the day after its due date, and a status that says otherwise makes the
 * whole report unusable within a year of go-live because every old challan is red.
 */
export function jobWorkStatus(
  challan: { sentOn: string; goodsType: JobWorkGoodsType; lines: JobWorkLineFacts[] },
  asOn: string
): JobWorkStatus {
  const lines = challan.lines.map((l) => ({
    ...l,
    // Clamped at zero: a return of more than was sent is refused at save time, and a negative
    // pending quantity here would quietly reduce the total on another line.
    pendingQtyMilli: Math.max(0, l.sentQtyMilli - l.returnedQtyMilli)
  }))
  const pendingQtyMilli = lines.reduce((t, l) => t + l.pendingQtyMilli, 0)
  const dueDate = returnDueDate(challan.sentOn, challan.goodsType)
  const daysLeft = daysBetween(asOn, dueDate)
  const state: JobWorkState =
    pendingQtyMilli === 0 ? 'closed' : daysLeft < 0 ? 'overdue' : daysLeft <= DUE_SOON_DAYS ? 'due-soon' : 'open'
  return {
    dueDate,
    daysLeft,
    state,
    pendingQtyMilli,
    lines,
    deemedSupplyOn: state === 'overdue' ? deemedSupplyDate(challan.sentOn) : null
  }
}

/** The day after the due date — the first day the goods are late. Kept as a function so no screen
 *  computes it as `dueDate` and reports a challan late a day early. */
export function firstLateDate(sentOn: string, goodsType: JobWorkGoodsType): string {
  return addDays(returnDueDate(sentOn, goodsType), 1)
}

export interface ReturnRequestLine {
  stockItemId: number
  qtyMilli: number
  /**
   * What came back as this line: the processed goods, the untouched balance, or the waste.
   *
   * Waste is separated because section 143(5) treats it differently — waste and scrap generated at
   * the job worker's premises may be supplied by the job worker directly on payment of tax, and it
   * does not need to come back at all. Lumping it in with the goods would make a challan look
   * short by the scrap percentage forever.
   */
  kind: 'goods' | 'waste'
}

export interface ReturnPlan {
  lines: ReturnRequestLine[]
  errors: string[]
}

/**
 * Check a receipt back against what is still out.
 *
 * Every reason at once, and named by item: a receipt refused with "quantity exceeds pending" on a
 * nine-line challan is a message that makes the user check all nine.
 */
export function planJobWorkReturn(input: {
  status: JobWorkStatus
  requested: ReturnRequestLine[]
  returnedOn: string
  sentOn: string
}): ReturnPlan {
  const errors: string[] = []
  if (input.returnedOn < input.sentOn) {
    errors.push('Goods cannot come back before they were sent out')
  }
  if (input.requested.length === 0) errors.push('Nothing to receive back')

  const pending = new Map(input.status.lines.map((l) => [l.stockItemId, l]))
  const takenByItem = new Map<number, number>()
  for (const req of input.requested) {
    const line = pending.get(req.stockItemId)
    if (!line) {
      errors.push(`Item ${req.stockItemId} was not on the challan that was sent out`)
      continue
    }
    if (req.qtyMilli <= 0) {
      errors.push(`${line.name}: a return of nothing is not a return`)
      continue
    }
    const taken = (takenByItem.get(req.stockItemId) ?? 0) + req.qtyMilli
    takenByItem.set(req.stockItemId, taken)
    if (taken > line.pendingQtyMilli) {
      errors.push(`${line.name}: more is coming back than is still out with the job worker`)
    }
  }
  return { lines: input.requested, errors }
}

/**
 * The godown a job worker's stock sits in.
 *
 * A named godown per job worker rather than one shared "Job work" godown, because the question the
 * principal is asked in a GST audit is "what is lying with WHOM", and one pooled godown answers
 * that with a single number covering four job workers. The prefix keeps them together in an
 * alphabetical godown list, where they would otherwise be scattered among the real premises.
 */
export function jobWorkGodownName(partyName: string): string {
  return `Job work — ${partyName}`.slice(0, 60)
}

export function isJobWorkGodown(name: string): boolean {
  return name.startsWith('Job work — ')
}
