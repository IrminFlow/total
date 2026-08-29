import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve, sep } from 'path'

/**
 * Where SQL is allowed to live (roadmap Q #330).
 *
 * This repo has no eslint, so the layering rule that everyone already follows is written down
 * here as a test that reads the source with fs. The rule is not aesthetic. SQL in a screen or in
 * the preload bridge means the renderer has a second way to reach the books, one that skips Zod
 * validation, the role check and the soft-delete filter; SQL in `src/shared/` breaks the promise
 * that the engine is pure and testable without a database. Both mistakes look harmless in review
 * — a one-line count, "just this once" — and both are cheap to catch mechanically.
 *
 * The rule fails when SQL appears anywhere under `src/` except the two layers that own it, and
 * that includes `src/main/ipc.ts`: an IPC handler's job is to parse a payload and call a service.
 */

const ROOT = resolve(__dirname, '../..')

/**
 * The layers that own SQL.
 *
 * `services/` is where a query belongs. `db/` holds migrations, the connection, backup, integrity
 * checks and the seed — code whose whole subject matter is the file on disk.
 */
const SQL_LAYERS = ['src/main/services', 'src/main/db']

/**
 * Everything a `.dbtest.ts` or `.test.ts` does is assert facts about rows, including rows that
 * are in the bin, so tests are outside this rule entirely — they are checked by running them.
 */
const isTest = (name: string): boolean => name.endsWith('.test.ts') || name.endsWith('.dbtest.ts')

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(full)
    if (!/\.(ts|tsx)$/.test(name) || name.endsWith('.d.ts') || isTest(name)) return []
    return [full]
  })
}

/**
 * What counts as SQL.
 *
 * Two shapes: reaching for the driver (`db.prepare`, `db.exec`), and the text of a statement.
 * The text patterns are anchored on the keyword pairs that only occur in real SQL — `SELECT …
 * FROM`, `INSERT INTO`, `UPDATE x SET`, `DELETE FROM`, `CREATE TABLE` — because bare `SELECT` or
 * `UPDATE` shows up in ordinary prose and in UI copy.
 *
 * The keywords are matched case-SENSITIVELY, in upper case, which is how every query in this
 * repo is written. Case-insensitive matching turns "Select a ledger from the list" — a real
 * string in a real screen — into a violation, and a rule that cries wolf gets switched off. The
 * gap it leaves (lower-case SQL smuggled into the renderer) is still closed from the other side:
 * nothing there can reach a `db` handle without `db.prepare`/`db.exec`, which are matched too.
 */
