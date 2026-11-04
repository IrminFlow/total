import { describe, expect, it } from 'vitest'
import { DEFAULT_FEATURES, HIDEABLE_FEATURES, flagCardShown, flagTurnedOff, mergeFeatures, moreFeatures, screenFeatures, splitFeaturesView, turnOffFeature, turnOnFeature } from './features'

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

describe('More features — the door to a hidden feature (review of #194)', () => {
  const none = (): ReturnType<typeof splitFeaturesView> => splitFeaturesView({ ...DEFAULT_FEATURES, unused: [...HIDEABLE_FEATURES] })

  it('lists every hidden feature except forex (removed separately), with its plain name', () => {
    expect(moreFeatures(none().noData, DEFAULT_FEATURES).map((m) => m.feature)).toEqual(['costCentres', 'cheques', 'interest', 'fixedAssets', 'tradeCycle', 'payrollStatutory'])
    expect(moreFeatures(new Set(), DEFAULT_FEATURES)).toEqual([])
  })

  it('turning one on shows its screens (no data needed); its flag and what it needs go on with it', () => {
    const stored = { ...DEFAULT_FEATURES, costCentres: false, orders: false, inventory: false, payroll: false }
    let next = turnOnFeature(stored, 'tradeCycle')
    expect(next).toMatchObject({ orders: true, inventory: true, turnedOn: ['tradeCycle'] })
    next = turnOnFeature(turnOnFeature(turnOnFeature(next, 'costCentres'), 'payrollStatutory'), 'fixedAssets')
    expect(next).toMatchObject({ costCentres: true, payroll: true, turnedOn: ['tradeCycle', 'costCentres', 'payrollStatutory', 'fixedAssets'] })
    const f = screenFeatures({ ...next, unused: [...HIDEABLE_FEATURES] })
    expect(f).toMatchObject({ orders: true, costCentres: true, payrollStatutory: true, fixedAssets: true, cheques: false, interest: false, forex: false })
    // a turned-on flag feature's card is back in the main list; More lists it no more
    const { unused, noData } = splitFeaturesView({ ...next, unused: [...HIDEABLE_FEATURES] })
    expect(flagCardShown('costCentres', unused)).toBe(true)
    expect(moreFeatures(noData, next).map((m) => m.feature)).toEqual(['cheques', 'interest', 'fixedAssets', 'payrollStatutory'])
    expect(moreFeatures(noData, next).find((m) => m.feature === 'fixedAssets')?.on).toBe(true)
  })

  it('turning it off hides it again while it has no data; data keeps it shown whatever the switch', () => {
    const on = turnOnFeature(DEFAULT_FEATURES, 'interest')
    const off = turnOffFeature(on, 'interest')
    expect(off.turnedOn).toEqual([])
    expect(screenFeatures({ ...off, unused: ['interest'] }).interest).toBe(false)
    expect(screenFeatures({ ...off, unused: [] }).interest).toBe(true)
    // a flag feature: turning its flag off in the main list drops it from turnedOn too
    const cc = turnOnFeature(DEFAULT_FEATURES, 'costCentres')
    expect(flagTurnedOff(cc, 'costCentres')).toMatchObject({ costCentres: false, turnedOn: [] })
    expect(flagTurnedOff(cc, 'tds')).toEqual({ ...cc, tds: false })
  })

  it('the stored list survives the schema and older builds ignore nothing else', () => {
    expect(mergeFeatures({ turnedOn: ['cheques'] })).toEqual({ ...DEFAULT_FEATURES, turnedOn: ['cheques'] })
    expect(mergeFeatures({ turnedOn: ['nope'] })).toEqual(DEFAULT_FEATURES)
    expect(mergeFeatures({})).toEqual(DEFAULT_FEATURES)
  })
})
