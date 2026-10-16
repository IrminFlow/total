// Perf (to-do after #135): hi / hinglish are their own chunks. The stored language's catalogue is
// loaded BEFORE the first paint (no flash of English), a switch to a language not loaded yet keeps
// the old one on screen with a short "loading" note, and t() for an unloaded language falls back
// to English (never blank) and reports once in dev.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import {
  CATALOGUES, configureI18n, en, isCatalogueLoaded, registerCatalogue, translator, unregisterCatalogueForTests, type Catalogue, type I18nProblem
} from '@shared/i18n'
import { hi } from '@shared/i18n/catalogues/hi'
import { hinglish } from '@shared/i18n/catalogues/hinglish'
import {
  LANGUAGE_KEY, languageStorageKey, languagesToPreload, loadCatalogue, preloadCatalogues, setCatalogueLoaderForTests, useLanguage, useLanguagePending, useT
} from '../lib/i18n'
import { AppearanceSection } from '../screens/settings/AppearanceSection'
import { useSession } from '../state/stores'

function deferred(cat: Catalogue): { loader: () => Promise<Catalogue>; resolve: () => void; calls: () => number } {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let n = 0
  return {
    loader: () => {
      n++
      return gate.then(() => cat)
    },
    resolve: () => release(),
    calls: () => n
  }
}

beforeEach(() => {
  localStorage.clear()
  unregisterCatalogueForTests('hi')
  unregisterCatalogueForTests('hinglish')
  act(() => useSession.setState({ slug: null, user: null }))
})
afterEach(() => {
  cleanup()
  setCatalogueLoaderForTests('hi', null)
  setCatalogueLoaderForTests('hinglish', null)
  registerCatalogue('hi', hi)
  registerCatalogue('hinglish', hinglish)
  configureI18n({ dev: false, report: (p) => p.kind !== 'untranslated' && console.warn(p) })
  vi.restoreAllMocks()
})

describe('t() before a catalogue is loaded', () => {
  it('falls back to English, never blank, and reports not-loaded once per language in dev', () => {
    const seen: I18nProblem[] = []
    configureI18n({ dev: true, report: (p) => seen.push(p) })
    const t = translator('hi')
    expect(t('simple.sell.makeBill')).toBe(en['simple.sell.makeBill'])
    expect(t('simple.home.moneyIn')).toBe('Money in')
    expect(seen.filter((p) => p.kind === 'not-loaded')).toEqual([{ kind: 'not-loaded', key: 'simple.sell.makeBill', lang: 'hi' }])
    registerCatalogue('hi', hi)
    expect(t('simple.home.moneyIn')).toBe('पैसे आए')
  })

  it('reports nothing in production', () => {
    const report = vi.fn()
    configureI18n({ dev: false, report })
    expect(translator('hinglish')('simple.home.moneyIn')).toBe('Money in')
    expect(report).not.toHaveBeenCalled()
  })
})

describe('before the first paint', () => {
  it('a stored Hindi choice is loaded before the first render: the first frame is Hindi', async () => {
    localStorage.setItem(LANGUAGE_KEY, 'hi')
    const d = deferred(hi)
    setCatalogueLoaderForTests('hi', d.loader)
    const pre = preloadCatalogues()
    d.resolve()
    expect(await pre).toEqual(['hi'])
    expect(isCatalogueLoaded('hi')).toBe(true)
    const frames: string[] = []
    function Probe(): React.JSX.Element {
      const text = useT()('simple.home.moneyIn')
      frames.push(text)
      return <p>{text}</p>
    }
    render(<Probe />)
    expect(frames[0]).toBe('पैसे आए')
    expect(frames).not.toContain('Money in')
  })

  it('an English user loads no chunk at all', async () => {
    localStorage.setItem(LANGUAGE_KEY, 'en')
    const loader = vi.fn(async () => hi)
    setCatalogueLoaderForTests('hi', loader)
    expect(await preloadCatalogues()).toEqual([])
    expect(loader).not.toHaveBeenCalled()
  })

  it('every user on this Mac counts (a sign-in must not flash English); the OS locale only when nothing is stored', () => {
    localStorage.setItem(LANGUAGE_KEY, 'en')
    localStorage.setItem(languageStorageKey('alpha-co', 7), 'hinglish')
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('hi-IN')
    expect(languagesToPreload()).toEqual(['hinglish'])
    localStorage.clear()
    expect(languagesToPreload()).toEqual(['hi']) // WP 10.4: a Hindi OS starts the wizard in Hindi
  })

  it('waits at most the bound, then paints English and switches when the chunk arrives', async () => {
    localStorage.setItem(LANGUAGE_KEY, 'hinglish')
    const d = deferred(hinglish)
    setCatalogueLoaderForTests('hinglish', d.loader)
    const started = Date.now()
    await preloadCatalogues(30)
    expect(Date.now() - started).toBeLessThan(2000)
    const { result } = renderHook(() => useT())
    expect(result.current('simple.home.moneyIn')).toBe('Money in')
    await act(async () => {
      d.resolve()
      await loadCatalogue('hinglish')
    })
    expect(result.current('simple.home.moneyIn')).toBe('Paise aaye')
    expect(d.calls()).toBe(1) // the effect re-used the running load
  })
})

describe('switching language', () => {
  it('keeps the current language with a loading note until the chunk is there, then switches', async () => {
    const d = deferred(hi)
    setCatalogueLoaderForTests('hi', d.loader)
    const { result } = renderHook(() => ({ lang: useLanguage()[0], pending: useLanguagePending(), t: useT() }))
    render(<AppearanceSection />)
    fireEvent.click(screen.getByTestId('btn-language-hi'))
    expect(result.current.pending).toBe('hi')
    expect(result.current.lang).toBe('en')
    expect(result.current.t('simple.home.moneyIn')).toBe('Money in')
    expect(screen.getByTestId('language-loading').textContent).toBe(CATALOGUES.en['settings.language.loading'])
    expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull()
    await act(async () => {
      d.resolve()
      await loadCatalogue('hi')
    })
    expect(result.current.lang).toBe('hi')
    expect(result.current.pending).toBeNull()
    expect(result.current.t('simple.home.moneyIn')).toBe('पैसे आए')
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('hi')
    expect(screen.queryByTestId('language-loading')).toBeNull()
  })

  it('a cached catalogue switches at once, with no loading note', () => {
    registerCatalogue('hinglish', hinglish)
    const loader = vi.fn(async () => hinglish)
    setCatalogueLoaderForTests('hinglish', loader)
    render(<AppearanceSection />)
    fireEvent.click(screen.getByTestId('btn-language-hinglish'))
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('hinglish')
    expect(screen.queryByTestId('language-loading')).toBeNull()
    expect(loader).not.toHaveBeenCalled()
  })

  it('the last choice wins when two loads race', async () => {
    const dHi = deferred(hi)
    const dHg = deferred(hinglish)
    setCatalogueLoaderForTests('hi', dHi.loader)
    setCatalogueLoaderForTests('hinglish', dHg.loader)
    const { result } = renderHook(() => useLanguage())
    act(() => result.current[1]('hi'))
    act(() => result.current[1]('hinglish'))
    await act(async () => {
      dHg.resolve()
      await loadCatalogue('hinglish')
    })
    await act(async () => {
      dHi.resolve()
      await loadCatalogue('hi')
    })
    expect(result.current[0]).toBe('hinglish')
  })
})
