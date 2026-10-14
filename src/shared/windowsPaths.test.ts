// WP 7.3 — the CLI finds the same Documents folder as the app on Windows.
import { describe, expect, it } from 'vitest'
import { chooseWindowsDocumentsDir, expandWindowsEnv, regQueryValue, windowsDocumentsDir } from './windowsPaths'

const REG = (value: string, type = 'REG_EXPAND_SZ'): string =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Personal    ${type}    ${value}\r\n\r\n`
const env = { USERPROFILE: 'C:\\Users\\Asha', OneDrive: 'C:\\Users\\Asha\\OneDrive' }

describe('windowsDocumentsDir', () => {
  it('reads the default, a OneDrive-moved and a redirected Documents folder', () => {
    expect(windowsDocumentsDir(REG('%USERPROFILE%\\Documents'), env, 'C:\\Users\\Asha')).toBe('C:\\Users\\Asha\\Documents')
    expect(windowsDocumentsDir(REG('%USERPROFILE%\\OneDrive\\Documents'), env, 'C:\\Users\\Asha')).toBe('C:\\Users\\Asha\\OneDrive\\Documents')
    expect(windowsDocumentsDir(REG('D:\\Data\\Asha Docs\\', 'REG_SZ'), env, 'C:\\Users\\Asha')).toBe('D:\\Data\\Asha Docs')
    expect(windowsDocumentsDir(REG('\\\\fileserver\\home$\\asha\\Documents', 'REG_SZ'), env, 'C:\\Users\\Asha')).toBe('\\\\fileserver\\home$\\asha\\Documents')
  })
  it('falls back to <home>\\Documents when the registry gives nothing usable', () => {
    expect(windowsDocumentsDir(null, env, 'C:\\Users\\Asha')).toBe('C:\\Users\\Asha\\Documents')
    expect(windowsDocumentsDir('ERROR: The system was unable to find the specified registry key or value.', env, 'C:\\Users\\Asha\\')).toBe('C:\\Users\\Asha\\Documents')
    expect(windowsDocumentsDir(REG('%NOPE%\\Documents'), env, 'C:\\Users\\Asha')).toBe('C:\\Users\\Asha\\Documents')
  })
  it('regQueryValue / expandWindowsEnv', () => {
    expect(regQueryValue(REG('x'), 'personal')).toBe('x')
    expect(regQueryValue(REG('x'), 'Desktop')).toBeNull()
    expect(expandWindowsEnv('%userprofile%\\a\\%ONEDRIVE%', env)).toBe('C:\\Users\\Asha\\a\\C:\\Users\\Asha\\OneDrive')
  })
})

describe('chooseWindowsDocumentsDir (WP 7.3 review)', () => {
  const home = 'C:\\Users\\José'
  const e = { USERPROFILE: home }
  it('trusts a readable registry path that exists, without asking PowerShell', () => {
    let asked = 0
    const got = chooseWindowsDocumentsDir(REG('%USERPROFILE%\\OneDrive\\Documents'), () => (asked++, null), e, home, () => true)
    expect(got).toBe('C:\\Users\\José\\OneDrive\\Documents')
    expect(asked).toBe(0)
  })
  it('a code-page-garbled registry path (U+FFFD) asks the known folder instead', () => {
    const garbled = REG('C:\\Users\\Jos\uFFFD\\OneDrive\\Documents', 'REG_SZ')
    const known = 'C:\\Users\\José\\OneDrive\\Documents\r\n'
    expect(chooseWindowsDocumentsDir(garbled, () => known, e, home, () => true)).toBe('C:\\Users\\José\\OneDrive\\Documents')
    // PowerShell unavailable: <home>\Documents, never the garbled path.
    expect(chooseWindowsDocumentsDir(garbled, () => null, e, home, () => true)).toBe('C:\\Users\\José\\Documents')
  })
  it('a registry path that does not exist asks the known folder; nothing better = the registry answer', () => {
    const reg = REG('D:\\Gone\\Docs', 'REG_SZ')
    expect(chooseWindowsDocumentsDir(reg, () => 'E:\\Docs', e, home, (p) => p === 'E:\\Docs')).toBe('E:\\Docs')
    expect(chooseWindowsDocumentsDir(reg, () => 'not a path', e, home, () => false)).toBe('D:\\Gone\\Docs')
  })
})
