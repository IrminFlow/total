// WP 10.1 — Ask Total in the panel: the simple-mode default while the AI assistant is off (and
// with it on, the first stop — what Total can't answer goes to the model, which says so);
// accountant mode keeps the AI panel; figures render as chips that open their screen; "Which …?"
// re-asks with the pick; an entry request opens its simple flow pre-filled with the draft; the
// Home box asks in the panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AiSettingsView } from '@shared/ai'
import type { AssistAnswer } from '@shared/assist'
import { AssistantPanel, useAssistantPanel } from '../components/ai/AssistantPanel'
import { useAskTotal } from '../simple/AskTotal'
import { askScreen } from '../simple/askTargets'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
let aiReady = false
const answers = new Map<string, AssistAnswer>()

const base = (over: Partial<AssistAnswer>): AssistAnswer => ({ intent: 'owed', answeredBy: 'total', sentences: [], figures: [], links: [], understood: true, ...over })

const OWES = base({
  sentences: ['₹11,800.00 is what 1 customer still owes you; the oldest is Ramesh Traders, 39 days.'],
  figures: [{ text: '₹11,800.00', paise: 1180000, sourced: true, tool: 'ask-total', source: { kind: 'screen', screen: 'outstandings', label: 'Outstandings' }, target: { screen: 'simple-people', params: { filter: 'owesYou' } } }],
  links: [{ label: 'See who owes you', target: { screen: 'simple-people', params: { filter: 'owesYou' } } }]
})

function settings(): AiSettingsView {
  return {
    settings: {
      enabled: aiReady, noticeAcceptedAt: aiReady ? '2025-08-01T10:00:00.000Z' : null, noticeAcceptedBy: null, noticeVersion: 1, defaultModel: 'm', fastModel: 'f',
      privacy: { maskIds: true, pseudonymiseParties: false }, prices: {}, maxSteps: 8, useMemory: true
    },
    keyPresent: aiReady, keyHint: null, secureStorageAvailable: true, mock: false, ready: aiReady, blocker: aiReady ? null : 'The assistant is off'
  } as AiSettingsView
}

