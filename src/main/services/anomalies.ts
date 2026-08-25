/**
 * Anomaly watch: reading the history the statistic compares against.
 *
 * The scoring lives in `@shared/ai/anomaly` and is pure. This file's only job is to hand it the
 * right two sets: everything BEFORE the window as history, and the window itself as candidates.
 *
 * The split matters. Scoring a period against a history that includes that period is how a run of
 * six identical fraudulent payments comes out looking normal — they become the distribution. So
 * history stops the day the window starts.
 */

import type { DB } from '../db/connection'
import { findAnomalies, type AnomalyFinding, type HistoryEntry } from '@shared/ai/anomaly'
import { formatPaise } from '@shared/money'
import { addDays } from '@shared/dates'
import { IN_BOOKS } from './vouchers'

interface AmountRow {
  voucherId: number
  date: string
  voucherTypeId: number
  partyLedgerId: number | null
  amountPaise: number
  ledgerName: string | null
  voucherType: string
  number: string
  narration: string | null
}

/**
 * Voucher amounts with the party attached.
 *
 * The amount is the debit side of the voucher, which is the same figure the Day Book shows — a
 * voucher balances, so either side would do, and using the one the user already sees means a
 * flagged figure matches the screen it came from.
 */
function amounts(db: DB, from: string, to: string): AmountRow[] {
  return db
    .prepare(
      `SELECT v.id AS voucherId, v.date, v.voucher_type_id AS voucherTypeId,
              v.party_ledger_id AS partyLedgerId, vt.name AS voucherType, v.number,
              v.narration, pl.name AS ledgerName,
              COALESCE((SELECT SUM(amount) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr'), 0) AS amountPaise
       FROM vouchers v
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as AmountRow[]
}

export interface AnomalyRow extends AnomalyFinding {
  voucherType: string
  number: string
  party: string | null
  narration: string | null
}

/**
 * Entries in [from, to] unlike anything in the two years before them.
 *
 * Two years rather than everything: a distribution from before the business changed size is not
 * the distribution this entry belongs to, and comparing against it flags every entry in a company
 * that grew.
 */
export function anomalyWatch(db: DB, from: string, to: string, historyDays = 730): AnomalyRow[] {
  const historyFrom = addDays(from, -historyDays)
  const history = amounts(db, historyFrom, addDays(from, -1))
  const candidates = amounts(db, from, to)

  const byId = new Map(candidates.map((c) => [c.voucherId, c]))
  const strip = (r: AmountRow): HistoryEntry => ({
    voucherId: r.voucherId,
    date: r.date,
    voucherTypeId: r.voucherTypeId,
    partyLedgerId: r.partyLedgerId,
    amountPaise: r.amountPaise
  })

  return findAnomalies(history.map(strip), candidates.map(strip), { money: formatPaise }).map((f) => {
    const row = byId.get(f.voucherId)!
    return {
      ...f,
      voucherType: row.voucherType,
      number: row.number,
      party: row.ledgerName,
      narration: row.narration
    }
  })
}
