import { describe, expect, it } from 'vitest'
import { hasMacShortcut, pcShortcutLabels } from './shortcutLabels'
import { en } from './i18n/catalogues/en'

describe('pcShortcutLabels (WP 7.3)', () => {
  it('writes the Mac shortcuts the Windows way', () => {
    expect(pcShortcutLabels('Search ⌘K')).toBe('Search Ctrl+K')
    expect(pcShortcutLabels('Save ⌘↵')).toBe('Save Ctrl+Enter')
    expect(pcShortcutLabels('⌘⇧F results')).toBe('Ctrl+Shift+F results')
    expect(pcShortcutLabels('⇧⌘F')).toBe('Ctrl+Shift+F')
    expect(pcShortcutLabels('“Against invoice…” (⌥A).')).toBe('“Against invoice…” (Alt+A).')
    expect(pcShortcutLabels('Help (? or ⌘/)')).toBe('Help (? or Ctrl+/)')
    expect(pcShortcutLabels('⌘↵ save · ⌘N new · Esc leave')).toBe('Ctrl+Enter save · Ctrl+N new · Esc leave')
    expect(pcShortcutLabels("⌘'")).toBe("Ctrl+'")
  })
  it('leaves text without Mac symbols alone (↵ on its own is the Enter key everywhere)', () => {
    expect(pcShortcutLabels('↵ selects')).toBe('↵ selects')
    expect(pcShortcutLabels('Nothing here')).toBe('Nothing here')
    expect(hasMacShortcut('Ctrl+K')).toBe(false)
  })
  it('every catalogue string with a Mac shortcut gets a Ctrl / Alt label and keeps its other words', () => {
    for (const [key, value] of Object.entries(en)) {
      if (!hasMacShortcut(value)) continue
      const pc = pcShortcutLabels(value)
      expect(hasMacShortcut(pc), key).toBe(false)
      expect(pc, key).toMatch(/Ctrl\+|Alt\+|Shift\+/)
    }
  })
})
