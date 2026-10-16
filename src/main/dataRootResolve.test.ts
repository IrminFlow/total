// Where the data root comes from: TOTAL_DATA_DIR, else the pointer file, else Documents/total.
import { describe, expect, it } from 'vitest'
import { posix, win32 } from 'path'
import { parsePointer, pointerText, resolveDataRoot, type ResolveDeps } from './dataRootResolve'
import { isOneDrivePath } from '@shared/windowsPaths'

function deps(over: Partial<ResolveDeps> & { files?: Record<string, string>; dirs?: string[] } = {}): ResolveDeps {
  const files = over.files ?? {}
  const dirs = new Set(over.dirs ?? [])
  return {
    env: {},
    pointerFile: '/ud/data-root.json',
    defaultRoot: '/home/a/Documents/total',
    readText: (p) => (p in files ? files[p]! : null),
    isDirectory: (p) => dirs.has(p),
    isAbsolutePath: posix.isAbsolute,
    ...over
  }
}

describe('resolveDataRoot', () => {
  it('TOTAL_DATA_DIR wins over a pointer and the default', () => {
    const r = resolveDataRoot(deps({ env: { TOTAL_DATA_DIR: '/scratch' }, files: { '/ud/data-root.json': pointerText('/books') }, dirs: ['/books'] }))
    expect(r).toEqual({ path: '/scratch', source: 'env', defaultPath: '/home/a/Documents/total' })
  })

  it('a pointer to an existing folder comes next', () => {
    const r = resolveDataRoot(deps({ files: { '/ud/data-root.json': pointerText('/books') }, dirs: ['/books'] }))
    expect(r).toEqual({ path: '/books', source: 'pointer', defaultPath: '/home/a/Documents/total' })
  })

  it('no pointer = the default folder, no problem', () => {
    expect(resolveDataRoot(deps())).toEqual({ path: '/home/a/Documents/total', source: 'default', defaultPath: '/home/a/Documents/total' })
  })

  it('a pointer to a folder that is gone is not followed (nor created), and is reported', () => {
    const r = resolveDataRoot(deps({ files: { '/ud/data-root.json': pointerText('/Volumes/USB/Total') } }))
    expect(r.path).toBe('/home/a/Documents/total')
    expect(r.source).toBe('default')
    expect(r.problem).toEqual({ kind: 'pointer_missing_folder', pointerPath: '/Volumes/USB/Total' })
  })

  it('an unreadable or malformed pointer falls back to the default', () => {
    for (const text of ['not json', '[]', '{"path":3}', '{"path":"relative/dir"}', '{"path":""}', 'null']) {
      const r = resolveDataRoot(deps({ files: { '/ud/data-root.json': text }, dirs: ['relative/dir'] }))
      expect(r.source, text).toBe('default')
      expect(r.problem?.kind, text).toBe('pointer_unreadable')
    }
    const throwing = resolveDataRoot(deps({ readText: () => { throw new Error('EACCES') } }))
    expect(throwing).toMatchObject({ source: 'default', problem: { kind: 'pointer_unreadable' } })
  })

  it('a stat failure on the pointed folder counts as missing', () => {
    const r = resolveDataRoot(deps({ files: { '/ud/data-root.json': pointerText('/books') }, isDirectory: () => { throw new Error('EIO') } }))
    expect(r.problem?.kind).toBe('pointer_missing_folder')
  })
})

describe('parsePointer', () => {
  it('reads Windows paths with the win32 rule', () => {
    expect(parsePointer(pointerText('D:\\Total'), win32.isAbsolute)).toBe('D:\\Total')
    expect(parsePointer(pointerText('\\\\server\\share\\Total'), win32.isAbsolute)).toBe('\\\\server\\share\\Total')
    expect(parsePointer(pointerText('Total'), win32.isAbsolute)).toBeNull()
    expect(parsePointer(JSON.stringify({ path: 'D:\\To\0tal' }), win32.isAbsolute)).toBeNull()
  })
})

describe('isOneDrivePath', () => {
  it('finds OneDrive folders on Windows and macOS, personal and business', () => {
    expect(isOneDrivePath('C:\\Users\\asha\\OneDrive\\Documents\\total')).toBe(true)
    expect(isOneDrivePath('C:\\Users\\asha\\OneDrive - Asha Traders Pvt Ltd\\Documents\\total')).toBe(true)
    expect(isOneDrivePath('/Users/asha/Library/CloudStorage/OneDrive-Personal/total')).toBe(true)
    expect(isOneDrivePath('c:/users/asha/onedrive/documents/total')).toBe(true)
  })
  it('leaves other folders alone', () => {
    expect(isOneDrivePath('C:\\Users\\asha\\Documents\\total')).toBe(false)
    expect(isOneDrivePath('D:\\Total')).toBe(false)
    expect(isOneDrivePath('/Users/asha/Documents/OneDriveNotes/total')).toBe(false)
  })
})
