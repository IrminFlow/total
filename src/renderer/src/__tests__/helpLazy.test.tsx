// #146: the Hindi / Hinglish help articles are lazy chunks — its own file, so no other test has
// loaded them into this module instance first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { useNav, useSession } from '../state/stores'
import { HelpPanel } from '../simple/help/HelpPanel'
import { handleHelpKey } from '../help/keys'
import { useHelpPanel } from '../help/store'
import { isHelpLanguageLoaded } from '../help/articles'
import { languageStorageKey } from '../lib/i18n'
import { AssistantPanel, useAssistantPanel } from '../components/ai/AssistantPanel'
import { useAskTotal } from '../simple/AskTotal'

const invoke = vi.fn()

function Keys(): null {
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      handleHelpKey(e)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  return null
}

function wrap(node: ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}


beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'ai:settings:get': return { ok: true, data: { settings: { enabled: false }, keyPresent: false, ready: false, blocker: 'off' } }
      case 'help:openLink': return { ok: true, data: undefined }
      case 'assist:ask':
        return { ok: true, data: { intent: 'unknown', answeredBy: 'total', sentences: ['I can’t answer that yet. Try one of these:'], figures: [], links: [], suggestions: [], understood: false, help: [] } }
      default: return { ok: true, data: [] }
    }
  })
  window.total = { platform: 'test', invoke, onAiEvent: () => () => undefined }
  act(() => {
    useSession.setState({ slug: 'ramesh', locked: false, user: null, ui: { mode: 'simple' }, info: { name: 'Ramesh Kirana' }, from: '2026-04-01', to: '2027-03-31', workingDate: '2026-10-14' } as never)
    useNav.setState({ stack: [{ name: 'gateway' }] })
    useHelpPanel.setState({ open: false, article: null, follow: false, query: '' })
    useAssistantPanel.setState({ open: false, pending: null, simpleView: 'ask' })
    useAskTotal.setState({ pending: null, turns: [], owner: null })
  })
})
afterEach(() => cleanup())

describe('lazy help translations (#146)', () => {
  it('Hindi help is a lazy chunk (#146): English while it loads (never blank, no "in English" note), then Hindi', async () => {
    expect(isHelpLanguageLoaded('hi')).toBe(false)
    localStorage.setItem(languageStorageKey('ramesh', null), 'hi')
    wrap(<><Keys /><HelpPanel /></>)
    fireEvent.keyDown(window, { key: '?' })
    const article = screen.getByTestId('help-article')
    expect(article.getAttribute('data-loading')).toBe('true')
    expect(screen.getByTestId('help-article-title').textContent).toBe('Getting started')
    expect(screen.queryByTestId('help-in-english')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('help-article').getAttribute('data-loading')).toBeNull())
    expect(screen.getByTestId('help-article-title').textContent).toMatch(/[\u0900-\u097F]/)
    expect(isHelpLanguageLoaded('hi')).toBe(true)
    // A search loads every language (it covers them all).
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'udhaar' } })
    await waitFor(() => expect(isHelpLanguageLoaded('hinglish')).toBe(true))
    expect(screen.getAllByTestId('help-hit').length).toBeGreaterThan(0)
  })
})
