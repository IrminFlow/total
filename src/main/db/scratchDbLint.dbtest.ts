// Windows CI flake (backup.dbtest "restoreCompanyDb happy path" 70 s, run 38913361210; the earlier
// rollbackRestore timeout): the restore under test is a few hundred ms — the time went into the
// test's own FIXTURES, file databases opened with the driver's constructor directly, which keeps SQLite's
// durable default: in rollback-journal mode every commit fsyncs (FlushFileBuffers) the journal and
// the file and creates / deletes the journal, and migrate() + seedCompany() are ~60 commits.
// test:db's TOTAL_TEST_DB_SYNCHRONOUS only reaches handles opened by openCompanyDb, so those
// fixtures never got it. A dbtest that WRITES a file database opens it with testFileDb
// (testdb.ts: synchronous = OFF, per connection — the code under test keeps its own pragmas).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { migrate } from './migrate'
import { openDb } from './encryption'
import { testFileDb } from './testdb'

/** testPragmas opens the production default on purpose (what real books run with); this file
 *  names the pattern it looks for. */
const ALLOWED = new Set(['src/main/db/testPragmas.dbtest.ts', 'src/main/db/scratchDbLint.dbtest.ts'])

const MAIN = join(__dirname, '..')
const ROOT = join(MAIN, '..', '..')

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : testFiles(p)
    return /\.(dbtest|testutil)\.ts$/.test(f) ? [p] : []
  })
}

/** Every `new Database(...)` call in `src` whose arguments are neither ':memory:' nor carry
 *  `readonly: true` — the arguments may span lines; comments in them don't count. */
function writableRawOpens(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  const re = /new Database\(/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
      i++
    }
    const args = src.slice(m.index + m[0].length, i - 1).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (/^\s*['"`]:memory:['"`]/.test(args) || /\breadonly\s*:\s*true\b/.test(args)) continue
    out.push({ line: src.slice(0, m.index).split('\n').length, text: src.slice(m.index, i).replace(/\s+/g, ' ') })
  }
  return out
}

describe('scratch file databases in dbtests', () => {
  it('every writable file database a dbtest (or a test fixture module) opens goes through testFileDb', () => {
    const offenders: string[] = []
    for (const file of testFiles(MAIN)) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (ALLOWED.has(rel)) continue
      for (const o of writableRawOpens(readFileSync(file, 'utf8'))) offenders.push(`${rel}:${o.line}: ${o.text}`)
    }
    expect(offenders).toEqual([])
  })

  it('the lint reads multi-line calls, ignores :memory: / readonly: true, and is not fooled by readonly: false or a comment', () => {
    const found = (s: string): number => writableRawOpens(s).length
    expect(found("new Database(':memory:')")).toBe(0)
    expect(found('new Database(p, { readonly: true })')).toBe(0)
    expect(found('new Database(\n  join(dir, "a.db"),\n  { readonly: true, fileMustExist: true }\n)')).toBe(0)
    expect(found('new Database(p)')).toBe(1)
    expect(found('new Database(join(dir, "a.db"))')).toBe(1)
    expect(found('new Database(p, { readonly: false })')).toBe(1)
    expect(found('new Database(p /* readonly: true */)')).toBe(1)
    expect(found('new Database(\n  p // readonly: true\n)')).toBe(1)
  })

  it('testFileDb turns synchronous off for a writable connection only, and nothing is stored in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-scratchdb-'))
    const path = join(dir, 'company.db')
    const db = testFileDb(path)
    expect(db.pragma('synchronous', { simple: true })).toBe(0)
    migrate(db)
    db.close()
    const ro = testFileDb(path, { readonly: true })
    // A read-only handle is left as SQLite opens it (FULL = 2 in rollback-journal mode).
    expect(ro.pragma('synchronous', { simple: true })).toBe(2)
    ro.close()
    // The code under test opens its own handles (db/encryption.ts openDb): they get the
    // production default, not the fixture's OFF — rollback journal FULL (2), WAL NORMAL (1).
    const prod = openDb(path)
    expect(prod.pragma('synchronous', { simple: true })).toBe(2)
    prod.pragma('journal_mode = WAL')
    prod.close()
    const fixture = testFileDb(path)
    expect(fixture.pragma('synchronous', { simple: true })).toBe(0)
    fixture.close()
    const prodWal = openDb(path)
    expect(prodWal.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(prodWal.pragma('synchronous', { simple: true })).toBe(1)
    prodWal.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
