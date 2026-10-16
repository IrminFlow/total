// PR #131 follow-up — the check worker (out/main/checkWorker.js) now carries the restore check of a
// backup (migrations, audit chain, trial balance). It is bundled on its own by
// scripts/build-check-worker.mjs, the same function electron.vite.config.ts runs: the file must
// stay self-contained — no require('electron') (a worker thread cannot load it; the packaged app
// has no electron package), no AI provider / MCP SDK — and need only Node built-ins and the driver.
import { describe, expect, it } from 'vitest'
import { builtinModules } from 'module'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CHECK_WORKER_FORBIDDEN, ELECTRON_STUB, buildCheckWorker } from '../../../scripts/build-check-worker.mjs'

describe('the check worker bundle', () => {
  it('is self-contained: Node built-ins and the SQLite driver only; no Electron, AI or MCP code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-checkworker-bundle-'))
    try {
      const out = join(dir, 'checkWorker.js')
      const result = await buildCheckWorker(out, { metafile: true })
      const inputs = Object.keys(result.metafile!.inputs)
      // It has the restore check's code…
      for (const f of ['src/main/services/backupVerify.ts', 'src/main/db/migrate.ts', 'src/main/db/migrations.ts', 'src/main/services/audit.ts', 'src/main/services/vouchers.ts']) {
        expect(inputs).toContain(f)
      }
      // …and none of the app's AI / MCP code.
      expect(inputs.filter((f) => /^src\/main\/(ai|mcp|assist)\//.test(f))).toEqual([])
      const code = readFileSync(out, 'utf8')
      const required = [...new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1] as string))].sort()
      const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
      expect(required.filter((m) => !builtins.has(m))).toEqual(['better-sqlite3-multiple-ciphers'])
      for (const re of CHECK_WORKER_FORBIDDEN) expect(required.filter((m) => re.test(m))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the Electron stand-in throws on any use (a check that reaches Electron fails loudly)', () => {
    const exp: Record<string, unknown> = {}
    new Function('exports', ELECTRON_STUB)(exp)
    expect(Object.keys(exp)).toEqual(expect.arrayContaining(['app', 'BrowserWindow']))
    expect(() => exp.app).toThrow(/Electron is not available in the check worker \(electron\.app\)/)
    expect(() => exp.BrowserWindow).toThrow(/electron\.BrowserWindow/)
    // esbuild's interop reads descriptors, never values, so importing it does not throw.
    expect(Object.getOwnPropertyDescriptor(exp, 'app')?.get).toBeTypeOf('function')
  })
})
