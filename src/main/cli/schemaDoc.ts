/**
 * Generate a JSON-Schema-style document for the voucher input contract by walking the live zod
 * schema (`voucherInputSchema`) — no zod-to-json-schema dependency. The walk covers exactly the
 * zod constructs that schema uses (object/number/string/enum/array/nullable/optional/default/
 * pipe — Zod 4 internals, `_zod.def`); anything unrecognized renders as {} rather than throwing, and the unit test asserts
 * every top-level field of the real schema appears here, so the doc can't silently drift.
 *
 * Pure module: imports only zod schemas from src/shared — safe under plain-Node vitest.
 */
import { z } from 'zod'
import { voucherInputSchema } from '@shared/schemas'

type JsonSchema = {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: (string | number)[]
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  maxItems?: number
  maxLength?: number
  minLength?: number
  default?: unknown
  additionalProperties?: boolean
}

/** Field-by-field descriptions, merged into the generated schema. Kept here (not .describe() on
 *  the shared schema) so the shared schema stays exactly as the app uses it. */
const FIELD_DOCS: Record<string, string> = {
  voucherTypeId: 'Voucher type id — see voucherTypes in <company>/agent/meta.json.',
  date: 'Voucher date, YYYY-MM-DD. Must be after the period lock date if one is set.',
  number: 'Voucher number. Omit for auto-numbered types (the app assigns the next number); required for manual-numbered types.',
  partyLedgerId: 'Party ledger id (Sundry Debtor/Creditor) for sales/purchase/receipt/payment; null otherwise.',
  narration: 'Free-text narration shown on the voucher.',
  reference: 'External reference (order no., bill no., ...).',
  instrumentNo: 'Cheque/instrument number for bank vouchers.',
  instrumentDate: 'Cheque/instrument date, YYYY-MM-DD.',
  transporterId: 'Transporter GSTIN/id for e-way bill flows.',
  vehicleNo: 'Vehicle number for e-way bill flows.',
  transportDistanceKm: 'Transport distance in km (integer).',
  posOverride: 'Place-of-supply override: two-digit GST state code (e.g. "27"); null = derive from party/company state.',
  postDated: 'Post-dated voucher (PDC): stays out of the books until its date arrives, then matures automatically on company open.',
  isOptional: 'Optional (memorandum) voucher: recorded but never counted in books or reports.',
  currencyCode: '3-letter currency code for multi-currency vouchers (e.g. USD); null = base currency (INR).',
  exchangeRate: 'Units of INR per 1 unit of currencyCode.',
  lines:
    'Ledger lines. Every amount is INTEGER PAISE (₹1 = 100). The voucher must balance: sum of dr amounts must equal sum of cr amounts, or the whole voucher is rejected.',
  inventory: 'Stock item lines for inventory vouchers. qtyMilli is integer thousandths (1000 = 1 unit); ratePaise/amount are integer paise.',
  billRefs: "Bill-wise allocations: kind 'new' opens a bill, 'against' settles one, by name.",
  tds: "TDS deduction on this voucher (section + base + deducted amount, paise), or null. The amount must equal the section's rate x base on the voucher date unless isManual; the voucher must credit the section's TDS payable ledger by that amount — or set autoPayable and leave that credit out (the server finds or creates the payable ledger and appends it).",
  tcs: "TCS collected on a sale or receipt (section + base + collected amount, paise), or null/absent. The amount must equal the section's rate x base unless isManual; the voucher must credit the section's TCS payable ledger by that amount (or set autoPayable), and on a sale the buyer's debit must include it (at least base + TCS).",
  trade: "Delivery challan / goods receipt note only: { purpose } (why the goods moved — supply, job_work, approval, liquid_gas or non_supply on a challan; purchase, return or job_work on a GRN). Absent keeps the stored purpose; ignored for every other kind."
}

type Schema = z.core.$ZodType

interface ZodDefLike {
  type: string
  innerType?: Schema
  in?: Schema
  out?: Schema
  shape?: Record<string, Schema>
  element?: Schema
  entries?: Record<string, string>
  checks?: z.core.$ZodCheck[]
  defaultValue?: unknown
}

interface CheckDef {
  check: string
  value?: number
  inclusive?: boolean
  minimum?: number
  maximum?: number
  length?: number
  format?: string
  pattern?: RegExp
}

function defOf(schema: Schema): ZodDefLike {
  return schema._zod.def as unknown as ZodDefLike
}

function checksOf(def: ZodDefLike): CheckDef[] {
  return (def.checks ?? []).map((c) => c._zod.def as unknown as CheckDef)
}

