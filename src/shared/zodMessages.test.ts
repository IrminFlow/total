// Zod 4: the issue codes the WP 8.5 mapping (errors/map.ts) reads, and the "Required" wording
// zodMessages.ts keeps from Zod 3, on real schema failures.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zod3Issues, zodIssueCode } from './zodMessages'
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

// Each expected message is Zod 3.25.76's output for the same schema and input (run under zod@3
// when this was written) — the wording accountant screens, e-invoice checks and imports show.
describe("Zod 3's default messages under Zod 4", () => {
  const cases: [string, z.ZodType, unknown, string[]][] = [
    ['wrong type', z.string(), 5, ['Expected string, received number']],
    ['missing', z.string(), undefined, ['Required']],
    ['float for int', z.number().int(), 1.5, ['Expected integer, received float']],
    ['string for number', z.number(), 'x', ['Expected number, received string']],
    ['NaN', z.number(), NaN, ['Expected number, received nan']],
    ['string min', z.string().min(4), 'ab', ['String must contain at least 4 character(s)']],
    ['string max', z.string().max(2), 'abc', ['String must contain at most 2 character(s)']],
    ['string length', z.string().length(3), 'ab', ['String must contain exactly 3 character(s)']],
    ['empty string', z.string().min(1), '', ['String must contain at least 1 character(s)']],
    ['number min', z.number().min(1), 0, ['Number must be greater than or equal to 1']],
    ['positive', z.number().positive(), 0, ['Number must be greater than 0']],
    ['number max', z.number().max(5), 6, ['Number must be less than or equal to 5']],
    ['number lt', z.number().lt(5), 5, ['Number must be less than 5']],
    ['array min', z.array(z.string()).min(1), [], ['Array must contain at least 1 element(s)']],
    ['array max', z.array(z.string()).max(1), ['a', 'b'], ['Array must contain at most 1 element(s)']],
    ['bad option', z.enum(['a', 'b']), 'c', ["Invalid enum value. Expected 'a' | 'b', received 'c'"]],
    ['enum null', z.enum(['a', 'b']), null, ["Expected 'a' | 'b', received null"]],
    ['enum missing', z.enum(['a', 'b']), undefined, ['Required']],
    ['literal', z.literal('x'), 'y', ['Invalid literal value, expected "x"']],
    ['unknown keys', z.object({ a: z.string() }).strict(), { a: 'x', b: 1, c: 2 }, ["Unrecognized key(s) in object: 'b', 'c'"]],
    ['email', z.string().email(), 'x', ['Invalid email']],
    ['url', z.string().url(), 'x', ['Invalid url']],
    ['uuid', z.string().uuid(), 'x', ['Invalid uuid']],
    ['regex', z.string().regex(/^\d+$/), 'x', ['Invalid']],
    ['startsWith', z.string().startsWith('ab'), 'x', ['Invalid input: must start with "ab"']],
    ['multipleOf', z.number().multipleOf(5), 3, ['Number must be a multiple of 5']],
    ['union', z.union([z.string(), z.number()]), true, ['Invalid input']],
    ['discriminator', z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })]), { k: 'c' }, ["Invalid discriminator value. Expected 'a' | 'b'"]],
    ['refine', z.string().refine(() => false), 'x', ['Invalid input']],
    ['invalid date', z.date(), new Date('x'), ['Invalid date']],
    ['datetime', z.string().datetime(), 'x', ['Invalid datetime']],
    ['boolean', z.boolean(), 'true', ['Expected boolean, received string']],
    ['own message wins', z.string().min(1, 'Type a value'), '', ['Type a value']],
    ['record word', z.record(z.string(), z.number()), [], ['Expected object, received array']],
    ['tuple word', z.tuple([z.string()]), {}, ['Expected array, received object']],
    ['record key keeps its own message', z.record(z.string().regex(/^[a-z]+$/, 'Model ids are letters'), z.number()), { 'bad id!': 1 }, ['Model ids are letters']],
    ['bigint literal', z.literal(5n), 6n, ['Invalid literal value, expected "5"']],
    ['Infinity for int', z.number().int(), Infinity, ['Expected integer, received float']],
    ['Infinity', z.number(), Infinity, ['Number must be finite']],
    ['-Infinity', z.number(), -Infinity, ['Number must be finite']],
    ['union reports the branch whose type fit', z.union([z.number().int(), z.string()]), 1.5, ['Expected integer, received float']]
  ]
  it.each(cases)('%s', (_name, schema, input, expected) => {
    expect(issuesOf(schema, input).map((i) => i.message)).toEqual(expected)
  })

  it('an enum value of the wrong type maps to "needed" as in Zod 3 (invalid_type); a bad option stays invalid', () => {
    const kind = z.object({ kind: z.enum(['a', 'b']) })
    const asCode = (v: unknown): string => zodIssueCode(kind.safeParse({ kind: v }).error!.issues[0]!)
    expect(asCode(null)).toBe('invalid_type')
    expect(asCode(3)).toBe('invalid_type')
    expect(asCode(undefined)).toBe('invalid_type')
    expect(asCode('c')).toBe('invalid_value')
  })
})

// What ipc.ts reports (handle()'s message + ipcStructuredError): the issue LIST as Zod 3 gave it.
describe('zod3Issues', () => {
  const listOf = (s: z.ZodType, v: unknown) => zod3Issues(s.safeParse(v).error!.issues).map((i) => [i.code, i.path.join('.'), i.message])

  it("a union whose value fit one branch's type reports that branch (int-or-text amount given 1.5)", () => {
    const amount = z.object({ amount: z.union([z.number().int().positive(), z.string().min(1)]) })
    expect(listOf(amount, { amount: 1.5 })).toEqual([['invalid_type', 'amount', 'Expected integer, received float']])
    expect(listOf(amount, { amount: true })).toEqual([['invalid_union', 'amount', 'Invalid input']])
    expect(listOf(amount, { amount: -1 })).toEqual([['too_small', 'amount', 'Number must be greater than 0']])
  })

  it('a size check beside a type failure on the same field is dropped, as Zod 3 stopped at the type', () => {
    expect(listOf(z.object({ key: z.string().min(8) }), { key: [] })).toEqual([['invalid_type', 'key', 'Expected string, received array']])
    expect(listOf(z.object({ ids: z.array(z.number()).min(1) }), { ids: '' })).toEqual([['invalid_type', 'ids', 'Expected array, received string']])
  })

  it('±Infinity and a bad record key are check failures inside a union, as in Zod 3', () => {
    const cells = z.object({ cells: z.array(z.union([z.string(), z.number().finite(), z.null()])) })
    expect(listOf(cells, { cells: [Infinity] })).toEqual([['invalid_type', 'cells.0', 'Number must be finite']])
    const keyed = z.union([z.record(z.string().regex(/^\d+$/), z.number()), z.string()])
    expect(listOf(keyed, { x: 1 }).map(([, , m]) => m)).toEqual(['Invalid'])
  })

  it('the same issue twice is listed once', () => {
    expect(listOf(z.number().int().safe(), 2 ** 60)).toEqual([['too_big', '', 'Number must be less than or equal to 9007199254740991']])
  })

  it('a missing enum keeps invalid_type', () => {
    expect(listOf(z.object({ kind: z.enum(['a', 'b']) }), {})).toEqual([['invalid_type', 'kind', 'Required']])
  })
})
