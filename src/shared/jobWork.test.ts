import { describe, expect, it } from 'vitest'
import { isJobWorkGodown, jobWorkGodownName } from './jobWork'

describe('jobWorkGodownName', () => {
  it('names the godown for the job worker', () => {
    expect(jobWorkGodownName('Sharma Polishing')).toBe('Job work — Sharma Polishing')
  })

  it('keeps every job worker together at the top of an alphabetical godown list', () => {
    const names = ['Zed Metals', 'Alpha Coating'].map(jobWorkGodownName).sort()
    expect(names).toEqual(['Job work — Alpha Coating', 'Job work — Zed Metals'])
  })

  it('fits a long party name into the column instead of failing the insert', () => {
    const long = jobWorkGodownName('A'.repeat(200))
    expect(long.length).toBe(60)
    expect(isJobWorkGodown(long)).toBe(true)
  })

  it('recognises its own names and nothing else', () => {
    expect(isJobWorkGodown(jobWorkGodownName('Sharma Polishing'))).toBe(true)
    expect(isJobWorkGodown('Main Godown')).toBe(false)
    // Near miss: the separator is an em dash, not a hyphen, and a hyphenated godown a user typed
    // by hand is a REAL godown that must not be mistaken for a job worker's.
    expect(isJobWorkGodown('Job work - Sharma Polishing')).toBe(false)
  })
})
