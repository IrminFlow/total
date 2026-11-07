// The per-connection statement cache (encryption.ts installStatementCache): one prepared statement
// per SQL text, shared only through run / get / all; the mode / bind / iterate methods give the
// caller a private copy, so no holder ever sees another's mode. The driver (v13, Node-API) frees a
// statement's memory only once the event loop turns — without the cache a long synchronous run
// (the 100k perf seed) grew to ~1.5 GB and died.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import ts from 'typescript'
import { instrument } from '../perf/profile'
import { installStatementCache, STATEMENT_CACHE_SIZE } from './encryption'

function db(): Database.Database {
  const d = new Database(':memory:')
  installStatementCache(d)
  d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES (\'a\'), (\'b\'), (\'c\')')
  return d
}

describe('statement cache', () => {
  it('hands out one statement per SQL text', () => {
    const d = db()
    const sql = 'SELECT name FROM t WHERE id = ?'
    expect(d.prepare(sql)).toBe(d.prepare(sql))
    expect(d.prepare(sql).get(2)).toEqual({ name: 'b' })
    expect(d.prepare('INSERT INTO t (name) VALUES (?)').run('d').changes).toBe(1)
  })

  it('a mode is the caller’s own: a raw / pluck / expand holder never changes what others get', () => {
    const d = db()
    const sql = 'SELECT id, name FROM t WHERE id = ?'
    const shared = d.prepare(sql)
    const raw = d.prepare(sql).raw(true)
    const plucked = d.prepare(sql).pluck()
    expect(raw).not.toBe(shared)
    expect(plucked).not.toBe(raw)
    expect(raw.get(1)).toEqual([1, 'a'])
    expect(plucked.get(1)).toBe(1)
    expect(shared.get(1)).toEqual({ id: 1, name: 'a' })
    expect(d.prepare(sql).get(3)).toEqual({ id: 3, name: 'c' })
    expect(raw.get(2)).toEqual([2, 'b']) // still raw after others used the shared one
  })

  it('iterating the same SQL twice at once, and preparing it inside the loop, works', () => {
    const d = db()
    const sql = 'SELECT id FROM t ORDER BY id'
    const seen: number[][] = []
    for (const a of d.prepare(sql).iterate() as IterableIterator<{ id: number }>) {
      const inner = [...(d.prepare(sql).iterate() as IterableIterator<{ id: number }>)].map((r) => r.id)
      seen.push([a.id, ...inner, (d.prepare(sql).all() as { id: number }[]).length])
    }
    expect(seen).toEqual([[1, 1, 2, 3, 3], [2, 1, 2, 3, 3], [3, 1, 2, 3, 3]])
  })

  it('bind gives a private bound copy', () => {
    const d = db()
    const sql = 'SELECT name FROM t WHERE id = ?'
    const bound = d.prepare(sql).bind(2)
    expect(bound.get()).toEqual({ name: 'b' })
    expect(d.prepare(sql).get(3)).toEqual({ name: 'c' })
  })

  it('keeps at most STATEMENT_CACHE_SIZE statements (least recently used out first)', () => {
    const d = db()
    const first = d.prepare('SELECT 0')
    for (let i = 1; i <= STATEMENT_CACHE_SIZE; i++) d.prepare(`SELECT ${i}`)
    expect(d.prepare('SELECT 0')).not.toBe(first) // evicted
    const kept = d.prepare(`SELECT ${STATEMENT_CACHE_SIZE}`)
    expect(d.prepare(`SELECT ${STATEMENT_CACHE_SIZE}`)).toBe(kept)
  })

  it('SQL with many parameters (one text per list length) is not kept', () => {
    const d = db()
    const sql = `SELECT name FROM t WHERE id IN (${Array.from({ length: 51 }, () => '?').join(', ')})`
    const args = Array.from({ length: 51 }, (_, i) => i)
    expect(d.prepare(sql)).not.toBe(d.prepare(sql))
    expect((d.prepare(sql).all(...args) as unknown[]).length).toBe(3)
  })

  it('a changed safe-integer default reaches statements prepared before it', () => {
    const d = db()
    const sql = 'SELECT id FROM t WHERE id = 1'
    expect(d.prepare(sql).get()).toEqual({ id: 1 })
    d.defaultSafeIntegers(true)
    expect(d.prepare(sql).get()).toEqual({ id: 1n })
  })

  it('installing twice changes nothing; the perf profiler wraps a shared statement once', () => {
    const d = db()
    installStatementCache(d)
    const sql = 'SELECT name FROM t WHERE id = ?'
    expect(d.prepare(sql)).toBe(d.prepare(sql))
    const prof = instrument(d)
    for (let i = 0; i < 20_000; i++) d.prepare(sql).get(1)
    expect([...(d.prepare('SELECT id FROM t').iterate() as IterableIterator<unknown>)].length).toBe(3)
    const stat = prof.stats().find((s) => s.sql === sql)!
    expect(stat.calls).toBe(20_000)
    prof.restore()
  })

  it('a long synchronous run of the same statements does not pile up native memory', () => {
    const d = db()
    const sql = 'SELECT ' + Array.from({ length: 40 }, (_, i) => `name AS c${i}`).join(', ') + ' FROM t WHERE id = ?'
    const before = process.memoryUsage().rss
    for (let i = 0; i < 100_000; i++) d.prepare(sql).get((i % 3) + 1)
    // Uncached this held ~2.5 GB under plain Node (100k × ~25 KB); cached it is one statement.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024)
  })
})

