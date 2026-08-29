// The walker reads zod's internals, which are private and moved wholesale in zod 4 (_def.typeName
// -> _zod.def.type, plain check records -> check schemas). When they move again, the walk does not
// throw: every node quietly renders as {}, and the only visible symptom is an assistant or a
// coding agent that suddenly has no idea what arguments a tool takes.
//
// schemaDoc.test.ts pins one consumer (the published voucher contract). This pins the other one —
// the AI and MCP tool definitions — by exercising the whole documented vocabulary at once.
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { toJsonSchema, walkSchema } from './jsonSchema'

describe('toJsonSchema (zod internals walk)', () => {
  it('renders every construct the tool params are allowed to use', () => {
    const schema = z.object({
      name: z.string().min(2).max(40),
      code: z.string().length(6),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      count: z.number().int().min(0).max(500),
      amount: z.number().int().positive(),
      ratio: z.number(),
      flag: z.boolean(),
      kind: z.enum(['a', 'b']),
      rows: z.array(z.object({ id: z.number().int().positive() })).max(3),
      note: z.string().nullable(),
      maybe: z.string().optional(),
      limit: z.number().int().default(50),
      opts: z.object({ deep: z.boolean().default(false) }).prefault({}),
      trimmed: z.string().trim().transform((s) => s.toUpperCase())
    })

    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'code', 'date', 'count', 'amount', 'ratio', 'flag', 'kind', 'rows', 'note', 'trimmed'],
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 40 },
        code: { type: 'string', minLength: 6, maxLength: 6 },
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        count: { type: 'integer', minimum: 0, maximum: 500 },
        amount: { type: 'integer', exclusiveMinimum: 0 },
        ratio: { type: 'number' },
        flag: { type: 'boolean' },
        kind: { type: 'string', enum: ['a', 'b'] },
        rows: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'integer', exclusiveMinimum: 0 } }
          }
        },
        note: { type: ['string', 'null'] },
        maybe: { type: 'string' },
        limit: { type: 'integer', default: 50 },
        opts: {
          type: 'object',
          additionalProperties: false,
          required: [],
          default: {},
          properties: { deep: { type: 'boolean', default: false } }
        },
        // .transform() documents its INPUT shape — that is what a caller has to send.
        trimmed: { type: 'string' }
      }
    })
  })

  it('reports optional and default separately, which is what the field docs key off', () => {
    expect(walkSchema(z.string()).optional).toBe(false)
    expect(walkSchema(z.string().optional()).optional).toBe(true)
    expect(walkSchema(z.string().default('x'))).toMatchObject({ optional: true, hasDefault: true })
    expect(walkSchema(z.string().nullable()).optional).toBe(false) // nullable is not omissible
  })

  it('renders an unknown construct as {} rather than throwing', () => {
    // The vocabulary limit is deliberate; the point is that overstepping it degrades to "no
    // guidance" instead of crashing a tool listing.
    expect(toJsonSchema(z.record(z.string(), z.string()) as never)).toEqual({ type: 'object', properties: {} })
  })
})
