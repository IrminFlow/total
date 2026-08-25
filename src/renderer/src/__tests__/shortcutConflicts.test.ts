import { describe, expect, it } from 'vitest'
import { SCREENS } from '../lib/screens'
import { SCREEN_KEY_CLAIMS, shortcutConflicts, type ScreenKeyClaim } from '../lib/shortcutConflicts'
import { VOUCHER_TYPE_KEYS } from '../lib/voucherTypeKeys'

const screens = [
  { name: 'daybook', title: 'Day book', accel: 'D' },
  { name: 'cost-centres', title: 'Cost centres', accel: 'C' },
  { name: 'voucher-entry', title: 'Voucher entry', accel: 'V' }
] as unknown as typeof SCREENS

describe('shortcutConflicts', () => {
  it('names the screen, the action and what it shadows', () => {
    const claims: ScreenKeyClaim[] = [{ screen: 'voucher-entry', key: 'c', label: 'Contra' }]
    expect(shortcutConflicts(screens, claims)).toEqual([
      {
        key: 'C',
        screen: 'voucher-entry',
        screenTitle: 'Voucher entry',
        action: 'Contra',
        shadows: 'Cost centres'
      }
    ])
  })

  it('says nothing about a key no screen navigates to', () => {
    // J is a journal on voucher entry and nothing anywhere else. Not a conflict.
    expect(shortcutConflicts(screens, [{ screen: 'voucher-entry', key: 'j', label: 'Journal' }])).toEqual([])
  })

  it('does not report a screen shadowing its own accelerator', () => {
    expect(shortcutConflicts(screens, [{ screen: 'voucher-entry', key: 'v', label: 'Something' }])).toEqual([])
  })

  it('is case-insensitive on the claim and reports uppercase', () => {
    expect(shortcutConflicts(screens, [{ screen: 'voucher-entry', key: 'C', label: 'Contra' }])[0]!.key).toBe('C')
  })

  it('reports two screens claiming the same letter as two separate facts', () => {
    const claims: ScreenKeyClaim[] = [
      { screen: 'voucher-entry', key: 'd', label: 'Something' },
      { screen: 'cost-centres', key: 'd', label: 'Other thing' }
    ]
    const found = shortcutConflicts(screens, claims)
    expect(found).toHaveLength(2)
    expect(found.map((c) => c.screenTitle)).toEqual(['Cost centres', 'Voucher entry'])
  })

  it('is stable — same input, same order', () => {
    const claims: ScreenKeyClaim[] = [
      { screen: 'voucher-entry', key: 'd', label: 'A' },
      { screen: 'voucher-entry', key: 'c', label: 'B' }
    ]
    expect(shortcutConflicts(screens, claims).map((c) => c.key)).toEqual(['C', 'D'])
  })

  it('handles a registry with no accelerators and an empty claim list', () => {
    expect(shortcutConflicts([], SCREEN_KEY_CLAIMS)).toEqual([])
    expect(shortcutConflicts(SCREENS, [])).toEqual([])
  })
})

describe('the real registry', () => {
  it('derives its claims from the array the screen actually binds', () => {
    // The guard that keeps the report honest: no second hand-maintained list of letters.
    expect(SCREEN_KEY_CLAIMS.map((c) => c.key)).toEqual(
      VOUCHER_TYPE_KEYS.filter((t) => t.key).map((t) => t.key)
    )
  })

  it('reports the real collisions, each against a screen that exists', () => {
    const found = shortcutConflicts(SCREENS, SCREEN_KEY_CLAIMS)
    // There genuinely are some — that is the whole reason this panel exists.
    expect(found.length).toBeGreaterThan(0)
    const titles = new Set(SCREENS.map((s) => s.title))
    for (const conflict of found) {
      expect(titles.has(conflict.shadows)).toBe(true)
      expect(conflict.key).toMatch(/^[A-Z0-9]$/)
      expect(conflict.action).not.toBe('')
    }
  })

  it('never reports a key that is not claimed by a screen', () => {
    const claimed = new Set(SCREEN_KEY_CLAIMS.map((c) => c.key.toUpperCase()))
    for (const conflict of shortcutConflicts(SCREENS, SCREEN_KEY_CLAIMS)) {
      expect(claimed.has(conflict.key)).toBe(true)
    }
  })
})
