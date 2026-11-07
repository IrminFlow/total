// Zod 4 with Zod 3's default messages. Every message a schema does not set itself is worded as Zod
// 3.25 worded it ("name: Required", "String must contain at least 4 character(s)", "Invalid enum
// value. Expected 'a' | 'b', received 'c'", "Unrecognized key(s) in object: 'x'" …): accountant
// screens show the service's wording as the fallback (WP 8.5), the e-invoice checks list them, the
// AI tools quote them to the model, and price / template imports report them. A message a schema
// sets itself still wins (Zod 4: a schema's own error beats the global one). Anything not listed
// here keeps Zod 4's wording. zodMessages.test.ts pins every template to Zod 3.25.76's output.
// Process-wide (z.config): imported once by every entry — main (index.ts AND ipc.ts), the renderer,
// the CLI, the check worker and the vitest setups.
import { z } from 'zod'

const REQUIRED = 'Required'

interface RawIssue {
  code?: string
  input?: unknown
  inst?: unknown
  expected?: string
  received?: string
  origin?: string
  minimum?: number | bigint
  maximum?: number | bigint
  inclusive?: boolean
  exact?: boolean
  values?: readonly unknown[]
  keys?: readonly string[]
  format?: string
  prefix?: string
  suffix?: string
  includes?: string
  divisor?: number | bigint
  note?: string
  options?: readonly unknown[]
  errors?: readonly (readonly UnionBranchIssue[])[]
  issues?: readonly UnionBranchIssue[]
}

/** An issue of one union branch, as Zod 4 hands it over (messages already worded). */
interface UnionBranchIssue {
  code: string
  path: readonly PropertyKey[]
  message: string
  expected?: string
  received?: string
  errors?: readonly (readonly UnionBranchIssue[])[]
  issues?: readonly UnionBranchIssue[]
}

const INFINITE = /^-?Infinity$/

/** Whether a number schema carries an integer check (`.int()`, `.safe()`, int32 …). */
const hasIntCheck = (inst: unknown): boolean =>
  ((inst as { _zod?: { def?: { checks?: { _zod?: { def?: { format?: string } } }[] } } } | undefined)?._zod?.def?.checks ?? [])
    .some((c) => /int/.test(c._zod?.def?.format ?? ''))

