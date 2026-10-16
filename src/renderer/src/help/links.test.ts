// Help links' screen parameters are checked per screen against the registry's known values
// (lib/screens.ts SCREEN_LINK_PARAMS): a known key + value is kept, anything else is dropped (and
// reported), and the link still opens its screen.
import { describe, expect, it } from 'vitest'
import { resolveHelpLink } from './links'
import { SCREEN_LINK_PARAMS, screenDef, screenLinkParams } from '../lib/screens'

describe('help-link parameters per screen', () => {
  it('keeps the values a screen knows and drops the rest', () => {
    expect(screenLinkParams('simple-stock', { filter: 'low' })).toEqual({ kept: { filter: 'low' }, dropped: [] })
    expect(screenLinkParams('simple-stock', { filter: 'late', tab: 'bills' })).toEqual({ kept: {}, dropped: ['filter=late', 'tab=bills'] })
    expect(screenLinkParams('simple-people', { tab: 'bills', filter: 'owesYou' })).toEqual({ kept: { tab: 'bills', filter: 'owesYou' }, dropped: [] })
    // A screen that takes no link parameters keeps none.
    expect(screenLinkParams('simple-sell', { tab: 'x' })).toEqual({ kept: {}, dropped: ['tab=x'] })
  })

  it('resolveHelpLink drops unknown keys / values but still opens the screen', () => {
    expect(resolveHelpLink('total://screen/simple-people?filter=late')).toEqual({ kind: 'screen', screen: { name: 'simple-people', filter: 'late' } })
    expect(resolveHelpLink('total://screen/simple-people?filter=bogus&tab=bills')).toEqual({ kind: 'screen', screen: { name: 'simple-people', tab: 'bills' }, dropped: ['filter=bogus'] })
    expect(resolveHelpLink('total://screen/settings?tab=nowhere')).toEqual({ kind: 'screen', screen: { name: 'settings' }, dropped: ['tab=nowhere'] })
    expect(resolveHelpLink('total://screen/simple-sell?id=3')).toEqual({ kind: 'screen', screen: { name: 'simple-sell' }, dropped: ['id=3'] })
    expect(resolveHelpLink('total://screen/simple-reports?report=owed&side=sideways')).toEqual({ kind: 'screen', screen: { name: 'simple-reports', report: 'owed' }, dropped: ['side=sideways'] })
    expect(resolveHelpLink('total://screen/simple-section?section=home')).toEqual({ kind: 'screen', screen: { name: 'gateway' } })
    // The section IS the screen: without a known one the link goes nowhere.
    expect(resolveHelpLink('total://screen/simple-section?section=x').kind).toBe('invalid')
  })

  it('every screen in the table exists in the registry', () => {
    for (const name of Object.keys(SCREEN_LINK_PARAMS)) expect(screenDef(name as never), name).toBeTruthy()
  })
})
