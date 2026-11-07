// The JSON schemas the model sees for every tool (strict structured outputs) are pinned to a
// fixture generated with Zod 3 (`zodToJsonSchema` on origin/main) — the Zod 4 port of the walker
// must give them byte for byte, and the same for a schema of the walker's edge cases (described
// wrappers, refinements, transforms, preprocess, .min(0) arrays, defaults). Regenerate only on
// known-good code: TOTAL_WRITE_TOOL_SCHEMAS=1.
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { zodToJsonSchema } from './jsonSchema'

function pinned(file: string, value: unknown): void {
  const path = join(__dirname, '__fixtures__', file)
  const text = JSON.stringify(value, null, 2) + '\n'
  if (process.env.TOTAL_WRITE_TOOL_SCHEMAS === '1') writeFileSync(path, text)
  expect(text).toBe(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
}

describe('tool parameter schemas', () => {
  it('are byte-identical to the fixture', async () => {
    const { createToolRegistry } = await import('./tools')
    pinned('toolSchemas.json', createToolRegistry().specs('owner'))
  })

  it('the walker edge cases are byte-identical to the fixture', () => {
    const shapes = z.object({
      describedOptional: z.string().describe('inner text').optional(),
      describedNullable: z.number().int().describe('a count').nullable(),
      describedDefault: z.boolean().describe('a flag').default(true),
      ownWrapperText: z.string().describe('inner').optional().describe('outer'),
      refined: z.string().min(1).refine((s) => s !== 'x').describe('refined'),
      refinedOptional: z.string().refine((s) => s !== 'x').optional(),
      transformed: z.string().max(5).transform((s) => s.length),
      transformedOptional: z.string().optional().transform((s) => s ?? ''),
      preprocessed: z.preprocess((v) => v, z.number().min(2).max(9)),
      bounds: z.number().nonnegative().lt(10),
      exclusive: z.number().int().positive().gt(3),
      safe: z.number().int().safe(),
      safePositive: z.number().int().safe().positive(),
      arrayMinZero: z.array(z.string()).min(0),
      arrayNonEmpty: z.array(z.string()).nonempty().max(4),
      arrayTwice: z.array(z.number()).min(1).min(2).max(9).max(8),
      arrayExact: z.array(z.number()).length(3),
      stringLength: z.string().length(4).regex(/^a+$/),
      trimmed: z.string().trim().min(2),
      objectDefault: z.object({ a: z.number().default(1) }).default({ a: 2 }),
      literal: z.literal('only'),
      union: z.union([z.string(), z.number()]).describe('either'),
      nested: z.object({ deep: z.array(z.object({ k: z.enum(['a', 'b']) })) }).optional()
    }).describe('shapes')
    pinned('jsonSchemaShapes.json', zodToJsonSchema(shapes))
  })
})
