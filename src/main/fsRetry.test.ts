// WP 7.3 — the Windows rename retry (no real files: the rename and the sleep are injected).
import { describe, expect, it } from 'vitest'
import { renameReplacing } from './fsRetry'

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('renameReplacing', () => {
  it('on Windows retries a rename that a scanner briefly blocks, then succeeds', () => {
    let calls = 0
    const slept: number[] = []
    renameReplacing('a.tmp', 'a', {
      platform: 'win32',
      rename: () => {
        if (++calls < 4) throw errno(calls === 2 ? 'EBUSY' : 'EPERM')
      },
      sleep: (ms) => slept.push(ms)
    })
    expect(calls).toBe(4)
    expect(slept).toEqual([10, 20, 40])
  })
  it('gives up after the time budget with the original error', () => {
    let calls = 0
    expect(() =>
      renameReplacing('a.tmp', 'a', { platform: 'win32', totalMs: 100, sleep: () => {}, rename: () => { calls++; throw errno('EACCES') } })
    ).toThrow('EACCES')
    expect(calls).toBeGreaterThan(1)
  })
  it('never retries other errors, nor anything on macOS / Linux', () => {
    let calls = 0
    expect(() => renameReplacing('a', 'b', { platform: 'win32', sleep: () => {}, rename: () => { calls++; throw errno('ENOENT') } })).toThrow('ENOENT')
    expect(() => renameReplacing('a', 'b', { platform: 'darwin', sleep: () => {}, rename: () => { calls++; throw errno('EPERM') } })).toThrow('EPERM')
    expect(calls).toBe(2)
  })
})
