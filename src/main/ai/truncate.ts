// Tool-result size budget (WP 5.1). A report can be thousands of rows; what is sent to the model
// is capped. Arrays are cut (the same fraction everywhere, repeatedly halved) and end with an
// explicit marker saying how many rows were left out, so the model knows the list is partial
// and can ask a narrower question. Long strings are cut with a marker too. Pure; tested.

export const DEFAULT_TOOL_RESULT_BUDGET = 16_000

export const truncationMarker = (omitted: number): string =>
  `…[${omitted} more row${omitted === 1 ? '' : 's'} not shown — result trimmed to fit; ask for a narrower period or search]`

const STRING_CAP = 2_000

function shrink(value: unknown, keepFraction: number, minKeep: number): unknown {
  if (typeof value === 'string') {
    return value.length > STRING_CAP ? `${value.slice(0, STRING_CAP)}…[${value.length - STRING_CAP} characters not shown]` : value
  }
  if (Array.isArray(value)) {
    const keep = value.length <= minKeep ? value.length : Math.max(minKeep, Math.ceil(value.length * keepFraction))
    const kept = value.slice(0, keep).map((v) => shrink(v, keepFraction, minKeep))
    if (keep < value.length) kept.push(truncationMarker(value.length - keep))
    return kept
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shrink(v, keepFraction, minKeep)
    return out
  }
  return value
}

export interface FitResult {
  value: unknown
  text: string
  truncated: boolean
  originalChars: number
}

/** `value` serialised to at most `budget` characters (JSON). */
export function fitToBudget(value: unknown, budget = DEFAULT_TOOL_RESULT_BUDGET): FitResult {
  const full = JSON.stringify(value) ?? 'null'
  if (full.length <= budget) return { value, text: full, truncated: false, originalChars: full.length }
  for (const minKeep of [3, 1]) {
    for (let fraction = 0.5; fraction > 0.0005; fraction /= 2) {
      const v = shrink(value, fraction, minKeep)
      const text = JSON.stringify(v)
      if (text.length <= budget) return { value: v, text, truncated: true, originalChars: full.length }
    }
  }
  const text = JSON.stringify({ truncatedText: `${full.slice(0, Math.max(0, budget - 120))}…[result cut at ${budget} characters]` })
  return { value: JSON.parse(text), text, truncated: true, originalChars: full.length }
}
