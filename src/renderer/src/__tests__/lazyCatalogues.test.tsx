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
  LANGUAGE_KEY, languageStorageKey, languagesToPreload, loadCatalogue, preloadCatalogues, setCatalogueLoaderForTests, useCatalogue, useLanguage, useLanguagePending, useT
} from '../lib/i18n'
import { AppearanceSection } from '../screens/settings/AppearanceSection'
import { ReminderPanel } from '../simple/people/ReminderPanel'
import type { PersonView } from '@shared/simple/people'
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

  it('every user on this Mac counts (a sign-in must not flash English); the OS locale while no app-wide choice is stored', () => {
    localStorage.setItem(LANGUAGE_KEY, 'en')
    localStorage.setItem(languageStorageKey('alpha-co', 7), 'hinglish')
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('hi-IN')
    expect(languagesToPreload()).toEqual(['hinglish'])
    localStorage.clear()
    expect(languagesToPreload()).toEqual(['hi']) // WP 10.4: a Hindi OS starts the wizard in Hindi
    // The wizard asks the OS whenever no APP-WIDE choice is stored, even beside a user's own one.
    localStorage.setItem(languageStorageKey('alpha-co', 7), 'en')
    expect(languagesToPreload()).toEqual(['hi'])
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
    const fallback = result.current
    await act(async () => {
      d.resolve()
      await loadCatalogue('hinglish')
    })
    expect(result.current('simple.home.moneyIn')).toBe('Paise aaye')
    // a NEW t, so memos keyed on it (kit labels, columns) re-run rather than keep the English
    expect(result.current).not.toBe(fallback)
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

// A component that shows a language OTHER than the user's (the People reminder's language chips,
// e2e 59): the chosen catalogue is loaded on demand and the panel never shows English text under
// a Hindi / Hinglish chip — it keeps the language it shows, with the loading note, until it arrives.
describe('a language other than the user\'s (useCatalogue)', () => {
  const bill = { name: '1', voucherId: 101, date: '2026-09-04', dueDate: '2026-09-19', amount: 100_000, pending: 100_000, overdueDays: 25 }
  const person: PersonView = {
    ledgerId: 10, name: 'Ramesh', side: 'customer', phone: '98765 43210', whatsapp: null, creditDays: 15, onHold: false, open: 100_000, ahead: 0,
    late: 100_000, lateBills: 1, maxLateDays: 25, walkIn: false, email: null, bills: [bill],
    reminder: { bucket: 'gentle', bills: [bill], amount: 100_000, lastSent: null, allowed: true, nextAllowed: null },
    holdReason: null, company: 'Sharma Traders', today: '2026-10-14'
  }
  const text = (): string => (screen.getByTestId('reminder-text') as HTMLTextAreaElement).value
  const chip = (lang: string): string | null => screen.getByTestId(`reminder-lang-${lang}`).getAttribute('aria-checked')

  it('the reminder switched to Hinglish before its chunk arrives shows Hinglish once it does, never English under the Hinglish chip', async () => {
    const d = deferred(hinglish)
    setCatalogueLoaderForTests('hinglish', d.loader)
    const seen: { text: string; hinglishChip: string | null }[] = []
    render(<ReminderPanel person={person} reminder={person.reminder!} startLang="en" onSent={() => {}} />)
    expect(text()).toContain('Hello Ramesh,')
    fireEvent.click(screen.getByTestId('reminder-lang-hinglish'))
    expect(d.calls()).toBe(1)
    // Still loading: the English text stays under the English chip, and the panel says so.
    seen.push({ text: text(), hinglishChip: chip('hinglish') })
    expect(text()).toContain('Hello Ramesh,')
    expect(chip('en')).toBe('true')
    expect(chip('hinglish')).not.toBe('true')
    expect(screen.getByTestId('reminder-lang-loading').textContent).toBe(en['simple.looks.languageLoading'])
    for (const id of ['whatsapp', 'copy', 'sms']) expect((screen.getByTestId(`btn-reminder-${id}`) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      d.resolve()
      await loadCatalogue('hinglish')
    })
    expect(text()).toContain('Namaste Ramesh ji,')
    expect(chip('hinglish')).toBe('true')
    expect(screen.queryByTestId('reminder-lang-loading')).toBeNull()
    for (const id of ['whatsapp', 'copy', 'sms']) expect((screen.getByTestId(`btn-reminder-${id}`) as HTMLButtonElement).disabled).toBe(false)
    for (const s of seen) if (s.hinglishChip === 'true') expect(s.text).not.toContain('Hello Ramesh,')
  })

  it('a cached catalogue switches at once, with no loading note and no load', () => {
    registerCatalogue('hi', hi)
    const loader = vi.fn(async () => hi)
    setCatalogueLoaderForTests('hi', loader)
    render(<ReminderPanel person={person} reminder={person.reminder!} startLang="en" onSent={() => {}} />)
    fireEvent.click(screen.getByTestId('reminder-lang-hi'))
    expect(text()).toContain('नमस्ते')
    expect(screen.queryByTestId('reminder-lang-loading')).toBeNull()
    expect(loader).not.toHaveBeenCalled()
  })

  it('useCatalogue: false until the chunk arrives, then true (one load)', async () => {
    const d = deferred(hi)
    setCatalogueLoaderForTests('hi', d.loader)
    const { result } = renderHook(() => useCatalogue('hi'))
    expect(result.current).toBe(false)
    await act(async () => {
      d.resolve()
      await loadCatalogue('hi')
    })
    expect(result.current).toBe(true)
    expect(d.calls()).toBe(1)
    expect(renderHook(() => useCatalogue('en')).result.current).toBe(true)
  })
})
