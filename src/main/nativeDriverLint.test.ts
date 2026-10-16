// WP 7.2 review: the database driver is better-sqlite3-multiple-ciphers, built for Electron's ABI.
//  - plain vitest (system Node) must never load it: no *.test.ts imports it (dbtests do, under
//    Electron-as-Node — scripts/test-db.mjs);
//  - nothing imports the old `better-sqlite3` package any more (it is not installed: a stray
//    import would fail only at run time, in the packaged app).
//  - PR #129 review: the test helpers (db/testdb.ts — testFileDb opens files with synchronous OFF —
//    and the *.testutil.ts fixtures) are imported only by tests, never by app / CLI code.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '..', '..')
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'out' || f === 'dist') continue
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(f)) out.push(p)
  }
  return out
}
const IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"]better-sqlite3(-multiple-ciphers)?['"]/

describe('native driver imports', () => {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]

  it('no plain-vitest test loads the native driver', () => {
    const bad = files.filter((f) => /\.test\.tsx?$/.test(f) && IMPORT.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f))
    expect(bad).toEqual([])
  })

  it('nothing imports the old better-sqlite3 package', () => {
    const old = /(?:from\s+|require\(\s*|import\(\s*)['"]better-sqlite3['"]/
    const bad = files.filter((f) => old.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f))
    expect(bad).toEqual([])
  })

  it('only tests import the test helpers (db/testdb.ts, *.testutil.ts)', () => {
    const HELPER = /(?:from\s+|require\(\s*|import\(\s*)['"][^'"]*\/(?:testdb|[\w.-]+\.testutil)['"]/
    const isTest = (f: string): boolean => /\.(test|dbtest)\.tsx?$|\.testutil\.ts$/.test(f) || /[\\/]db[\\/]testdb\.ts$/.test(f)
    const bad = files.filter((f) => !isTest(f) && HELPER.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f))
    expect(bad).toEqual([])
  })
})
