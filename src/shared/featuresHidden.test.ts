import { describe, expect, it } from 'vitest'
import { DEFAULT_FEATURES, HIDEABLE_FEATURES, flagCardShown, screenFeatures, splitFeaturesView } from './features'

describe('screenFeatures (feature cleanup)', () => {
  it('nothing hidden when `unused` is absent or empty: the stored flags as before, every hideable feature on', () => {
    for (const v of [{ ...DEFAULT_FEATURES }, { ...DEFAULT_FEATURES, unused: [] }]) {
      const f = screenFeatures(v)
      expect(f).toMatchObject({ ...DEFAULT_FEATURES, manufacturing: true, forex: true, fixedAssets: true, cheques: true, interest: true, payrollStatutory: true })
    }
  })

  it('an unused feature turns its flags off; the stored flags are untouched', () => {
    const view = { ...DEFAULT_FEATURES, orders: true, unused: [...HIDEABLE_FEATURES] }
    const f = screenFeatures(view)
    expect(f).toMatchObject({ costCentres: false, multiCurrency: false, orders: false, forex: false, fixedAssets: false, cheques: false, interest: false, payrollStatutory: false })
    expect(f).toMatchObject({ inventory: true, tds: true, payroll: true, billWise: true })
    expect(splitFeaturesView(view).stored).toEqual({ ...DEFAULT_FEATURES, orders: true })
  })

  it('a hidden feature’s Settings → Features card goes with it', () => {
    const unused = splitFeaturesView({ ...DEFAULT_FEATURES, unused: ['costCentres', 'forex', 'tradeCycle'] }).unused
    expect(['costCentres', 'multiCurrency', 'orders'].map((k) => flagCardShown(k as never, unused))).toEqual([false, false, false])
    expect(['inventory', 'tds', 'payroll', 'billWise'].map((k) => flagCardShown(k as never, unused))).toEqual([true, true, true, true])
    expect(flagCardShown('costCentres', new Set())).toBe(true)
  })
})
