import { describe, expect, it } from 'vitest'
import { GST_STATE_LIST } from './states'
import { GST_STATE_NAMES_HI, stateListIn, stateNameIn } from './stateNames'
import { bannedWordsIn } from '../simple/bannedWords'

describe('Hindi state names (wizard)', () => {
  it('every GST state code has a Devanagari Hindi name, and no extra codes', () => {
    for (const [code] of GST_STATE_LIST) {
      const hi = GST_STATE_NAMES_HI[code]
      expect(hi, code).toBeTruthy()
      expect(hi, code).toMatch(/[ऀ-ॿ]/)
      expect(hi, code).not.toMatch(/[A-Za-z]/)
      expect(bannedWordsIn(hi!), code).toEqual([])
    }
    expect(Object.keys(GST_STATE_NAMES_HI).sort()).toEqual(GST_STATE_LIST.map(([c]) => c).sort())
  })

  it('keeps the code order; Hinglish and English keep the English names', () => {
    const codes = GST_STATE_LIST.map(([c]) => c)
    for (const lang of ['en', 'hi', 'hinglish'] as const) expect(stateListIn(lang).map(([c]) => c)).toEqual(codes)
    expect(stateListIn('en')).toEqual(GST_STATE_LIST)
    expect(stateListIn('hinglish')).toEqual(GST_STATE_LIST)
    expect(stateListIn(undefined)).toEqual(GST_STATE_LIST)
    expect(stateNameIn('27', 'hi')).toBe('महाराष्ट्र')
    expect(stateNameIn('27', 'hinglish')).toBe('Maharashtra')
    expect(stateNameIn('99', 'hi')).toBe('99')
  })
})
