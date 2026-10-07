/** Pure, zero-import field-level diffing for audit_log's before_json/after_json blobs. */

export interface FieldDiff {
  key: string
  from: string
  to: string
}

/** Parse a JSON object blob, tolerating null/invalid/non-object input as an empty object. */
function safeParseObject(json: string | null): Record<string, unknown> {
  if (json === null) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

/** One-level flatten: nested objects/arrays are stringified for comparison and display. */
function formatValue(v: unknown): string {
  if (v === undefined) return ''
  if (v !== null && typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * Diff two audit_log JSON blobs (before_json/after_json) into changed fields only.
 * A key missing from `before` reads as added (from: ''); missing from `after` reads as
 * removed (to: ''). Identical objects (or two nulls) yield [].
 */
export function diffJson(beforeJson: string | null, afterJson: string | null): FieldDiff[] {
  const before = safeParseObject(beforeJson)
  const after = safeParseObject(afterJson)
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])

  const diffs: FieldDiff[] = []
  for (const key of keys) {
    const hasBefore = Object.prototype.hasOwnProperty.call(before, key)
    const hasAfter = Object.prototype.hasOwnProperty.call(after, key)
    const from = hasBefore ? formatValue(before[key]) : ''
    const to = hasAfter ? formatValue(after[key]) : ''
    if (from !== to) diffs.push({ key, from, to })
  }
  return diffs
}

/** Flatten a JSON value into path → scalar-text pairs: `lines[0].amount`, `party.name`. Arrays of
 *  scalars stay one entry (`tags: ["a","b"]`) so a reorder reads as one change. Depth-capped. */
function flatten(value: unknown, prefix: string, out: Map<string, string>, depth: number): void {
  if (value === null || typeof value !== 'object' || depth >= 6) {
    out.set(prefix, formatValue(value))
    return
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      out.set(prefix, JSON.stringify(value))
      return
    }
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out, depth + 1))
    return
  }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length === 0 && prefix) out.set(prefix, '{}')
  for (const k of keys) flatten((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out, depth + 1)
}

/**
 * Field-level diff for the edit-log report (WP 3.8): like diffJson but nested objects and arrays
 * of objects (voucher lines, inventory rows) are compared leaf by leaf, so the report shows
 * `lines[1].amount: 5000 → 6000` rather than two whole JSON blobs. A create (before null) lists
 * every field with from '' and a delete every field with to ''.
 */
export function diffJsonDeep(beforeJson: string | null, afterJson: string | null): FieldDiff[] {
  const parse = (j: string | null): unknown => {
    if (j === null) return {}
    try {
      return JSON.parse(j) as unknown
    } catch {
      return { value: j }
    }
  }
  const b = new Map<string, string>()
  const a = new Map<string, string>()
  flatten(parse(beforeJson), '', b, 0)
  flatten(parse(afterJson), '', a, 0)
  const keys = [...new Set([...b.keys(), ...a.keys()])]
  const diffs: FieldDiff[] = []
  for (const key of keys) {
    const from = b.get(key) ?? ''
    const to = a.get(key) ?? ''
    if (from !== to) diffs.push({ key: key || 'value', from, to })
  }
  return diffs
}

/** One-line text of a diff for CSV/PDF cells: `name: A → B; lines[0].amount: 1 → 2`. */
export function diffText(diffs: readonly FieldDiff[], maxLen = Infinity): string {
  const s = diffs.map((d) => `${d.key}: ${d.from || '—'} → ${d.to || '—'}`).join('; ')
  return s.length > maxLen ? `${s.slice(0, Math.max(0, maxLen - 1))}…` : s
}
