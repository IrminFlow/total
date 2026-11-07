// Zod → JSON Schema for tool parameters (WP 5.1). Covers the subset tool inputs use — objects,
// strings, numbers/integers, booleans, enums, literals, arrays, unions, optional / nullable /
// default, refinements / transforms — and `.describe()` text, which the model reads. Pure; unit-tested.
//
// Zod 4: walks `_zod.def` (refinements are checks on the schema itself; a transform / preprocess
// is a pipe). The output is pinned byte for byte to what the Zod 3 walker gave
// (`toolSchemas.dbtest.ts`), including Zod 3's habit of carrying a schema's description over to
// the optional / nullable / default wrapping it.
import type { z } from 'zod'

type Json = Record<string, unknown>
type Schema = z.core.$ZodType

interface CheckDef {
  check: string
  value?: number
  inclusive?: boolean
  minimum?: number
  maximum?: number
  format?: string
  pattern?: RegExp
}

const defOf = (t: Schema): z.core.$ZodTypeDef & Record<string, unknown> =>
  t._zod.def as z.core.$ZodTypeDef & Record<string, unknown>

const checksOf = (t: Schema): CheckDef[] => ((defOf(t).checks ?? []) as z.core.$ZodCheck[]).map((c) => c._zod.def as CheckDef)

/** The wrappers Zod 3 created with their inner schema's description. */
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault'])

function ownDescription(t: Schema): string | undefined {
  return (t as { description?: string }).description
}

/** The description Zod 3 would have given this node: its own, else (for optional / nullable /
 *  default) the one inherited from the schema it wraps. */
function descriptionOf(t: Schema): string | undefined {
  const own = ownDescription(t)
  if (own !== undefined) return own
  const def = defOf(t)
  return WRAPPERS.has(def.type) ? descriptionOf(def.innerType as Schema) : undefined
}

function withDescription(schema: Json, t: Schema): Json {
  const d = descriptionOf(t)
  return d ? { ...schema, description: d } : schema
}

/** The schema a transform / preprocess documents: the input of a transform, the target of a preprocess. */
function pipeTarget(t: Schema): Schema {
  const def = defOf(t)
  const input = def.in as Schema
  return defOf(input).type === 'transform' ? (def.out as Schema) : input
}

/** True when the object key may be omitted. */
function isOptional(t: Schema): boolean {
  const type = defOf(t).type
  return type === 'optional' || type === 'default' || type === 'prefault' || (type === 'pipe' && isOptional(pipeTarget(t)))
}

export function zodToJsonSchema(t: Schema): Json {
  const def = defOf(t)
  switch (def.type) {
    case 'optional':
      return withDescription(zodToJsonSchema(def.innerType as Schema), t)
    case 'default':
    case 'prefault':
      return withDescription({ ...zodToJsonSchema(def.innerType as Schema), default: def.defaultValue }, t)
    case 'pipe':
      return withDescription(zodToJsonSchema(pipeTarget(t)), t)
    case 'nullable':
      return withDescription({ anyOf: [zodToJsonSchema(def.innerType as Schema), { type: 'null' }] }, t)
    case 'object': {
      const shape = def.shape as Record<string, Schema>
      const properties: Json = {}
      const required: string[] = []
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v)
        if (!isOptional(v)) required.push(k)
      }
      const out: Json = { type: 'object', properties, additionalProperties: false }
      if (required.length) out.required = required
      return withDescription(out, t)
    }
    case 'string': {
      const out: Json = { type: 'string' }
      for (const c of checksOf(t)) {
        if (c.check === 'min_length') out.minLength = c.minimum
        if (c.check === 'max_length') out.maxLength = c.maximum
        if (c.check === 'string_format' && c.format === 'regex' && c.pattern) out.pattern = c.pattern.source
      }
      return withDescription(out, t)
    }
    case 'number': {
      const checks = checksOf(t)
      const out: Json = { type: checks.some((c) => c.check === 'number_format' && c.format === 'safeint') ? 'integer' : 'number' }
      let safeInts = 0
      for (const c of checks) {
        // Zod 4's .safe() is the same check as .int(); a second one is a `.int().safe()`, which
        // Zod 3 wrote as the safe-integer bounds.
        if (c.check === 'number_format' && c.format === 'safeint' && ++safeInts > 1) {
          out.minimum = Number.MIN_SAFE_INTEGER
          out.maximum = Number.MAX_SAFE_INTEGER
        }
        if (c.check === 'greater_than') out[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value
        if (c.check === 'less_than') out[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value
      }
      return withDescription(out, t)
    }
    case 'boolean':
      return withDescription({ type: 'boolean' }, t)
    case 'enum':
      return withDescription({ type: 'string', enum: Object.values(def.entries as Record<string, string>) }, t)
    case 'literal': {
      const values = def.values as unknown[]
      if (values.length !== 1) break
      return withDescription({ const: values[0] }, t)
    }
    case 'array': {
      const out: Json = { type: 'array', items: zodToJsonSchema(def.element as Schema) }
      let min: number | undefined
      let max: number | undefined
      for (const c of checksOf(t)) {
        if (c.check === 'min_length') min = c.minimum
        if (c.check === 'max_length') max = c.maximum
      }
      // Zod 3 kept only the last .min() / .max(), minItems first.
      if (min !== undefined) out.minItems = min
      if (max !== undefined) out.maxItems = max
      return withDescription(out, t)
    }
    case 'union':
      return withDescription({ anyOf: (def.options as Schema[]).map(zodToJsonSchema) }, t)
  }
  throw new Error(`zodToJsonSchema: unsupported schema type ${def.type}`)
}
