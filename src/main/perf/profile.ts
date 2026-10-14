// WP 7.1 — a statement-level profiler for `total-cli perf --profile <case>`: wraps db.prepare so
// every statement's run / get / all / iterate is timed by its SQL text, and prints the top ones
// with their EXPLAIN QUERY PLAN. Developer tooling only — never loaded by the app.
import type { DB } from '../db/connection'

interface Stat { sql: string; calls: number; ms: number; stack?: string }

export function instrument(db: DB): { stats: () => Stat[]; restore: () => void } {
  const original = db.prepare.bind(db)
  const stats = new Map<string, Stat>()
  const wrap = (sql: string, stmt: ReturnType<DB['prepare']>): ReturnType<DB['prepare']> => {
    const stat = stats.get(sql) ?? { sql, calls: 0, ms: 0 }
    stats.set(sql, stat)
    for (const m of ['run', 'get', 'all'] as const) {
      const fn = (stmt as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.bind(stmt)
      ;(stmt as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        const t0 = performance.now()
        try {
          return fn(...args)
        } finally {
          if (!stat.calls) stat.stack = (new Error().stack ?? '').split('\n').slice(2, 9).map((l) => l.trim().replace(/\(.*[/\\]/, '(')).join(' < ')
          stat.calls++
          stat.ms += performance.now() - t0
        }
      }
    }
    const it = (stmt as unknown as Record<string, (...a: unknown[]) => Iterable<unknown>>).iterate!.bind(stmt)
    ;(stmt as unknown as Record<string, unknown>).iterate = function* (...args: unknown[]) {
      const t0 = performance.now()
      try {
        yield* it(...args)
      } finally {
        stat.calls++
        stat.ms += performance.now() - t0
      }
    }
    return stmt
  }
  ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => wrap(sql, original(sql))
  return {
    stats: () => [...stats.values()].sort((a, b) => b.ms - a.ms),
    restore: () => {
      ;(db as unknown as { prepare: unknown }).prepare = original
    }
  }
}

export function explain(db: DB, sql: string): string {
  try {
    const n = (sql.match(/\?/g) ?? []).length
    const named = [...new Set(sql.match(/[:@$][a-zA-Z_]\w*/g) ?? [])]
    const params = named.length ? Object.fromEntries(named.map((k) => [k.slice(1), null])) : undefined
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    const rows = (params ? stmt.all(params) : stmt.all(...Array(n).fill(null))) as { detail: string }[]
    return rows.map((r) => `    ${r.detail}`).join('\n')
  } catch (err) {
    return `    (no plan: ${err instanceof Error ? err.message : String(err)})`
  }
}
