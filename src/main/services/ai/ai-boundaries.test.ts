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
