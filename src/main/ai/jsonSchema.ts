// Zod → JSON Schema for tool parameters (WP 5.1). Covers the subset tool inputs use — objects,
// strings, numbers/integers, booleans, enums, literals, arrays, unions, optional / nullable /
// default, refinements — and `.describe()` text, which the model reads. Pure; unit-tested.
import { z } from 'zod'

type Json = Record<string, unknown>

function withDescription(schema: Json, t: z.ZodTypeAny): Json {
  const d = t.description
  return d ? { ...schema, description: d } : schema
}

/** True when the object key may be omitted. */
function isOptional(t: z.ZodTypeAny): boolean {
  return t instanceof z.ZodOptional || t instanceof z.ZodDefault || (t instanceof z.ZodEffects && isOptional(t.innerType()))
}

export function zodToJsonSchema(t: z.ZodTypeAny): Json {
  if (t instanceof z.ZodOptional) return withDescription(zodToJsonSchema(t.unwrap()), t)
  if (t instanceof z.ZodDefault) return withDescription({ ...zodToJsonSchema(t.removeDefault()), default: t._def.defaultValue() }, t)
  if (t instanceof z.ZodEffects) return withDescription(zodToJsonSchema(t.innerType()), t)
  if (t instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(t.unwrap())
    return withDescription({ anyOf: [inner, { type: 'null' }] }, t)
  }
  if (t instanceof z.ZodObject) {
    const shape = t.shape as Record<string, z.ZodTypeAny>
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
  if (t instanceof z.ZodString) {
    const out: Json = { type: 'string' }
    for (const c of t._def.checks) {
      if (c.kind === 'min') out.minLength = c.value
      if (c.kind === 'max') out.maxLength = c.value
      if (c.kind === 'regex') out.pattern = c.regex.source
    }
    return withDescription(out, t)
  }
  if (t instanceof z.ZodNumber) {
    const out: Json = { type: t._def.checks.some((c) => c.kind === 'int') ? 'integer' : 'number' }
    for (const c of t._def.checks) {
      if (c.kind === 'min') out[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value
      if (c.kind === 'max') out[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value
    }
    return withDescription(out, t)
  }
  if (t instanceof z.ZodBoolean) return withDescription({ type: 'boolean' }, t)
  if (t instanceof z.ZodEnum) return withDescription({ type: 'string', enum: [...(t.options as string[])] }, t)
  if (t instanceof z.ZodLiteral) return withDescription({ const: t.value }, t)
  if (t instanceof z.ZodArray) {
    const out: Json = { type: 'array', items: zodToJsonSchema(t.element) }
    if (t._def.minLength) out.minItems = t._def.minLength.value
    if (t._def.maxLength) out.maxItems = t._def.maxLength.value
    return withDescription(out, t)
  }
  if (t instanceof z.ZodUnion) return withDescription({ anyOf: (t.options as z.ZodTypeAny[]).map(zodToJsonSchema) }, t)
  throw new Error(`zodToJsonSchema: unsupported schema type ${t.constructor.name}`)
}
