/**
 * Fields a company defines for itself, per voucher type (roadmap #195).
 *
 * Every business has one or two facts the books do not model — a PO number the customer insists
 * on, the site a delivery went to, a dispatch mode. The temptation is to let the user add a
 * column. That is how a user-defined field becomes user-defined SQL, and how an accounting
 * package acquires a schema nobody can migrate.
 *
 * So: the DEFINITIONS are rows in a table, the VALUES are rows in a table keyed by voucher, and
 * this file is the whole of the type system between them. It is pure — the validation that runs
 * at the IPC boundary and the formatting that runs on the print are the same code.
 *
 * **A number here is not money.** A custom field's value is stored as text and is never parsed
 * into paise, never summed, and never reaches a report's arithmetic. `1000` typed into a field
 * called "Advance" is the characters 1000; if it were money it would have to be a ledger, because
 * a rupee that is not in a ledger is a rupee that is not in the trial balance. This is the one
 * rule in this feature that is not a preference: see `customFields.test.ts` and the guard test in
 * `src/main/customFieldsPurity.test.ts`.
 */

export const CUSTOM_FIELD_KINDS = ['text', 'number', 'date', 'list'] as const
export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number]

export const CUSTOM_FIELD_KIND_LABEL: Record<CustomFieldKind, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  list: 'One of a list'
}

export interface CustomFieldDef {
  id: number
  /** The voucher type this field appears on. A field belongs to one type, never to all of them. */
  voucherTypeId: number
  /** Stable machine name, derived from the label once and then never changed. */
  key: string
  label: string
  kind: CustomFieldKind
  /** Only meaningful for `list`. */
  options: string[]
  required: boolean
  /** Whether the field is printed on the document as well as shown on entry. */
  printed: boolean
  sortOrder: number
  /**
   * When the user removed the field.
   *
   * Removing is a retirement, not a delete. Vouchers already carry values for it, and those
   * values are what the document said when it was issued — dropping them would rewrite history
   * to make a screen tidier. A retired field disappears from entry and stays on the vouchers
   * that have it.
   */
  retiredAt: string | null
}

export const MAX_TEXT_LEN = 200
export const MAX_OPTIONS = 50

/**
 * A label becomes a key once, at creation.
 *
 * Lower case, non-alphanumerics to underscores, collapsed and trimmed. The key is what an export
 * and the print template address the field by, so renaming the label later must not move it.
 */
export function customFieldKey(label: string): string {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return key
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** Optional sign, digits, optional single decimal point. Not a currency, not an expression. */
const PLAIN_NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/

export type ValidationResult = { ok: true; value: string } | { ok: false; error: string }

/**
 * Validate one typed value against its definition, returning the text to store.
 *
 * An empty string means "not filled in", which is only an error when the field is required. The
 * stored form is always text: a date is its ISO string, a number is the digits as typed with the
 * sign and the decimal point kept. Nothing is converted, because a conversion is where a
 * user-defined field would start pretending to be an amount.
 */
export function validateCustomValue(def: Pick<CustomFieldDef, 'label' | 'kind' | 'options' | 'required'>, raw: string): ValidationResult {
  const value = raw.trim()
  if (value === '') {
    return def.required ? { ok: false, error: `${def.label} is required` } : { ok: true, value: '' }
  }
  switch (def.kind) {
    case 'text':
      return value.length > MAX_TEXT_LEN
        ? { ok: false, error: `${def.label} is longer than ${MAX_TEXT_LEN} characters` }
        : { ok: true, value }
    case 'number':
      // Rejected on purpose: "1,000", "₹100", "1e6", "12.". A field that quietly accepted them
      // would be a field whose stored text nobody can read back the same way twice.
      return PLAIN_NUMBER.test(value)
        ? { ok: true, value }
        : { ok: false, error: `${def.label} must be a plain number — digits, an optional minus and one decimal point` }
    case 'date': {
      if (!ISO_DATE.test(value)) return { ok: false, error: `${def.label} must be a date` }
      const [y, m, d] = value.split('-').map(Number) as [number, number, number]
      const dt = new Date(Date.UTC(y, m - 1, d))
      const real = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
      return real ? { ok: true, value } : { ok: false, error: `${def.label} is not a real date` }
    }
    case 'list':
      return def.options.includes(value)
        ? { ok: true, value }
        : { ok: false, error: `${def.label} must be one of: ${def.options.join(', ')}` }
  }
}

/** Every value on one voucher, or the first complaint. */
export function validateCustomValues(
  defs: CustomFieldDef[],
  values: { fieldId: number; value: string }[]
): { ok: true; values: { fieldId: number; value: string }[] } | { ok: false; error: string } {
  const byId = new Map(defs.map((d) => [d.id, d]))
  const out: { fieldId: number; value: string }[] = []
  for (const v of values) {
    const def = byId.get(v.fieldId)
    if (!def) return { ok: false, error: 'That field is not defined on this voucher type' }
    if (def.retiredAt) {
      // Not an error worth failing a save over — an alteration of an old voucher resubmits what
      // it already carries. The value is kept as it stands and the field cannot be typed into.
      out.push({ fieldId: v.fieldId, value: v.value })
      continue
    }
    const res = validateCustomValue(def, v.value)
    if (!res.ok) return { ok: false, error: res.error }
    out.push({ fieldId: v.fieldId, value: res.value })
  }
  for (const def of defs) {
    if (def.required && !def.retiredAt && !out.some((v) => v.fieldId === def.id && v.value !== '')) {
      return { ok: false, error: `${def.label} is required` }
    }
  }
  return { ok: true, values: out }
}

/**
 * How a value reads on a document.
 *
 * A date prints in the Indian order because that is what every other date on the invoice does.
 * A number prints exactly as it was typed — no thousands separators, no two decimal places,
 * nothing that would make it look like an amount.
 */
export function formatCustomValue(kind: CustomFieldKind, value: string): string {
  if (value === '') return ''
  if (kind === 'date' && ISO_DATE.test(value)) {
    const [y, m, d] = value.split('-')
    return `${d}-${m}-${y}`
  }
  return value
}
