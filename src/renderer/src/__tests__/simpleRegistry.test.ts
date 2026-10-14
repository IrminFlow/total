// WP 8.1: the screen registry's mode fields (plan 2026-10-13 §2.3). Every screen declares its
// modes; every simple-mode screen has a simple section; the simple entries carry linted i18n
// keys and a place in SIMPLE_ENTRY_ORDER; the simple sidebar stays ≤ 10 entries; screenView
// applies the "accountant company / accountant-only screen / per-screen override" rules.
import { existsSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n'
import { SIMPLE_SECTION_IDS } from '@shared/simple/uiMode'
import { ACCOUNTANT_NAV, SCREENS, SIMPLE_ENTRIES, SIMPLE_ENTRY_ORDER, SIMPLE_SECTIONS, screenView, simpleEntriesOf, simpleSectionOf } from '../lib/screens'

// Screens that exist only in the simple shell (no 0.10 counterpart).
const SIMPLE_ONLY: string[] = ['simple-section', 'simple-looks', 'simple-features', 'simple-openings', 'simple-sell', 'simple-sales', 'simple-quick-bill', 'simple-bank']

describe('screen registry modes (WP 8.1)', () => {
  it('every screen declares its modes; every 0.10 screen is an accountant screen', () => {
    for (const s of SCREENS) {
      expect(s.modes.length, s.name).toBeGreaterThan(0)
      if (!SIMPLE_ONLY.includes(s.name)) expect(s.modes, s.name).toContain('accountant')
    }
  })

  it('each simple-mode screen has a simple section (the section page itself excepted)', () => {
    for (const s of SCREENS.filter((d) => d.modes.includes('simple') && d.name !== 'simple-section')) {
      expect(s.simpleSection, s.name).toBeDefined()
      expect(SIMPLE_SECTION_IDS).toContain(s.simpleSection)
    }
  })

  it('every simple-mode screen is drawn by a component under src/renderer/src/simple/ (so the i18n lints cover it)', () => {
    const simple = SCREENS.filter((d) => d.modes.includes('simple'))
    expect(simple.map((d) => d.name).sort()).toEqual(['gateway', 'simple-bank', 'simple-features', 'simple-looks', 'simple-openings', 'simple-quick-bill', 'simple-sales', 'simple-section', 'simple-sell'])
    for (const d of simple) {
      // A component under simple/ — WP 9.2's flows live in a folder per section (simple/sell/…).
      expect(d.simpleView, d.name).toMatch(/^([a-z]+\/)?[A-Z]\w+$/)
      expect(existsSync(resolve(__dirname, '../simple', `${d.simpleView}.tsx`)), d.name).toBe(true)
    }
  })

  it('Registers entries ask for their tab; Sell is the simple flows (WP 9.2)', () => {
    const tab = (id: string): unknown => SIMPLE_ENTRIES.find((e) => e.id === id)?.screen
    expect(tab('sales-list')).toEqual({ name: 'simple-sales' })
    expect(tab('make-bill')).toEqual({ name: 'simple-sell' })
    expect(tab('quick-bill')).toEqual({ name: 'simple-quick-bill' })
    expect(simpleEntriesOf('sell').map((e) => e.id).slice(0, 3)).toEqual(['make-bill', 'quick-bill', 'sales-list'])
    expect(tab('purchase-list')).toEqual({ name: 'registers', tab: 'purchase' })
    expect(tab('by-month')).toEqual({ name: 'registers', tab: 'sales' })
  })

  it('the simple Settings list: business details, day one … how Total looks, then Advanced (the full Settings)', () => {
    expect(simpleEntriesOf('settings').map((e) => e.id)).toEqual(['business', 'openings', 'bills-printing', 'backups', 'people-roles', 'features', 'looks', 'advanced'])
    expect(simpleEntriesOf('settings').find((e) => e.id === 'looks')?.screen).toEqual({ name: 'simple-looks' })
    expect(simpleEntriesOf('settings').find((e) => e.id === 'advanced')?.screen).toEqual({ name: 'settings' })
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
    // WP 9.6: Money → Bank is the simple Bank screen (the full Banking stays the accountant view).
    expect(simpleEntriesOf('money').find((e) => e.id === 'bank')?.screen).toEqual({ name: 'simple-bank' })
    expect(simpleEntriesOf('settings')[0]).toMatchObject({ id: 'business', screen: { name: 'company-info' } })
    expect(simpleEntriesOf('reports').filter((e) => e.group === 'forYourCa').map((e) => e.id)).toEqual(['trial-balance', 'balance-sheet', 'cash-flow', 'ca-export'])
  })

  it('screenView: accountant company → accountant; accountant-only screen → accountant; override → accountant', () => {
    expect(screenView('accountant', 'gateway', false)).toBe('accountant')
    expect(screenView('simple', 'gateway', false)).toBe('simple')
    expect(screenView('simple', 'gateway', true)).toBe('accountant')
    expect(screenView('simple', 'daybook', false)).toBe('accountant')
    expect(screenView('simple', 'trial-balance', false)).toBe('accountant')
    expect(screenView('simple', 'simple-section', false)).toBe('simple')
    expect(simpleSectionOf({ name: 'simple-section', section: 'buy' })).toBe('buy')
    expect(simpleSectionOf({ name: 'daybook' })).toBe('money')
  })
})
