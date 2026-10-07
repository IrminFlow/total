// The numbers rule, checked (WP 5.1): the model must never compute money — every amount in an
// answer has to be quoted from a tool result. After each answer the agent extracts the
// money-looking figures and looks each one up in the turn's tool results; the panel marks any
// figure it cannot find ("not from your books — check it"). Pure; tested in core.test.ts.
import { parseRupees } from '@shared/money'
import type { AiFigure } from '@shared/ai'

/** ₹/Rs/INR-prefixed numbers, Indian/Western comma-grouped numbers, and plain numbers with
 *  exactly two decimals. Bare integers (years, counts, ids, days) are not treated as money. */
const FIGURE_RE = /-?(?:₹|\bRs\.?|\bINR)\s?-?\d[\d,]*(?:\.\d{1,2})?|-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|-?\d+\.\d{2}/g

export interface ExtractedFigure {
  text: string
  paise: number
}

export function extractFigures(text: string): ExtractedFigure[] {
  const out: ExtractedFigure[] = []
  for (const m of text.matchAll(FIGURE_RE)) {
    const raw = m[0]
    const at = m.index ?? 0
    const before = text.slice(Math.max(0, at - 1), at)
    const after = text.slice(at + raw.length, at + raw.length + 2)
    // Percentages, dates (01.07.2025), versions and digits glued to letters are not money.
    if (/^[%A-Za-z0-9]/.test(after) || /^\.\d/.test(after)) continue
    if (/[\dA-Za-z.\-/]/.test(before)) continue
    const cleaned = raw.replace(/₹|\bRs\.?|\bINR/g, '').replace(/\s/g, '').replace(/^--/, '-')
    const paise = parseRupees(cleaned)
    if (paise === null) continue
    out.push({ text: raw.trim(), paise })
  }
  return out
}

/** Each figure in `answer`, marked sourced when the same absolute amount appears in a tool result. */
export function checkFigures(answer: string, toolResults: readonly { name: string; text: string }[]): AiFigure[] {
  const known = new Map<number, string>()
  for (const r of toolResults) {
    for (const f of extractFigures(r.text)) if (!known.has(Math.abs(f.paise))) known.set(Math.abs(f.paise), r.name)
  }
  return extractFigures(answer).map((f) => {
    const tool = known.get(Math.abs(f.paise)) ?? null
    return { text: f.text, paise: f.paise, sourced: tool !== null, tool }
  })
}
