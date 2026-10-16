// The CLI / MCP data-root order matches the app: TOTAL_DATA_DIR -> data-root.json pointer -> Documents/total.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveCliDataRoot, userDataDir } from './dataRoot'
import { pointerText } from '../dataRootResolve'

let home: string
let books: string
const DEFAULT = '/default/total'
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'total-cliroot-'))
  books = join(home, 'moved books')
  mkdirSync(books)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function writePointer(path: string, appName = 'total'): void {
  const dir = join(home, 'Library', 'Application Support', appName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data-root.json'), pointerText(path))
}
const resolve = (env: Record<string, string> = {}, warn: string[] = []) =>
  resolveCliDataRoot({ env, platform: 'darwin', home, defaultRoot: () => DEFAULT, warn: (l) => warn.push(l) })

describe('resolveCliDataRoot', () => {
  it('userData per platform', () => {
    expect(userDataDir('win32', { APPDATA: 'C:\\U\\AppData\\Roaming' }, 'C:\\U')).toMatch(/total$/)
    expect(userDataDir('darwin', {}, '/h')).toBe('/h/Library/Application Support/total')
    expect(userDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/total')
    expect(userDataDir('linux', {}, '/h')).toBe('/h/.config/total')
  })

  it('TOTAL_DATA_DIR wins over a pointer', () => {
    writePointer(books)
    expect(resolve({ TOTAL_DATA_DIR: '/scratch' })).toMatchObject({ path: '/scratch', source: 'env' })
  })

  it('a pointer to an existing folder is followed', () => {
    writePointer(books)
    expect(resolve()).toMatchObject({ path: books, source: 'pointer' })
  })

  it('no pointer: the default, no warning', () => {
    const warn: string[] = []
    expect(resolve({}, warn)).toMatchObject({ path: DEFAULT, source: 'default' })
    expect(warn).toEqual([])
  })

  it('a pointer whose folder is gone falls back to the default with one warning', () => {
    writePointer(join(home, 'gone'))
    const warn: string[] = []
    expect(resolve({}, warn)).toMatchObject({ path: DEFAULT, source: 'default' })
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('gone')
  })

  it('a garbage pointer falls back with a warning', () => {
    const dir = join(home, 'Library', 'Application Support', 'total')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'data-root.json'), 'nope')
    const warn: string[] = []
    expect(resolve({}, warn).path).toBe(DEFAULT)
    expect(warn).toHaveLength(1)
  })
})
