import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readUpdateSettings, writeUpdateSettings } from './appSettings'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'total-appsettings-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('app-level update settings', () => {
  it('defaults to automatic check ON when there is no file or it is unreadable', () => {
    expect(readUpdateSettings(root)).toEqual({ autoCheck: true, skippedVersion: null })
    writeFileSync(join(root, 'app-settings.json'), '{not json')
    expect(readUpdateSettings(root)).toEqual({ autoCheck: true, skippedVersion: null })
  })

  it('a corrupt file is reported (a missing one is not), never thrown, and a write replaces it', () => {
    const warns: string[] = []
    readUpdateSettings(root, (e) => warns.push(e))
    expect(warns).toEqual([])
    for (const bad of ['{not json', 'null', '[1]', '"x"']) {
      writeFileSync(join(root, 'app-settings.json'), bad)
      expect(readUpdateSettings(root, (e) => warns.push(e))).toEqual({ autoCheck: true, skippedVersion: null })
    }
    expect(warns.length).toBe(1) // only the unparsable one; the others parse and fall back silently
    writeFileSync(join(root, 'app-settings.json'), '{not json')
    expect(writeUpdateSettings(root, { autoCheck: false }, null, '0.12.0').autoCheck).toBe(false)
    expect(readUpdateSettings(root)).toEqual({ autoCheck: false, skippedVersion: null })
    expect(existsSync(join(root, 'app-settings.json.tmp'))).toBe(false)
  })

  it('persists a patch, keeps unrelated keys, and appends an audit line', () => {
    writeFileSync(join(root, 'app-settings.json'), JSON.stringify({ other: 1 }))
    writeUpdateSettings(root, { autoCheck: false }, 'Asha', '0.12.0')
    writeUpdateSettings(root, { skippedVersion: '0.13.0' }, null, '0.12.0')
    expect(readUpdateSettings(root)).toEqual({ autoCheck: false, skippedVersion: '0.13.0' })
    expect(JSON.parse(readFileSync(join(root, 'app-settings.json'), 'utf8')).other).toBe(1)
    const lines = readFileSync(join(root, 'app-settings-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ user: 'Asha', before: { autoCheck: true }, after: { autoCheck: false } })
  })

  it('an unchanged patch writes nothing', () => {
    writeUpdateSettings(root, { autoCheck: true }, null, '0.12.0')
    expect(existsSync(join(root, 'app-settings.json'))).toBe(false)
    expect(existsSync(join(root, 'app-settings-audit.jsonl'))).toBe(false)
  })
})
