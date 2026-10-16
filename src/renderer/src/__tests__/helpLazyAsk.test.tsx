// #148 review: Ask Total's "can't answer" help search never waits for the translation chunks —
// its own file, so the chunks are not loaded yet when the answer arrives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useNav, useSession } from '../state/stores'
import { HelpPanel } from '../simple/help/HelpPanel'
import { useHelpPanel } from '../help/store'
import { isHelpLanguageLoaded } from '../help/articles'
import { AssistantPanel, useAssistantPanel } from '../components/ai/AssistantPanel'
import { useAskTotal } from '../simple/AskTotal'

const invoke = vi.fn()

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

describe('Ask Total help search with lazy translations (#148 review)', () => {
  it('an English company: the English help hits come in the same render as the answer, the translations land later', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    vi.doMock('../help/hiFiles', async () => {
      await gate
      return { HI_FILES: {} }
    })
    act(() => useAssistantPanel.setState({ open: true }))
    wrap(<><AssistantPanel /><HelpPanel /></>)
    fireEvent.change(await screen.findByTestId('ask-input'), { target: { value: 'how do I back up my books' } })
    fireEvent.click(screen.getByTestId('ask-send'))
    await screen.findByTestId('ask-answer')
    expect(isHelpLanguageLoaded('hi')).toBe(false)
    expect(screen.getAllByTestId('ask-help-article')[0]!.getAttribute('data-article')).toBe('backups')
    release()
    await waitFor(() => expect(isHelpLanguageLoaded('hi')).toBe(true))
    expect(screen.getAllByTestId('ask-help-article')[0]!.getAttribute('data-article')).toBe('backups')
  })
})
