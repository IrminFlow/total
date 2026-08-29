/**
 * The ask bar: deterministic first, model second.
 *
 * Most of what people type into a box marked "ask your books" is not a question that needs a
 * language model. "who owes me", "trial balance", "sales last month", "what is blocking gstr-1"
 * are report names with a period attached, and Total already computes every one of them exactly.
 * Routing those through an endpoint would be slower, cost money, need a key, need a network, and
 * arrive as prose rather than as the screen the user actually wanted.
 *
 * So the palette resolves a typed question here FIRST. A match offers the report; only an
 * unmatched question offers the assistant. Three properties fall out of that ordering and each
 * is worth the code:
 *
 *  - The common questions work with the assistant switched off, and on a machine with no key
 *    and no network. That is most Total users.
 *  - The answer is the report, not a sentence about the report — clickable, printable, exact.
 *  - The model is left for the questions it is actually better at: "why", "compared to what",
 *    and anything needing two reports joined by a sentence.
 *
 * Matching is intentionally conservative. A wrong deterministic answer is worse than no
 * deterministic answer, because it silently hides the assistant behind a report that does not
 * answer the question. Every intent below needs a distinctive keyword, not a vibe.
 */

import { addDays, fyOf } from '../dates'

/** Screen names, as strings, so shared stays free of renderer types. */
export type AskScreen =
  | 'outstandings'
  | 'trial-balance'
  | 'profit-loss'
  | 'balance-sheet'
  | 'cash-flow'
  | 'stock-summary'
  | 'daybook'
  | 'registers'
  | 'exceptions'
  | 'gstr1'
  | 'gstr3b'
  | 'gstr2b'
  | 'banking'
  | 'khata'
  | 'collections'
  | 'assets'
  | 'payroll'

export interface AskMatch {
  screen: AskScreen
  /** What the palette row says: "Outstanding receivables". */
  label: string
  /** Date window when the question named one — passed to the Day Book as a span. */
  span?: { from: string; to: string; label: string }
  /** Which side of a two-sided report, when the question said. */
  side?: 'receivable' | 'payable'
  /** Roughly how sure: only `sure` matches are offered above the assistant. */
  confidence: 'sure' | 'likely'
}

interface Intent {
  screen: AskScreen
  label: string
  /** All of these must appear for the intent to fire; alternatives are separate entries. */
  needs: RegExp
  /** Disqualifies a match — cheaper than making every `needs` mutually exclusive. */
  not?: RegExp
  confidence?: 'sure' | 'likely'
}

