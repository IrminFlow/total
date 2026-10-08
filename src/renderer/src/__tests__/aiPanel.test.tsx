// WP 5.1 — the chat panel renders from streamed AiEvents (reducer + component), and the
// assistant's UI is gated on the settings (notice, switch, key, role).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AiEvent, AiMessageDto, AiSettingsView } from '@shared/ai'
import { applyAiEvent, emptyPanel, turnCost } from '../lib/aiThread'
import { AssistantDrawer, screenFor } from '../components/ai/AssistantPanel'
import { AiSection } from '../screens/settings/AiSection'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
const isDisabled = (el: HTMLElement): boolean => (el as HTMLInputElement).disabled
let listener: ((e: unknown) => void) | null = null

function msg(over: Partial<AiMessageDto>): AiMessageDto {
  return {
    id: 1, threadId: 7, role: 'assistant', content: '', status: 'ok', toolCalls: [], toolCallId: null, toolName: null, toolInput: null,
    toolOutput: null, toolOk: null, truncated: false, sources: [], figures: [], model: null, costMicroUsd: null, inputTokens: null,
    outputTokens: null, draftId: null, createdAt: '2025-08-14T10:00:00Z', ...over
  }
}

function view(over: Partial<AiSettingsView> = {}, settings: Partial<AiSettingsView['settings']> = {}): AiSettingsView {
  return {
    settings: {
      enabled: true, noticeAcceptedAt: '2025-08-01T10:00:00.000Z', noticeAcceptedBy: 'Owner', noticeVersion: 1, defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna',
      privacy: { maskIds: true, pseudonymiseParties: false }, prices: {}, maxSteps: 8, ...settings
    },
    keyPresent: true, keyHint: '…WXYZ', secureStorageAvailable: true, mock: false, ready: true, blocker: null, ...over
  }
}

let settingsView = view()

