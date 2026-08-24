import { describe, it, expect } from 'vitest'
import { duplicateWarning, findDuplicateCompanies } from './companyIdentity'

const existing = [
  { slug: 'acme', name: 'Acme Traders', gstin: '27AAAPA1234A1Z5' },
  { slug: 'sharma', name: 'Sharma & Co', gstin: null }
]

describe('is this company already here', () => {
  it('says nothing about a company nobody has seen', () => {
    expect(findDuplicateCompanies(existing, { name: 'New Venture', gstin: '29BBBPB1111B1Z1' })).toEqual([])
    expect(duplicateWarning([])).toBeNull()
  })

  it('treats a matching GSTIN as decisive, whatever the name says', () => {
    const matches = findDuplicateCompanies(existing, { name: 'Acme Traders (2024)', gstin: '27aaapa1234a1z5' })
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ slug: 'acme', reason: 'gstin' })
    expect(duplicateWarning(matches)).toMatch(/SECOND, separate set of books/)
  })

  it('treats a matching name as a suspicion, because two businesses can share one', () => {
    const matches = findDuplicateCompanies(existing, { name: ' sharma  &  co ', gstin: null })
    expect(matches[0]).toMatchObject({ slug: 'sharma', reason: 'name' })
    expect(duplicateWarning(matches)).toMatch(/already on this machine/)
  })

  it('puts the GSTIN match first when both kinds hit', () => {
    const both = findDuplicateCompanies(
      [...existing, { slug: 'other', name: 'Zed Ltd', gstin: '27AAAPA1234A1Z5' }],
      { name: 'Sharma & Co', gstin: '27AAAPA1234A1Z5' }
    )
    expect(both.map((m) => m.reason)).toEqual(['gstin', 'gstin', 'name'])
  })
})
