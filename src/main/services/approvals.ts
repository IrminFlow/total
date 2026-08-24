import type { DB } from '../db/connection'
import { canDecideApproval, needsApproval, type ApprovalState } from '@shared/approvals'
import type { Role } from './roles'
import { getApprovalThreshold } from './config'
import { currentAuditUser, writeAudit } from './audit'
import { NOT_DELETED } from './vouchers'

/**
 * Vouchers that are waiting for the owner.
 *
 * A held voucher is saved, numbered and visible to whoever typed it — it is simply not in the
 * books yet (IN_BOOKS excludes it, see services/vouchers.ts). That is the honest state for an
 * entry the owner has not seen: not lost, not counted.
 *
 * Nothing here posts anything by itself. Approving flips one flag on a voucher that already
 * exists; rejecting flips it the other way and keeps the reason.
 */

export interface PendingVoucher {
  voucherId: number
  date: string
  number: string
  voucherType: string
  partyName: string | null
  /** Debit total, paise. */
  amount: number
  narration: string | null
  /** Who entered it, from the audit trail — the queue is meaningless without it. */
  enteredBy: string | null
  enteredAt: string
  state: ApprovalState
  decidedBy: string | null
  decidedAt: string | null
  note: string | null
}

const PENDING_SQL = `
  SELECT v.id AS voucherId, v.date, v.number, vt.name AS voucherType,
         pl.name AS partyName, v.narration,
         COALESCE((SELECT SUM(amount) FROM voucher_lines WHERE voucher_id = v.id AND dr_cr = 'dr'), 0) AS amount,
         v.created_at AS enteredAt,
         v.approval_state AS state, v.approval_by AS decidedBy, v.approval_at AS decidedAt,
         v.approval_note AS note,
         (SELECT user_name FROM audit_log
           WHERE entity = 'voucher' AND entity_id = v.id AND action = 'create'
           ORDER BY id LIMIT 1) AS enteredBy
  FROM vouchers v
  JOIN voucher_types vt ON vt.id = v.voucher_type_id
  LEFT JOIN ledgers pl ON pl.id = v.party_ledger_id`

/** Everything still waiting. Binned vouchers drop out: somebody withdrew the entry, which is a
 *  decision of its own and does not need a second one. */
export function listPending(db: DB): PendingVoucher[] {
  return db
    .prepare(`${PENDING_SQL} WHERE v.approval_state = 'pending' AND ${NOT_DELETED} ORDER BY v.date, v.id`)
    .all() as PendingVoucher[]
}

/** Recently decided, newest first — so an owner can see what they let through last week. */
export function listDecided(db: DB, limit = 50): PendingVoucher[] {
  return db
    .prepare(
      `${PENDING_SQL} WHERE v.approval_state IN ('approved','rejected') AND ${NOT_DELETED}
       ORDER BY v.approval_at DESC, v.id DESC LIMIT ?`
    )
    .all(limit) as PendingVoucher[]
}

export function pendingCount(db: DB): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE v.approval_state = 'pending' AND ${NOT_DELETED}`)
    .get() as { n: number }
  return row.n
}

export function getPending(db: DB, voucherId: number): PendingVoucher | null {
  const row = db.prepare(`${PENDING_SQL} WHERE v.id = ?`).get(voucherId) as PendingVoucher | undefined
  return row ?? null
}

/**
 * Apply the threshold to a voucher that has just been saved.
 *
 * Called by saveVoucher (which owns the transaction) rather than by the IPC layer, so a held
 * voucher is never briefly in the books between two statements.
 *
 * An ALTERATION is re-gated, not grandfathered: raising a ₹40,000 entry to ₹4,00,000 after it was
 * approved is precisely the move the threshold exists to catch, and letting the old decision
 * stand would make the whole thing decorative.
 */
export function applyApprovalGate(
  db: DB,
  voucherId: number,
  amount: number,
  actor: { role: Role | null; hasUsers: boolean }
): ApprovalState | null {
  const threshold = getApprovalThreshold(db)
  const hold = needsApproval({ threshold, amount, actorRole: actor.role, hasUsers: actor.hasUsers })
  if (!hold) {
    const current = (db.prepare('SELECT approval_state AS s FROM vouchers WHERE id = ?').get(voucherId) as
      { s: ApprovalState | null }).s
    // An APPROVED voucher keeps its approval on the record, even after the owner switches
    // thresholds off — the decision happened, and the trail should go on saying so.
    //
    // A REJECTED one is cleared instead, because reaching this line means somebody has just
    // edited it. The refusal was about the entry as it stood; that entry no longer exists, and
    // leaving the flag on would keep the corrected voucher out of the books with no way back in.
    if (current === 'rejected') {
      db.prepare(
        'UPDATE vouchers SET approval_state = NULL, approval_by = NULL, approval_at = NULL, approval_note = NULL WHERE id = ?'
      ).run(voucherId)
      return null
    }
    return current
  }
  db.prepare(
    `UPDATE vouchers SET approval_state = 'pending', approval_by = NULL, approval_at = NULL, approval_note = NULL
     WHERE id = ?`
  ).run(voucherId)
  return 'pending'
}

export interface DecideInput {
  voucherId: number
  approve: boolean
  note?: string | null
}

/**
 * The owner's decision.
 *
 * `approverRole`/`approverName` are passed in rather than read from a session here — services do
 * not know about sessions, and the rule itself (owner only, never your own entry) lives in
 * src/shared/approvals.ts where it can be tested one case at a time.
 */
export function decide(
  db: DB,
  input: DecideInput,
  approver: { role: Role | null; name: string | null }
): PendingVoucher {
  const voucher = getPending(db, input.voucherId)
  if (!voucher) throw new Error('Voucher not found')
  if (voucher.state !== 'pending') throw new Error('That voucher has already been decided')
  if (!canDecideApproval({ approverRole: approver.role, approverName: approver.name, enteredBy: voucher.enteredBy })) {
    throw new Error(
      approver.role === 'owner'
        ? 'An entry cannot be approved by the person who made it'
        : 'Only the owner can approve an entry'
    )
  }
  const state: ApprovalState = input.approve ? 'approved' : 'rejected'
  db.prepare(
    `UPDATE vouchers SET approval_state = ?, approval_by = ?, approval_at = datetime('now'), approval_note = ?
     WHERE id = ?`
  ).run(state, approver.name ?? currentAuditUser(), input.note ?? null, input.voucherId)
  const after = getPending(db, input.voucherId)!
  // 'update' rather than a new action: the audit_log CHECK constraint from migration 017 owns the
  // vocabulary, and the before/after snapshot already says exactly what changed.
  writeAudit(db, 'voucher', input.voucherId, 'update', { approvalState: 'pending' }, {
    approvalState: state,
    approvalBy: after.decidedBy,
    approvalNote: after.note
  })
  return after
}
