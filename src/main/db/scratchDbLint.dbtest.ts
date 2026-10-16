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
import { testFileDb } from './testdb'

/** testPragmas opens the production default on purpose (what real books run with); this file
 *  names the pattern it looks for. */
const ALLOWED = new Set(['src/main/db/testPragmas.dbtest.ts', 'src/main/db/scratchDbLint.dbtest.ts'])

const MAIN = join(__dirname, '..')
const ROOT = join(MAIN, '..', '..')

function dbtests(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : dbtests(p)
    return f.endsWith('.dbtest.ts') ? [p] : []
  })
}

describe('scratch file databases in dbtests', () => {
  it('every writable file database a dbtest opens goes through testFileDb (no durable fixture commits)', () => {
    const offenders: string[] = []
    for (const file of dbtests(MAIN)) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (ALLOWED.has(rel)) continue
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!line.includes('new Database(')) return
          if (line.includes(':memory:') || line.includes('readonly')) return
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
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
    rmSync(dir, { recursive: true, force: true })
  })
})
