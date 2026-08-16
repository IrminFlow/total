import { describe, it, expect } from 'vitest'
import { DEFAULT_FEATURES, featuresSchema, mergeFeatures } from './features'

describe('featuresSchema / mergeFeatures', () => {
  it('DEFAULT_FEATURES has every module flag on and every guard flag off', () => {
    expect(DEFAULT_FEATURES).toEqual({
      inventory: true,
      billWise: true,
      costCentres: true,
      tds: true,
      multiCurrency: true,
      payroll: true,
      preventNegativeStock: false,
      batches: false,
      enforceCreditLimit: false
    })
  })

  it('round-trips a fully-specified object through the schema', () => {
    const input = {
      inventory: false, billWise: true, costCentres: false, tds: true, multiCurrency: false, payroll: true,
      preventNegativeStock: true, batches: true, enforceCreditLimit: false
    }
    expect(featuresSchema.parse(input)).toEqual(input)
  })

  it('mergeFeatures(undefined) returns the defaults', () => {
    expect(mergeFeatures(undefined)).toEqual(DEFAULT_FEATURES)
    expect(mergeFeatures(null)).toEqual(DEFAULT_FEATURES)
    expect(mergeFeatures({})).toEqual(DEFAULT_FEATURES)
  })

  it('mergeFeatures fills in missing keys (e.g. an older persisted shape) with defaults', () => {
    expect(mergeFeatures({ payroll: false })).toEqual({ ...DEFAULT_FEATURES, payroll: false })
  })

  it('mergeFeatures falls back to all-defaults on a garbage value rather than throwing', () => {
    expect(mergeFeatures({ inventory: 'nope' })).toEqual(DEFAULT_FEATURES)
    expect(mergeFeatures('not an object')).toEqual(DEFAULT_FEATURES)
  })

  it('featuresSchema rejects a non-boolean field', () => {
    expect(() => featuresSchema.parse({ ...DEFAULT_FEATURES, tds: 'yes' })).toThrow()
  })
})
