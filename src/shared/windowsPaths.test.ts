// WP 7.3 — the CLI finds the same Documents folder as the app on Windows.
import { describe, expect, it } from 'vitest'
import { expandWindowsEnv, regQueryValue, windowsDocumentsDir } from './windowsPaths'

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
