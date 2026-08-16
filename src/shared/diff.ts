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
