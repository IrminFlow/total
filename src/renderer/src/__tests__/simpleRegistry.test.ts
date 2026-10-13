// WP 8.1: the screen registry's mode fields (plan 2026-10-13 §2.3). Every screen declares its
// modes; every simple-mode screen has a simple section; the simple entries carry linted i18n
// keys and a place in SIMPLE_ENTRY_ORDER; the simple sidebar stays ≤ 10 entries; screenView
// applies the "accountant company / accountant-only screen / per-screen override" rules.
import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n'
import { SIMPLE_SECTION_IDS } from '@shared/simple/uiMode'
import { ACCOUNTANT_NAV, SCREENS, SIMPLE_ENTRIES, SIMPLE_ENTRY_ORDER, SIMPLE_SECTIONS, screenView, simpleEntriesOf, simpleSectionOf } from '../lib/screens'

describe('screen registry modes (WP 8.1)', () => {
  it('every screen declares its modes; every 0.10 screen is an accountant screen', () => {
    for (const s of SCREENS) {
      expect(s.modes.length, s.name).toBeGreaterThan(0)
      if (s.name !== 'simple-section') expect(s.modes, s.name).toContain('accountant')
    }
  })

  it('each simple-mode screen has a simple section (the section page itself excepted)', () => {
    for (const s of SCREENS.filter((d) => d.modes.includes('simple') && d.name !== 'simple-section')) {
      expect(s.simpleSection, s.name).toBeDefined()
      expect(SIMPLE_SECTION_IDS).toContain(s.simpleSection)
    }
  })

  it('the accountant sidebar lists only accountant screens, and every one of them', () => {
    const listed = ACCOUNTANT_NAV.flatMap((sec) => sec.items.map((i) => i.screen.name))
    const expected = SCREENS.filter((s) => s.navSection !== null && s.screen !== null).map((s) => s.name)
    expect(listed).toEqual(expected)
  })

  it('simple entries: linted, existing keys; one place each in the order; real targets', () => {
    const ids = SIMPLE_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...SIMPLE_ENTRY_ORDER].sort()).toEqual([...ids].sort())
    for (const e of SIMPLE_ENTRIES) {
      expect(e.label, e.id).toMatch(/^(simple|common)\./)
      expect(e.label in en, e.label).toBe(true)
      expect(SIMPLE_SECTION_IDS).toContain(e.section)
      expect(SCREENS.some((s) => s.name === e.screen.name), e.id).toBe(true)
    }
    for (const s of SIMPLE_SECTIONS) expect(s.label in en, s.label).toBe(true)
  })

  it('the simple sidebar has at most ten entries; every section but Home lists something', () => {
    expect(SIMPLE_SECTIONS.length).toBeLessThanOrEqual(10)
    for (const id of SIMPLE_SECTION_IDS.filter((id) => id !== 'home')) expect(simpleEntriesOf(id).length, id).toBeGreaterThan(0)
  })

  it('plan §2.3 placements: People → customers and suppliers, Money → all entries, Settings → business details', () => {
    expect(simpleEntriesOf('people')[0]).toMatchObject({ id: 'customers-suppliers', screen: { name: 'masters', tab: 'ledgers', parties: true } })
    expect(simpleEntriesOf('money').find((e) => e.id === 'all-entries')?.screen).toEqual({ name: 'daybook' })
    expect(simpleEntriesOf('settings')[0]).toMatchObject({ id: 'business', screen: { name: 'company-info' } })
    expect(simpleEntriesOf('reports').filter((e) => e.group === 'forYourCa').map((e) => e.id)).toEqual(['trial-balance', 'balance-sheet', 'cash-flow', 'ca-export'])
  })

  it('screenView: accountant company → accountant; accountant-only screen → accountant; override → accountant', () => {
    expect(screenView('accountant', 'daybook', false)).toBe('accountant')
    expect(screenView('simple', 'daybook', false)).toBe('simple')
    expect(screenView('simple', 'daybook', true)).toBe('accountant')
    expect(screenView('simple', 'trial-balance', false)).toBe('accountant')
    expect(screenView('simple', 'simple-section', false)).toBe('simple')
    expect(simpleSectionOf({ name: 'simple-section', section: 'buy' })).toBe('buy')
    expect(simpleSectionOf({ name: 'daybook' })).toBe('money')
  })
})
