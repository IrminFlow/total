// D7: the renderer runs sandboxed (windowPolicy.ts `sandbox: true`), so the preload may import only
// `electron` (contextBridge / ipcRenderer) — no Node built-ins, no local modules or packages
// (a sandboxed preload can't require them) — and use only the sandbox's own `process` fields.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const DIR = __dirname
const SOURCES = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
// Electron's sandboxed-preload `process` (docs: "Process sandboxing").
const SANDBOX_PROCESS = new Set(['platform', 'argv', 'env', 'versions', 'arch', 'pid', 'type', 'version', 'sandboxed', 'contextIsolated', 'execPath'])

describe('preload is sandbox-compatible', () => {
  it('has sources to check', () => expect(SOURCES).toContain('index.ts'))
  for (const f of SOURCES) {
    const src = readFileSync(join(DIR, f), 'utf8')
    it(`${f} imports only electron`, () => {
      const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4])
      expect(specs.length).toBeGreaterThan(0)
      expect(specs.filter((s) => s !== 'electron')).toEqual([])
      expect(src).not.toMatch(/\brequire\s*\(/)
    })
    it(`${f} reads only the sandbox's process fields`, () => {
      const used = [...src.matchAll(/\bprocess\.(\w+)/g)].map((m) => m[1] ?? '')
      expect(used.filter((u) => !SANDBOX_PROCESS.has(u))).toEqual([])
    })
  }
})

describe('the built preload (out/preload, when built)', () => {
  const built = join(DIR, '../../out/preload/index.js')
  it('requires only electron', () => {
    let js: string
    try {
      js = readFileSync(built, 'utf8')
    } catch {
      return // not built in this run (npm test before npm run build)
    }
    const reqs = [...js.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
    expect(reqs.filter((r) => r !== 'electron')).toEqual([])
    expect(js).not.toMatch(/\bimport\s*\(/)
  })
})
