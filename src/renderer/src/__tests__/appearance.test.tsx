// Appearance (Settings → Appearance): theme light/dark/system and density persisted like the old
// theme store and applied to <html>; DataTable follows the app density unless its view picks one;
// v1 stored table views migrate (the old default 'comfortable' now follows the app).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DataTable, defineColumns, tableViewStorageKey } from '../components/table'
import { AppearanceSection } from '../screens/settings/AppearanceSection'
import { initialDensity, initialTheme, resolveTheme, useAppearance, useSession, useTheme } from '../state/stores'

interface Row {
  id: number
  name: string
}
const COLUMNS = defineColumns<Row>([{ id: 'name', header: 'Name', kind: 'text', value: (r) => r.name }])
const ROWS: Row[] = [{ id: 1, name: 'A' }]

beforeEach(() => {
  localStorage.clear()
  act(() => {
    useSession.setState({ slug: 'alpha-co' })
    useAppearance.getState().setDensity('comfortable')
    useTheme.getState().setPref('light')
  })
})
afterEach(() => cleanup())

describe('appearance store', () => {
  it('density is applied to <html> and persisted', () => {
    act(() => useAppearance.getState().setDensity('compact'))
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(localStorage.getItem('total-density')).toBe('compact')
    expect(initialDensity()).toBe('compact')
  })

  it('theme: explicit choices persist; system resolves via matchMedia; toggle flips the theme in effect', () => {
    act(() => useTheme.getState().setPref('dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(initialTheme()).toBe('dark')
    act(() => useTheme.getState().setPref('system'))
    expect(localStorage.getItem('total-theme')).toBe('system')
    expect(document.documentElement.dataset.theme).toBe(resolveTheme('system'))
    act(() => useTheme.getState().toggle())
    expect(useTheme.getState().pref).not.toBe('system')
  })

  it('reduce motion sets data-motion', () => {
    act(() => useAppearance.getState().setReduceMotion(true))
    expect(document.documentElement.dataset.motion).toBe('reduce')
    act(() => useAppearance.getState().setReduceMotion(false))
    expect(document.documentElement.dataset.motion).toBeUndefined()
  })

  it('Settings → Appearance drives the stores', () => {
    render(<AppearanceSection />)
    fireEvent.click(screen.getByTestId('btn-density-compact'))
    expect(useAppearance.getState().density).toBe('compact')
    expect(screen.getByTestId('btn-density-compact').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('btn-theme-pref-dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
    fireEvent.click(screen.getByTestId('input-reduce-motion'))
    expect(useAppearance.getState().reduceMotion).toBe(true)
  })
})

describe('DataTable density', () => {
  const tableDensity = (): string | undefined => screen.getByRole('table').dataset.density

  it('follows the app density by default', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} viewId="d" />)
    expect(tableDensity()).toBe('comfortable')
    act(() => useAppearance.getState().setDensity('compact'))
    expect(tableDensity()).toBe('compact')
  })

  it('the toolbar toggle overrides it for this table; toggling back to the app density follows again', () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} viewId="d" />)
    fireEvent.click(screen.getByTestId('d-table-density'))
    expect(tableDensity()).toBe('compact')
    const stored = (): unknown => JSON.parse(localStorage.getItem(tableViewStorageKey('alpha-co', 'd'))!).current.density
    expect(stored()).toBe('compact')
    act(() => useAppearance.getState().setDensity('comfortable'))
    expect(tableDensity()).toBe('compact') // explicit choice wins
    fireEvent.click(screen.getByTestId('d-table-density'))
    expect(tableDensity()).toBe('comfortable')
    expect(stored()).toBeNull() // same as the app → follow it
    act(() => useAppearance.getState().setDensity('compact'))
    expect(tableDensity()).toBe('compact')
  })

  it('a v1 stored view: comfortable (the old default) follows the app; compact stays explicit', () => {
    const base = { v: 1, order: ['name'], hidden: [], widths: {}, sort: [], filters: {}, groupBy: null }
    localStorage.setItem(tableViewStorageKey('alpha-co', 'old'), JSON.stringify({ v: 1, current: { ...base, density: 'comfortable' }, active: null, saved: [] }))
    localStorage.setItem(tableViewStorageKey('alpha-co', 'old2'), JSON.stringify({ v: 1, current: { ...base, density: 'compact' }, active: null, saved: [] }))
    act(() => useAppearance.getState().setDensity('compact'))
    const a = render(<DataTable columns={COLUMNS} rows={ROWS} viewId="old" />)
    expect(tableDensity()).toBe('compact')
    a.unmount()
    act(() => useAppearance.getState().setDensity('comfortable'))
    render(<DataTable columns={COLUMNS} rows={ROWS} viewId="old2" />)
    expect(tableDensity()).toBe('compact')
  })
})