beforeEach(() => {
  aiReady = false
  answers.clear()
  answers.set('who owes me', OWES)
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'ai:settings:get': return { ok: true, data: settings() }
      case 'ai:threads': return { ok: true, data: [] }
      case 'ai:drafts': return { ok: true, data: [] }
      case 'assist:ask': {
        const p = payload as { text: string; picks?: { party?: number } }
        const key = p.picks?.party ? `${p.text}#${p.picks.party}` : p.text
        return { ok: true, data: answers.get(key) ?? base({ intent: 'unknown', understood: false, sentences: ['I can’t answer that yet. Try one of these:'], suggestions: ['Who owes me money?'] }) }
      }
      case 'assist:draft': return { ok: true, data: { draftId: 41, prefill: { screen: 'simple-money-out', who: 'expense', payee: 9, amount: 50000, how: 'cash', note: 'tea' } } }
      case 'ai:send': return { ok: true, data: { threadId: 3, runId: 'r', userMessage: { id: 1, threadId: 3, role: 'user', content: (payload as { text: string }).text, status: 'ok', toolCalls: [], toolCallId: null, toolName: null, toolInput: null, toolOutput: null, toolOk: null, truncated: false, sources: [], figures: [], model: null, costMicroUsd: null, inputTokens: null, outputTokens: null, draftId: null, context: null, memoryIds: [], createdAt: '2025-08-14T10:00:00Z' } } }
      case 'log:renderer': return { ok: true, data: null }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke, onAiEvent: () => () => undefined }
  useSession.setState({ user: null, from: '2025-04-01', to: '2026-03-31', workingDate: '2025-10-14', ui: { mode: 'simple' } } as never)
  useNav.setState({ stack: [{ name: 'gateway' }] })
  useAssistantPanel.setState({ open: true, pending: null, simpleView: 'ask' })
  useAskTotal.setState({ pending: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function wrap(node: ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

async function askIt(text: string): Promise<void> {
  fireEvent.change(await screen.findByTestId('ask-input'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('ask-send'))
}

describe('Ask Total — which panel', () => {
  it('simple mode with AI off: the panel is Ask Total (no key needed)', async () => {
    wrap(<AssistantPanel />)
    expect(await screen.findByTestId('ask-panel')).toBeTruthy()
    expect(screen.queryByTestId('ai-panel')).toBeNull()
    expect(screen.getByTestId('ask-empty').textContent).toContain('Ask about your business')
  })

  it('accountant mode keeps the AI panel', async () => {
    useSession.setState({ ui: { mode: 'accountant' } } as never)
    wrap(<AssistantPanel />)
    expect(await screen.findByTestId('ai-panel')).toBeTruthy()
    expect(screen.queryByTestId('ask-panel')).toBeNull()
  })

  it('simple mode with AI on: Total answers first; what it can’t answer goes to the model, which says so', async () => {
    aiReady = true
    wrap(<AssistantPanel />)
    await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'ai:settings:get')).toBe(true))
    await askIt('who owes me')
    expect(await screen.findByTestId('ask-by-total')).toBeTruthy()
    await askIt('write me a poem about my shop')
    expect(await screen.findByTestId('ai-escalated')).toBeTruthy()
    await waitFor(() => expect(invoke.mock.calls.some(([c, p]) => c === 'ai:send' && (p as { text: string }).text === 'write me a poem about my shop')).toBe(true))
    fireEvent.click(screen.getByTestId('btn-back-ask-total'))
    expect(await screen.findByTestId('ask-panel')).toBeTruthy()
  })

  it('with AI off an unknown question stays with Total: suggestions, nothing sent to a model', async () => {
    wrap(<AssistantPanel />)
    await askIt('write me a poem')
    expect(await screen.findByTestId('ask-suggestions')).toBeTruthy()
    expect(invoke.mock.calls.some(([c]) => c === 'ai:send')).toBe(false)
  })
})

describe('Ask Total — answers', () => {
  it('figures are chips that open where they came from; links too', async () => {
    wrap(<AssistantPanel />)
    await askIt('who owes me')
    const chip = await screen.findByTestId('ask-figure')
    expect(chip.textContent).toBe('₹11,800.00')
    expect(screen.getByTestId('ask-answer').textContent).toContain('is what 1 customer still owes you')
    fireEvent.click(chip)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-people', filter: 'owesYou' }))
  })

  it('"Which Ramesh?" re-asks with the pick — never a guess', async () => {
    answers.set('does ramesh owe me', base({ sentences: ['Which ramesh do you mean?'], choice: { slot: 'party', question: 'Which ramesh do you mean?', options: [{ id: 5, label: 'Ramesh Traders' }, { id: 6, label: 'Ramesh Kumar' }] } }))
    answers.set('does ramesh owe me#5', base({ sentences: ['Ramesh Traders owes you ₹11,800.00 on 1 bill.'] }))
    wrap(<AssistantPanel />)
    await askIt('does ramesh owe me')
    fireEvent.click(await screen.findByText('Ramesh Traders'))
    expect(await screen.findByText('Ramesh Traders owes you ₹11,800.00 on 1 bill.')).toBeTruthy()
    expect(invoke.mock.calls.some(([c, p]) => c === 'assist:ask' && (p as { picks?: { party?: number } }).picks?.party === 5)).toBe(true)
  })

  it('an entry request opens Money out pre-filled with its draft (nothing is saved here)', async () => {
    answers.set(
      'paid 500 for tea in cash',
      base({
        intent: 'entry',
        sentences: ['Nothing is saved yet — open Money out, check it and press Save.'],
        entry: { kind: 'money_out', prefill: { screen: 'simple-money-out', who: 'expense', payee: 9, amount: 50000, how: 'cash', note: 'tea' }, intent: null, sentences: [], missing: null, canDraft: true }
      })
    )
    wrap(<AssistantPanel />)
    await askIt('paid 500 for tea in cash')
    fireEvent.click(await screen.findByTestId('ask-open-entry'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toMatchObject({ name: 'simple-money-out', ask: { draftId: 41, prefill: { payee: 9, amount: 50000 } } }))
    expect(invoke.mock.calls.filter(([c]) => c === 'simple:post')).toHaveLength(0)
  })

  it('a viewer gets no "Open" button for an entry', async () => {
    answers.set('paid 500 to Mohan', base({ intent: 'entry', sentences: ['You can look at the books but not record entries.'], entry: { kind: 'money_out', prefill: { screen: 'simple-money-out', who: 'supplier', party: 3, amount: 50000 }, intent: null, sentences: [], missing: null, canDraft: false } }))
    wrap(<AssistantPanel />)
    await askIt('paid 500 to Mohan')
    await screen.findByTestId('ask-answer')
    expect(screen.queryByTestId('ask-open-entry')).toBeNull()
  })

  it('"open bank" navigates right away', async () => {
    answers.set('open bank', base({ intent: 'open', sentences: ['Opening Bank.'], open: { screen: 'simple-bank' } }))
    wrap(<AssistantPanel />)
    await askIt('open bank')
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'simple-bank' }))
  })

  it('a question from the Home box is asked in the panel', async () => {
    wrap(<AssistantPanel />)
    await screen.findByTestId('ask-panel')
    act(() => useAskTotal.getState().ask('who owes me'))
    expect(await screen.findByTestId('ask-figure')).toBeTruthy()
  })
})

describe('askScreen (the whitelist)', () => {
  it('maps known screens and drops anything else', () => {
    expect(askScreen({ screen: 'simple-person', params: { id: 4 } })).toEqual({ name: 'simple-person', id: 4 })
    expect(askScreen({ screen: 'simple-taxes', params: { period: '2025-09' } })).toEqual({ name: 'simple-taxes', period: '2025-09' })
    expect(askScreen({ screen: 'simple-person', params: { id: -1 } })).toBeNull()
    expect(askScreen({ screen: 'settings', params: { tab: 'users' } })).toEqual({ name: 'settings' })
    expect(askScreen({ screen: 'company-delete' })).toBeNull()
  })
})
