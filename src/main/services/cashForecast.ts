/**
 * Cash-flow forecast, assembled from what the books already know.
 *
 * Four sources, and nothing else:
 *   open receivable bills  → money expected in on the due date
 *   open payable bills     → money going out on the due date
 *   post-dated cheques     → the cash effect of a voucher that is not in the books yet
 *   recurring templates    → the rent and the salaries that will be posted because they always are
 *
 * No trend, no growth rate, no seasonality. Every row can be opened, and the total is the sum of
 * things that already exist somewhere else in the app. That is the whole design: a forecast that
 * cannot be audited gets quoted to a bank and then defended by someone who cannot explain it.
 *
 * The one honest caveat, stated on the screen rather than buried here: a recurring template that
 * posts a payment against a supplier bill will also appear as that open bill. Recurring rows are
 * therefore marked 'expected' and the screen shows the contracted-only line beside the full one.
 */

import type { DB } from '../db/connection'
import type { CashForecast, ForecastItem } from '@shared/forecast'
import { buildForecast } from '@shared/forecast'
import { nextDueAfter } from '@shared/recurring'
import { voucherInputSchema } from '@shared/schemas'
import { cashBankGroupIds } from './masters'
import { paymentSchedule, type PaymentSchedule } from './receivables'
import { listTemplates } from './recurring'
import { NOT_DELETED } from './vouchers'

/** How many occurrences one template may contribute, so a daily-ish cadence over a long window
 *  cannot flood the forecast with hundreds of identical rows. */
const MAX_OCCURRENCES_PER_TEMPLATE = 60

function billItems(schedule: PaymentSchedule, from: string, side: 'receivable' | 'payable'): ForecastItem[] {
  const sign = side === 'receivable' ? 1 : -1
  const items: ForecastItem[] = []
  // Overdue bills are dated at the window start: they are due now, whatever their invoice says.
  for (const b of schedule.overdue) {
    items.push({
      date: from,
      amount: sign * b.pending,
      source: side,
      certainty: 'contracted',
      label: `${b.party} — ${b.number} (${b.overdueDays}d overdue)`,
      ledgerId: b.ledgerId
    })
  }
  for (const day of schedule.days) {
    for (const b of day.bills) {
      items.push({
        date: day.date,
        amount: sign * b.pending,
        source: side,
        certainty: 'contracted',
        label: `${b.party} — ${b.number}`,
        ledgerId: b.ledgerId
      })
    }
  }
  return items
}

/**
 * Post-dated cheques.
 *
 * A PDC is deliberately kept out of the books until its date arrives (IN_BOOKS excludes it), so
 * its cash effect is exactly what a forecast is for. NOT_DELETED rather than IN_BOOKS here for
 * that reason — this is the one report that wants the vouchers the books are ignoring — and
 * optional (memorandum) vouchers are excluded by hand, since they never become cash.
 */
function pdcItems(db: DB, to: string): ForecastItem[] {
  const cashIds = [...cashBankGroupIds(db)]
  if (cashIds.length === 0) return []
  const placeholders = cashIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT v.id AS voucherId, v.date AS date, v.number AS number,
              COALESCE(pl.name, vt.name) AS label,
              COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS effect
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
       JOIN voucher_lines vl ON vl.voucher_id = v.id
       JOIN ledgers l ON l.id = vl.ledger_id
       WHERE v.post_dated = 1 AND v.is_optional = 0 AND v.date <= ? AND ${NOT_DELETED}
         AND l.group_id IN (${placeholders})
       GROUP BY v.id`
    )
    .all(to, ...cashIds) as { voucherId: number; date: string; number: string; label: string; effect: number }[]

  return rows
    .filter((r) => r.effect !== 0)
    .map((r) => ({
      date: r.date,
      amount: r.effect,
      source: 'pdc' as const,
      certainty: 'contracted' as const,
      label: `PDC ${r.number} — ${r.label}`,
      voucherId: r.voucherId
    }))
}

/** The net cash effect of a stored template voucher, in paise (positive = money in). */
function templateCashEffect(voucherJson: string, cashIds: Set<number>, groupOfLedger: Map<number, number>): number {
  const parsed = voucherInputSchema.safeParse(JSON.parse(voucherJson) as unknown)
  // A template whose stored voucher no longer parses (a deleted ledger, a schema change) is
  // skipped rather than guessed at — it will fail loudly at post time, which is the right place.
  if (!parsed.success) return 0
  let effect = 0
  for (const line of parsed.data.lines) {
    const gid = groupOfLedger.get(line.ledgerId)
    if (gid === undefined || !cashIds.has(gid)) continue
    effect += line.drCr === 'dr' ? line.amount : -line.amount
  }
  return effect
}

function recurringItems(db: DB, from: string, to: string): ForecastItem[] {
  const cashIds = cashBankGroupIds(db)
  if (cashIds.size === 0) return []
  const groupOfLedger = new Map(
    (db.prepare('SELECT id, group_id AS groupId FROM ledgers').all() as { id: number; groupId: number }[]).map((l) => [
      l.id,
      l.groupId
    ])
  )

  const items: ForecastItem[] = []
  for (const t of listTemplates(db)) {
    if (!t.active) continue
    const effect = templateCashEffect(t.voucherJson, cashIds, groupOfLedger)
    if (effect === 0) continue
    const opts = { dayOfMonth: t.dayOfMonth ?? undefined, weekday: t.weekday ?? undefined }
    let date = t.nextDue
    for (let i = 0; i < MAX_OCCURRENCES_PER_TEMPLATE && date <= to; i++) {
      // An occurrence already overdue still counts — it is going to be posted, late.
      items.push({
        date: date < from ? from : date,
        amount: effect,
        source: 'recurring',
        certainty: 'expected',
        label: t.name
      })
      try {
        date = nextDueAfter(t.cadence, opts, date)
      } catch {
        // A template missing the field its cadence needs is corrupt; one occurrence is all it
        // can honestly contribute, and refusing to forecast at all would be worse.
        break
      }
    }
  }
  return items
}

/** Opening cash for the forecast: cash + bank as on the window start, from the payment schedule
 *  (which computes it against the same group set every other cash view uses). */
export function cashForecast(db: DB, from: string, to: string, bucketDays = 7): CashForecast {
  const payables = paymentSchedule(db, from, to, 'payable')
  const receivables = paymentSchedule(db, from, to, 'receivable')
  return buildForecast({
    from,
    to,
    openingCash: payables.funds,
    bucketDays,
    items: [
      ...billItems(receivables, from, 'receivable'),
      ...billItems(payables, from, 'payable'),
      ...pdcItems(db, to),
      ...recurringItems(db, from, to)
    ]
  })
}