const defType = (inst: unknown): string | undefined => (inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type

/** Zod 3's `util.joinValues`: strings quoted with ', joined by " | ". */
const joinValues = (values: readonly unknown[]): string => values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(' | ')

/** JSON.stringify as Zod 3's literal message used it — a bigint / symbol never throws. */
const literalText = (v: unknown): string => (typeof v === 'bigint' || typeof v === 'symbol' ? `"${String(v)}"` : JSON.stringify(v))

/** Zod 4's type words that Zod 3 named differently in "Expected …". */
const EXPECTED_WORDS: Record<string, string> = { record: 'object', tuple: 'array', int: 'integer' }

/** A failure Zod 3 called INVALID (the value's type / option did not fit), as opposed to DIRTY
 *  (the type fit, a check failed). Zod 3's union returned the first dirty branch's own issues. */
const isHard = (i: UnionBranchIssue): boolean =>
  // ±Infinity is a type failure in Zod 4 but was a check (.finite / .int) in Zod 3.
  (i.code === 'invalid_type' && i.expected !== 'int' && !INFINITE.test(i.received ?? '')) || i.code === 'invalid_value' ||
  // A record key: hard only when the key itself had the wrong type / option.
  (i.code === 'invalid_key' && (i.issues ?? []).some(isHard)) ||
  (i.code === 'invalid_union' && !dirtyBranch(i.errors))

/** Zod 3's union rule: the first branch whose value had the right type (only checks failed). */
export function dirtyBranch(errors: readonly (readonly UnionBranchIssue[])[] | undefined): readonly UnionBranchIssue[] | undefined {
  return errors?.find((branch) => branch.length > 0 && !branch.some(isHard))
}

/** Zod 3's `getParsedType` names (as "received"). */
function parsedType(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  if (v instanceof Map) return 'map'
  if (v instanceof Set) return 'set'
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : 'number'
  if (typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function') return 'promise'
  return typeof v
}

const FORMAT_WORDS: Record<string, string> = {
  email: 'email', url: 'url', uuid: 'uuid', guid: 'uuid', cuid: 'cuid', cuid2: 'cuid2', ulid: 'ulid', emoji: 'emoji',
  datetime: 'datetime', date: 'date', time: 'time', duration: 'duration', ipv4: 'ip', ipv6: 'ip', cidrv4: 'cidr', cidrv6: 'cidr',
  base64: 'base64', base64url: 'base64url', nanoid: 'nanoid', jwt: 'jwt'
}

function tooSmall(i: RawIssue): string | undefined {
  const n = i.minimum
  switch (i.origin) {
    case 'string':
      return `String must contain ${i.exact ? 'exactly' : i.inclusive ? 'at least' : 'over'} ${n} character(s)`
    case 'set':
      return 'Invalid input'
    case 'array':
      return `Array must contain ${i.exact ? 'exactly' : i.inclusive ? 'at least' : 'more than'} ${n} element(s)`
    case 'number':
    case 'int':
    case 'bigint':
      return `Number must be ${i.exact ? 'exactly equal to ' : i.inclusive ? 'greater than or equal to ' : 'greater than '}${n}`
    case 'date':
      return `Date must be ${i.exact ? 'exactly equal to ' : i.inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(n))}`
    default:
      return undefined
  }
}

function tooBig(i: RawIssue): string | undefined {
  const n = i.maximum
  switch (i.origin) {
    case 'string':
      return `String must contain ${i.exact ? 'exactly' : i.inclusive ? 'at most' : 'under'} ${n} character(s)`
    case 'set':
      return 'Invalid input'
    case 'array':
      return `Array must contain ${i.exact ? 'exactly' : i.inclusive ? 'at most' : 'less than'} ${n} element(s)`
    case 'number':
    case 'int':
      return `Number must be ${i.exact ? 'exactly' : i.inclusive ? 'less than or equal to' : 'less than'} ${n}`
    case 'bigint':
      return `BigInt must be ${i.exact ? 'exactly' : i.inclusive ? 'less than or equal to' : 'less than'} ${n}`
    case 'date':
      return `Date must be ${i.exact ? 'exactly' : i.inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(n))}`
    default:
      return undefined
  }
}

/** The global error map: Zod 3's wording for the issue, or undefined (= Zod 4's own). */
export function zodCustomError(issue: RawIssue): string | undefined {
  const type = defType(issue.inst)
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined && !issue.received) return REQUIRED
      if (issue.expected === 'date' && issue.received === 'Invalid Date') return 'Invalid date'
      const infinite = INFINITE.test(issue.received ?? '')
      if ((issue.expected === 'int' || (infinite && hasIntCheck(issue.inst))) && (infinite || typeof issue.input === 'number')) return 'Expected integer, received float'
      if (infinite) return 'Number must be finite'
      // Zod 4 reports NaN / Infinity with input null and a `received` word.
      const received = issue.received === 'NaN' ? 'nan' : parsedType(issue.input)
      if (issue.expected === 'int') return `Expected integer, received ${received}`
      return `Expected ${EXPECTED_WORDS[issue.expected ?? ''] ?? issue.expected}, received ${received}`
    }
    case 'invalid_key':
      // Zod 3 reported the key schema's own issue (e.g. "Model ids are letters, digits …").
      return issue.issues?.[0]?.message
    case 'invalid_value': {
      const values = issue.values ?? []
      if (type === 'enum') {
        if (issue.input === undefined) return REQUIRED
        // Zod 3: a non-string was invalid_type, not a bad option.
        if (typeof issue.input !== 'string') return `Expected ${joinValues(values)}, received ${parsedType(issue.input)}`
        return `Invalid enum value. Expected ${joinValues(values)}, received '${String(issue.input)}'`
      }
      if (type === 'literal') {
        return values.length === 1 ? `Invalid literal value, expected ${literalText(values[0])}` : undefined
      }
      return undefined
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${(issue.keys ?? []).map((k) => `'${k}'`).join(', ')}`
    case 'invalid_union':
      if (issue.note === 'No matching discriminator') return `Invalid discriminator value. Expected ${joinValues(issue.options ?? [])}`
      return dirtyBranch(issue.errors)?.[0]?.message ?? 'Invalid input'
    case 'invalid_format': {
      const f = issue.format ?? ''
      if (f === 'regex') return 'Invalid'
      if (f === 'starts_with') return `Invalid input: must start with "${issue.prefix}"`
      if (f === 'ends_with') return `Invalid input: must end with "${issue.suffix}"`
      if (f === 'includes') return `Invalid input: must include "${issue.includes}"`
      const word = FORMAT_WORDS[f]
      return word ? `Invalid ${word}` : undefined
    }
    case 'too_small':
      return tooSmall(issue)
    case 'too_big':
      return tooBig(issue)
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`
    case 'custom':
      return 'Invalid input'
    default:
      return undefined
  }
}

