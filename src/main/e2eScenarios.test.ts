import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

/**
 * The E2E scenarios are numbered, and the numbers have to mean something.
 *
 * Lives here with the other repo-hygiene greps (`notDeleted`, `dbBoundaries`, `channels`) rather
 * than beside the scenarios, because `scripts/` has no test harness of its own and these all
 * answer the same kind of question: is the thing that is only true by convention still true.
 *
 * Two collisions have already happened, both from parallel branches each taking "the next free
 * number". A duplicate number is not fatal — the runner globs files, so both still run — but
 * `node scripts/run-e2e.mjs 42` then means two different things, and the summary prints two rows
 * that look like a retry. A mismatched id is worse: the runner reports the id, so a failure names
 * a file that is not the one that failed.
 */

const DIR = resolve(__dirname, '../../scripts/e2e')

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort()

describe('the E2E scenarios', () => {
  it('found them', () => {
    expect(files.length).toBeGreaterThan(30)
  })

  it('names every scenario after its own file', () => {
    const wrong: string[] = []
    for (const file of files) {
      const src = readFileSync(join(DIR, file), 'utf8')
      // The call is sometimes wrapped across lines, so match the first string argument rather
      // than requiring it on the same line as `scenario(`.
      const m = src.match(/\bscenario\(\s*'([^']+)'/)
      if (!m) wrong.push(`${file} — no scenario() call found`)
      else if (m[1] !== file.replace(/\.mjs$/, '')) wrong.push(`${file} — declares itself '${m[1]}'`)
    }
    expect(wrong).toEqual([])
  })

  it('gives each one a number of its own', () => {
    const byNumber = new Map<string, string[]>()
    for (const file of files) {
      const n = file.match(/^(\d+)-/)?.[1]
      if (!n) continue
      byNumber.set(n, [...(byNumber.get(n) ?? []), file])
    }
    const shared = [...byNumber.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([n, list]) => `${n}: ${list.join(', ')}`)
    expect(shared).toEqual([])
  })

  it('numbers every one of them', () => {
    expect(files.filter((f) => !/^\d+-/.test(f))).toEqual([])
  })
})
