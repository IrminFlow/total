import { describe, expect, it } from 'vitest'
import { findShortcutConflicts, SCREENS, SCREEN_SHORTCUTS } from '../lib/screens'

describe('shortcut conflict detector', () => {
  it('keeps the shipped Gateway and navigation scopes collision-free', () => {
    expect(findShortcutConflicts()).toEqual([])
  })

  it('reports a duplicate in its exact scope before it can be installed', () => {
    const shortcuts = { ...SCREEN_SHORTCUTS, daybook: { key: 'v' } }
    expect(findShortcutConflicts(SCREENS, shortcuts)).toContainEqual({
      scope: 'navigation', binding: 'alt+v', screens: ['voucher-entry', 'daybook']
    })
  })
})
