import type { DB } from '../db/connection'
import {
  SCRATCHPAD_GROUP_NAME,
  SCRATCHPAD_LEDGER_NAME,
  checkReclassify,
  reclassifyNote
} from '@shared/scratchpad'
import { writeAudit } from './audit'
import { IN_BOOKS, getLockDate, getVoucher } from './vouchers'
import { findOrCreateLedger } from './masters'

/**
 * The scratchpad ledger (roadmap B #46).
 *
 * See `@shared/scratchpad` for why this is a real ledger under Suspense A/c rather than a flag on
 * a voucher, and why classifying EDITS the existing line instead of posting a transfer journal.
 *
 * The ledger is created on demand — the first time somebody asks for it — rather than seeded into
 * every company. Most books never need one, and a Suspense ledger sitting at zero in every new
 * company's trial balance is a line that teaches people to ignore a Suspense balance.
 */

/** The scratchpad ledger's id, creating it if this is the first time. */
export function scratchpadLedgerId(db: DB): number {
  return findOrCreateLedger(db, SCRATCHPAD_LEDGER_NAME, SCRATCHPAD_GROUP_NAME)
}

/** Its id if it exists, without creating one — for the screens that only want to show a count. */
export function existingScratchpadLedgerId(db: DB): number | null {
  const row = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(SCRATCHPAD_LEDGER_NAME) as
    | { id: number }
    | undefined
  return row?.id ?? null
}

export interface ScratchpadEntry {
  voucherLineId: number
  voucherId: number
  voucherNumber: string
  voucherType: string
  date: string
  drCr: 'dr' | 'cr'
  amount: number
  narration: string | null
  partyName: string | null
  /** The other side of the entry, so the list says what the money actually was without opening
   *  the voucher — "₹3,400 cr, other side HDFC Bank" is the whole question in one line. */
  contraNames: string
}

export interface ScratchpadSummary {
  ledgerId: number | null
  /** Signed dr-positive. The number an accountant wants at zero. */
  balancePaise: number
  entries: ScratchpadEntry[]
}

/**
 * What is sitting on the scratchpad, oldest first.
 *
 * Oldest first on purpose. A scratchpad is worked off, not browsed: the entry that has been
 * unclassified longest is the one whose answer is hardest to remember and the one most likely to
 * still be there at the year end.
 *
 * `IN_BOOKS` for the balance because that is what a trial balance shows, but the LIST is scoped
 * only to live vouchers: a post-dated cheque parked on the scratchpad still needs classifying
 * before it matures, and hiding it until then means it matures unclassified.
 */
export function scratchpad(db: DB, limit = 200): ScratchpadSummary {
  const ledgerId = existingScratchpadLedgerId(db)
  if (ledgerId === null) return { ledgerId: null, balancePaise: 0, entries: [] }

  const { bal } = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS bal
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
        WHERE vl.ledger_id = ? AND ${IN_BOOKS}`
    )
    .get(ledgerId) as { bal: number }

  const entries = db
    .prepare(
      `SELECT vl.id AS voucherLineId, v.id AS voucherId, v.number AS voucherNumber, vt.name AS voucherType,
              v.date, vl.dr_cr AS drCr, vl.amount, v.narration, p.name AS partyName,
              COALESCE((
                SELECT GROUP_CONCAT(ol.name, ', ') FROM (
                  SELECT l2.name AS name FROM voucher_lines vl2
                    JOIN ledgers l2 ON l2.id = vl2.ledger_id
                   WHERE vl2.voucher_id = v.id AND vl2.id <> vl.id
                   ORDER BY vl2.line_order LIMIT 3
                ) ol
              ), '') AS contraNames
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         LEFT JOIN ledgers p ON p.id = v.party_ledger_id
        WHERE vl.ledger_id = ? AND v.deleted_at IS NULL
        ORDER BY v.date, v.id, vl.line_order
        LIMIT ?`
    )
    .all(ledgerId, limit) as ScratchpadEntry[]

  return { ledgerId, balancePaise: bal, entries }
}

export interface ReclassifyInput {
  voucherLineId: number
  targetLedgerId: number
}

export interface ReclassifyResult {
  voucherId: number
  fromLedger: string
  toLedger: string
  amount: number
}

/**
 * Move one parked line to the ledger it always should have been on.
 *
 * A single-column UPDATE on `voucher_lines`, and everything else is checks. That is deliberate:
 * the amount, the side, the date, the party and the bill reference are all right already — only
 * the account was unknown — and re-posting the voucher would re-allocate its number, re-run the
 * negative-stock and credit-limit gates on an entry that already passed them, and change
 * `updated_at` on rows nobody touched.
 *
 * The audit row is written against `voucher_line` with both ledger names in it, so the trail says
 * what a reader needs: this line used to be unclassified, and here is who decided what it was.
 */
export function reclassify(db: DB, input: ReclassifyInput): ReclassifyResult {
  const scratchpadId = existingScratchpadLedgerId(db)
  if (scratchpadId === null) throw new Error('Nothing has ever been parked on the scratchpad')

  const line = db
    .prepare(
      `SELECT vl.id, vl.voucher_id AS voucherId, vl.ledger_id AS ledgerId, vl.amount,
              v.date, v.deleted_at AS deletedAt
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
        WHERE vl.id = ?`
    )
    .get(input.voucherLineId) as
    | { id: number; voucherId: number; ledgerId: number; amount: number; date: string; deletedAt: string | null }
    | undefined
  if (!line) throw new Error('That line is not there any more')

  const target = db.prepare('SELECT id, name FROM ledgers WHERE id = ?').get(input.targetLedgerId) as
    | { id: number; name: string }
    | undefined
  if (!target) throw new Error('Ledger not found')

  const problem = checkReclassify({
    lockDate: getLockDate(db),
    voucherDate: line.date,
    isDeleted: line.deletedAt !== null,
    targetLedgerId: input.targetLedgerId,
    scratchpadLedgerId: scratchpadId,
    notOnScratchpad: line.ledgerId !== scratchpadId
  })
  if (problem) throw new Error(problem)

  const before = getVoucher(db, line.voucherId)
  db.prepare("UPDATE voucher_lines SET ledger_id = ? WHERE id = ?").run(input.targetLedgerId, line.id)
  db.prepare("UPDATE vouchers SET updated_at = datetime('now') WHERE id = ?").run(line.voucherId)
  const after = getVoucher(db, line.voucherId)

  writeAudit(db, 'voucher_line', line.id, 'update', before, after)
  writeAudit(db, 'voucher', line.voucherId, 'update', { note: reclassifyNote(SCRATCHPAD_LEDGER_NAME, target.name) }, after)

  return {
    voucherId: line.voucherId,
    fromLedger: SCRATCHPAD_LEDGER_NAME,
    toLedger: target.name,
    amount: line.amount
  }
}
