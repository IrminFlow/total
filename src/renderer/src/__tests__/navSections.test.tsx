// Collapsible sidebar sections (lib/navSections.ts): defaults, the active-section auto-open that
// never overwrites stored prefs, toggling, and per-company localStorage persistence.
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { DEFAULT_OPEN, isSectionOpen, sectionOfScreen, toggleSection, useNavSections } from '../lib/navSections'
import { NAV_SECTIONS, SCREENS } from '../lib/screens'
import { useSession, type Screen } from '../state/stores'

describe('navSections pure helpers', () => {
  it('defaults: top and Books open, everything else collapsed', () => {
    const open = NAV_SECTIONS.filter((s) => isSectionOpen(s.id, {}, null)).map((s) => s.id)
    expect(open).toEqual(['top', 'trade', 'books'])
  })

  it('has a default for every registry section', () => {
    for (const s of NAV_SECTIONS) expect(typeof DEFAULT_OPEN[s.id]).toBe('boolean')
  })

  it('stored prefs override defaults', () => {
    expect(isSectionOpen('gst', { gst: true }, null)).toBe(true)
    expect(isSectionOpen('books', { books: false }, null)).toBe(false)
  })

  it('the top block is always open, even if a pref says otherwise', () => {
    expect(isSectionOpen('top', { top: false }, null)).toBe(true)
    expect(toggleSection('top', {}, null)).toEqual({ prefs: {}, autoOpen: null })
  })

  it('the auto-opened section shows expanded without touching stored prefs', () => {
    const prefs = { books: false }
    expect(isSectionOpen('gst', prefs, 'gst')).toBe(true)
    expect(isSectionOpen('books', prefs, 'gst')).toBe(false)
    expect(prefs).toEqual({ books: false })
  })

  it('toggling a section stores the flipped visible state', () => {
    expect(toggleSection('analysis', {}, null)).toEqual({ prefs: { analysis: true }, autoOpen: null })
    expect(toggleSection('books', {}, 'gst')).toEqual({ prefs: { books: false }, autoOpen: 'gst' })
  })

  it('toggling the auto-opened section collapses it and clears the override', () => {
    const next = toggleSection('gst', {}, 'gst')
    expect(next).toEqual({ prefs: { gst: false }, autoOpen: null })
    expect(isSectionOpen('gst', next.prefs, next.autoOpen)).toBe(false)
  })

  it('maps screens to their sidebar section', () => {
    expect(sectionOfScreen('gstr1')).toBe('gst')
    expect(sectionOfScreen('gateway')).toBe('top')
    expect(sectionOfScreen('ledger-statement')).toBeNull()
  })

  it('Import from Tally is the last item of System', () => {
    const system = SCREENS.filter((s) => s.navSection === 'system').map((s) => s.name)
    expect(system[system.length - 1]).toBe('import-tally')
    expect(system).toContain('settings')
  })
})

describe('useNavSections', () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useSession.setState({ slug: 'alpha-co' })
    })
  })

  it('auto-opens the active screen\'s section and follows navigation', () => {
    const { result, rerender } = renderHook(({ screen }) => useNavSections(screen), {
      initialProps: { screen: 'gstr1' as Screen['name'] }
    })
    expect(result.current.isOpen('gst')).toBe(true)
    rerender({ screen: 'banking' })
    expect(result.current.isOpen('banking')).toBe(true)
    expect(result.current.isOpen('gst')).toBe(false)
    expect(localStorage.getItem('total-navsections-alpha-co')).toBeNull()
  })

  it('persists toggles per company', () => {
    const first = renderHook(() => useNavSections('gateway'))
    act(() => first.result.current.toggle('analysis'))
    expect(first.result.current.isOpen('analysis')).toBe(true)
    expect(JSON.parse(localStorage.getItem('total-navsections-alpha-co') ?? '{}')).toEqual({ analysis: true })
    first.unmount()

    const again = renderHook(() => useNavSections('gateway'))
    expect(again.result.current.isOpen('analysis')).toBe(true)
    again.unmount()

    act(() => {
      useSession.setState({ slug: 'beta-co' })
    })
    const other = renderHook(() => useNavSections('gateway'))
    expect(other.result.current.isOpen('analysis')).toBe(false)
  })

  it('setOpen expands/collapses idempotently', () => {
    const { result } = renderHook(() => useNavSections('gateway'))
    act(() => result.current.setOpen('payroll', true))
    act(() => result.current.setOpen('payroll', true))
    expect(result.current.isOpen('payroll')).toBe(true)
    act(() => result.current.setOpen('payroll', false))
    expect(result.current.isOpen('payroll')).toBe(false)
  })
})
