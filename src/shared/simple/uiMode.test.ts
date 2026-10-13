import { describe, expect, it } from 'vitest'
import { applyUiPatch, normalizeUi, uiPatchSchema } from './uiMode'

describe('company mode model (WP 8.1)', () => {
  it('a missing ui key means accountant', () => {
    expect(normalizeUi(null)).toEqual({ mode: 'accountant' })
    expect(normalizeUi(undefined)).toEqual({ mode: 'accountant' })
  })
  it('malformed values fall back to accountant, keeping what validates', () => {
    expect(normalizeUi('simple')).toEqual({ mode: 'accountant' })
    expect(normalizeUi({ mode: 'expert' })).toEqual({ mode: 'accountant' })
    expect(normalizeUi({ mode: 'simple', language: 'fr' })).toEqual({ mode: 'simple' })
    expect(normalizeUi({ language: 'hi' })).toEqual({ mode: 'accountant', language: 'hi' })
  })
  it('keeps a full valid object', () => {
    const ui = { mode: 'simple', setup: { businessType: 'retail', gst: 'no', stock: true }, startedFresh: true, language: 'hinglish' }
    expect(normalizeUi(ui)).toEqual(ui)
  })
  it('patches merge and validate; unknown keys are refused', () => {
    expect(applyUiPatch({ mode: 'accountant', language: 'hi' }, { mode: 'simple' })).toEqual({ mode: 'simple', language: 'hi' })
    expect(uiPatchSchema.safeParse({ mode: 'simple', theme: 'dark' }).success).toBe(false)
    expect(uiPatchSchema.safeParse({ mode: 'bogus' }).success).toBe(false)
  })
})
