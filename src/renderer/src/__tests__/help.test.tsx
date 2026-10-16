// WP 10.3 — the help panel: ? (no box focused) and ⌘/ open it on the current screen's article
// (registry helpKey), it follows the user from screen to screen until they pick an article,
// search finds by title and body, links open screens / other articles / (only) the GST portal
// through main, the simple header has a Help button, Ask Total's "can't answer" searches it, and
// the full app keeps ? for its shortcut list (no panel).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { useNav, useSession } from '../state/stores'
import { HelpPanel } from '../simple/help/HelpPanel'
import { handleHelpKey } from '../help/keys'
import { useHelpPanel } from '../help/store'
import { HELP } from '../help/articles'
import { SimpleHeader } from '../simple/SimpleHeader'
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

const go = (name: string, extra: Record<string, unknown> = {}): void => {
  act(() => useNav.getState().go({ name, ...extra } as never, { force: true }))
}
const top = (): unknown => useNav.getState().stack.at(-1)
const shownArticle = (): string | null => screen.queryByTestId('help-article')?.getAttribute('data-article') ?? null

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

describe('help panel (WP 10.3)', () => {
  it('? opens it on the current screen’s article — Home → Getting started; ? again closes it', () => {
    wrap(<><Keys /><HelpPanel /></>)
    expect(screen.queryByTestId('help-panel')).toBeNull()
    fireEvent.keyDown(window, { key: '?' })
    expect(screen.getByTestId('help-panel')).toBeTruthy()
    expect(shownArticle()).toBe('getting-started')
    expect(screen.getByTestId('help-article-title').textContent).toBe('Getting started')
    fireEvent.keyDown(window, { key: '?' })
    expect(screen.queryByTestId('help-panel')).toBeNull()
  })

  it('? typed in a box is just a question mark; ⌘/ opens it from a box too', () => {
    wrap(<><Keys /><input data-testid="box" /><HelpPanel /></>)
    const box = screen.getByTestId('box')
    box.focus()
    fireEvent.keyDown(box, { key: '?' })
    expect(screen.queryByTestId('help-panel')).toBeNull()
    fireEvent.keyDown(box, { key: '/', metaKey: true })
    expect(screen.getByTestId('help-panel')).toBeTruthy()
    fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    expect(screen.queryByTestId('help-panel')).toBeNull()
  })

  it('context: each screen opens its own article, and the open panel follows the user until they pick one', () => {
    go('simple-taxes')
    wrap(<><Keys /><HelpPanel /></>)
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    expect(shownArticle()).toBe('gst')
    go('simple-bank')
    expect(shownArticle()).toBe('bank-statement')
    go('simple-section', { section: 'people' })
    expect(shownArticle()).toBe('people-and-reminders')
    // Picking an article from the list stops the following.
    fireEvent.click(screen.getByTestId('help-all'))
    fireEvent.click(within(screen.getByTestId('help-list')).getAllByTestId('help-list-item').find((b) => b.getAttribute('data-article') === 'backups')!)
    expect(shownArticle()).toBe('backups')
    go('simple-sell')
    expect(shownArticle()).toBe('backups')
  })

  it('lists every article and searches title and body', () => {
    wrap(<HelpPanel />)
    act(() => useHelpPanel.getState().openList())
    expect(screen.getAllByTestId('help-list-item')).toHaveLength(HELP.list('en').length)
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'overdraft' } })
    const hits = screen.getAllByTestId('help-hit')
    expect(hits.map((h) => h.getAttribute('data-article'))).toContain('day-one')
    fireEvent.click(hits.find((h) => h.getAttribute('data-article') === 'day-one')!)
    expect(shownArticle()).toBe('day-one')
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'qwertyuiop' } })
    expect(screen.getByTestId('help-no-hits').textContent).toContain('qwertyuiop')
  })

  it('links: a screen link opens the screen, an article link the article, the GST portal goes through main', async () => {
    wrap(<HelpPanel />)
    act(() => useHelpPanel.getState().openArticle('getting-started'))
    const link = (href: string): HTMLElement => screen.getAllByTestId('help-link').find((l) => l.getAttribute('data-href') === href)!
    fireEvent.click(link('total://screen/simple-sell'))
    await waitFor(() => expect(top()).toEqual({ name: 'simple-sell' }))
    expect(screen.getByTestId('help-panel')).toBeTruthy()
    fireEvent.click(link('total://help/day-one'))
    expect(shownArticle()).toBe('day-one')
    act(() => useHelpPanel.getState().openArticle('gst'))
    fireEvent.click(link('https://www.gst.gov.in'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('help:openLink', { url: 'https://www.gst.gov.in' }))
    // Nothing in an article is HTML: the body is text nodes and buttons only.
    expect(screen.getByTestId('help-body').querySelector('script, iframe, a[href^="javascript"]')).toBeNull()
  })

  it('the simple header has a Help button that opens the current screen’s article', () => {
    go('simple-stock')
    wrap(<><SimpleHeader onOpenPalette={() => undefined} /><HelpPanel /></>)
    fireEvent.click(screen.getByTestId('btn-help'))
    expect(shownArticle()).toBe('stock-and-count')
    fireEvent.click(screen.getByTestId('btn-help'))
    expect(screen.queryByTestId('help-panel')).toBeNull()
  })

  it('help and Ask Total share the edge: opening one closes the other', () => {
    wrap(<HelpPanel />)
    act(() => useAssistantPanel.getState().setOpen(true))
    act(() => useHelpPanel.getState().openForScreen('getting-started'))
    expect(useAssistantPanel.getState().open).toBe(false)
    act(() => useAssistantPanel.getState().setOpen(true))
    expect(useHelpPanel.getState().open).toBe(false)
  })

  it('Ask Total: a question it can’t answer lists matching help articles, which open here', async () => {
    act(() => useAssistantPanel.setState({ open: true }))
    wrap(<><AssistantPanel /><HelpPanel /></>)
    fireEvent.change(await screen.findByTestId('ask-input'), { target: { value: 'how do I back up my books' } })
    fireEvent.click(screen.getByTestId('ask-send'))
    const box = await screen.findByTestId('ask-help-articles')
    const first = within(box).getAllByTestId('ask-help-article')[0]!
    expect(first.getAttribute('data-article')).toBe('backups')
    fireEvent.click(first)
    expect(shownArticle()).toBe('backups')
    expect(useAssistantPanel.getState().open).toBe(false)
  })

  it('the full app: no help panel, ? is left to the shortcut list', () => {
    act(() => useSession.setState({ ui: { mode: 'accountant' } } as never))
    wrap(<><Keys /><HelpPanel /></>)
    const e = new KeyboardEvent('keydown', { key: '?', cancelable: true })
    expect(handleHelpKey(e)).toBe(false)
    fireEvent.keyDown(window, { key: '/', metaKey: true })
    act(() => useHelpPanel.getState().openForScreen('gst'))
    expect(screen.queryByTestId('help-panel')).toBeNull()
  })
})
