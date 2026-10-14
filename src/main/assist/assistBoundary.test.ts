// WP 10.1: Ask Total needs no key and nothing leaves the machine. Every module src/main/assist/
// reaches (its whole import graph, @shared included) is walked: none is the AI provider adapter
// or the agent loop, none imports the OpenAI SDK, the MCP SDK or a network module, and none calls
// fetch / XHR / WebSocket.
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

const ROOT = join(__dirname, '..', '..', '..')
const SRC = join(ROOT, 'src')

const code = (p: string): string => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@shared/')) base = join(SRC, 'shared', spec.slice('@shared/'.length))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base]) if (existsSync(c) && !c.endsWith('/')) {
    try {
      readFileSync(c)
      return c
    } catch {
      /* a directory */
    }
  }
  return null
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

function graph(entries: string[]): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>()
  const packages = new Map<string, string>()
  const todo = [...entries]
  while (todo.length) {
    const f = todo.pop()!
    if (files.has(f)) continue
    files.add(f)
    for (const m of code(f).matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3]!
      // type-only imports carry no code
      if (/^\s*import\s+type\b/.test(m[0]) || /^\s*export\s+type\b/.test(m[0])) continue
      const r = resolveImport(f, spec)
      if (r) todo.push(r)
      else if (!spec.startsWith('.') && !spec.startsWith('@shared/')) packages.set(spec, relative(ROOT, f))
    }
  }
  return { files, packages }
}

describe('Ask Total never reaches the network or the AI provider', () => {
  const dir = __dirname
  const entries = readdirSync(dir).filter((n) => /\.ts$/.test(n) && !/\.(test|dbtest)\.ts$/.test(n)).map((n) => join(dir, n))
  const { files, packages } = graph(entries)

  it('walked the assistant and what it uses', () => {
    expect(entries.length).toBeGreaterThanOrEqual(5)
    expect(files.size).toBeGreaterThan(30)
  })

  it('no module in its graph is the provider adapter, the agent loop or the MCP server', () => {
    const rel = [...files].map((f) => relative(ROOT, f).split('\\').join('/'))
    expect(rel.filter((f) => /src\/main\/ai\/(?:provider|agent|mockProvider)\.ts$|src\/main\/mcp\//.test(f))).toEqual([])
  })

  it('no package import is the OpenAI / MCP SDK or a network module', () => {
    const bad = [...packages.keys()].filter((p) => /^(?:openai|@modelcontextprotocol\/|node:(?:http|https|net|tls|dgram)|http|https|net|tls|dgram|undici|ws)(?:\/|$)/.test(p))
    expect(bad).toEqual([])
  })

  it('no module in its graph calls fetch, XHR, WebSocket or EventSource', () => {
    const NET = /(?<![\w.])fetch\s*\(|XMLHttpRequest|new\s+WebSocket\b|new\s+EventSource\b/
    expect([...files].filter((f) => NET.test(code(f))).map((f) => relative(ROOT, f))).toEqual([])
  })
})
