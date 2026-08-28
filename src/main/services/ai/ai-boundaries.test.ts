import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

/**
 * Structural guards on the AI service. These are the two promises the feature makes to the user,
 * expressed as tests rather than as review discipline:
 *
 *  1. The assistant cannot write to the books. There is no write tool, and `saveVoucher` and
 *     friends are simply unreachable from this directory — the model produces drafts that a
 *     human saves through the normal path.
 *  2. The OpenAI SDK is confined to one file, so "what talks to the network" stays a
 *     one-file answer.
 *  3. The SDK is not in the static import graph of the process that starts up, so it is not
 *     parsed on a launch that never uses it.
 *
 * A filesystem grep is the right shape here: it fails when someone ADDS a call, which is exactly
 * when the promise would quietly stop being true.
 */

const AI_DIR = join(__dirname)
const ROOT = resolve(__dirname, '../../../..')
const MAIN_DIR = resolve(__dirname, '../..')


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

  it('imports only named read functions into the model tool module', () => {
    const tools = readFileSync(join(AI_DIR, 'tools', 'index.ts'), 'utf8')
    // A namespace import from vouchers/masters/etc. puts every writer exported by that service
    // into the tool module's runtime scope even when today's code happens not to call it.
    expect(tools).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+['"]\.\.\/\.\.\//)
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

  /**
   * The SDK is not in the startup graph (roadmap K #235).
   *
   * The assistant is off by default and most launches never call it, so `openai` is a megabyte of
   * parse work in the startup path of somebody who is not using the feature. Every entry point
   * reaches it with `await import(...)` instead.
   *
   * The rule is about the module GRAPH, not about a directory, because that is the thing that is
   * actually true or false: a static `import` anywhere on a chain from main's entry to
   * `provider.ts` pulls the SDK in at load time, and one added link undoes it silently — nothing
   * about the app looks different afterwards except a number nobody is watching.
   *
   * `import type` is exempt: it is erased at build time and costs nothing at runtime. So is
   * `src/main/mcp/`, which is built as a separate binary that exists to serve the tools and has
   * no startup budget to protect.
   */
  it('is not in the static import graph of the app that starts up', () => {
    const resolveImport = (fromFile: string, spec: string): string | null => {
      if (!spec.startsWith('.')) return null
      const base = resolve(dirname(fromFile), spec)
      for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) return candidate
      }
      return null
    }

    // Breadth-first over STATIC imports only, from the two files Electron actually loads.
    const seen = new Set<string>()
    const trail = new Map<string, string>()
    const queue = [resolve(MAIN_DIR, 'index.ts'), resolve(MAIN_DIR, 'ipc.ts')].filter(existsSync)
    queue.forEach((f) => seen.add(f))

    while (queue.length > 0) {
      const file = queue.shift()!
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const m of code.matchAll(/^\s*import\s+(type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
        if (m[1]) continue
        const next = resolveImport(file, m[2]!)
        if (!next || seen.has(next)) continue
        seen.add(next)
        trail.set(next, file)
        queue.push(next)
      }
    }

    const provider = resolve(AI_DIR, 'provider.ts')
    // On failure, print the chain rather than the fact — "provider.ts is reachable" sends the
    // reader hunting, and the one link that was added is the whole answer.
    const chain: string[] = []
    for (let at: string | undefined = provider; at; at = trail.get(at)) chain.unshift(relative(ROOT, at))
    expect(seen.has(provider) ? chain.join(' → ') : '').toBe('')
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