/** Zod 3's "invalid_type" messages for an enum (a missing value, or one of the wrong type). */
const ENUM_AS_TYPE = /^(Required|Expected .+, received [a-z]+)$/

/** The issue code the WP 8.5 mapping (errors/map.ts) reads, as `zod.<code>`: Zod 4's, except an
 *  enum value that is missing or of the wrong type, which Zod 3 reported as invalid_type
 *  (→ "needed", not "invalid"). A real bad option reads "Invalid enum value…", never matched. */
export function zodIssueCode(issue: { code: string; message: string }): string {
  return issue.code === 'invalid_value' && ENUM_AS_TYPE.test(issue.message) ? 'invalid_type' : issue.code
}

export interface Zod3Issue {
  code: string
  path: PropertyKey[]
  message: string
}

/** A ZodError's issues as Zod 3 would have listed them (what ipc.ts reports): a union whose value
 *  fit one branch's type reports that branch's issues (Zod 3's dirty-branch rule) instead of one
 *  "invalid_union"; a size check next to a type failure on the same path is dropped (Zod 4 adds
 *  "Array must contain…" to a string field given an array — Zod 3 stopped at the type); the same
 *  issue twice (`.int().safe()` runs the safe-integer check twice) is listed once. Codes go
 *  through zodIssueCode. */
export function zod3Issues(issues: readonly { code: string; path: PropertyKey[]; message: string; errors?: unknown }[]): Zod3Issue[] {
  const flat: Zod3Issue[] = []
  const walk = (list: readonly UnionBranchIssue[] | readonly { code: string; path: PropertyKey[]; message: string; errors?: unknown }[], prefix: PropertyKey[]): void => {
    for (const raw of list) {
      const i = raw as UnionBranchIssue
      const path = [...prefix, ...i.path]
      const branch = i.code === 'invalid_union' ? dirtyBranch(i.errors) : undefined
      if (branch) walk(branch, path)
      else flat.push({ code: zodIssueCode(i), path, message: i.message })
    }
  }
  walk(issues, [])
  const key = (i: Zod3Issue): string => i.path.map(String).join('\u0000')
  const typed = new Set(flat.filter((i) => i.code === 'invalid_type').map(key))
  const seen = new Set<string>()
  return flat.filter((i) => {
    if ((i.code === 'too_small' || i.code === 'too_big') && typed.has(key(i))) return false
    const id = `${key(i)}\u0001${i.code}\u0001${i.message}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

z.config({ customError: zodCustomError })
