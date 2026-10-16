// The CLI / MCP data-root order matches the app: TOTAL_DATA_DIR -> data-root.json pointer -> Documents/total.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, posix, win32 } from 'path'
import { resolveCliDataRoot, userDataDir } from './dataRoot'
import { pointerText } from '../dataRootResolve'

let home: string
let books: string
let DEFAULT = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'total-cliroot-'))
  DEFAULT = join(home, 'default', 'total')
  books = join(home, 'moved books')
  mkdirSync(books)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

// Fixtures live under the real temp dir and use the host platform, so path styles always agree.
const PLATFORM = process.platform
const baseEnv = (): Record<string, string> => ({ APPDATA: join(home, 'appdata'), XDG_CONFIG_HOME: join(home, 'cfg') })
const userData = (): string => userDataDir(PLATFORM, baseEnv(), home)

function writePointer(path: string): void {
  const dir = userData()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'data-root.json'), pointerText(path))
}
const resolve = (env: Record<string, string> = {}, warn: string[] = []) =>
  resolveCliDataRoot({ env: { ...baseEnv(), ...env }, platform: PLATFORM, home, defaultRoot: () => DEFAULT, warn: (l) => warn.push(l) })

describe('resolveCliDataRoot', () => {
  it('userData per platform', () => {
    expect(userDataDir('win32', { APPDATA: 'C:\\U\\AppData\\Roaming' }, 'C:\\U')).toBe(win32.join('C:\\U\\AppData\\Roaming', 'total'))
    expect(userDataDir('win32', {}, 'C:\\U')).toBe(win32.join('C:\\U', 'AppData', 'Roaming', 'total'))
    expect(userDataDir('darwin', {}, '/h')).toBe(posix.join('/h', 'Library', 'Application Support', 'total'))
    expect(userDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/h')).toBe(posix.join('/x', 'total'))
    expect(userDataDir('linux', {}, '/h')).toBe(posix.join('/h', '.config', 'total'))
  })

  it('TOTAL_DATA_DIR wins over a pointer', () => {
    writePointer(books)
    expect(resolve({ TOTAL_DATA_DIR: join(home, 'scratch') })).toMatchObject({ path: join(home, 'scratch'), source: 'env' })
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
    const dir = userData()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'data-root.json'), 'nope')
    const warn: string[] = []
    expect(resolve({}, warn).path).toBe(DEFAULT)
    expect(warn).toHaveLength(1)
  })
})
