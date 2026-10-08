// WP 5.1 network boundary: the renderer makes no network calls (CSP default-src 'self', no
// fetch / XHR / WebSocket / EventSource / beacon in its source), nothing outside main imports the
// OpenAI SDK, and inside main only the provider adapter does. When a build exists (out/), the
// renderer bundle is checked too.
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '..', '..', '..')

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.test(name)) out.push(p)
  }
  return out
}

/** Source without comments (a comment saying "fetch (so …" is not a network call). */
const code = (p: string): string =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
const isTest = (p: string): boolean => /\.(test|dbtest)\.tsx?$/.test(p) || p.includes('__tests__')
const IMPORTS_OPENAI = /(?:from\s+['"]openai(?:\/[^'"]*)?['"]|require\(\s*['"]openai(?:\/[^'"]*)?['"]\s*\)|import\(\s*['"]openai)/
const NETWORK_API = /(?<![\w.])fetch\s*\(|XMLHttpRequest|new\s+WebSocket\b|new\s+EventSource\b|sendBeacon\s*\(/

describe('renderer has no network and no AI SDK', () => {
  const rendererFiles = [...walk(join(ROOT, 'src', 'renderer'), /\.(ts|tsx|html)$/), ...walk(join(ROOT, 'src', 'preload'), /\.ts$/)].filter((p) => !isTest(p))

  it('found the renderer sources', () => {
    expect(rendererFiles.length).toBeGreaterThan(50)
  })

  it('no renderer / preload / shared file imports openai', () => {
    const shared = walk(join(ROOT, 'src', 'shared'), /\.ts$/).filter((p) => !isTest(p))
    const offenders = [...rendererFiles, ...shared].filter((p) => IMPORTS_OPENAI.test(readFileSync(p, 'utf8'))).map((p) => relative(ROOT, p))
    expect(offenders).toEqual([])
  })

  it('no renderer / preload source calls fetch, XHR, WebSocket, EventSource or sendBeacon', () => {
    const offenders = rendererFiles.filter((p) => NETWORK_API.test(code(p))).map((p) => relative(ROOT, p))
    expect(offenders).toEqual([])
  })

  it('the CSP keeps every fetch on self', () => {
    const html = readFileSync(join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toMatch(/default-src 'self'/)
    expect(csp).not.toMatch(/connect-src/)
    expect(csp).not.toMatch(/https?:|wss?:|\*/)
  })

  it('the built renderer bundle (when present) carries no OpenAI client', () => {
    const bundle = walk(join(ROOT, 'out', 'renderer'), /\.js$/)
    for (const f of bundle) {
      const text = readFileSync(f, 'utf8')
      expect(text.includes('api.openai.com'), relative(ROOT, f)).toBe(false)
      expect(text.includes('x-stainless'), relative(ROOT, f)).toBe(false)
    }
  })
})

describe('inside main, only the provider adapter imports openai', () => {
  it('src/main/ai/provider.ts is the single importer', () => {
    const files = walk(join(ROOT, 'src', 'main'), /\.ts$/).filter((p) => !isTest(p))
    const importers = files.filter((p) => IMPORTS_OPENAI.test(readFileSync(p, 'utf8'))).map((p) => relative(ROOT, p).split('\\').join('/'))
    expect(importers).toEqual(['src/main/ai/provider.ts'])
  })

  it('openai is a runtime dependency (externalised into the main bundle, not shipped to the renderer)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    expect(pkg.dependencies.openai).toBeDefined()
    expect(pkg.devDependencies.openai).toBeUndefined()
  })
})
