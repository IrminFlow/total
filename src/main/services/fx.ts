import type { DB } from '../db/connection'
import {
  FX_GAIN_LOSS_LEDGER,
  fcMinorFor,
  revalue,
  revaluationNarration,
  type RateMicro,
  type Revaluation
} from '@shared/fx'
import { writeAudit } from './audit'
import { IN_BOOKS, deleteVoucher, getLockDate, saveVoucher } from './vouchers'
import { findOrCreateLedger } from './masters'

/**
 * Multi-currency accounts and revaluation (roadmap F #140).
 *
 * The arithmetic is in `@shared/fx`; this file answers what the books say and writes what follows.
 *
 * The one decision worth restating here, because it is the whole feature: **the rate is recorded,
 * not looked up.** Every foreign-currency line stores the rate that produced its rupee amount, and
 * every revaluation stores the closing rate it used on the `fx_revaluations` row AND on the
 * voucher's own lines. Nothing here ever re-reads a rate table to explain a number that was
 * already posted — that is how a March revaluation ends up being redescribed at June's rate, and
 * the redescription is neither wrong-looking nor recoverable.
 *
 * An unrealised difference is a real posting with real tax consequences (AS 11 / Ind AS 21 para
 * 23(a) and 28: monetary items at the closing rate, difference to the statement of profit and
 * loss). So it goes through `saveVoucher` like any other journal — audited, numbered, in the day
 * book, reversible only by binning the voucher — and not into a report that quietly restates a
 * balance sheet line.
 */

export interface FcAccount {
  ledgerId: number
  ledgerName: string
  currencyCode: string
  symbol: string
  decimals: number
  /** Books balance in rupees, signed dr-positive, as on the date asked for. */
  bookPaise: number
  /**
   * Foreign balance, signed dr-positive.
   *
   * Summed from the lines that CARRY a foreign amount. A line with none contributes nothing to
   * the foreign side even though it moved the rupee side — bank charges levied in rupees on a
   * dollar account are exactly that — and the difference between the two is what `unmatchedPaise`
   * reports rather than hides.
   */
  fcMinor: number
  /** Rupees on this ledger that no foreign amount accounts for. Non-zero is a thing to look at,
   *  not necessarily a bug: it is the rupee-only movements on a foreign account. */
  unmatchedPaise: number
  /** The most recent revaluation, if the account has ever been revalued. */
  lastRevaluedOn: string | null
  lastRateMicro: RateMicro | null
}

/**
 * Every ledger that keeps a foreign currency, with both balances as on `asOn`.
 *
 * `IN_BOOKS`, so a post-dated or unapproved voucher does not join a balance that is about to be
 * revalued — revaluing money that has not arrived posts a gain on it.
 */
export function fcAccounts(db: DB, asOn: string): FcAccount[] {
  return db
    .prepare(
      `SELECT l.id AS ledgerId, l.name AS ledgerName, l.currency_code AS currencyCode,
              COALESCE(c.symbol, l.currency_code) AS symbol, COALESCE(c.decimals, 2) AS decimals,
              l.opening_balance + COALESCE((
                SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
                  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                 WHERE vl.ledger_id = l.id AND v.date <= ? AND ${IN_BOOKS}
              ), 0) AS bookPaise,
              COALESCE((
                SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.fc_amount ELSE -vl.fc_amount END)
                  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                 WHERE vl.ledger_id = l.id AND vl.fc_amount IS NOT NULL AND v.date <= ? AND ${IN_BOOKS}
              ), 0) AS fcMinor,
              COALESCE((
                SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
                  FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
                 WHERE vl.ledger_id = l.id AND vl.fc_amount IS NULL AND v.date <= ? AND ${IN_BOOKS}
              ), 0) AS unmatchedPaise,
              (SELECT r.as_on FROM fx_revaluations r WHERE r.ledger_id = l.id ORDER BY r.as_on DESC LIMIT 1)
                AS lastRevaluedOn,
              (SELECT r.closing_rate_micro FROM fx_revaluations r WHERE r.ledger_id = l.id ORDER BY r.as_on DESC LIMIT 1)
                AS lastRateMicro
         FROM ledgers l
         LEFT JOIN currencies c ON c.code = l.currency_code
        WHERE l.currency_code IS NOT NULL
        ORDER BY l.name`
    )
    .all(asOn, asOn, asOn) as FcAccount[]
}

