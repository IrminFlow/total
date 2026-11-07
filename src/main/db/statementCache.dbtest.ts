// The per-connection statement cache (encryption.ts installStatementCache): one prepared statement
// per SQL text, shared only through run / get / all; the mode / bind / iterate methods give the
// caller a private copy, so no holder ever sees another's mode. The driver (v13, Node-API) frees a
// statement's memory only once the event loop turns — without the cache a long synchronous run
// (the 100k perf seed) grew to ~1.5 GB and died.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
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

  it('a long synchronous run of the same statements does not pile up native memory', () => {
    const d = db()
    const sql = 'SELECT ' + Array.from({ length: 40 }, (_, i) => `name AS c${i}`).join(', ') + ' FROM t WHERE id = ?'
    const before = process.memoryUsage().rss
    for (let i = 0; i < 100_000; i++) d.prepare(sql).get((i % 3) + 1)
    // Uncached this held ~2.5 GB under plain Node (100k × ~25 KB); cached it is one statement.
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024)
  })
})

// The private-copy rule needs the mode calls CHAINED (`db.prepare(sql).raw(true)` — the copy is the
// method's return value). A bare `stmt.raw(true);` statement would set the mode on a copy and drop it.
describe('mode calls are chained in app code', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.(test|dbtest)\.tsx?$/.test(n) ? [p] : []
    })
  it('no statement-level `x.pluck(…)` / `x.raw(…)` / `x.expand(…)` / `x.safeIntegers(…)` whose result is dropped', () => {
    const bad: string[] = []
    for (const f of files(join(__dirname, '..'))) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*[\w$.[\]]+\.(pluck|raw|expand|safeIntegers)\([^)]*\)\s*;?\s*$/.test(line)) bad.push(`${f}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
})
