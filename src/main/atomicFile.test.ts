import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { atomicWriteFile } from './atomicFile'

describe('atomicWriteFile', () => {
  it('creates and durably replaces a file without leaving temporary siblings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'total-atomic-'))
    const file = join(dir, 'settings.json')
    atomicWriteFile(file, '{"version":1}')
    atomicWriteFile(file, '{"version":2}')

    expect(readFileSync(file, 'utf8')).toBe('{"version":2}')
    expect(readdirSync(dir)).toEqual(['settings.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
