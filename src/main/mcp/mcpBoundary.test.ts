// WP 5.7 packaging boundary: the MCP SDK lives only in the CLI. Only src/main/mcp/server.ts and
// stdio.ts import it; nothing the app's main entry reaches imports them; the SDK is a
// devDependency (electron-builder ships `dependencies` only); and — when builds exist — the app's
// main bundle carries no MCP SDK and no HTTP server stack (express / hono), and the CLI bundle,
// which does carry the stdio server, carries no HTTP server stack either.
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

const ROOT = join(__dirname, '..', '..', '..')
const SRC_MAIN = join(ROOT, 'src', 'main')

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.test(name)) out.push(p)
  }
  return out
}

const isTest = (p: string): boolean => /\.(test|dbtest|testutil)\.ts$/.test(p)
const IMPORTS_SDK = /(?:from\s+|import\s*\(\s*|require\(\s*)['"]@modelcontextprotocol\/sdk/
const rel = (p: string): string => relative(ROOT, p).split('\\').join('/')

/** Static import specifiers of a TS file (type-only imports included — harmless). */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g), ...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!)
}

function resolveTs(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else if (spec.startsWith('@shared/')) base = join(ROOT, 'src', 'shared', spec.slice(8))
  else if (spec.startsWith('@main/')) base = join(SRC_MAIN, spec.slice(6))
  else return null
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c
  return null
}

/** Every source file reachable from `entry` through relative / alias imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const spec of importsOf(f)) {
      const r = resolveTs(f, spec)
      if (r && /\.tsx?$/.test(r)) stack.push(r)
    }
  }
  return seen
}

describe('the MCP SDK stays in the CLI', () => {
  it('only src/main/mcp/server.ts and stdio.ts import @modelcontextprotocol/sdk', () => {
    const importers = walk(join(ROOT, 'src'), /\.tsx?$/)
      .filter((p) => !isTest(p))
      .filter((p) => IMPORTS_SDK.test(readFileSync(p, 'utf8')))
      .map(rel)
      .sort()
    expect(importers).toEqual(['src/main/mcp/server.ts', 'src/main/mcp/stdio.ts'])
  })

  it('the app main entry never reaches the MCP server (it only reads mcp/log.ts and the config)', () => {
    const files = [...reachable(join(SRC_MAIN, 'index.ts'))].map(rel)
    expect(files).toContain('src/main/ipc.ts')
    expect(files).toContain('src/main/mcp/log.ts')
    expect(files.filter((f) => /src\/main\/mcp\/(server|stdio)\.ts$/.test(f))).toEqual([])
  })

  it('the CLI entry does reach it', () => {
    const files = [...reachable(join(SRC_MAIN, 'cli', 'main.ts'))].map(rel)
    expect(files).toContain('src/main/mcp/stdio.ts')
    expect(files).toContain('src/main/mcp/server.ts')
  })

  it('is a devDependency — electron-builder packages `dependencies` only, so the app never ships it', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      build: { files: string[] }
    }
    expect(pkg.devDependencies['@modelcontextprotocol/sdk']).toBeDefined()
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeUndefined()
    for (const dep of ['express', 'hono', '@hono/node-server', 'cors']) expect(pkg.dependencies[dep], dep).toBeUndefined()
    // The packaged app is out/ + package.json, minus the CLI bundle (out/cli, written by the
    // launcher in a checkout — it inlines the SDK's stdio server) should one be lying around.
    expect(pkg.build.files).toEqual(['out/**/*', '!out/cli/**', 'package.json'])
  })

  const HTTP_STACK = /require\(["'](?:express|hono|@hono\/node-server|cors|express-rate-limit)["']\)|node_modules\/(?:express|hono|@hono)\//

  // CI's smoke-mac job runs this file after `npm run build` (and one CLI run) with
  // TOTAL_REQUIRE_BUILT=1: a missing bundle then fails instead of skipping.
  const requireBuilt = process.env.TOTAL_REQUIRE_BUILT === '1'

  it('the built app main bundle (when present) has no MCP SDK and no HTTP server stack', () => {
    const files = walk(join(ROOT, 'out', 'main'), /\.(c|m)?js$/)
    if (requireBuilt) expect(files.length, 'out/main must be built (TOTAL_REQUIRE_BUILT=1)').toBeGreaterThan(0)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text.includes('@modelcontextprotocol'), rel(f)).toBe(false)
      expect(HTTP_STACK.test(text), rel(f)).toBe(false)
      expect(/StreamableHTTPServerTransport|SSEServerTransport/.test(text), rel(f)).toBe(false)
    }
  })

  it('the CLI bundle (when present) carries the stdio server but no HTTP transport or server stack', () => {
    const cli = join(ROOT, 'out', 'cli', 'total-cli.cjs')
    if (requireBuilt) expect(existsSync(cli), 'out/cli/total-cli.cjs must exist (run the CLI once; TOTAL_REQUIRE_BUILT=1)').toBe(true)
    if (!existsSync(cli)) return
    const text = readFileSync(cli, 'utf8')
    expect(text).toContain('StdioServerTransport')
    expect(HTTP_STACK.test(text)).toBe(false)
    expect(/StreamableHTTPServerTransport|SSEServerTransport|createMcpExpressApp/.test(text)).toBe(false)
    // Nor the OpenAI client: the MCP server sends nothing to a model provider.
    expect(text.includes('api.openai.com')).toBe(false)
  })
})
