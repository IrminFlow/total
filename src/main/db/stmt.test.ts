import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve, sep } from 'path'

/**
 * The two rules that make the prepared-statement cache safe (roadmap K#228).
 *
 * A cached `Statement` is shared between every caller of that SQL on that connection. Two things
 * make sharing wrong, and neither is visible at the call site:
 *
 *   1. **SQL built at runtime.** `IN (${placeholders})` produces a different string per call, so
 *      the map grows without bound — a leak wearing a cache's clothes. Those call sites must keep
 *      using `db.prepare`. The one exception is interpolating a module-level SQL constant such as
 *      `NOT_DELETED`, which yields a fixed, finite set of strings.
 *   2. **Sticky statement state.** `.pluck()`, `.raw()` and `.expand()` persist on the statement,
 *      and `.iterate()` leaves it busy until the iterator is drained. Any of those on a shared
 *      statement is a bug that only appears when two features are used in the same session, which
 *      is the kind that ships.
 *
 * Checked mechanically rather than by review, because both are invisible in a diff that looks
 * like `db.prepare(` → `prep(db, `.
 */

const ROOT = resolve(__dirname, '..', '..', '..')
const MAIN = join(ROOT, 'src', 'main')

const isTest = (name: string): boolean => name.endsWith('.test.ts') || name.endsWith('.dbtest.ts')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || isTest(name)) return []
    return [full]
  })
}

/** SQL fragments that are module-level constants, so interpolating them is still a fixed string. */
const CONSTANT_FRAGMENTS = ['NOT_DELETED', 'IN_BOOKS']

/** Every `prep(db, <arg>)` call, with the argument text and the ~120 chars that follow the call. */
function prepCalls(code: string): { arg: string; after: string; index: number }[] {
  const out: { arg: string; after: string; index: number }[] = []
  const re = /\bprep\(\s*db\s*,\s*/g
  for (const m of code.matchAll(re)) {
    const start = m.index + m[0].length
    let depth = 1
    let i = start
    while (depth > 0 && i < code.length) {
      const c = code[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === '`' || c === "'" || c === '"') {
        const quote = c
        i++
        while (i < code.length && !(code[i] === quote && code[i - 1] !== '\\')) i++
      }
      i++
    }
    out.push({ arg: code.slice(start, i - 1).trim(), after: code.slice(i - 1, i + 120), index: m.index })
  }
  return out
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length

describe('the prepared-statement cache is only reached for statements it is safe to share', () => {
  const files = sourceFiles(MAIN)

  it('is only ever given SQL that is a fixed string', () => {
    const bad: string[] = []
    let calls = 0
    for (const full of files) {
      const code = readFileSync(full, 'utf8')
      const rel = relative(ROOT, full).split(sep).join('/')
      for (const call of prepCalls(code)) {
        calls++
        const literal =
          (call.arg.startsWith('`') && call.arg.endsWith('`')) ||
          (call.arg.startsWith("'") && call.arg.endsWith("'")) ||
          (call.arg.startsWith('"') && call.arg.endsWith('"'))
        const exprs = [...call.arg.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!.trim())
        const constantsOnly = exprs.every((e) => CONSTANT_FRAGMENTS.includes(e))
        if (!literal || !constantsOnly) {
          bad.push(`${rel}:${lineOf(code, call.index)} — ${call.arg.slice(0, 90).replace(/\s+/g, ' ')}`)
        }
      }
    }
    // The guard is worthless if it is silently scanning nothing.
    expect(calls, 'no prep() call sites found at all — has the helper been renamed?').toBeGreaterThan(20)
    expect(
      bad,
      'prep() was given SQL that is assembled at run time. Use db.prepare for those — a cache keyed ' +
        'on a string that changes every call is an unbounded map.\n' + bad.join('\n')
    ).toEqual([])
  })

  it('never has a state-mutating method chained onto it', () => {
    const bad: string[] = []
    for (const full of files) {
      const code = readFileSync(full, 'utf8')
      const rel = relative(ROOT, full).split(sep).join('/')
      for (const call of prepCalls(code)) {
        const chained = /^\)\s*\.?\s*(?:\n\s*)?\.?(pluck|raw|expand|iterate)\b/.exec(call.after.slice(0))
        if (chained) bad.push(`${rel}:${lineOf(code, call.index)} — .${chained[1]}()`)
      }
    }
    expect(
      bad,
      'pluck/raw/expand/iterate change or occupy the statement, and a cached statement is shared. ' +
        'Use db.prepare at these call sites.\n' + bad.join('\n')
    ).toEqual([])
  })
})
