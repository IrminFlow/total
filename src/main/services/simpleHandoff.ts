// WP 9.10 — "Back to simple" from a full-app screen lands on the matching simple screen WITH the
// same object (renderer lib/handoff.ts holds the one mapping table). The table needs two facts only
// main has, read here (viewer, read-only):
//
// - a voucher: its kind while it is IN the books (binned / optional / post-dated ones have no
//   simple view — the table then falls back to the flow), and for a credit / debit note the bill
//   it returns against (a `return` line link, else — a bill without item lines — the bill whose
//   number (sales) / supplier bill no. (purchase) the note carries as its reference, the way
//   services/simpleReturns.ts counts returns);
// - a ledger: whether it is a customer / supplier (a People page exists for it).
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import { isPartyLedger } from '@shared/chartOfAccounts'
import type { HandoffFacts } from '@shared/simple/handoff'
import { listGroups } from './masters'
import { IN_BOOKS } from './vouchers'

export function handoffFacts(db: DB, q: { voucherId?: number; ledgerId?: number }): HandoffFacts {
  const out: HandoffFacts = {}
  if (q.voucherId != null) {
    const v = db
      .prepare(
        `SELECT v.id, vt.kind, v.party_ledger_id AS partyId, v.reference FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE v.id = ? AND ${IN_BOOKS}`
      )
      .get(q.voucherId) as { id: number; kind: VoucherKind; partyId: number | null; reference: string | null } | undefined
    if (v) out.voucher = { id: v.id, kind: v.kind, originalId: v.kind === 'credit_note' || v.kind === 'debit_note' ? originalOf(db, v) : null }
  }
  if (q.ledgerId != null) {
    const l = db.prepare('SELECT id, group_id AS groupId FROM ledgers WHERE id = ?').get(q.ledgerId) as { id: number; groupId: number } | undefined
    if (l) out.ledger = { id: l.id, isParty: isPartyLedger(l, listGroups(db)) }
  }
  return out
}

function originalOf(db: DB, note: { id: number; kind: VoucherKind; partyId: number | null; reference: string | null }): number | null {
  const billKind = note.kind === 'credit_note' ? 'sales' : 'purchase'
  const linked = db
    .prepare(
      `SELECT ll.from_voucher_id AS id FROM line_links ll JOIN vouchers v ON v.id = ll.from_voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE ll.to_voucher_id = ? AND ll.link_type = 'return' AND vt.kind = ? AND ${IN_BOOKS} ORDER BY ll.id LIMIT 1`
    )
    .get(note.id, billKind) as { id: number } | undefined
  if (linked) return linked.id
  const ref = note.reference?.trim()
  if (!ref || note.partyId == null) return null
  const key = billKind === 'sales' ? 'v.number' : "COALESCE(NULLIF(TRIM(v.reference), ''), v.number)"
  const byRef = db
    .prepare(
      `SELECT v.id FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = ? AND v.party_ledger_id = ? AND ${key} = ? AND ${IN_BOOKS} ORDER BY v.date DESC, v.id DESC LIMIT 1`
    )
    .get(billKind, note.partyId, ref) as { id: number } | undefined
  return byRef?.id ?? null
}