/** Walk one zod node into a JSON-Schema-ish node. Returns [schema, isOptional]. */
function walk(schema: Schema): { node: JsonSchema; optional: boolean; hasDefault: boolean } {
  const def = defOf(schema)
  switch (def.type) {
    case 'default':
    case 'prefault': {
      const inner = walk(def.innerType!)
      let dflt: unknown
      try {
        dflt = def.defaultValue
      } catch {
        dflt = undefined
      }
      return { node: { ...inner.node, default: dflt }, optional: true, hasDefault: true }
    }
    case 'optional': {
      const inner = walk(def.innerType!)
      return { node: inner.node, optional: true, hasDefault: inner.hasDefault }
    }
    case 'nullable': {
      const inner = walk(def.innerType!)
      const t = inner.node.type
      return {
        node: { ...inner.node, type: t === undefined ? undefined : ([] as string[]).concat(t as string, 'null') },
        optional: inner.optional,
        hasDefault: inner.hasDefault
      }
    }
    case 'pipe': // .transform() / z.preprocess() — document the input shape (a refinement is a check)
      return walk(defOf(def.in!).type === 'transform' ? def.out! : def.in!)
    case 'object': {
      const shape = def.shape!
      const properties: Record<string, JsonSchema> = {}
      const requiredKeys: string[] = []
      for (const [key, child] of Object.entries(shape)) {
        const walked = walk(child)
        properties[key] = walked.node
        if (FIELD_DOCS[key]) properties[key] = { description: FIELD_DOCS[key], ...properties[key] }
        if (!walked.optional) requiredKeys.push(key)
      }
      return {
        node: { type: 'object', properties, required: requiredKeys, additionalProperties: false },
        optional: false,
        hasDefault: false
      }
    }
    case 'array': {
      const item = walk(def.element!)
      const node: JsonSchema = { type: 'array', items: item.node }
      for (const check of checksOf(def)) if (check.check === 'max_length') node.maxItems = check.maximum
      return { node, optional: false, hasDefault: false }
    }
    case 'enum':
      return { node: { type: 'string', enum: Object.values(def.entries ?? {}) }, optional: false, hasDefault: false }
    case 'string': {
      const node: JsonSchema = { type: 'string' }
      for (const check of checksOf(def)) {
        if (check.check === 'string_format' && check.format === 'regex' && check.pattern) node.pattern = check.pattern.source
        if (check.check === 'max_length' && typeof check.maximum === 'number') node.maxLength = check.maximum
        if (check.check === 'min_length' && typeof check.minimum === 'number') node.minLength = check.minimum
        if (check.check === 'length_equals' && typeof check.length === 'number') {
          node.minLength = check.length
          node.maxLength = check.length
        }
      }
      return { node, optional: false, hasDefault: false }
    }
    case 'number': {
      const node: JsonSchema = { type: 'number' }
      let safeInts = 0
      for (const check of checksOf(def)) {
        if (check.check === 'number_format' && check.format === 'safeint') {
          // Zod 4's .safe() is the same check as .int(); the second one is the `.int().safe()` our
          // schemas write, which Zod 3 documented as the safe-integer bounds.
          if (++safeInts === 1) node.type = 'integer'
          else {
            node.minimum = Math.max(node.minimum ?? -Infinity, Number.MIN_SAFE_INTEGER)
            node.maximum = Math.min(node.maximum ?? Infinity, Number.MAX_SAFE_INTEGER)
          }
        }
        if (check.check === 'greater_than' && typeof check.value === 'number') {
          if (check.inclusive === false) node.exclusiveMinimum = Math.max(node.exclusiveMinimum ?? -Infinity, check.value)
          else node.minimum = Math.max(node.minimum ?? -Infinity, check.value)
        }
        if (check.check === 'less_than' && typeof check.value === 'number' && check.inclusive !== false) {
          node.maximum = Math.min(node.maximum ?? Infinity, check.value)
        }
      }
      if (node.minimum !== undefined && node.exclusiveMinimum !== undefined && node.exclusiveMinimum >= node.minimum) {
        delete node.minimum // redundant next to the tighter exclusive bound
      }
      return { node, optional: false, hasDefault: false }
    }
    case 'boolean':
      return { node: { type: 'boolean' }, optional: false, hasDefault: false }
    default:
      return { node: {}, optional: false, hasDefault: false }
  }
}

/** The generated voucher JSON schema document (object form). */
export function voucherJsonSchema(): Record<string, unknown> {
  const { node } = walk(voucherInputSchema)
  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    title: 'Total voucher input',
    description:
      'One voucher for `total-cli post` (a file may also hold an array of these). ' +
      'ALL AMOUNTS ARE INTEGER PAISE (₹1 = 100 paise); quantities are integer milli-units (1000 = 1 unit). ' +
      'Debits must equal credits — the app rejects everything else. Same validation as the app UI.',
    ...node
  }
}
