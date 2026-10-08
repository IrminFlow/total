// Test-only: a canonical dump of every books table of a company (WP 6.3 Books fidelity tests).
import type { DB } from '../db/connection'

/** Tables that are not books data, or legitimately differ between two companies. */
const NOT_COMPARED = new Set(['audit_log', 'migrations', 'meta', 'sqlite_sequence', 'import_templates', 'import_batches', 'import_batch_items'])
const SKIP_COLUMN = (c: string): boolean => c === 'id' || c.endsWith('_at') || c === 'row_hash' || c === 'prev_hash'

/** Every table as a sorted list of canonical rows. */
export function canonicalDump(db: DB): Record<string, string[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name).filter((t) => !NOT_COMPARED.has(t) && !t.startsWith('sqlite_'))
  const fks = new Map<string, Map<string, { table: string; to: string }>>()
  for (const t of tables) {
    fks.set(t, new Map((db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { from: string; table: string; to: string | null }[]).map((f) => [f.from, { table: f.table, to: f.to ?? 'id' }])))
  }
  const memo = new Map<string, string>()
  const canon = (table: string, row: Record<string, unknown>, depth: number): string => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (SKIP_COLUMN(k)) continue
      const ref = fks.get(table)?.get(k)
      out[k] = ref && v !== null && depth < 6 ? refCanon(ref.table, ref.to, v, depth + 1) : v
    }
    return JSON.stringify(out)
  }
  const refCanon = (table: string, to: string, id: unknown, depth: number): string => {
    const key = `${table}#${to}#${String(id)}`
    if (!memo.has(key)) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE ${to} = ?`).get(id) as Record<string, unknown> | undefined
      memo.set(key, row ? canon(table, row, depth) : 'missing')
    }
    return memo.get(key)!
  }
  const dump: Record<string, string[]> = {}
  for (const t of tables) dump[t] = (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]).map((r) => canon(t, r, 0)).sort()
  return dump
}

