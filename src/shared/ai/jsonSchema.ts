/**
 * zod -> JSON Schema, by walking the live schema.
 *
 * Lifted out of src/main/cli/schemaDoc.ts, whose header explains why there is no
 * zod-to-json-schema dependency: the walk covers exactly the constructs this codebase's schemas
 * use, and anything unrecognised renders as {} rather than throwing.
 *
 * Two callers now share it — the published voucher contract (agent-skill/voucher.schema.json)
 * and the AI tool definitions. They must agree: a coding agent posting a voucher through the
 * inbox and the assistant drafting one are working from the same shape.
 *
 * Vocabulary limit worth knowing when writing new tool params: object / string / number /
 * boolean / enum / array / nullable / optional / default / prefault / transform. No z.union of objects, no
 * z.record, no z.lazy — those render as {} and the model would get no guidance at all.
 */
import { z } from 'zod'

export type JsonSchema = {
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

/**
 * zod 4 internals, read defensively.
 *
 * zod 4 moved the schema definition from `_def` (with a PascalCase `typeName`) to `_zod.def`
 * (with a lowercase `type`), and turned validation checks from plain `{ kind, value }` records
 * into check *schemas* that carry their own `_zod.def`. Nothing below throws on an unknown
 * shape — an unrecognised node still renders as {}, exactly as before.
 */
interface ZodCheckDefLike {
  check?: string
  format?: string
  pattern?: RegExp
  value?: unknown
  inclusive?: boolean
  minimum?: number
  maximum?: number
  length?: number
}

interface ZodDefLike {
  type?: string
  format?: string
  innerType?: z.ZodTypeAny
  in?: z.ZodTypeAny
  element?: z.ZodTypeAny
  entries?: Record<string, string | number>
  checks?: unknown[]
  defaultValue?: unknown
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return ((schema as unknown as { _zod?: { def?: ZodDefLike } })._zod?.def ?? {}) as ZodDefLike
}

/** Unwrap a check schema to its definition. */
function checkDefs(def: ZodDefLike): ZodCheckDefLike[] {
  return (def.checks ?? []).map(
    (c) => ((c as { _zod?: { def?: ZodCheckDefLike } })?._zod?.def ?? {}) as ZodCheckDefLike
  )
}

/** Walk one zod node into a JSON-Schema-ish node. Returns [schema, isOptional]. */
function walk(schema: z.ZodTypeAny): { node: JsonSchema; optional: boolean; hasDefault: boolean } {
  const def = defOf(schema)
  switch (def.type) {
    // `prefault` is `default` that runs its value through the parse; for documentation purposes
    // the two are the same thing — a value the caller may omit.
    case 'default':
    case 'prefault': {
      const inner = walk(def.innerType!)
      // zod 3 stored a thunk here, zod 4 stores the value. Accept either.
      let dflt: unknown = def.defaultValue
      if (typeof dflt === 'function') {
        try {
          dflt = (dflt as () => unknown)()
        } catch {
          dflt = undefined
        }
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
    // .transform() produces a pipe (input -> output); document the input shape. (.refine() no
    // longer wraps at all in zod 4 — it adds a check to the same node — so there is nothing to
    // unwrap for it.)
    case 'pipe':
      return walk(def.in!)
    case 'object': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
      const properties: Record<string, JsonSchema> = {}
      const requiredKeys: string[] = []
      for (const [key, child] of Object.entries(shape)) {
        const walked = walk(child as z.ZodTypeAny)
        properties[key] = walked.node
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
      for (const check of checkDefs(def)) {
        if (check.check === 'max_length' && typeof check.maximum === 'number') node.maxItems = check.maximum
      }
      return { node, optional: false, hasDefault: false }
    }
    case 'enum':
      return {
        node: { type: 'string', enum: Object.values(def.entries ?? {}) },
        optional: false,
        hasDefault: false
      }
    case 'string': {
      const node: JsonSchema = { type: 'string' }
      for (const check of checkDefs(def)) {
        if (check.check === 'string_format' && check.format === 'regex' && check.pattern) {
          node.pattern = check.pattern.source
        }
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
      // `.int()` / `z.int()` is a number_format check (or a def-level format) in zod 4, not a
      // `{ kind: 'int' }` entry.
      if (def.format === 'safeint' || def.format === 'int32') node.type = 'integer'
      for (const check of checkDefs(def)) {
        if (check.check === 'number_format' && (check.format === 'safeint' || check.format === 'int32')) {
          node.type = 'integer'
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

/**
 * Public entry point: a JSON Schema object for a zod schema, suitable for an OpenAI tool
 * definition. `additionalProperties: false` matters — without it a model may invent arguments.
 */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { node } = walk(schema)
  return { type: 'object', properties: {}, ...node } as Record<string, unknown>
}

/** Walk exposed for callers that need the optional/default flags (schemaDoc's field docs). */
export function walkSchema(schema: z.ZodTypeAny): { node: JsonSchema; optional: boolean; hasDefault: boolean } {
  return walk(schema)
}
