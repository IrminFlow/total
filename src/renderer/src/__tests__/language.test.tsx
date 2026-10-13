// WP 8.2: Settings → Appearance → Language drives useT(); the choice is per user (localStorage,
// per company + user when signed in), untranslated keys fall back to English, and the simple
// placeholder renders through t().
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { AppearanceSection } from '../screens/settings/AppearanceSection'
import { LANGUAGE_KEY, languageStorageKey, useLanguage, useT } from '../lib/i18n'
import { SimplePlaceholder } from '../simple/SimplePlaceholder'
import { useSession } from '../state/stores'

beforeEach(() => {
  localStorage.clear()
  act(() => useSession.setState({ slug: null, user: null }))
})
afterEach(() => cleanup())

describe('language switch', () => {
  it('defaults to English; picking Hindi re-renders t() and is stored app-wide when nobody is signed in', () => {
    const { result } = renderHook(() => useT())
    render(<AppearanceSection />)
    expect(result.current('simple.home.moneyIn')).toBe('Money in')
    expect(screen.getByTestId('btn-language-en').getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByTestId('btn-language-hi'))
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('hi')
    expect(result.current('simple.home.moneyIn')).toBe('पैसे आए')
    expect(result.current('simple.sell.makeBill')).toBe('Make a bill') // stub → en per key
    expect(screen.getByTestId('btn-language-hi').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('भाषा')).toBeTruthy() // the row title itself follows the language

    fireEvent.click(screen.getByTestId('btn-language-hinglish'))
    expect(result.current('simple.home.moneyIn')).toBe('Paise aaye')
  })

  it('a signed-in user keeps their own choice; others start from the app-wide one', () => {
    localStorage.setItem(LANGUAGE_KEY, 'hinglish')
    act(() => useSession.setState({ slug: 'alpha-co', user: { id: 7, name: 'Asha', role: 'accountant' } }))
    const { result } = renderHook(() => useT())
    render(<AppearanceSection />)
    expect(result.current('simple.home.moneyOut')).toBe('Paise gaye')

    fireEvent.click(screen.getByTestId('btn-language-hi'))
    expect(localStorage.getItem(languageStorageKey('alpha-co', 7))).toBe('hi')
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('hinglish')
    expect(result.current('simple.home.moneyOut')).toBe('पैसे गए')

    act(() => useSession.setState({ user: { id: 8, name: 'Ravi', role: 'viewer' } }))
    expect(result.current('simple.home.moneyOut')).toBe('Paise gaye')
  })

  it('a switch made anywhere else (not AppearanceSection) re-renders every useT() consumer', () => {
    render(<SimplePlaceholder />)
    const { result: other } = renderHook(() => useLanguage())
    const { result: t } = renderHook(() => useT())
    expect(t.current('simple.home.moneyIn')).toBe('Money in')
    act(() => other.current[1]('hinglish'))
    expect(other.current[0]).toBe('hinglish')
    expect(t.current('simple.home.moneyIn')).toBe('Paise aaye')
    // the placeholder has no Hinglish yet: it falls back to English, still rendered
    expect(screen.getByTestId('simple-placeholder').textContent).toContain('Simple mode is on its way')
  })

  it('the existing Appearance wording is unchanged', () => {
    render(<AppearanceSection />)
    for (const text of ['How Total looks', 'Theme', 'Density', 'Motion', 'Language']) expect(screen.getByText(text)).toBeTruthy()
  })

  it('the simple placeholder renders through t()', () => {
    render(<SimplePlaceholder />)
    expect(screen.getByTestId('simple-placeholder').textContent).toContain('Simple mode is on its way')
  })
})