// The private-copy rule needs the mode calls' RESULT used (`db.prepare(sql).raw(true)` — the copy is
// the method's return value). A call whose result is dropped (`stmt.raw(true);`, `if (x) s.pluck()`,
// `x && s.raw()`) would set the mode on a copy and lose it: none in app code (TypeScript AST).
describe('mode calls never drop their result in app code', () => {
  const MODE = new Set(['pluck', 'raw', 'expand', 'safeIntegers', 'bind'])
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.(test|dbtest)\.tsx?$/.test(n) ? [p] : []
    })
  /** The node's value is thrown away: an expression statement, or only reached through
   *  && / || / ?? / , / ?: / ( ) / void on the way up to one. */
  const discarded = (node: ts.Node): boolean => {
    const p = node.parent
    if (!p) return false
    if (ts.isExpressionStatement(p)) return true
    if (ts.isParenthesizedExpression(p) || ts.isVoidExpression(p)) return discarded(p)
    if (ts.isConditionalExpression(p) && p.condition !== node) return discarded(p)
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind
      if (op === ts.SyntaxKind.CommaToken) return p.left === node || discarded(p)
      if ((op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) && p.right === node) return discarded(p)
    }
    return false
  }
  it('every pluck / raw / expand / safeIntegers / bind result is used', () => {
    const bad: string[] = []
    for (const f of [...files(join(__dirname, '..')), ...files(join(__dirname, '..', '..', 'shared'))]) {
      const src = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MODE.has(n.expression.name.text) && discarded(n)) {
          bad.push(`${f}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
        }
        ts.forEachChild(n, visit)
      }
      visit(src)
    }
    expect(bad).toEqual([])
  })

  it('the check itself catches the dropped forms', () => {
    const src = ts.createSourceFile('x.ts', 's.raw(true)\nif (x) s.pluck()\nx && s.expand()\nconst k = s.raw(true)\nfoo(s.pluck())\n', ts.ScriptTarget.Latest, true)
    const found: number[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MODE.has(n.expression.name.text) && discarded(n)) found.push(src.getLineAndCharacterOfPosition(n.getStart()).line + 1)
      ts.forEachChild(n, visit)
    }
    visit(src)
    expect(found).toEqual([1, 2, 3])
  })
})