export function fcAccount(db: DB, ledgerId: number, asOn: string): FcAccount | null {
  return fcAccounts(db, asOn).find((a) => a.ledgerId === ledgerId) ?? null
}

export interface RevaluationPreview extends Revaluation {
  ledgerId: number
  ledgerName: string
  currencyCode: string
  decimals: number
  asOn: string
  closingRateMicro: RateMicro
  fcMinor: number
  bookPaise: number
  /** The opening balance restated, shown so the arithmetic on screen is checkable by eye. */
  narration: string
  /** Why it cannot be posted, if it cannot. Empty when it can. */
  errors: string[]
}

/**
 * What revaluing this account on this date would do, without doing it.
 *
 * Every refusal is collected rather than thrown, because the form shows them next to the numbers
 * that caused them — a revaluation refused with one message is one the user re-attempts blind.
 */
export function previewRevaluation(
  db: DB,
  input: { ledgerId: number; asOn: string; closingRateMicro: RateMicro }
): RevaluationPreview {
  const account = fcAccount(db, input.ledgerId, input.asOn)
  if (!account) throw new Error('That ledger does not keep a foreign currency')

  const result = revalue({
    fcMinor: account.fcMinor,
    bookPaise: account.bookPaise,
    closingRateMicro: input.closingRateMicro,
    decimals: account.decimals
  })

  const errors: string[] = []
  const lock = getLockDate(db)
  if (lock && input.asOn <= lock) errors.push(`Books are locked up to ${lock}`)
  if (input.closingRateMicro <= 0) errors.push('A closing rate must be a positive number')
  const already = db
    .prepare('SELECT as_on AS asOn FROM fx_revaluations WHERE ledger_id = ? AND as_on = ?')
    .get(input.ledgerId, input.asOn) as { asOn: string } | undefined
  if (already) {
    // Refused rather than added to. A second revaluation of the same period end at a corrected
    // rate must replace the first, and replacing means deleting the voucher the first one posted
    // — which the user does explicitly, because it is a posted entry in a period they may have
    // already reported.
    errors.push(`${account.ledgerName} has already been revalued as on ${input.asOn} — remove that entry first`)
  }
  if (result.isNil && errors.length === 0) {
    errors.push('The rate has not moved against the books — there is nothing to post')
  }

  return {
    ...result,
    ledgerId: account.ledgerId,
    ledgerName: account.ledgerName,
    currencyCode: account.currencyCode,
    decimals: account.decimals,
    asOn: input.asOn,
    closingRateMicro: input.closingRateMicro,
    fcMinor: account.fcMinor,
    bookPaise: account.bookPaise,
    narration: revaluationNarration({
      ledgerName: account.ledgerName,
      code: account.currencyCode,
      fcMinor: account.fcMinor,
      decimals: account.decimals,
      rateMicro: input.closingRateMicro,
      asOn: input.asOn
    }),
    errors
  }
}

export interface RevaluationRecord {
  id: number
  ledgerId: number
  ledgerName: string
  asOn: string
  currencyCode: string
  closingRateMicro: RateMicro
  fcMinor: number
  bookPaise: number
  restatedPaise: number
  differencePaise: number
  voucherId: number | null
  voucherNumber: string | null
}

const REVAL_SELECT = `
  SELECT r.id, r.ledger_id AS ledgerId, l.name AS ledgerName, r.as_on AS asOn, r.currency_code AS currencyCode,
         r.closing_rate_micro AS closingRateMicro, r.fc_minor AS fcMinor, r.book_paise AS bookPaise,
         r.restated_paise AS restatedPaise, r.difference_paise AS differencePaise,
         r.voucher_id AS voucherId,
         (SELECT v.number FROM vouchers v WHERE v.id = r.voucher_id AND v.deleted_at IS NULL) AS voucherNumber
    FROM fx_revaluations r JOIN ledgers l ON l.id = r.ledger_id`

export function listRevaluations(db: DB, ledgerId?: number | null): RevaluationRecord[] {
  return ledgerId == null
    ? (db.prepare(`${REVAL_SELECT} ORDER BY r.as_on DESC, l.name`).all() as RevaluationRecord[])
    : (db.prepare(`${REVAL_SELECT} WHERE r.ledger_id = ? ORDER BY r.as_on DESC`).all(ledgerId) as RevaluationRecord[])
}