beforeEach(() => {
  invoke.mockReset()
  listener = null
  settingsView = view()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'ai:settings:get': return { ok: true, data: settingsView }
      case 'ai:threads': return { ok: true, data: [] }
      case 'ai:usage': return { ok: true, data: [] }
      case 'ai:outbound': return { ok: true, data: [] }
      case 'ai:send': {
        const p = payload as { text: string }
        return { ok: true, data: { threadId: 7, runId: 'r1', userMessage: msg({ id: 1, role: 'user', content: p.text }) } }
      }
      case 'ai:cancel': return { ok: true, data: { cancelled: true } }
      case 'ai:draft:get': return { ok: true, data: DRAFT }
      case 'log:renderer': return { ok: true, data: null }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = {
    platform: 'test',
    invoke,
    onAiEvent: (l) => {
      listener = l
      return () => {
        listener = null
      }
    }
  }
  useSession.setState({ user: null, from: '2025-04-01', to: '2026-03-31' })
  useNav.setState({ stack: [{ name: 'gateway' }] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function wrap(node: ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const DRAFT = {
  id: 3, threadId: 7, kind: 'voucher' as const, summary: 'Payment of ₹1,500.00 on 2025-08-14: Dr Shop Rent / Cr Cash', status: 'open' as const,
  payload: { voucherTypeId: 2, voucherKind: 'payment', date: '2025-08-14', partyLedgerId: null, narration: 'rent', reference: null, lines: [] },
  voucherId: null, unrequested: true, createdAt: '2025-08-14T10:00:00Z', consumedAt: null
}

const ev = (e: Omit<AiEvent, 'threadId' | 'runId'> & Record<string, unknown>): AiEvent => ({ threadId: 7, runId: 'r1', ...e }) as AiEvent

describe('applyAiEvent', () => {
  it('adopts the new thread, streams, tracks tools and finishes', () => {
    let s = { ...emptyPanel(), awaitingThread: true }
    s = applyAiEvent(s, ev({ type: 'run-start', userMessage: msg({ id: 1, role: 'user', content: 'q' }) }))
    expect(s).toMatchObject({ threadId: 7, running: true, awaitingThread: false })
    s = applyAiEvent(s, ev({ type: 'delta', text: 'Hel' }))
    s = applyAiEvent(s, ev({ type: 'delta', text: 'lo' }))
    expect(s.streaming).toBe('Hello')
    s = applyAiEvent(s, ev({ type: 'tool-start', callId: 'c1', name: 'trial_balance', input: {} }))
    expect(s.pendingTools).toHaveLength(1)
    s = applyAiEvent(s, ev({ type: 'message', message: msg({ id: 2, content: 'Hello', toolCalls: [{ callId: 'c1', name: 'trial_balance', input: {} }] }) }))
    expect(s.streaming).toBe('')
    s = applyAiEvent(s, ev({ type: 'message', message: msg({ id: 3, role: 'tool', toolCallId: 'c1', toolName: 'trial_balance', toolOk: true }) }))
    expect(s.pendingTools).toHaveLength(0)
    // events for another thread are ignored
    expect(applyAiEvent(s, { type: 'delta', threadId: 99, runId: 'x', text: 'nope' })).toBe(s)
    s = applyAiEvent(s, ev({ type: 'done' }))
    expect(s).toMatchObject({ running: false, streaming: '' })
    expect(s.messages.map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('totals a turn’s cost across its steps', () => {
    const list = [
      msg({ id: 1, role: 'user' }),
      msg({ id: 2, costMicroUsd: 1000, inputTokens: 100, outputTokens: 10 }),
      msg({ id: 3, role: 'tool' }),
      msg({ id: 4, costMicroUsd: 500, inputTokens: 50, outputTokens: 5 })
    ]
    expect(turnCost(list, 4)).toEqual({ cost: 1500, input: 150, output: 15 })
  })

  it('maps screen sources to navigation targets', () => {
    expect(screenFor({ kind: 'screen', screen: 'profit-loss', label: 'P&L' })).toEqual({ name: 'profit-loss' })
    expect(screenFor({ kind: 'screen', screen: 'ledger-statement', label: 'x', params: { ledgerId: 5 } })).toEqual({ name: 'ledger-statement', ledgerId: 5 })
    expect(screenFor({ kind: 'screen', screen: 'voucher-entry', label: 'x', params: { aiDraftId: 3 } })).toEqual({ name: 'voucher-entry', aiDraftId: 3 })
    expect(screenFor({ kind: 'screen', screen: 'nowhere', label: 'x' })).toBeNull()
  })
})

describe('AssistantDrawer', () => {
  it('renders a conversation from streamed events: tool chip, sourced answer, cost, draft card', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    const input = await screen.findByTestId('ai-input')
    await waitFor(() => expect(isDisabled(input)).toBe(false))
    fireEvent.change(input, { target: { value: 'What were sales in July?' } })
    fireEvent.click(screen.getByTestId('btn-ai-send'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:send', { threadId: undefined, text: 'What were sales in July?', context: { screen: 'gateway', from: '2025-04-01', to: '2026-03-31' } }))
    expect(listener).not.toBeNull()
    await screen.findByTestId('ai-msg-user')

    act(() => listener!(ev({ type: 'delta', text: 'Checking…' })))
    expect(screen.getByTestId('ai-streaming').textContent).toBe('Checking…')
    expect(screen.getByTestId('btn-ai-stop')).toBeTruthy()

    act(() => listener!(ev({ type: 'message', message: msg({ id: 2, content: 'Checking…', toolCalls: [{ callId: 'c1', name: 'profit_and_loss', input: { from: '2025-07-01', to: '2025-07-31' } }], costMicroUsd: 2500, inputTokens: 1000, outputTokens: 100, model: 'gpt-6.1-sol' }) })))
    act(() => listener!(ev({ type: 'tool-start', callId: 'c1', name: 'profit_and_loss', input: {} })))
    expect(screen.getByTestId('ai-tool-chip-profit_and_loss').closest('[data-testid="ai-tool-chip"]')!.getAttribute('data-status')).toBe('running')
    act(() =>
      listener!(ev({
        type: 'message',
        message: msg({
          id: 3, role: 'tool', toolCallId: 'c1', toolName: 'profit_and_loss', toolOk: true, toolInput: {},
          toolOutput: { ok: true, result: { tradingIncomes: [{ name: 'Sales Accounts', amount: '₹1,00,000.00' }] } },
          sources: [{ kind: 'screen', screen: 'profit-loss', label: 'Profit & loss July' }]
        })
      }))
    )
    const chip = screen.getByTestId('ai-tool-chip-profit_and_loss').closest('[data-testid="ai-tool-chip"]') as HTMLElement
    expect(chip.getAttribute('data-status')).toBe('ok')
    fireEvent.click(screen.getByTestId('ai-tool-chip-profit_and_loss'))
    expect(within(chip).getByTestId('ai-tool-detail').textContent).toContain('₹1,00,000.00')

    act(() =>
      listener!(ev({
        type: 'message',
        message: msg({
          id: 4, content: 'Sales in July were ₹1,00,000.00, maybe ₹7.00 more.', model: 'gpt-6.1-sol', costMicroUsd: 2500, inputTokens: 1200, outputTokens: 40,
          figures: [
            { text: '₹1,00,000.00', paise: 10_000_000, sourced: true, tool: 'profit_and_loss' },
            { text: '₹7.00', paise: 700, sourced: false, tool: null }
          ],
          sources: [{ kind: 'screen', screen: 'profit-loss', label: 'Profit & loss July' }, { kind: 'voucher', voucherId: 9, label: 'Sales 9' }]
        })
      }))
    )
    act(() => listener!(ev({ type: 'message', message: msg({ id: 5, role: 'tool', toolCallId: 'c9', toolName: 'draft_voucher', toolOk: true, draftId: 3 }) })))
    act(() => listener!(ev({ type: 'draft', draft: DRAFT })))
    act(() => listener!(ev({ type: 'done' })))

    const answer = screen.getByTestId('ai-msg-answer')
    expect(answer.textContent).toContain('Sales in July were ₹1,00,000.00')
    expect(within(answer).getByTestId('ai-unsourced').textContent).toContain('₹7.00')
    expect(within(answer).getByTestId('ai-sources').textContent).toContain('Profit & loss July')
    expect(within(answer).getByTestId('voucher-link')).toBeTruthy()
    expect(within(answer).getByTestId('ai-cost').textContent).toBe('gpt-6.1-sol · 2,200 in / 140 out tokens · cost $0.0050')
    expect(screen.getByTestId('btn-ai-send')).toBeTruthy()
    const card = await screen.findByTestId('ai-draft-card')
    expect(card.textContent).toContain('Payment of ₹1,500.00')
    expect(within(card).getByTestId('ai-draft-unrequested').textContent).toBe('You did not ask for this')

    fireEvent.click(within(card).getByTestId('btn-ai-review-draft'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', aiDraftId: 3, kindHint: 'payment' }))
  })

  it('"New" is disabled while a new-thread question is being sent', async () => {
    let resolveSend!: (v: unknown) => void
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'ai:settings:get') return { ok: true, data: settingsView }
      if (channel === 'ai:threads') return { ok: true, data: [] }
      if (channel === 'ai:send') return new Promise((r) => (resolveSend = r))
      return { ok: true, data: null }
    })
    wrap(<AssistantDrawer onClose={() => {}} />)
    const input = await screen.findByTestId('ai-input')
    await waitFor(() => expect(isDisabled(input)).toBe(false))
    fireEvent.change(input, { target: { value: 'q' } })
    fireEvent.click(screen.getByTestId('btn-ai-send'))
    await waitFor(() => expect(isDisabled(screen.getByTestId('btn-ai-new'))).toBe(true))
    await act(async () => resolveSend({ ok: true, data: { threadId: 7, runId: 'r1', userMessage: msg({ id: 1, role: 'user', content: 'q' }) } }))
    expect(screen.getByTestId('ai-msg-user').textContent).toBe('q')
  })

  it('is off (input disabled, reason shown) until the assistant is ready', async () => {
    settingsView = view({ ready: false, blocker: 'Read and accept the data notice first', keyPresent: false }, { enabled: false, noticeAcceptedAt: null })
    wrap(<AssistantDrawer onClose={() => {}} />)
    const banner = await screen.findByTestId('ai-off-banner')
    expect(banner.textContent).toContain('Read and accept the data notice first')
    expect(isDisabled(screen.getByTestId('ai-input'))).toBe(true)
    expect(isDisabled(screen.getByTestId('btn-ai-send'))).toBe(true)
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('ai:send')
  })
})

describe('Settings → AI gating', () => {
  it('asks for the data notice first; the switch stays disabled until it is accepted', async () => {
    settingsView = view({ ready: false, blocker: 'Read and accept the data notice first', keyPresent: false, keyHint: null }, { enabled: false, noticeAcceptedAt: null, noticeAcceptedBy: null })
    wrap(<AiSection />)
    const notice = await screen.findByTestId('ai-notice')
    expect(notice.textContent).toMatch(/optional and off by default/)
    expect(notice.textContent).toMatch(/OpenAI/)
    expect(isDisabled(screen.getByTestId('btn-ai-accept-notice'))).toBe(false)
    expect(isDisabled(screen.getByTestId('input-ai-enabled'))).toBe(true)
    expect(screen.getByTestId('ai-status').textContent).toBe('Off')
  })

  it('once accepted shows who accepted, the key hint (never the key), and enables the switch', async () => {
    settingsView = view({ ready: false, blocker: 'The assistant is off for this company — turn it on in Settings → AI' }, { enabled: false })
    wrap(<AiSection />)
    expect((await screen.findByTestId('ai-notice-accepted')).textContent).toContain('by Owner')
    expect(isDisabled(screen.getByTestId('input-ai-enabled'))).toBe(false)
    expect(screen.queryByTestId('btn-ai-accept-notice')).toBeNull()
    expect(screen.getByText(/A key is saved \(…WXYZ\)/)).toBeTruthy()
    expect((screen.getByTestId('input-ai-key') as HTMLInputElement).type).toBe('password')
  })

  it('is read-only for a non-owner', async () => {
    useSession.setState({ user: { id: 2, name: 'Arun', role: 'accountant' } })
    wrap(<AiSection />)
    await screen.findByTestId('ai-notice')
    expect(screen.getByText(/Read-only — only owners/)).toBeTruthy()
    expect(isDisabled(screen.getByTestId('input-ai-enabled'))).toBe(true)
    expect(isDisabled(screen.getByTestId('input-ai-key'))).toBe(true)
    expect(isDisabled(screen.getByTestId('btn-ai-delete-all'))).toBe(true)
  })
})
