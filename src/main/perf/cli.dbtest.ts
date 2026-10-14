// WP 7.1 review — the perf commands refuse the user's real data folder however it is spelt.
import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { isInside, usePerfDataRoot } from './cli'

describe('usePerfDataRoot never touches ~/Documents/total', () => {
  const real = join(homedir(), 'Documents', 'total')
  it('refuses the folder, anything inside it and other spellings of it', () => {
    const caseBlind = process.platform === 'darwin' || process.platform === 'win32'
    for (const d of [real, join(real, 'perf'), `${real}/./x/..`, ...(caseBlind ? [join(homedir(), 'Documents', 'Total', 'perf')] : [])]) {
      expect(() => usePerfDataRoot(d), d).toThrow(/Refusing/)
    }
  })
  it('isInside: separators, case and siblings', () => {
    expect(isInside('/home/a/Documents/Total', '/home/a/Documents/total', 'linux')).toBe(false)
    expect(isInside('/Users/a/Documents/Total/p', '/Users/a/Documents/total', 'darwin')).toBe(true)
    expect(isInside('/Users/a/Documents/total-perf', '/Users/a/Documents/total', 'darwin')).toBe(false)
  })
})
