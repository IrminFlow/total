import { describe, expect, it } from 'vitest'
import { RCM_CATEGORIES, rcmAdvice, rcmCategoryForSac } from './reverseCharge'

describe('rcmCategoryForSac', () => {
  it('says nothing for a code it does not know, and for no code at all', () => {
    expect(rcmCategoryForSac('998314')).toBeNull() // IT design services — forward charge
    expect(rcmCategoryForSac('')).toBeNull()
    expect(rcmCategoryForSac(null)).toBeNull()
    expect(rcmCategoryForSac(undefined)).toBeNull()
  })

  it('recognises goods transport, the commonest case', () => {
    expect(rcmCategoryForSac('996511')?.category.id).toBe('gta')
    expect(rcmCategoryForSac('9965')?.category.id).toBe('gta')
  })

  it('recognises legal, security, cab hire and sponsorship', () => {
    expect(rcmCategoryForSac('998212')?.category.id).toBe('legal')
    expect(rcmCategoryForSac('998521')?.category.id).toBe('security')
    expect(rcmCategoryForSac('996601')?.category.id).toBe('rent-a-cab')
    expect(rcmCategoryForSac('998397')?.category.id).toBe('sponsorship')
  })

  it('prefers the longest matching prefix', () => {
    // 9971 is a broad insurance rule; 997136 is the specific agent code under it. A
    // shortest-first match would let the broad prefix shadow the precise one.
    const m = rcmCategoryForSac('997136')!
    expect(m.matchedPrefix).toBe('997136')
    expect(m.category.id).toBe('insurance-agent')
  })

  it('tolerates surrounding whitespace, which masters data is full of', () => {
    expect(rcmCategoryForSac('  998212  ')?.category.id).toBe('legal')
  })

  it('carries a reason a user can look up, on every category', () => {
    for (const c of RCM_CATEGORIES) {
      expect(c.reason.length).toBeGreaterThan(20)
      expect(c.sacPrefixes.length).toBeGreaterThan(0)
      // Prefixes must be digits: a stray letter would never match and would fail silently.
      for (const p of c.sacPrefixes) expect(p).toMatch(/^\d{4,6}$/)
    }
  })

  it('has no duplicate category ids', () => {
    const ids = RCM_CATEGORIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('rcmAdvice', () => {
  it('says nothing on an ordinary forward-charge purchase', () => {
    expect(rcmAdvice({ sac: '998314', partyFlagged: false, partyGstin: '27AAPFU0939F1ZV' })).toEqual({
      kind: 'none'
    })
  })

  it('suggests reverse charge on a notified supply from an unflagged party', () => {
    // The case the party flag cannot catch: an ordinary vendor billing one notified service.
    const a = rcmAdvice({ sac: '998212', partyFlagged: false, partyGstin: '27AAPFU0939F1ZV' })
    expect(a.kind).toBe('suggest')
    expect(a.kind === 'suggest' && a.match.category.id).toBe('legal')
  })

  it('confirms rather than nags when the party flag already agrees', () => {
    const a = rcmAdvice({ sac: '998212', partyFlagged: true, partyGstin: '27AAPFU0939F1ZV' })
    expect(a.kind).toBe('confirmed')
  })

  it('leaves an unregistered supplier to the separate section 9(4) rule', () => {
    // Folding 9(4) in here would attach a 9(3) reason to a 9(4) situation.
    expect(rcmAdvice({ sac: '998314', partyFlagged: false, partyGstin: null })).toEqual({ kind: 'none' })
  })
})
