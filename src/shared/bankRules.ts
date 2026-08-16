/** Bank rules: pattern-matched auto-categorization for statement import (task 2.5). Pure engine
 *  code — src/main/services/banking.ts wires this up to the DB (bank_rules table + statement
 *  parsing) and src/renderer/src/screens/Banking.tsx surfaces it as suggested vouchers. */

/** The subset of a parsed statement row that matching needs — either the DB-backed
 *  ImportResult.unmatched shape or the raw StatementRow, both qualify structurally. */
export interface StatementLike {
  description: string
  /** Positive paise: money into the account. */
  deposit: number
  /** Positive paise: money out. */
  withdrawal: number
}

export interface RuleRow {
  id: number
  pattern: string
  ledgerId: number
  kind: 'payment' | 'receipt'
  /** Defaults to true (matched) when omitted — callers that already filter to active rules
   *  before calling matchRules don't need to carry the column through. */
  active?: boolean
}

export interface RuleMatch<T extends StatementLike = StatementLike> {
  row: T
  rule: RuleRow
}

/**
 * Matches statement rows against bank rules: case-insensitive substring of `pattern` against
 * `description`. Deposits (deposit > 0) only match 'receipt' rules; withdrawals only match
 * 'payment' rules — the same wording can't misfire across direction. When more than one active
 * rule matches a row, the longest pattern wins (most specific rule takes precedence). Rows with
 * no matching rule are excluded from the output — this is a suggestion list, not a 1:1 map.
 */
export function matchRules<T extends StatementLike>(rows: T[], rules: RuleRow[]): RuleMatch<T>[] {
  const active = rules.filter((r) => r.active !== false)
  const results: RuleMatch<T>[] = []
  for (const row of rows) {
    const wantKind: 'payment' | 'receipt' = row.deposit > 0 ? 'receipt' : 'payment'
    const desc = row.description.toLowerCase()
    let best: RuleRow | null = null
    for (const rule of active) {
      if (rule.kind !== wantKind) continue
      const pattern = rule.pattern.toLowerCase()
      if (pattern === '' || !desc.includes(pattern)) continue
      if (!best || rule.pattern.length > best.pattern.length) best = rule
    }
    if (best) results.push({ row, rule: best })
  }
  return results
}

/**
 * Suggests a rule pattern from a statement description: strips bank reference tokens (anything
 * containing a digit — NEFT-000123, IMPS/1234, UPI refs, DD/MM dates, ...) along with any
 * leading/trailing slash or dash noise on the remaining tokens, then returns the longest
 * contiguous run of what's left, e.g. 'NEFT-000123 ACME SUPPLIES 15/08' → 'ACME SUPPLIES'.
 */
export function suggestPattern(description: string): string {
  const tokens = description.trim().split(/\s+/).filter(Boolean)

  const runs: string[][] = []
  let current: string[] = []
  for (const raw of tokens) {
    const stripped = raw.replace(/^[/-]+|[/-]+$/g, '')
    if (stripped === '' || /\d/.test(stripped)) {
      if (current.length) runs.push(current)
      current = []
    } else {
      current.push(stripped)
    }
  }
  if (current.length) runs.push(current)

  let best: string[] = []
  for (const run of runs) {
    if (run.join(' ').length > best.join(' ').length) best = run
  }
  return best.join(' ')
}
