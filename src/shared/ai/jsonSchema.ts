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
 * boolean / enum / array / nullable / optional / default / effects. No z.union of objects, no
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
