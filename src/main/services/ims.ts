/**
 * Invoice Management System decisions (roadmap #352).
 *
 * The engine — what to suggest, and why — is in src/shared/gst/ims.ts, with the statutory
 * position and the honest limits. This file stores what was decided, and joins it back onto a
 * fresh reconciliation.
 *
 * The one design decision worth defending: the action is keyed on the DOCUMENT, not on a voucher.
 * The rows most in need of a decision are the ones with no voucher at all — filed by a supplier,
 * never recorded here — and a table keyed on voucher_id could not hold a decision about them.
 */

import type { DB } from '../db/connection'
import { allowedActionsFor, buildWorklist, IMS_ACTIONS, imsKey, type ImsAction, type ImsDocumentKind, type ImsWorklist } from '@shared/gst/ims'
import type { Recon2bResult } from '@shared/gst/recon2b'
import { recon2b } from './gst'
import { writeAudit } from './audit'

interface ActionRow {
  doc_key: string
  action: ImsAction
  note: string | null
  decided_at: string
}

function decisions(db: DB): Map<string, { action: ImsAction; note: string | null; at: string }> {
  const rows = db.prepare('SELECT doc_key, action, note, decided_at FROM ims_actions').all() as ActionRow[]
  return new Map(rows.map((r) => [r.doc_key, { action: r.action, note: r.note, at: r.decided_at }]))
}

/**
 * A worklist from a downloaded GSTR-2B, with the decisions already taken folded back in.
 *
 * Takes the JSON rather than a stored reconciliation because nothing stores one: the 2B screen
 * reconciles from a file the user picks, and the decisions are the only part worth keeping.
 */
export function imsWorklist(
  db: DB,
  jsonText: string,
  from: string,
  to: string
): { worklist: ImsWorklist; errors: string[]; recon: Recon2bResult } {
  const { result, errors, period } = recon2b(db, jsonText, from, to)
  const worklist = buildWorklist(result.pairs, period ?? `${from}..${to}`, decisions(db))
  return { worklist, errors, recon: result }
}

export interface ImsDecisionInput {
  docKey: string
  period: string
  documentKind: ImsDocumentKind
  action: ImsAction
  note: string | null
}

/**
 * Record what was done on the portal.
 *
 * Upsert on the document key: a decision is revisable right up to the moment 2B generates, and
 * keeping a history of somebody changing their mind twice would be a table nobody reads. The
 * audit trail keeps the previous value, which is where that history belongs.
 */
export function recordImsDecision(db: DB, input: ImsDecisionInput, by: string | null): ImsAction {
  if (!IMS_ACTIONS.includes(input.action)) throw new Error(`Unknown IMS action ${input.action}`)
  if (!allowedActionsFor(input.documentKind, input.period).includes(input.action)) {
    throw new Error(
      input.documentKind === 'book_only'
        ? 'This book document has no IMS record on the portal; chase the supplier instead.'
        : `${input.action} is not available for this ${input.documentKind.replace('_', ' ')} in tax period ${input.period}`
    )
  }
  const before = db.prepare('SELECT * FROM ims_actions WHERE doc_key = ?').get(input.docKey) ?? null
  db.prepare(
    `INSERT INTO ims_actions (doc_key, period, action, note, decided_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(doc_key) DO UPDATE SET
       period = excluded.period, action = excluded.action, note = excluded.note,
       decided_at = datetime('now'), decided_by = excluded.decided_by`
  ).run(input.docKey, input.period, input.action, input.note, by)
  const after = db.prepare('SELECT * FROM ims_actions WHERE doc_key = ?').get(input.docKey)
  writeAudit(db, 'imsAction', 0, before ? 'update' : 'create', before, after)
  return input.action
}

/** Clear a decision, putting the document back on the worklist. */
export function clearImsDecision(db: DB, docKey: string): void {
  const before = db.prepare('SELECT * FROM ims_actions WHERE doc_key = ?').get(docKey) ?? null
  if (!before) return
  db.prepare('DELETE FROM ims_actions WHERE doc_key = ?').run(docKey)
  writeAudit(db, 'imsAction', 0, 'delete', before, null)
}

/**
 * Accept every row the reconciliation matched cleanly, in one action.
 *
 * The only bulk action offered, and deliberately the only one: a matched document is one where
 * the portal and the books agree on value and tax, and working through four hundred of those by
 * hand is how the twelve that do NOT agree get rubber-stamped along with them. Nothing else is
 * ever bulk-decided.
 */
export function acceptMatched(db: DB, worklist: ImsWorklist, by: string | null): number {
  let n = 0
  const run = db.transaction(() => {
    for (const row of worklist.rows) {
      if (row.bucket !== 'matched' || row.action) continue
      recordImsDecision(
        db,
        { docKey: row.key, period: worklist.period, documentKind: row.documentKind, action: 'accept', note: 'Accepted in bulk: portal and books agree.' },
        by
      )
      n += 1
    }
  })
  run()
  return n
}

/** Decisions recorded for a period, for the export the person on the portal works from. */
export function imsDecisions(db: DB, period: string): { docKey: string; action: ImsAction; note: string | null; decidedAt: string }[] {
  const rows = db
    .prepare('SELECT doc_key, action, note, decided_at FROM ims_actions WHERE period = ? ORDER BY decided_at')
    .all(period) as ActionRow[]
  return rows.map((r) => ({ docKey: r.doc_key, action: r.action, note: r.note, decidedAt: r.decided_at }))
}

export { imsKey }
