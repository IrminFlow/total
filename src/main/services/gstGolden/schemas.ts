// The OFFICIAL published JSON schemas of the GSTR-1 / GSTR-3B save payloads (GSTN developer
// portal) and the e-invoice (GSTN e-invoice portal, schema 1.1), vendored byte-for-byte in
// ./schemas/ (sources, dates and SHA-256 in ./schemas/sources.json and GST_SOURCES in
// shared/gst/sources.ts). No network at test time.
//
// The published files need a few mechanical repairs before a JSON Schema validator can use them;
// each is applied HERE, in code, so the vendored files stay exactly as published:
//  - e-invoice: the field definitions sit at the file's root instead of under `properties`, so a
//    draft-07 validator would check nothing but the root `required` list — they are moved under
//    `properties`; list fields (ItemList, PrecDocDtls, ContrDtls, AttribDtls, AddlDocDtls) are
//    published as a one-element JSON array holding the element schema, not `{ type: 'array', items }`
//    — wrapped; keys, `type` values and `required` names carry stray spaces / capitals ("AddlDocDtls ",
//    "String", " number", " InvStDt ") — trimmed and lower-cased; a `required` list written INSIDE
//    RefDtls' `properties` (InvNo, InvDt — the PrecDocDtls fields) is moved onto the PrecDocDtls item
//    whose properties it names (as the NIC spec marks them mandatory); patterns
//    starting with the inline flag "(?i)" (not JavaScript regex syntax) lose the flag (the same
//    field's `enum` still holds the exact upper-case values).
//  - GSTR-1: the published file puts `if` / `then` inside the top-level `properties`, where they
//    describe two properties literally named "if" and "then" — harmless, left as is.
//  - e-invoice: the published file sets no `additionalProperties: false`, so a misspelt key passes
//    the schema (as published — not loosened here; the golden test compares the fields by name).
//  - all: `multipleOf: 0.01` on decimal amounts is checked with a 1e-6 tolerance (Ajv's
//    multipleOfPrecision) — 2.05 / 0.01 is 204.99999999999997 in binary floating point, which
//    would otherwise reject the GSTN's own sample.
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import { readFileSync } from 'fs'
import { join } from 'path'

/** A vendored file of ./schemas/, parsed. */
export const vendored = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(__dirname, 'schemas', file), 'utf8'))

const ajv = new Ajv({ strict: false, allErrors: true, multipleOfPrecision: 6, unicodeRegExp: false })

/** Repair one schema node (see the header): trimmed keys, `type` values and `required` names, no
 *  inline regex flags, and `properties` entries published as one-element arrays wrapped. */
function repair(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(repair)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [rawKey, v] of Object.entries(node as Record<string, unknown>)) {
    const k = rawKey.trim()
    if (k === 'type' && typeof v === 'string') out[k] = v.trim().toLowerCase()
    else if (k === 'pattern' && typeof v === 'string') out[k] = v.replace(/^\(\?i\)/, '')
    else if (k === 'required' && Array.isArray(v)) out[k] = v.map((x) => (typeof x === 'string' ? x.trim() : x))
    else if (k === 'properties' && v && typeof v === 'object') out[k] = repairProperties(v as Record<string, unknown>)
    else out[k] = repair(v)
  }
  return out
}

function repairProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let stray: string[] | null = null
  for (const [rawKey, v] of Object.entries(props)) {
    const k = rawKey.trim()
    if (k === 'required' && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      stray = v.map((x: string) => x.trim())
      continue
    }
    out[k] = Array.isArray(v) ? { type: 'array', items: repair(v[0]) } : repair(v)
  }
  // A `required` list misplaced among the properties belongs to the list field whose items name it.
  if (stray) {
    const names = stray
    for (const v of Object.values(out) as { type?: string; items?: { properties?: Record<string, unknown>; required?: string[] } }[]) {
      if (v?.type === 'array' && v.items?.properties && names.every((n) => n in v.items!.properties!)) {
        v.items.required = [...new Set([...(v.items.required ?? []), ...names])]
      }
    }
  }
  return out
}

/** The e-invoice schema as published, repaired into a schema a validator applies (see above). */
export function repairedEinvoiceSchema(): Record<string, unknown> {
  const { $schema, Title, Description, required, ...fields } = vendored('einvoice-1.1.schema.json')
  return { $schema, title: Title, description: Description, type: 'object', properties: repairProperties(fields), required }
}

const compiled: Record<string, ValidateFunction> = {}
const validator = (key: string, schema: () => object): ValidateFunction => (compiled[key] ??= ajv.compile(schema()))

const messages = (errors: ErrorObject[] | null | undefined): string[] =>
  (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}${e.params ? ' ' + JSON.stringify(e.params) : ''}`.trim())

/** Problems the GSTN GSTR-1 save schema finds in `json` ([] = valid). `version` defaults to the
 *  newest vendored one. */
export function validateGstr1Json(json: unknown, version: 'v4.1' | 'v5.0' = 'v5.0'): string[] {
  const v = validator(`gstr1-${version}`, () => vendored(`gstr1-save-${version}.schema.json`))
  return v(json) ? [] : messages(v.errors)
}

/** Problems the GSTN GSTR-3B save schema (v7.1) finds in `json` ([] = valid). */
export function validateGstr3bJson(json: unknown): string[] {
  const v = validator('gstr3b', () => vendored('gstr3b-save-v7.1.schema.json'))
  return v(json) ? [] : messages(v.errors)
}

/** Problems the e-invoice schema 1.1 finds in one e-invoice document ([] = valid). */
export function validateEinvoiceJson(doc: unknown): string[] {
  const v = validator('einvoice', repairedEinvoiceSchema)
  return v(doc) ? [] : messages(v.errors)
}
