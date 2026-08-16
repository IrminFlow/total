/**
 * Generate a JSON-Schema-style document for the voucher input contract by walking the live zod
 * schema (`voucherInputSchema`) — no zod-to-json-schema dependency. The walk covers exactly the
 * zod constructs that schema uses (object/number/string/enum/array/nullable/optional/default/
 * effects); anything unrecognized renders as {} rather than throwing, and the unit test asserts
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
  currencyCode: '3-letter currency code for multi-currency vouchers (e.g. USD); null = base currency (INR).',
  exchangeRate: 'Units of INR per 1 unit of currencyCode.',
  lines:
    'Ledger lines. Every amount is INTEGER PAISE (₹1 = 100). The voucher must balance: sum of dr amounts must equal sum of cr amounts, or the whole voucher is rejected.',
  inventory: 'Stock item lines for inventory vouchers. qtyMilli is integer thousandths (1000 = 1 unit); ratePaise/amount are integer paise.',
  billRefs: "Bill-wise allocations: kind 'new' opens a bill, 'against' settles one, by name.",
  tds: 'TDS deduction on this voucher (section + base + deducted amount, paise), or null.'
}

interface ZodDefLike {
  typeName?: string
  innerType?: z.ZodTypeAny
  schema?: z.ZodTypeAny
  type?: z.ZodTypeAny
  values?: string[]
  checks?: { kind: string; value?: unknown; regex?: RegExp; inclusive?: boolean }[]
  defaultValue?: () => unknown
  exactLength?: { value: number } | null
  minLength?: { value: number } | null
  maxLength?: { value: number } | null
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def
}

/** Walk one zod node into a JSON-Schema-ish node. Returns [schema, isOptional]. */
function walk(schema: z.ZodTypeAny): { node: JsonSchema; optional: boolean; hasDefault: boolean } {
  const def = defOf(schema)
  switch (def.typeName) {
    case 'ZodDefault': {
      const inner = walk(def.innerType!)
      let dflt: unknown
      try {
        dflt = def.defaultValue!()
      } catch {
        dflt = undefined
      }
      return { node: { ...inner.node, default: dflt }, optional: true, hasDefault: true }
    }
    case 'ZodOptional': {
      const inner = walk(def.innerType!)
      return { node: inner.node, optional: true, hasDefault: inner.hasDefault }
    }
    case 'ZodNullable': {
      const inner = walk(def.innerType!)
      const t = inner.node.type
      return {
        node: { ...inner.node, type: t === undefined ? undefined : ([] as string[]).concat(t as string, 'null') },
        optional: inner.optional,
        hasDefault: inner.hasDefault
      }
    }
    case 'ZodEffects': // .transform()/.refine() — document the input shape
      return walk(def.schema!)
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
      const properties: Record<string, JsonSchema> = {}
      const requiredKeys: string[] = []
      for (const [key, child] of Object.entries(shape)) {
        const walked = walk(child as z.ZodTypeAny)
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
    case 'ZodArray': {
      const item = walk(def.type!)
      const node: JsonSchema = { type: 'array', items: item.node }
      if (def.maxLength) node.maxItems = def.maxLength.value
      return { node, optional: false, hasDefault: false }
    }
    case 'ZodEnum':
      return { node: { type: 'string', enum: def.values ?? [] }, optional: false, hasDefault: false }
    case 'ZodString': {
      const node: JsonSchema = { type: 'string' }
      for (const check of def.checks ?? []) {
        if (check.kind === 'regex' && check.regex) node.pattern = check.regex.source
        if (check.kind === 'max' && typeof check.value === 'number') node.maxLength = check.value
        if (check.kind === 'min' && typeof check.value === 'number') node.minLength = check.value
        if (check.kind === 'length' && typeof check.value === 'number') {
          node.minLength = check.value
          node.maxLength = check.value
        }
      }
      return { node, optional: false, hasDefault: false }
    }
    case 'ZodNumber': {
      const node: JsonSchema = { type: 'number' }
      for (const check of def.checks ?? []) {
        if (check.kind === 'int') node.type = 'integer'
        if (check.kind === 'min' && typeof check.value === 'number') {
          if (check.inclusive === false) node.exclusiveMinimum = Math.max(node.exclusiveMinimum ?? -Infinity, check.value)
          else node.minimum = Math.max(node.minimum ?? -Infinity, check.value)
        }
        if (check.kind === 'max' && typeof check.value === 'number' && check.inclusive !== false) {
          node.maximum = Math.min(node.maximum ?? Infinity, check.value)
        }
      }
      if (node.minimum !== undefined && node.exclusiveMinimum !== undefined && node.exclusiveMinimum >= node.minimum) {
        delete node.minimum // redundant next to the tighter exclusive bound
      }
      return { node, optional: false, hasDefault: false }
    }
    case 'ZodBoolean':
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
      'One voucher for `total-cli post` or a `<company>/inbox/*.json` drop (a file may also hold an array of these). ' +
      'ALL AMOUNTS ARE INTEGER PAISE (₹1 = 100 paise); quantities are integer milli-units (1000 = 1 unit). ' +
      'Debits must equal credits — the app rejects everything else. Same validation as the app UI.',
    ...node
  }
}
