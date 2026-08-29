/**
 * Tool-result envelopes and size caps.
 *
 * Total's reports are unpaginated by design — every one materialises a whole period. A trial
 * balance or day book handed to a model verbatim would blow the context window, and a model that
 * silently sees half a day book will state half a total as if it were the whole one.
 *
 * So every tool returns the same envelope, and three properties hold:
 *
 *  1. `truncated` is explicit, and the system prompt requires the model to disclose it.
 *  2. `totals` is computed over EVERY matching row, before truncation. A truncated
 *     `list_vouchers` still answers "how much did I sell in March" correctly.
 *  3. `note` names what was dropped and how to narrow the query, so the model has a next move
 *     rather than guessing.
 */

/** Rows per tool result unless a tool asks for more. */
export const DEFAULT_ROW_CAP = 50
/** Hard ceiling a tool may raise its own cap to. */
export const MAX_ROW_CAP = 200
/** Serialized characters per tool result. */
export const RESULT_CHAR_CAP = 12_000
/** Serialized characters for every tool result in one run combined. */
export const RUN_CHAR_CAP = 40_000

export interface ToolEnvelope<T = unknown> {
  ok: true
  /** Period echoed back, so the model can never misattribute a figure to the wrong dates. */
  asOn?: string
  from?: string
  to?: string
  rows: T[]
  rowCount: number
  totalRows: number
  truncated: boolean
  note?: string
  /** Aggregates over ALL totalRows, present even when `rows` was cut. */
  totals?: Record<string, string | number>
}

export interface CapOptions {
  rowCap?: number
  charCap?: number
  asOn?: string
  from?: string
  to?: string
  totals?: Record<string, string | number>
  /** Appended to the note — how to narrow this particular query. */
  hint?: string
}

/**
 * Build an envelope, cutting rows to fit both the row cap and the character budget.
 *
 * Characters are trimmed a whole row at a time; a half-serialized row would be worse than a
 * missing one, because the model would read it as real.
 */
export function capRows<T>(all: T[], opts: CapOptions = {}): ToolEnvelope<T> {
  const rowCap = Math.min(opts.rowCap ?? DEFAULT_ROW_CAP, MAX_ROW_CAP)
  const charCap = opts.charCap ?? RESULT_CHAR_CAP

  let rows = all.slice(0, rowCap)
  while (rows.length > 0 && JSON.stringify(rows).length > charCap) {
    rows = rows.slice(0, rows.length - 1)
  }

  const dropped = all.length - rows.length
  const envelope: ToolEnvelope<T> = {
    ok: true,
    rows,
    rowCount: rows.length,
    totalRows: all.length,
    truncated: dropped > 0
  }
  if (opts.asOn) envelope.asOn = opts.asOn
  if (opts.from) envelope.from = opts.from
  if (opts.to) envelope.to = opts.to
  if (opts.totals) envelope.totals = opts.totals
  if (dropped > 0) {
    envelope.note =
      `${dropped.toLocaleString('en-IN')} more row${dropped === 1 ? '' : 's'} omitted — you have NOT seen all the data. ` +
      `Use "totals" for any figure covering the whole set` +
      (opts.hint ? `, or narrow the query: ${opts.hint}.` : '.')
  }
  return envelope
}

/**
 * Running character budget for one assistant turn. The runner stops calling tools once this is
 * exhausted, rather than letting a chain of large results push the conversation over the model's
 * context limit mid-answer.
 */
export class RunBudget {
  private used = 0

  constructor(private readonly cap: number = RUN_CHAR_CAP) {}

  /** Record a result; returns false when the budget is spent. */
  spend(serialized: string): boolean {
    this.used += serialized.length
    return this.used < this.cap
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.used)
  }

  get exhausted(): boolean {
    return this.used >= this.cap
  }
}
