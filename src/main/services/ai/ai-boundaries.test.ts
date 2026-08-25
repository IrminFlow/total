import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Structural guards on the AI service. These are the two promises the feature makes to the user,
 * expressed as tests rather than as review discipline:
 *
 *  1. The assistant cannot write to the books. There is no write tool, and `saveVoucher` and
 *     friends are simply unreachable from this directory — the model produces drafts that a
 *     human saves through the normal path.
 *  2. The OpenAI SDK is confined to one file, so "what talks to the network" stays a
 *     one-file answer.
 *
 * A filesystem grep is the right shape here: it fails when someone ADDS a call, which is exactly
 * when the promise would quietly stop being true.
 */

const AI_DIR = join(__dirname)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.dbtest.ts')) return []
    return [full]
  })
}

/** Anything that mutates the books, plus raw SQL. */
const FORBIDDEN = [
  /\bsaveVoucher\s*\(/,
  /\bdeleteVoucher\s*\(/,
  /\brestoreVoucher\s*\(/,
  /\bpostClose\s*\(/,
  /\bapplyImport\s*\(/,
  /\bcommitRun\s*\(/,
  /\bdb\.prepare\s*\(/,
  /\bdb\.exec\s*\(/,
  /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i
]

describe('AI service boundaries', () => {
  const files = sourceFiles(AI_DIR)

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('cannot write to the books from anywhere in the AI service', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      // Strip comments so prose about saveVoucher does not trip the guard.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(code), `${file} matches ${pattern}`).toBe(false)
      }
    }
  })

  /**
   * The audit trail (roadmap #217) is the first thing on an AI path that writes anything at all,
   * and the promise it must not weaken is "the assistant cannot change the books".
   *
   * Two halves. It lives OUTSIDE this directory, so the grep above still holds over every file
   * here; and it may only touch its own table. A row recording that a model proposed a draft is
   * provenance. A row in `vouchers` is books.
   */
  it('lets the AI service record provenance, and nothing else', () => {
    const writers = files.filter((file) => /from '\.\.\/assistantLog'/.test(readFileSync(file, 'utf8')))
    expect(writers.map((f) => f.split('/').pop())).toEqual(['runner.ts'])

    // Comments stripped first: the file's own header talks about `vouchers` in prose, and prose
    // about a table is not a query against it.
    const log = readFileSync(join(__dirname, '..', 'assistantLog.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    // Every table it names must be its own.
    // `(?!SET\b)` because an upsert's `ON CONFLICT DO UPDATE SET` is not a second table.
    const tables = [...log.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+(?!SET\b)([a-z_]+)/gi)].map((m) =>
      m[1]!.toLowerCase()
    )
    expect([...new Set(tables)]).toEqual(['assistant_runs'])
  })

  it('confines the OpenAI SDK to provider.ts', () => {
    const importers = files.filter((file) => {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      return /from ['"]openai['"]/.test(code)
    })
    expect(importers.map((f) => f.split('/').pop())).toEqual(['provider.ts'])
  })
})
