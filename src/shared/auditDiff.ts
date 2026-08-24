/**
 * What actually changed between two audited snapshots.
 *
 * The audit log stores whole before/after JSON blobs, which is right for fidelity and useless for
 * reading: "someone updated this voucher" is not an answer to "who changed the amount". This
 * turns the pair into the short list of fields that differ.
 *
 * Deliberately shallow with one exception. Nested arrays of lines are summarised by count and
 * total rather than diffed element by element: a line-level diff of a re-keyed voucher grid is
 * mostly noise about ids that moved, and the question being asked is nearly always "did the money
 * change", which the total answers exactly.
 */

export interface AuditFieldChange {
  field: string
  /** Human-readable rendering of each side; null means the field was absent. */
  before: string | null
  after: string | null
}

/** Fields that carry no information for a reader, or that change on every save regardless. */
const IGNORED = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt'])

/** Field names whose values are paise and should read as money rather than as a bare integer. */
const MONEY_FIELDS = /amount|balance|total|paise|value|limit|opening|debit|credit|tax|fee|interest/i

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Render one value for a human.
 *
 * `formatMoney` is injected rather than imported so this module stays free of any opinion about
 * currency formatting, and so a caller can pass a locale-aware formatter.
 */
function describe(value: unknown, field: string, formatMoney: (paise: number) => string): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return MONEY_FIELDS.test(field) ? formatMoney(value) : String(value)
  if (Array.isArray(value)) {
    // Summarised, not diffed: see the module comment.
    //
    // Only the debit side is totalled when the lines carry one. A balanced voucher's lines sum to
    // twice its value, and printing that as the total would make every entry look like double
    // what it is — which is exactly the number a reader would take at face value.
    const hasSides = value.some((item) => isPlainObject(item) && (item.drCr === 'dr' || item.drCr === 'cr'))
    const total = value.reduce<number>((sum, item) => {
      if (!isPlainObject(item) || typeof item.amount !== 'number') return sum
      if (hasSides && item.drCr !== 'dr') return sum
      return sum + item.amount
    }, 0)
    const count = `${value.length} line${value.length === 1 ? '' : 's'}`
    return total === 0 ? count : `${count}, ${formatMoney(total)}`
  }
  if (isPlainObject(value)) return JSON.stringify(value)
  return String(value)
}

/**
 * Fields that differ between two snapshots, in the order they appear in the newer one.
 *
 * A field present in only one side counts as a change: adding a narration where there was none is
 * exactly the kind of edit someone wants to see.
 */
export function auditFieldChanges(
  before: unknown,
  after: unknown,
  formatMoney: (paise: number) => string
): AuditFieldChange[] {
  const a = isPlainObject(before) ? before : {}
  const b = isPlainObject(after) ? after : {}
  const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((f) => !IGNORED.has(f))

  const out: AuditFieldChange[] = []
  for (const field of fields) {
    const beforeVal = a[field]
    const afterVal = b[field]
    // Structural comparison: two arrays of lines with the same contents are the same value even
    // though they are different objects.
    if (JSON.stringify(beforeVal ?? null) === JSON.stringify(afterVal ?? null)) continue
    out.push({
      field,
      before: field in a ? describe(beforeVal, field, formatMoney) : null,
      after: field in b ? describe(afterVal, field, formatMoney) : null
    })
  }
  return out
}

/** camelCase or snake_case to something a person reads: `partyLedgerId` → "Party ledger id". */
export function fieldLabel(field: string): string {
  const spaced = field.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
