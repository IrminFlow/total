// Zod 4: the issue codes the WP 8.5 mapping (errors/map.ts) reads, and the "Required" wording
// zodMessages.ts keeps from Zod 3, on real schema failures.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodIssueCode } from './zodMessages'
import { errorEntry } from './errors/map'

const issuesOf = (s: z.ZodType, v: unknown): { code: string; path: string; message: string }[] => {
  const r = s.safeParse(v)
  if (r.success) throw new Error('expected a failure')
  return r.error.issues.map((i) => ({ code: i.code, path: i.path.join('.'), message: i.message }))
}

describe('Zod 4 issues as the error mapping reads them', () => {
  const schema = z.object({
    name: z.string().trim().min(1).max(5),
    amount: z.number().int().positive(),
    gstin: z.string().regex(/^\d{2}[A-Z0-9]{13}$/).nullable(),
    kind: z.enum(['a', 'b']),
    own: z.string().min(1, 'Type a value')
  }).strict()

  it('a missing value reads "Required" and maps to "needed"', () => {
    expect(issuesOf(schema, {})).toEqual([
      { code: 'invalid_type', path: 'name', message: 'Required' },
      { code: 'invalid_type', path: 'amount', message: 'Required' },
      { code: 'invalid_type', path: 'gstin', message: 'Required' },
      { code: 'invalid_value', path: 'kind', message: 'Required' },
      { code: 'invalid_type', path: 'own', message: 'Required' }
    ])
    expect(errorEntry('zod.invalid_type', 'name')?.key).toBe('errors.nameNeeded')
    // a missing enum: Zod 4 says invalid_value; ipc.ts reports it as Zod 3 did (invalid_type)
    const kind = schema.safeParse({}).error!.issues.find((i) => i.path[0] === 'kind')!
    expect(kind.code).toBe('invalid_value')
    expect(zodIssueCode(kind)).toBe('invalid_type')
    expect(errorEntry(`zod.${zodIssueCode(kind)}`, 'kind')?.key).toBe('errors.fieldNeeded')
    const wrong = schema.safeParse({ kind: 'c' }).error!.issues.find((i) => i.path[0] === 'kind')!
    expect(zodIssueCode(wrong)).toBe('invalid_value')
  })

  it('other failures keep the codes the mapping knows (renamed ones land on fieldInvalid as before)', () => {
    const got = issuesOf(schema, { name: '  ', amount: 1.5, gstin: 'x', kind: 'c', own: '', extra: 1 })
    expect(got.map((i) => [i.code, i.path])).toEqual([
      ['too_small', 'name'], ['invalid_type', 'amount'], ['invalid_format', 'gstin'], ['invalid_value', 'kind'], ['too_small', 'own'], ['unrecognized_keys', '']
    ])
    expect(got[4]!.message).toBe('Type a value')
    expect(errorEntry('zod.too_small', 'name')?.key).toBe('errors.nameNeeded')
    expect(errorEntry('zod.invalid_format', 'gstin')?.key).toBe('errors.gstinInvalid')
    // Zod 3's invalid_enum_value / invalid_string were fieldInvalid; their Zod 4 names are too.
    expect(errorEntry('zod.invalid_value', 'kind')?.key).toBe('errors.fieldInvalid')
    expect(errorEntry('zod.invalid_format', 'code')?.key).toBe('errors.fieldInvalid')
  })
})
