import { describe, it, expect } from 'vitest'
import { isInside, moveVerdict } from './dataMove'

const current = '/Users/a/Dropbox/Documents/total'
const clean = { targetIsExistingDataRoot: false, targetHasContents: false }

describe('moving the data folder somewhere safe', () => {
  it('accepts a plain local folder', () => {
    expect(moveVerdict(current, '/Users/a/TotalBooks', clean)).toEqual({ ok: true, warning: null })
  })

  it('refuses a folder inside the one being moved, and one containing it', () => {
    expect(moveVerdict(current, `${current}/new`, clean).ok).toBe(false)
    expect(moveVerdict(current, '/Users/a/Dropbox/Documents', clean).ok).toBe(false)
  })

  it('refuses the very kind of folder the move exists to escape', () => {
    const verdict = moveVerdict(current, '/Users/a/OneDrive/books', clean)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.error).toMatch(/onedrive/i)
  })

  it('refuses to land on another Total data folder rather than merging two sets of books', () => {
    const verdict = moveVerdict(current, '/Users/a/Books', { ...clean, targetIsExistingDataRoot: true })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.error).toMatch(/merging/)
  })

  it('allows a folder that already has other things in it, and says so', () => {
    const verdict = moveVerdict(current, '/Users/a/Documents', { ...clean, targetHasContents: true })
    expect(verdict).toEqual({ ok: true, warning: expect.stringContaining('other files') })
  })

  it('treats a case-only difference as the same folder, because the filesystem usually does', () => {
    expect(isInside('/Users/A/Total/companies', '/users/a/total')).toBe(true)
    expect(moveVerdict(current, current.toUpperCase(), clean).ok).toBe(false)
  })
})