function journalTypeId(db: DB): number {
  const vt = db
    .prepare("SELECT id FROM voucher_types WHERE kind = 'journal' ORDER BY is_system DESC, id LIMIT 1")
    .get() as { id: number } | undefined
  if (!vt) throw new Error('No journal voucher type exists')
  return vt.id
}

/**
 * Post the revaluation.
 *
 * The foreign-currency ledger takes the difference on the side the sign says, and the gain/loss
 * account takes the other. The FC ledger's line carries `fcAmount = 0` and the closing rate: the
 * balance did not move in dollars, only in rupees, and recording a zero foreign movement AT the
 * rate is what makes the rate visible on the voucher itself rather than only on a side table.
 */
export function postRevaluation(
  db: DB,
  input: { ledgerId: number; asOn: string; closingRateMicro: RateMicro; narration?: string | null }
): RevaluationRecord {
  const preview = previewRevaluation(db, input)
  if (preview.errors.length) throw new Error(preview.errors.join('; '))

  // Indirect Expenses, not a new group: an unrealised exchange difference is a P&L item under AS
  // 11 para 28, and a LOSS is the case the account is created for. A gain lands as a debit balance
  // in an expense head, which reads correctly on the P&L as a negative expense and is what every
  // Tally chart in this market does with the same account.
  const gainLossId = findOrCreateLedger(db, FX_GAIN_LOSS_LEDGER, 'Indirect Expenses')
  const amount = Math.abs(preview.differencePaise)

  const run = db.transaction((): number => {
    const voucher = saveVoucher(db, {
      voucherTypeId: journalTypeId(db),
      date: input.asOn,
      narration: input.narration?.trim() || preview.narration,
      lines: [
        {
          ledgerId: input.ledgerId,
          drCr: preview.ledgerSide,
          amount,
          costAllocations: [],
          fcAmount: 0,
          fcRateMicro: input.closingRateMicro
        },
        {
          ledgerId: gainLossId,
          drCr: preview.ledgerSide === 'dr' ? 'cr' : 'dr',
          amount,
          costAllocations: []
        }
      ],
      inventory: [],
      billRefs: [],
      tds: null
    })

    const res = db
      .prepare(
        `INSERT INTO fx_revaluations
           (ledger_id, as_on, currency_code, closing_rate_micro, fc_minor, book_paise, restated_paise,
            difference_paise, voucher_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.ledgerId, input.asOn, preview.currencyCode, input.closingRateMicro,
        preview.fcMinor, preview.bookPaise, preview.restatedPaise, preview.differencePaise, voucher.id
      )
    return Number(res.lastInsertRowid)
  })

  const id = run()
  const record = db.prepare(`${REVAL_SELECT} WHERE r.id = ?`).get(id) as RevaluationRecord
  writeAudit(db, 'fx_revaluation', id, 'create', null, record)
  return record
}

/**
 * Undo a revaluation: the row and the voucher it posted.
 *
 * The voucher goes to the BIN, not out of existence — it was a posted entry, possibly in a period
 * that has been reported, and the bin is where this app keeps the record of an entry that should
 * not have been made. The row goes because its whole purpose is the UNIQUE that stops the same
 * period being revalued twice, and leaving it would block the corrected posting.
 */
export function removeRevaluation(db: DB, id: number): void {
  const record = db.prepare(`${REVAL_SELECT} WHERE r.id = ?`).get(id) as RevaluationRecord | undefined
  if (!record) throw new Error('Revaluation not found')
  const lock = getLockDate(db)
  if (lock && record.asOn <= lock) throw new Error(`Books are locked up to ${lock}`)
  const run = db.transaction(() => {
    db.prepare('DELETE FROM fx_revaluations WHERE id = ?').run(id)
    if (record.voucherId) deleteVoucher(db, record.voucherId)
  })
  run()
  writeAudit(db, 'fx_revaluation', id, 'delete', record, null)
}

/** What a rupee balance is worth in the account's own currency at a rate — for the screen only,
 *  never stored. Exposed here so the renderer does not do the arithmetic itself. */
export function fcEquivalent(paise: number, rateMicro: RateMicro, decimals: number): number {
  return fcMinorFor(paise, rateMicro, decimals)
}