const INTENTS: Intent[] = [
  { screen: 'outstandings', label: 'Outstanding receivables', needs: /\b(who\s+owes\s+me|receivables?|debtors?|money\s+owed\s+to\s+me)\b/i },
  { screen: 'outstandings', label: 'Outstanding payables', needs: /\b(payables?|creditors?|who\s+do\s+i\s+owe|whom\s+do\s+i\s+owe|what\s+do\s+i\s+owe)\b/i },
  { screen: 'trial-balance', label: 'Trial balance', needs: /\btrial\s*balance\b/i },
  { screen: 'profit-loss', label: 'Profit and loss', needs: /\b(profit(\s*(and|&|\/)\s*loss)?|p\s*&\s*l|p\s*and\s*l|net\s+profit|gross\s+profit|income\s+statement)\b/i },
  { screen: 'balance-sheet', label: 'Balance sheet', needs: /\bbalance\s*sheet\b/i },
  { screen: 'cash-flow', label: 'Cash flow', needs: /\bcash\s*flow\b/i },
  { screen: 'stock-summary', label: 'Stock summary', needs: /\b(stock|inventory)\b/i, not: /\bjournal\b/i },
  { screen: 'registers', label: 'Sales and purchase registers', needs: /\b(sales|purchase)\s*(register|summary|by\s+month)\b/i },
  { screen: 'daybook', label: 'Day book', needs: /\b(day\s*book|daybook|all\s+entries|what\s+did\s+i\s+(enter|post))\b/i },
  { screen: 'exceptions', label: 'Exceptions', needs: /\b(exceptions?|what(?:'s| is)?\s+wrong|needs?\s+fixing|unbalanced)\b/i },
  { screen: 'gstr1', label: 'GSTR-1', needs: /\bgstr\s*-?\s*1\b/i },
  { screen: 'gstr3b', label: 'GSTR-3B', needs: /\bgstr\s*-?\s*3\s*b\b/i },
  { screen: 'gstr2b', label: 'GSTR-2B reconciliation', needs: /\bgstr\s*-?\s*2\s*b\b/i },
  { screen: 'banking', label: 'Bank reconciliation', needs: /\b(bank\s+rec|reconcil\w*|brs|bank\s+statement)\b/i },
  { screen: 'khata', label: 'Khata', needs: /\bkhata\b/i },
  { screen: 'collections', label: 'Collections desk', needs: /\b(collections?|chase|follow\s*-?\s*ups?|promised\s+to\s+pay)\b/i },
  { screen: 'assets', label: 'Fixed assets', needs: /\b(fixed\s+assets?|depreciation)\b/i },
  { screen: 'payroll', label: 'Payroll', needs: /\b(payroll|salary|salaries|payslips?)\b/i }
]

/**
 * Questions the report cannot answer, however well it matches.
 *
 * "Why is my cash lower than last month" contains "cash" and would happily route to the cash
 * flow screen, but the user asked for a reason, and a screen is not a reason. Anything shaped
 * like an explanation, a comparison or a cause goes to the assistant even when a report name is
 * sitting in the middle of it.
 */
const NEEDS_PROSE = /\b(why|explain|reason|compare[d]?|versus|vs\.?|unusual|should\s+i|how\s+come|what\s+changed|higher\s+than|lower\s+than)\b/i

/** Month names in the shapes people type them. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function monthBounds(year: number, month0: number): { from: string; to: string } {
  const from = `${year}-${String(month0 + 1).padStart(2, '0')}-01`
  // Day 0 of the next month is the last day of this one, and UTC arithmetic keeps it a calendar
  // day either side of a daylight-saving change.
  const end = new Date(Date.UTC(year, month0 + 1, 0))
  return { from, to: end.toISOString().slice(0, 10) }
}

/**
 * The date window a question names, relative to `today`.
 *
 * Financial-year aware: "this quarter" is the Indian financial quarter (Q1 is Apr-Jun), because
 * that is the only quarter a user of this app means.
 */
export function parseWindow(text: string, today: string): AskMatch['span'] | undefined {
  const q = text.toLowerCase()
  const [y, m] = today.split('-').map(Number) as [number, number, number]
  const fy = fyOf(today)

  if (/\btoday\b/.test(q)) return { from: today, to: today, label: 'Today' }
  if (/\byesterday\b/.test(q)) {
    const d = addDays(today, -1)
    return { from: d, to: d, label: 'Yesterday' }
  }
  if (/\bthis\s+month\b/.test(q)) {
    const b = monthBounds(y, m - 1)
    return { ...b, label: 'This month' }
  }
  if (/\blast\s+month\b/.test(q)) {
    const b = m === 1 ? monthBounds(y - 1, 11) : monthBounds(y, m - 2)
    return { ...b, label: 'Last month' }
  }
  if (/\b(this|current)\s+(financial\s+year|fy|year)\b/.test(q)) {
    return { from: fy.from, to: fy.to, label: `FY ${fy.label}` }
  }
  if (/\blast\s+(financial\s+year|fy|year)\b/.test(q)) {
    const prev = fyOf(addDays(fy.from, -1))
    return { from: prev.from, to: prev.to, label: `FY ${prev.label}` }
  }
  if (/\b(this|last)\s+quarter\b/.test(q)) {
    // Financial quarters start in April, so quarter index counts months from April.
    const monthsIntoFy = (m - 4 + 12) % 12
    const qIndex = Math.floor(monthsIntoFy / 3) - (/\blast\s+quarter\b/.test(q) ? 1 : 0)
    const startYear = Number(fy.from.slice(0, 4))
    const startMonth0 = 3 + qIndex * 3
    const first = monthBounds(startYear + Math.floor(startMonth0 / 12), startMonth0 % 12)
    const lastMonth0 = startMonth0 + 2
    const last = monthBounds(startYear + Math.floor(lastMonth0 / 12), lastMonth0 % 12)
    return { from: first.from, to: last.to, label: /\blast\b/.test(q) ? 'Last quarter' : 'This quarter' }
  }
  for (let i = 0; i < MONTHS.length; i++) {
    if (!new RegExp(`\\b${MONTHS[i]}[a-z]*\\b`, 'i').test(q)) continue
    // A named month with no year means the most recent one that has happened.
    const year = i + 1 <= m ? y : y - 1
    const b = monthBounds(year, i)
    return { ...b, label: `${MONTHS[i]!.replace(/^./, (c) => c.toUpperCase())} ${year}` }
  }
  return undefined
}

/**
 * Resolve a typed question to a report, or null when the assistant should take it.
 *
 * Returns at most one match. Two intents firing on the same text (e.g. "sales register" also
 * containing "stock") means the text was ambiguous, and an ambiguous deterministic answer is
 * exactly the wrong-and-silent case the header warns about — so it goes to the assistant.
 */
export function resolveAsk(text: string, today: string): AskMatch | null {
  const q = text.trim()
  if (q.length < 3) return null
  if (NEEDS_PROSE.test(q)) return null

  const hits = INTENTS.filter((i) => i.needs.test(q) && !(i.not && i.not.test(q)))
  if (hits.length !== 1) return null
  const hit = hits[0]!

  const match: AskMatch = { screen: hit.screen, label: hit.label, confidence: hit.confidence ?? 'sure' }
  const span = parseWindow(q, today)
  if (span) {
    match.span = span
    match.label = `${hit.label} — ${span.label}`
  }
  if (hit.screen === 'outstandings') {
    match.side = /\b(payables?|creditors?|owe)\b/i.test(q) && !/\bowes?\s+me\b/i.test(q) ? 'payable' : 'receivable'
  }
  return match
}