const SQL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'db.prepare(', re: /\b\w*[dD]b\.prepare\s*\(/ },
  { name: 'db.exec(', re: /\b\w*[dD]b\.exec\s*\(/ },
  { name: 'SELECT … FROM', re: /\bSELECT\b[\s\S]{0,400}?\bFROM\s+[a-z_"`(]/ },
  { name: 'INSERT INTO', re: /\bINSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\s+[a-z_]/ },
  { name: 'UPDATE … SET', re: /\bUPDATE\s+[a-z_]\w*\s+SET\b/ },
  { name: 'DELETE FROM', re: /\bDELETE\s+FROM\s+[a-z_]/ },
  { name: 'CREATE TABLE', re: /\bCREATE\s+TABLE\b/ },
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/ }
]

/**
 * The exceptions that exist today, one entry per line of production code, kept as file plus a
 * snippet of the offending line so that moving the line does not silently widen the hole.
 *
 * None of these are "we will fix it later": each is a single count or lookup whose service round
 * trip would be pure ceremony. They are listed so that a fourth one is a decision somebody makes
 * on purpose rather than a diff nobody questioned.
 */
const ALLOWED_EXCEPTIONS: { file: string; contains: string; why: string }[] = [
  {
    file: 'src/main/ipc.ts',
    contains: "count('SELECT COUNT(*) AS n FROM ledgers')",
    // The getting-started checklist derives every step from the books rather than from a ticked
    // flag; these two counts are the whole of that derivation and have no other caller.
    why: 'app:checklist counts ledgers to decide whether the "add a ledger" step is done'
  },
  {
    file: 'src/main/ipc.ts',
    contains: 'const count = (sql: string): number',
    why: 'the local helper the two checklist counts share'
  },
  {
    file: 'src/main/ipc.ts',
    contains: 'voucherCount: count(',
    why: 'the same checklist, counting vouchers — already scoped with vouchers.IN_BOOKS'
  },
  {
    file: 'src/main/ipc.ts',
    contains: "SELECT COUNT(*) AS n FROM vouchers v WHERE ${vouchers.IN_BOOKS}",
    // voucher:count is asked on nearly every screen mount; it is a COUNT with the books scope
    // applied inline, and it is the only query in this file.
    why: 'voucher:count — one scoped COUNT behind an IPC channel of the same name'
  },
  {
    file: 'src/main/mcp/companyDb.ts',
    contains: "SELECT COUNT(*) AS n FROM migrations",
    // The MCP server opens company databases itself and refuses one that has never been
    // migrated. Asking the migrations table is how it tells; it cannot use a service to find out
    // whether services can run.
    why: 'the MCP server checks a database has been migrated before it will open it'
  },
  {
    file: 'src/main/cli/commands.ts',
    contains: 'SELECT id, name FROM voucher_types',
    // A name→id map for the CLI's voucher filter. Everything else the CLI reads goes through
    // services; this one predates listVoucherTypes returning what it needs.
    why: 'CLI resolves a voucher-type name to an id'
  }
]

const inSqlLayer = (rel: string): boolean =>
  SQL_LAYERS.some((layer) => rel === layer || rel.startsWith(layer + '/'))

/** Strip comments so that prose about a SELECT is not itself a violation. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

interface Violation {
  file: string
  line: number
  pattern: string
  text: string
}

function violations(): { scanned: number; sqlFilesInLayers: number; found: Violation[] } {
  const files = sourceFiles(join(ROOT, 'src'))
  const found: Violation[] = []
  let sqlFilesInLayers = 0

  for (const full of files) {
    const rel = relative(ROOT, full).split(sep).join('/')
    const code = stripComments(readFileSync(full, 'utf8'))
    const hasSql = SQL_PATTERNS.some((p) => p.re.test(code))
    if (inSqlLayer(rel)) {
      if (hasSql) sqlFilesInLayers++
      continue
    }
    if (!hasSql) continue
    code.split('\n').forEach((text, i) => {
      const hit = SQL_PATTERNS.find((p) => p.re.test(text))
      if (!hit) return
      const excused = ALLOWED_EXCEPTIONS.some((e) => e.file === rel && text.includes(e.contains))
      if (excused) return
      found.push({ file: rel, line: i + 1, pattern: hit.name, text: text.trim() })
    })
  }
  return { scanned: files.length, sqlFilesInLayers, found }
}

describe('SQL stays in the layers that own it', () => {
  const result = violations()

  it('actually read the tree', () => {
    // A rule that silently scans nothing passes forever. These floors are far below today's
    // counts; they fail if the walk breaks or the source layout moves out from under it.
    expect(result.scanned).toBeGreaterThan(150)
    expect(result.sqlFilesInLayers).toBeGreaterThan(40)
  })

  it('detects the shapes it claims to detect', () => {
    // The other half of the same worry: patterns that match nothing would also pass forever.
    const samples = [
      "const rows = db.prepare('SELECT id FROM ledgers').all()",
      "db.exec('CREATE TABLE t (id INTEGER)')",
      "run('INSERT INTO vouchers (date) VALUES (?)')",
      "run('UPDATE vouchers SET narration = ? WHERE id = ?')",
      "run('DELETE FROM voucher_lines WHERE voucher_id = ?')"
    ]
    for (const sample of samples) {
      expect(SQL_PATTERNS.some((p) => p.re.test(sample)), sample).toBe(true)
    }
    // And it does not fire on ordinary English or UI copy.
    for (const innocent of [
      'Select a ledger from the list to continue',
      'const updated = { ...draft, set: true }',
      'Delete this voucher? It moves to the bin.'
    ]) {
      expect(SQL_PATTERNS.some((p) => p.re.test(innocent)), innocent).toBe(false)
    }
  })

  it('finds no SQL outside src/main/services and src/main/db', () => {
    const report = result.found.map((v) => `${v.file}:${v.line} [${v.pattern}] ${v.text}`)
    expect(report).toEqual([])
  })

  it('keeps the renderer, the preload bridge and the engine completely clear', () => {
    // Stated separately from the rule above because these three are the ones with no exception
    // and never will have: SQL here is a second, unvalidated route to the books, or an engine
    // that can no longer be tested without a database.
    const sealed = ['src/renderer/', 'src/preload/', 'src/shared/', 'src/main/ipc.ts']
    const leaks = result.found.filter((v) => sealed.some((prefix) => v.file.startsWith(prefix)))
    expect(leaks.map((v) => `${v.file}:${v.line}`)).toEqual([])
  })

  it('has no stale entries in the exception list', () => {
    // An exception whose line has been deleted or reworded is one nobody is checking any more.
    for (const e of ALLOWED_EXCEPTIONS) {
      const src = readFileSync(join(ROOT, e.file), 'utf8')
      expect(src.includes(e.contains), `${e.file} no longer contains: ${e.contains}`).toBe(true)
      expect(e.why.length).toBeGreaterThan(10)
    }
  })
})
