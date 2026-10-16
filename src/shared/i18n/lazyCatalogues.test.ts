// Perf (to-do after #135): only `en` may reach the renderer's startup bundle. hi / hinglish are
// imported statically only by ./all (main, tests) and dynamically by renderer lib/i18n.ts.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : files(p)
    return /\.(ts|tsx)$/.test(name) && !/\.(test|dbtest)\.(ts|tsx)$/.test(name) && !p.includes('__tests__') ? [p] : []
  })
}
const STATIC_LAZY = /^\s*(?:import|export)\b[^'"]*from\s+['"][^'"]*(?:i18n\/all|catalogues\/(?:hi|hinglish))['"]|^\s*import\s+['"][^'"]*(?:i18n\/all|catalogues\/(?:hi|hinglish))['"]/m

describe('lazy catalogues', () => {
  it('no renderer or shared module imports hi / hinglish (or ./all) statically', () => {
    const offenders = [...files(join(ROOT, 'src', 'renderer')), ...files(join(ROOT, 'src', 'shared'))]
      .filter((p) => !p.endsWith(join('shared', 'i18n', 'all.ts')))
      .filter((p) => STATIC_LAZY.test(readFileSync(p, 'utf8')))
      .map((p) => relative(ROOT, p))
    expect(offenders).toEqual([])
  })

  it('the renderer loads them with dynamic imports; main registers them eagerly', () => {
    const lib = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'lib', 'i18n.ts'), 'utf8')
    expect(lib).toContain("import('@shared/i18n/catalogues/hi')")
    expect(lib).toContain("import('@shared/i18n/catalogues/hinglish')")
    for (const f of ['index.ts', 'i18n.ts', join('cli', 'main.ts')]) {
      expect(readFileSync(join(ROOT, 'src', 'main', f), 'utf8')).toContain("import '@shared/i18n/all'")
    }
  })
})
