/**
 * The period a plain question names — pure, deterministic, no AI. Ask Total (src/main/assist/
 * classify.ts) reads "this month", "last quarter", "this financial year", "in July" … through it.
 *
 * This is the period half of the phrase mapper that used to sit behind the report builder's
 * "Report from a question" (WP 5.5, shared/reportBuilder/nl.ts `parseReportQuestion`); the
 * report builder is gone, the period reading is kept exactly as it was.
 */
import type { RelativePeriod } from './reportPeriod'

export type QuestionPeriod = { kind: 'range'; from: string; to: string } | { kind: 'relative'; rule: RelativePeriod }

const RELATIVE: [RegExp, RelativePeriod][] = [
  [/\blast\s+month\b|\bprevious\s+month\b/, 'lastMonth'],
  [/\bthis\s+month\b|\bcurrent\s+month\b/, 'thisMonth'],
  [/\blast\s+quarter\b|\bprevious\s+quarter\b/, 'lastQuarter'],
  [/\bthis\s+quarter\b|\bcurrent\s+quarter\b/, 'thisQuarter'],
  [/\blast\s+(financial\s+)?year\b|\bprevious\s+(financial\s+)?year\b/, 'lastFy'],
  [/\bthis\s+(financial\s+)?year\b|\byear\s+to\s+date\b|\bytd\b/, 'fyToDate']
]

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** A month named in the question ("in July", "for jul") → its range in the working FY. */
function namedMonth(q: string, working: { from: string } | undefined): { from: string; to: string } | null {
  if (!working) return null
  const m = MONTHS.findIndex((name) => new RegExp(`\\b(in|for|during)\\s+(${name}|${name.slice(0, 3)})\\b`).test(q))
  if (m < 0) return null
  const month = m + 1
  const [wy, wm] = working.from.split('-').map(Number) as [number, number]
  const fyStart = wm >= 4 ? wy : wy - 1
  const year = month >= 4 ? fyStart : fyStart + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const mm = String(month).padStart(2, '0')
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` }
}

/**
 * The period named in a question: "in <month>" (that month of the working FY) first, else a
 * relative phrase (this / last month, quarter, financial year, year to date); null = none.
 */
export function questionPeriod(question: string, working?: { from: string; to: string }): QuestionPeriod | null {
  const q = question.toLowerCase()
  const month = namedMonth(q, working)
  if (month) return { kind: 'range', ...month }
  const rel = RELATIVE.find(([re]) => re.test(q))
  return rel ? { kind: 'relative', rule: rel[1] } : null
}
