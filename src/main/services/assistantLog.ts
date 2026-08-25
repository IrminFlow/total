/**
 * The assistant audit trail: question → draft → posted voucher.
 *
 * Deliberately OUTSIDE services/ai. That directory is grepped by ai-boundaries.test.ts for any
 * statement that could write, and the guard is worth more than the convenience of keeping this
 * beside the runner: the assistant must remain unable to write even by accident, and a file that
 * writes cannot live in a directory whose promise is that none of them do.
 *
 * What it may touch is bounded on this side too. It writes one table, `assistant_runs`, and it
 * never touches `vouchers` or `voucher_lines` — the link to a voucher is recorded only after the
 * human has saved that voucher through the ordinary path, and setting it is an UPDATE of this
 * table, not of the books.
 *
 * What it exists for: six months later, "where did this ₹4,50,000 journal come from?" has an
 * answer that includes the question somebody asked and the draft a model proposed, and the reader
 * can see that a person still pressed Save.
 */

import type { DB } from '../db/connection'
import type { VoucherDraftProposal } from '@shared/ai/draft'

export interface AssistantRunRecord {
  runId: string
  question: string
  answer: string | null
  model: string
  host: string
  local: boolean
  tools: string[]
  quarantined: number
  draft: VoucherDraftProposal | null
  costPaise: number
  finish: string
  askedBy: string | null
}

export interface AssistantRunRow {
  id: number
  runId: string
  askedAt: string
  askedBy: string | null
  question: string
  answer: string | null
  model: string
  host: string
  local: boolean
  tools: string[]
  quarantined: number
  draft: VoucherDraftProposal | null
  voucherId: number | null
  costPaise: number
  finish: string | null
}

export function recordRun(db: DB, run: AssistantRunRecord): void {
  db.prepare(
    `INSERT INTO assistant_runs
       (run_id, asked_by, question, answer, model, host, local, tools, quarantined, draft, cost_paise, finish)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       answer = excluded.answer,
       tools = excluded.tools,
       quarantined = excluded.quarantined,
       draft = excluded.draft,
       cost_paise = excluded.cost_paise,
       finish = excluded.finish`
  ).run(
    run.runId,
    run.askedBy,
    run.question,
    run.answer,
    run.model,
    run.host,
    run.local ? 1 : 0,
    JSON.stringify(run.tools),
    run.quarantined,
    run.draft ? JSON.stringify(run.draft) : null,
    run.costPaise,
    run.finish
  )
}

/**
 * Attach a saved voucher to the run that proposed it.
 *
 * Called from the voucher save path, not from the assistant: the link is a fact about what a
 * human did, and it is only true once the save succeeded.
 */
export function linkVoucher(db: DB, runId: string, voucherId: number): boolean {
  const result = db
    .prepare('UPDATE assistant_runs SET voucher_id = ? WHERE run_id = ? AND voucher_id IS NULL')
    .run(voucherId, runId)
  return result.changes > 0
}

function toRow(r: Record<string, unknown>): AssistantRunRow {
  const parse = <T>(value: unknown): T | null => {
    if (typeof value !== 'string' || value === '') return null
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return {
    id: r.id as number,
    runId: r.runId as string,
    askedAt: r.askedAt as string,
    askedBy: (r.askedBy as string | null) ?? null,
    question: r.question as string,
    answer: (r.answer as string | null) ?? null,
    model: r.model as string,
    host: r.host as string,
    local: !!r.local,
    tools: parse<string[]>(r.tools) ?? [],
    quarantined: (r.quarantined as number) ?? 0,
    draft: parse<VoucherDraftProposal>(r.draft),
    voucherId: (r.voucherId as number | null) ?? null,
    costPaise: (r.costPaise as number) ?? 0,
    finish: (r.finish as string | null) ?? null
  }
}

const SELECT = `SELECT id, run_id AS runId, asked_at AS askedAt, asked_by AS askedBy, question, answer,
                       model, host, local, tools, quarantined, draft, voucher_id AS voucherId,
                       cost_paise AS costPaise, finish
                FROM assistant_runs`

export function listRuns(db: DB, limit = 50): AssistantRunRow[] {
  return (db.prepare(`${SELECT} ORDER BY id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map(toRow)
}

/** Every assistant run behind one voucher — what the voucher screen's provenance line reads. */
export function runsForVoucher(db: DB, voucherId: number): AssistantRunRow[] {
  return (db.prepare(`${SELECT} WHERE voucher_id = ? ORDER BY id DESC`).all(voucherId) as Record<string, unknown>[]).map(
    toRow
  )
}
