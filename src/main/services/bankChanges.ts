import type { DB } from '../db/connection'
import {
  bankChangeNeedsSecondPerson, bankDetailsChanged, canConfirmBankChange, type BankDetails
} from '@shared/bankDetails'
import type { Role } from './roles'
import { currentAuditUser, writeAudit } from './audit'
import { getLedger, updateLedger } from './masters'
import type { LedgerInput } from '@shared/schemas'

/**
 * The two-person rule for a supplier's bank details (roadmap V #388).
 *
 * The fraud this exists for needs no access to the bank and no forged instrument: one field on a
 * master, and every payment after it goes somewhere else. It is usually discovered a month later,
 * when the real supplier asks where their money is.
 *
 * So a change to an account number, an IFSC or the holder's name does not take effect when it is
 * saved. It is parked here, and someone else has to look at it. Nothing else about the party is
 * held up — the name, address, GSTIN and credit terms save as they always did, because a rule
 * that makes routine master maintenance painful is a rule that gets worked around.
 */

export type BankChangeState = 'pending' | 'approved' | 'rejected'

export interface BankChangeRequest {
  id: number
  ledgerId: number
  ledgerName: string
  oldAccount: string | null
  oldIfsc: string | null
  oldHolder: string | null
  newAccount: string | null
  newIfsc: string | null
  newHolder: string | null
  state: BankChangeState
  requestedBy: string | null
  requestedAt: string
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string | null
}

const SELECT = `
  SELECT r.id, r.ledger_id AS ledgerId, l.name AS ledgerName,
         r.old_account AS oldAccount, r.old_ifsc AS oldIfsc, r.old_holder AS oldHolder,
         r.new_account AS newAccount, r.new_ifsc AS newIfsc, r.new_holder AS newHolder,
         r.state, r.requested_by AS requestedBy, r.requested_at AS requestedAt,
         r.decided_by AS decidedBy, r.decided_at AS decidedAt, r.decision_note AS decisionNote
  FROM bank_detail_requests r JOIN ledgers l ON l.id = r.ledger_id`

export function listPendingBankChanges(db: DB): BankChangeRequest[] {
  return db.prepare(`${SELECT} WHERE r.state = 'pending' ORDER BY r.id`).all() as BankChangeRequest[]
}

export function listDecidedBankChanges(db: DB, limit = 50): BankChangeRequest[] {
  return db
    .prepare(`${SELECT} WHERE r.state <> 'pending' ORDER BY r.decided_at DESC, r.id DESC LIMIT ?`)
    .all(limit) as BankChangeRequest[]
}

export function getBankChange(db: DB, id: number): BankChangeRequest | null {
  return (db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as BankChangeRequest | undefined) ?? null
}

export function pendingBankChangeCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM bank_detail_requests WHERE state = 'pending'").get() as { n: number }).n
}

function activeUserCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as { n: number }).n
}

export type BankChangeOutcome =
  | { applied: true; request: null }
  | { applied: false; request: BankChangeRequest }
  | { applied: 'unchanged'; request: null }

/**
 * Route a bank-detail change: apply it, or park it for a second person.
 *
 * Called from the ledger-save path with only the bank fields; everything else on the master has
 * already been written by then. Returns what happened so the UI can say so plainly — a change
 * that silently did not take effect would be worse than no rule at all.
 */
export function submitBankChange(
  db: DB,
  ledgerId: number,
  next: BankDetails,
  actor: { role: Role | null; name: string | null }
): BankChangeOutcome {
  const ledger = getLedger(db, ledgerId)
  if (!ledger) throw new Error('Ledger not found')
  const before: BankDetails = { account: ledger.bankAccount, ifsc: ledger.bankIfsc, holder: ledger.bankHolder }
  if (!bankDetailsChanged(before, next)) return { applied: 'unchanged', request: null }

  if (!bankChangeNeedsSecondPerson({ activeUsers: activeUserCount(db), actorRole: actor.role })) {
    applyBankDetails(db, ledgerId, next)
    return { applied: true, request: null }
  }

  // One pending request per ledger: a second change while the first is waiting supersedes it,
  // rather than leaving a queue of half-truths about where one supplier is paid.
  db.prepare("UPDATE bank_detail_requests SET state = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = 'Superseded by a newer request' WHERE ledger_id = ? AND state = 'pending'")
    .run(actor.name ?? currentAuditUser(), ledgerId)

  const res = db
    .prepare(
      `INSERT INTO bank_detail_requests
        (ledger_id, old_account, old_ifsc, old_holder, new_account, new_ifsc, new_holder, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ledgerId, before.account, before.ifsc, before.holder, next.account, next.ifsc, next.holder,
      actor.name ?? currentAuditUser())
  const request = getBankChange(db, Number(res.lastInsertRowid))!
  writeAudit(db, 'bank_detail_request', request.id, 'create', before, next)
  return { applied: false, request }
}

/** Write the details onto the master. The only place that does. */
function applyBankDetails(db: DB, ledgerId: number, next: BankDetails): void {
  const ledger = getLedger(db, ledgerId)!
  // updateLedger owns the audit row and the full-record write; passing the existing values for
  // everything else keeps this a bank-details-only change rather than a re-save of the party.
  const input: LedgerInput = {
    ...ledger,
    bankAccount: next.account,
    bankIfsc: next.ifsc,
    bankHolder: next.holder
  } as LedgerInput
  updateLedger(db, ledgerId, input)
}

/** Confirm or refuse a parked change. The rule about who may (never the requester) is pure —
 *  src/shared/bankDetails.ts — so every case has a test of its own. */
export function decideBankChange(
  db: DB,
  id: number,
  approve: boolean,
  approver: { role: Role | null; name: string | null },
  note?: string | null
): BankChangeRequest {
  const request = getBankChange(db, id)
  if (!request) throw new Error('Request not found')
  if (request.state !== 'pending') throw new Error('That change has already been decided')
  const verdict = canConfirmBankChange({
    approverRole: approver.role,
    approverName: approver.name,
    requestedBy: request.requestedBy
  })
  if (!verdict.ok) throw new Error(verdict.message)

  const run = db.transaction(() => {
    if (approve) {
      applyBankDetails(db, request.ledgerId, {
        account: request.newAccount,
        ifsc: request.newIfsc,
        holder: request.newHolder
      })
    }
    db.prepare(
      `UPDATE bank_detail_requests SET state = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?
       WHERE id = ?`
    ).run(approve ? 'approved' : 'rejected', approver.name, note ?? null, id)
  })
  run()

  const after = getBankChange(db, id)!
  writeAudit(db, 'bank_detail_request', id, 'update', { state: 'pending' }, {
    state: after.state,
    decidedBy: after.decidedBy,
    note: after.decisionNote
  })
  return after
}
