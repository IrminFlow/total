import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Guards on the shipped MCP bundle.
 *
 * Both of these exist because the packaged app failed in ways development could not show:
 *
 *  1. The bundle required `electron`. Under ELECTRON_RUN_AS_NODE inside an app bundle there is
 *     no node_modules/electron to resolve, so it died at load with "Cannot find module
 *     'electron'". In development the npm shim resolves and the code paths that would have used
 *     `app` never run, so it looked fine.
 *  2. better-sqlite3's own dependencies stayed inside the asar, so the server died with
 *     "Cannot find module 'bindings'".
 *
 * The first is checkable cheaply here. The second is a packaging concern, asserted against
 * package.json so a future edit that drops the unpack globs is caught.
 */

const ROOT = join(__dirname, '..', '..', '..')
const BUNDLE = join(ROOT, 'out', 'mcp', 'total-mcp.cjs')

describe('MCP bundle', () => {
  it('builds', () => {
    execFileSync('node', [join(ROOT, 'scripts', 'build-mcp.mjs')], { cwd: ROOT })
    expect(existsSync(BUNDLE)).toBe(true)
    expect(statSync(BUNDLE).size).toBeGreaterThan(10_000)
  })

  /**
   * Actually load it, which is the only thing that catches this class of bug.
   *
   * Reaching the "No company" message means every module resolved: it is past requiring
   * better-sqlite3, past the electron stub, and into argument handling. Both packaging failures
   * died before this point, and neither showed up in any other test.
   */
  it('loads under Electron-as-Node with every module resolved', () => {
    const electronBinary = createRequire(join(ROOT, 'package.json'))('electron') as string
    let output = ''
    try {
      execFileSync(electronBinary, [BUNDLE, '--company', '__no_such_company__'], {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TOTAL_DATA_DIR: mkdtempSync(join(tmpdir(), 'mcp-load-')) },
        encoding: 'utf8',
        timeout: 60_000
      })
    } catch (err) {
      output = String((err as { stderr?: string }).stderr ?? '')
    }
    expect(output, 'a module failed to resolve rather than reaching argument handling').not.toMatch(
      /Cannot find module/
    )
    expect(output).toMatch(/No company "__no_such_company__"/)
  })
})

describe('packaging', () => {
  it('unpacks the bundle and better-sqlite3 with its dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      build: { asarUnpack: string[] }
    }
    const unpacked = pkg.build.asarUnpack.join(' ')
    // Without these the packaged server dies at load; the failure is invisible until someone
    // actually spawns it from Claude Desktop.
    for (const needed of ['out/mcp/**', 'better-sqlite3', 'bindings', 'file-uri-to-path']) {
      expect(unpacked, needed).toContain(needed)
    }
  })
})
