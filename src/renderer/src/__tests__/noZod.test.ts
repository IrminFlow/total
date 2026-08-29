import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

/**
 * The renderer does not ship zod.
 *
 * Every IPC payload is validated in MAIN — that is the security boundary, and a second copy of
 * the validator in the renderer would not make anything safer even if the renderer used it. What
 * the renderer legitimately wants from those modules is `DEFAULT_FEATURES`, `KEY_MASK`, an
 * endpoint helper: plain values and pure functions sitting in the same file as a schema.
 *
 * One runtime `import { z } from 'zod'` on that path put roughly 130 KB into the chunk read
 * before anything is on screen, and another 130 into a lazy one — to describe objects the
 * renderer only ever reads. Splitting the schemas into `*.schema.ts` took the entry chunk from
 * 1,453 KB to 1,320 and the renderer total from 3,160 to 3,023.
 *
 * The cost of keeping it out is exactly one thing: when a value and its schema want to live in
 * the same file, they have to live in two. This test is what makes that trade visible at the
 * moment somebody undoes it, rather than in a bundle report nobody reads.
 *
 * TYPES ARE FINE. `import type { AiSettings }` is erased at build time and costs nothing, which
 * is why this looks for value imports only.
 */

const ROOT = resolve(__dirname, '../../../..')
const RENDERER = resolve(ROOT, 'src/renderer/src')

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })

/** Resolve a relative or `@shared/...` specifier to a file on disk. */
function resolveSpec(fromFile: string, spec: string): string | null {
  const base = spec.startsWith('@shared/')
    ? resolve(ROOT, 'src/shared', spec.slice('@shared/'.length))
    : spec.startsWith('.')
      ? resolve(dirname(fromFile), spec)
      : null
  if (!base) return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every VALUE import in a file — `import type` and inline `type` specifiers excluded. */
function valueImports(file: string): string[] {
  const code = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  for (const m of code.matchAll(/^\s*import\s+(type\s+)?([\s\S]*?)from\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue
    // `import { type A, b } from 'x'` still imports `b` at runtime; `import { type A } from 'x'`
    // does not, but esbuild keeps the module in the graph either way, so it counts.
    out.push(m[3]!)
  }
  return out
}

describe('the renderer bundle', () => {
  it('never reaches zod through a value import', () => {
    const seen = new Set<string>()
    const trail = new Map<string, string>()
    const queue = sourceFiles(RENDERER)
    queue.forEach((f) => seen.add(f))
    const offenders: string[] = []

    while (queue.length > 0) {
      const file = queue.shift()!
      for (const spec of valueImports(file)) {
        if (spec === 'zod' || spec.startsWith('zod/')) {
          // Print the chain, not the fact: the one import that was added is the whole answer.
          const chain: string[] = []
          for (let at: string | undefined = file; at; at = trail.get(at)) chain.unshift(relative(ROOT, at))
          offenders.push(`${chain.join(' → ')} → zod`)
          continue
        }
        const next = resolveSpec(file, spec)
        if (!next || seen.has(next)) continue
        seen.add(next)
        trail.set(next, file)
        queue.push(next)
      }
    }

    expect([...new Set(offenders)]).toEqual([])
  })

  it('actually walked the graph', () => {
    // A resolver that silently stops resolving would leave the test above passing vacuously.
    expect(sourceFiles(RENDERER).length).toBeGreaterThan(60)
    expect(resolveSpec(join(RENDERER, 'lib/client.ts'), '@shared/features')).toContain('features.ts')
  })
})
