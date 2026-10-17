// WP 10.6 — the AI helper in plain words: the simple Settings → AI helper screen (off / key
// missing / key works / errors on their field / hiding toggles / spend), the simple AI panel
// (plain answer, Details, draft offer → the simple flow) vs the accountant panel (unchanged),
// and the plain capture estimate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AiConnectionResult, AiDraftDto, AiEvent, AiMessageDto, AiSettingsView, AiUsageRow } from '@shared/ai'
import type { CaptureEstimate } from '@shared/capture/types'
import { todayISO } from '@shared/dates'
import { AiHelper } from '../simple/ai/AiHelper'
import { PlainCaptureEstimate } from '../simple/ai/CaptureEstimatePlain'
import { AssistantPanel, useAssistantPanel } from '../components/ai/AssistantPanel'
import { useNav, useSession } from '../state/stores'
import { DockModeContext, isPanelOpen } from '../components/kit'
import { a11yProblems } from './helpers/a11yProblems'

const invoke = vi.fn()
let listener: ((e: unknown) => void) | null = null
let view: AiSettingsView
let test: AiConnectionResult
let usage: AiUsageRow[]
let rates: unknown[]
let keySetError: string | null
let canSet: { allowed: boolean; reason: string }
let drafts: Record<number, AiDraftDto>

function baseView(over: Partial<AiSettingsView> = {}, settings: Partial<AiSettingsView['settings']> = {}): AiSettingsView {
  return {
    settings: {
      enabled: false, noticeAcceptedAt: null, noticeAcceptedBy: null, noticeVersion: null, defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna',
      privacy: { maskIds: true, pseudonymiseParties: false }, prices: {}, maxSteps: 8, useMemory: true, ...settings
    },
    keyPresent: false, keyHint: null, secureStorageAvailable: true, mock: false, ready: false, blocker: 'Add an API key', ...over
  }
}
const READY = (): AiSettingsView => baseView({ keyPresent: true, keyHint: '…WXYZ', ready: true, blocker: null }, { enabled: true, noticeAcceptedAt: '2026-10-01T10:00:00.000Z', noticeVersion: 1 })

function msg(over: Partial<AiMessageDto>): AiMessageDto {
  return {
    id: 1, threadId: 9, role: 'assistant', content: '', status: 'ok', toolCalls: [], toolCallId: null, toolName: null, toolInput: null, toolOutput: null, toolOk: null,
    truncated: false, sources: [], figures: [], model: null, costMicroUsd: null, inputTokens: null, outputTokens: null, draftId: null, context: null, memoryIds: [], createdAt: '2026-10-14T10:00:00Z', ...over
  }
}
const ev = (e: Partial<AiEvent>): AiEvent => ({ threadId: 9, runId: 'r9', ...e }) as AiEvent

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  listener = null
  view = baseView()
  test = { ok: true, models: ['whisper-1', 'gpt-5', 'gpt-5-mini', 'text-embedding-3-small'], defaultModelFound: false, fastModelFound: false, error: null }
  usage = []
  rates = []
  keySetError = null
  canSet = { allowed: true, reason: 'ok' }
  drafts = {}
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'ai:settings:get': return { ok: true, data: view }
      case 'ai:settings:set': {
        const p = payload as Partial<AiSettingsView['settings']>
        view = { ...view, settings: { ...view.settings, ...p, privacy: { ...view.settings.privacy, ...(p.privacy ?? {}) } } }
        if (p.enabled !== undefined) view = { ...view, ready: p.enabled && view.keyPresent, blocker: p.enabled ? null : 'off' }
        return { ok: true, data: view }
      }
      case 'ai:notice:accept':
        view = { ...view, settings: { ...view.settings, noticeAcceptedAt: '2026-10-14T10:00:00.000Z', noticeVersion: 1 } }
        return { ok: true, data: view }
      case 'ai:key:set':
        if (keySetError) return { ok: false, error: keySetError }
        view = { ...view, keyPresent: true, keyHint: '…WXYZ' }
        return { ok: true, data: view }
      case 'ai:key:canSet': return { ok: true, data: canSet }
      case 'ai:key:clear': return { ok: true, data: view }
      case 'ai:testConnection': return { ok: true, data: test }
      case 'ai:usage': return { ok: true, data: usage }
      case 'fx:rates': return { ok: true, data: rates }
      case 'ai:threads': return { ok: true, data: [] }
      case 'ai:drafts': return { ok: true, data: [] }
      case 'ai:draft:get': return { ok: true, data: drafts[(payload as { id: number }).id] }
      case 'ai:memory:list': return { ok: true, data: { entries: [], suggestions: [] } }
      case 'ai:send': return { ok: true, data: { threadId: 9, runId: 'r9', userMessage: msg({ id: 50, role: 'user', content: (payload as { text: string }).text, context: (payload as { context?: never }).context ?? null }) } }
      case 'log:renderer': return { ok: true, data: null }
      default: return { ok: false, error: `unmocked ${channel}` }
    }
  })
  window.total = { platform: 'test', invoke, onAiEvent: (l: (e: unknown) => void) => { listener = l; return () => { listener = null } } }
  useSession.setState({ user: { id: 1, name: 'Owner', role: 'owner' }, from: '2026-04-01', to: '2027-03-31', workingDate: '2026-10-14', ui: { mode: 'simple' } } as never)
  useNav.setState({ stack: [{ name: 'gateway' }] })
  useAssistantPanel.setState({ open: true, pending: null, simpleView: 'ask' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function wrap(node: ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}
const calls = (channel: string): unknown[] => invoke.mock.calls.filter(([c]) => c === channel).map(([, p]) => p)

describe('Settings → AI helper (simple)', () => {
  it('off: says what it is, the notice summary first, the full notice behind a disclosure, and waits for a key', async () => {
    wrap(<AiHelper />)
    expect((await screen.findByTestId('simple-ai-intro')).textContent).toContain('Nothing is sent until you turn it on')
    expect(screen.getByTestId('simple-ai-status').textContent).toBe('Off')
    const bullets = within(screen.getByTestId('simple-ai-notice-summary')).getAllByRole('listitem').map((li) => li.textContent)
    expect(bullets).toHaveLength(3)
    expect(bullets[0]).toMatch(/^What is sent/)
    expect(bullets[1]).toMatch(/^What is hidden/)
    expect(bullets[2]).toMatch(/^Where it goes/)
    expect(screen.getByTestId('simple-ai-notice-full').tagName).toBe('DETAILS')
    expect(screen.getByTestId('simple-ai-switch').textContent).toContain('Add and check a key first.')
    expect((screen.getByTestId('simple-ai-on') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('simple-ai-check').textContent).toBe('Check it')
    expect(screen.getByTestId('simple-ai-spend-text').textContent).toBe('Nothing asked yet this month.')
    // No model id, no token count on the screen.
    expect(document.body.textContent).not.toMatch(/gpt-|token/i)
  })

  it('paste key → Check it: saves the key, checks it, picks a model from the list (never the unverified default)', async () => {
    wrap(<AiHelper />)
    fireEvent.change(await screen.findByTestId('simple-ai-key-input'), { target: { value: 'sk-test-0123456789WXYZ' } })
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    const ok = await screen.findByTestId('simple-ai-check-ok')
    expect(ok.textContent).toContain('Works. Models available: gpt-5, gpt-5-mini, whisper-1, text-embedding-3-small.')
    expect(screen.getByTestId('simple-ai-picked').textContent).toBe('Total will use gpt-5.')
    expect(calls('ai:key:set')).toEqual([{ key: 'sk-test-0123456789WXYZ', confirmNoUsers: false }])
    expect(calls('ai:settings:set')).toContainEqual({ defaultModel: 'gpt-5', fastModel: 'gpt-5-mini' })
    // The key never comes back into the page.
    expect(document.documentElement.outerHTML).not.toContain('sk-test-0123456789WXYZ')
    await waitFor(() => expect((screen.getByTestId('simple-ai-on') as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId('simple-ai-on').textContent).toBe('I agree — turn on the AI helper')
  })

  it('says before anything is pasted that another business holds the key, and locks the box', async () => {
    canSet = { allowed: false, reason: 'other_company_has_users' }
    wrap(<AiHelper />)
    expect((await screen.findByTestId('simple-ai-key-blocked')).textContent).toContain('Another business on this computer has sign-ins')
    expect((screen.getByTestId('simple-ai-key-input') as HTMLInputElement).disabled).toBe(true)
    expect(calls('ai:key:set')).toEqual([])
  })

  it('a signed-in non-owner is told only the owner can change the key', async () => {
    canSet = { allowed: false, reason: 'owner_only' }
    useSession.setState({ user: { id: 2, name: 'Asha', role: 'viewer' } } as never)
    wrap(<AiHelper />)
    expect((await screen.findByTestId('simple-ai-key-blocked')).textContent).toContain('Only the owner of this business')
  })

  it('the models the key offers are kept as they are', async () => {
    test = { ok: true, models: ['gpt-6.1-sol', 'gpt-6-luna'], defaultModelFound: true, fastModelFound: true, error: null }
    view = baseView({ keyPresent: true, keyHint: '…WXYZ' })
    wrap(<AiHelper />)
    expect((await screen.findByTestId('simple-ai-check')).textContent).toBe('Check again')
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    expect((await screen.findByTestId('simple-ai-picked')).textContent).toBe('Total will use gpt-6.1-sol.')
    expect(calls('ai:key:set')).toEqual([])
    expect(calls('ai:settings:set')).toEqual([])
  })

  it('a rejected key is said under the key box; out of credit and no network on the screen', async () => {
    test = { ok: false, models: [], defaultModelFound: false, fastModelFound: false, error: 'The provider rejected the API key (401). Check the key in Settings → AI.' }
    wrap(<AiHelper />)
    fireEvent.change(await screen.findByTestId('simple-ai-key-input'), { target: { value: 'sk-bad-0123456789' } })
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    const err = await screen.findByTestId('simple-ai-key-error')
    expect(err.getAttribute('data-kind')).toBe('key')
    expect(err.textContent).toContain('Your AI service did not accept this key.')
    expect(screen.getByTestId('simple-ai-key-input').getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByTestId('simple-ai-error')).toBeNull()

    test = { ok: false, models: [], defaultModelFound: false, fastModelFound: false, error: 'The provider is rate-limiting this key (429): You exceeded your current quota' }
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    expect((await screen.findByTestId('simple-ai-error')).textContent).toContain('Your AI service says you have run out of credit')

    test = { ok: false, models: [], defaultModelFound: false, fastModelFound: false, error: 'Could not reach the provider (network error).' }
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    await waitFor(() => expect(screen.getByTestId('simple-ai-error').textContent).toContain('Could not reach the AI service — Total works without it'))
  })

  it('a failed check never leaves the helper on: a new key that does not work turns it off', async () => {
    view = READY()
    test = { ok: false, models: [], defaultModelFound: false, fastModelFound: false, error: 'The provider rejected the API key (401). Check the key in Settings → AI.' }
    wrap(<AiHelper />)
    fireEvent.change(await screen.findByTestId('simple-ai-key-input'), { target: { value: 'sk-bad-0123456789' } })
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    expect((await screen.findByTestId('simple-ai-key-error')).getAttribute('data-kind')).toBe('key')
    await waitFor(() => expect(calls('ai:settings:set')).toEqual([{ enabled: false }]))
    expect((await screen.findByTestId('simple-ai-stopped')).textContent).toBe('The AI helper is off until a key works.')
    await waitFor(() => expect(screen.getByTestId('simple-ai-status').textContent).toBe('Off'))
  })

  it('a busy service on a re-check of the key in use leaves the helper on', async () => {
    view = READY()
    test = { ok: false, models: [], defaultModelFound: false, fastModelFound: false, error: 'Could not reach the provider (network error).' }
    wrap(<AiHelper />)
    fireEvent.click(await screen.findByTestId('simple-ai-check'))
    await screen.findByTestId('simple-ai-error')
    expect(calls('ai:settings:set')).toEqual([])
  })

  it('a list with no chat model picks nothing and says the current model may not work', async () => {
    test = { ok: true, models: ['whisper-1', 'text-embedding-3-small'], defaultModelFound: false, fastModelFound: false, error: null }
    view = baseView({ keyPresent: true, keyHint: '…WXYZ' })
    wrap(<AiHelper />)
    fireEvent.click(await screen.findByTestId('simple-ai-check'))
    expect((await screen.findByTestId('simple-ai-no-model')).textContent).toContain('keeps gpt-6.1-sol, which may not work')
    expect(screen.queryByTestId('simple-ai-picked')).toBeNull()
    expect(calls('ai:settings:set')).toEqual([])
    cleanup()
    test = { ok: true, models: [], defaultModelFound: false, fastModelFound: false, error: null }
    wrap(<AiHelper />)
    fireEvent.click(await screen.findByTestId('simple-ai-check'))
    expect((await screen.findByTestId('simple-ai-check-ok')).textContent).toContain('did not list the models it offers')
  })

  it('a failure that is not the AI service is said as such, main’s words behind Details (never swallowed)', async () => {
    view = READY()
    wrap(<AiHelper />)
    const real = invoke.getMockImplementation()!
    invoke.mockImplementation(async (c: string, p?: unknown) => (c === 'ai:settings:set' ? { ok: false, error: 'database is locked' } : real(c, p)))
    fireEvent.click(await screen.findByTestId('simple-ai-memory'))
    const err = await screen.findByTestId('simple-ai-error-text')
    expect(err.textContent).toContain('That could not be saved. Try again.')
    expect(err.querySelector('details')!.textContent).toContain('database is locked')
  })

  it('the notice summary follows the hiding setting', async () => {
    view = baseView({}, { privacy: { maskIds: false, pseudonymiseParties: false } })
    wrap(<AiHelper />)
    const bullets = within(await screen.findByTestId('simple-ai-notice-summary')).getAllByRole('listitem').map((li) => li.textContent)
    expect(bullets[1]).toContain('sent as they are')
  })

  it('a too-short key is caught before anything is sent', async () => {
    wrap(<AiHelper />)
    fireEvent.change(await screen.findByTestId('simple-ai-key-input'), { target: { value: 'sk-1' } })
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    expect((await screen.findByTestId('simple-ai-key-error')).textContent).toContain('too short')
    expect(calls('ai:key:set')).toEqual([])
  })

  it('the shared-key rule in one sentence', async () => {
    keySetError = 'The API key is shared by every company on this computer. Another company here has users — open it and sign in as its owner to change the key.'
    wrap(<AiHelper />)
    fireEvent.change(await screen.findByTestId('simple-ai-key-input'), { target: { value: 'sk-test-0123456789WXYZ' } })
    fireEvent.click(screen.getByTestId('simple-ai-check'))
    expect((await screen.findByTestId('simple-ai-error')).textContent).toContain('another business here has sign-ins')
  })

  it('turn on accepts the notice and switches on through the existing channels', async () => {
    view = baseView({ keyPresent: true, keyHint: '…WXYZ' })
    wrap(<AiHelper />)
    fireEvent.click(await screen.findByTestId('simple-ai-on'))
    await waitFor(() => expect(screen.getByTestId('simple-ai-status').textContent).toBe('On'))
    expect(invoke.mock.calls.map(([c]) => c).filter((c) => c === 'ai:notice:accept' || c === 'ai:settings:set')).toEqual(['ai:notice:accept', 'ai:settings:set'])
    expect(calls('ai:settings:set')).toEqual([{ enabled: true }])
    expect(screen.getByTestId('simple-ai-notice-accepted').textContent).toContain('You agreed to this on 14 Oct 2026')
  })

  it('hiding toggles and memory in plain words', async () => {
    view = READY()
    wrap(<AiHelper />)
    const mask = await screen.findByTestId('simple-ai-mask')
    expect(screen.getByTestId('simple-ai-privacy').textContent).toContain('Hide GST and bank numbers before sending')
    expect(screen.getByTestId('simple-ai-privacy').textContent).toContain('Use what Total remembers')
    expect((mask as HTMLInputElement).checked).toBe(true)
    fireEvent.click(mask)
    await waitFor(() => expect(calls('ai:settings:set')).toContainEqual({ privacy: { maskIds: false } }))
    fireEvent.click(screen.getByTestId('simple-ai-names'))
    await waitFor(() => expect(calls('ai:settings:set')).toContainEqual({ privacy: { pseudonymiseParties: true } }))
    fireEvent.click(screen.getByTestId('simple-ai-memory'))
    await waitFor(() => expect(calls('ai:settings:set')).toContainEqual({ useMemory: false }))
  })

  it('spend this month: rupees with the company’s dollar rate, tokens behind Details', async () => {
    view = READY()
    const day = todayISO()
    usage = [
      { id: 2, at: `${day}T10:00:00Z`, day, threadId: 1, threadTitle: 'x', model: 'gpt-5', inputTokens: 12000, cachedTokens: 0, outputTokens: 800, costMicroUsd: 1_000_000, durationMs: 1, ok: true },
      { id: 1, at: '2020-01-01T10:00:00Z', day: '2020-01-01', threadId: 1, threadTitle: 'x', model: 'gpt-5', inputTokens: 5, cachedTokens: 0, outputTokens: 5, costMicroUsd: 9_000_000, durationMs: 1, ok: true }
    ]
    rates = [{ id: 1, date: '2026-01-01', currencyCode: 'USD', rateMicro: 84_100_000, note: null }]
    wrap(<AiHelper />)
    await waitFor(() => expect(screen.getByTestId('simple-ai-spend-text').textContent).toBe('1 question so far — about ₹84.10.'))
    expect(screen.getByTestId('simple-ai-spend').textContent).toContain('At your dollar rate of ₹84.10 from 1 Jan 2026.')
    expect(within(screen.getByTestId('simple-ai-spend-details')).getByText(/12,000 tokens read, 800 written/)).toBeTruthy()
  })

  it('unpriced: the cost is not guessed', async () => {
    view = READY()
    const day = todayISO()
    usage = [{ id: 2, at: `${day}T10:00:00Z`, day, threadId: 1, threadTitle: 'x', model: 'gpt-5', inputTokens: 100, cachedTokens: 0, outputTokens: 10, costMicroUsd: null, durationMs: 1, ok: true }]
    wrap(<AiHelper />)
    await waitFor(() => expect(screen.getByTestId('simple-ai-spend-text').textContent).toContain('Total doesn’t know the price yet'))
  })

  it('not the owner: read-only, said once', async () => {
    useSession.setState({ user: { id: 2, name: 'Clerk', role: 'accountant' } } as never)
    view = READY()
    wrap(<AiHelper />)
    expect((await screen.findByTestId('simple-ai-owner-only')).textContent).toBe('Only the owner can change the AI helper.')
    expect((screen.getByTestId('simple-ai-key-input') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByTestId('simple-ai-mask') as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByTestId('simple-ai-off')).toBeNull()
  })
})

async function escalate(question: string): Promise<void> {
  view = READY()
  wrap(<AssistantPanel />)
  await waitFor(() => expect(calls('ai:settings:get').length).toBeGreaterThan(0))
  act(() => useAssistantPanel.getState().ask(question))
  await waitFor(() => expect(calls('ai:send').length).toBe(1))
  await waitFor(() => expect(listener).not.toBeNull())
}

function answerTurn(extra: AiMessageDto[] = []): void {
  act(() => {
    listener!(ev({ type: 'run-start', userMessage: msg({ id: 50, role: 'user', content: 'Anything unusual?', context: { screen: 'gateway', label: 'Home', from: '2026-04-01', to: '2027-03-31' } as never }) }))
    listener!(ev({ type: 'message', message: msg({ id: 51, toolCalls: [{ callId: 'c1', name: 'profit_and_loss', input: {} }], model: 'gpt-5', inputTokens: 1200, outputTokens: 40, costMicroUsd: 10_000 }) }))
    listener!(ev({ type: 'message', message: msg({ id: 52, role: 'tool', toolCallId: 'c1', toolName: 'profit_and_loss', toolOk: true, toolOutput: {} }) }))
    for (const m of extra) listener!(ev({ type: 'message', message: m }))
    listener!(ev({
      type: 'message',
      message: msg({ id: 60, content: 'Sales were ₹1,00,000.00.', model: 'gpt-5', inputTokens: 1500, outputTokens: 60, costMicroUsd: 20_000, figures: [{ text: '₹1,00,000.00', paise: 10_000_000, sourced: true, tool: 'profit_and_loss', source: { kind: 'screen', screen: 'profit-loss', label: 'Profit & loss' } }] })
    }))
    listener!(ev({ type: 'done' }))
  })
}

describe('the AI panel in plain words (simple mode)', () => {
  it('a plain answer: who answered, where the figures came from, the cost; model, tokens and tools behind Details', async () => {
    rates = [{ id: 1, date: '2026-01-01', currencyCode: 'USD', rateMicro: 84_100_000, note: null }]
    await escalate('Anything unusual?')
    expect(await screen.findByTestId('ai-panel-plain')).toBeTruthy()
    expect(screen.queryByTestId('ai-panel')).toBeNull()
    expect(screen.getByTestId('ai-escalated')).toBeTruthy()
    answerTurn()
    const answer = await screen.findByTestId('ai-plain-answer')
    expect(within(answer).getByTestId('ai-plain-by').textContent).toBe('Answered by the AI service')
    expect(within(answer).getByTestId('ai-plain-from').textContent).toBe('This answer used figures from: How your business is doing.')
    // $0.03 × ₹84.10 = ₹2.523 → ₹2.52
    await waitFor(() => expect(within(answer).getByTestId('ai-plain-cost').textContent).toBe('This answer cost about ₹2.52.'))
    // The figure is still a chip.
    expect(within(answer).getByTestId('ai-figure')).toBeTruthy()
    // Outside Details: no model id, no tokens, no tool name, no raw context strip.
    const details = within(answer).getByTestId('ai-plain-details')
    const outside = answer.textContent!.replace(details.textContent!, '')
    expect(outside).not.toMatch(/gpt-5|token|profit_and_loss|Screen:/i)
    expect(screen.queryByTestId('ai-context')).toBeNull()
    expect(screen.queryByTestId('ai-tool-chip')).toBeNull()
    expect(details.tagName).toBe('DETAILS')
    expect(details.textContent).toContain('Model: gpt-5')
    expect(details.textContent).toContain('Tokens: 2,700 read, 100 written')
    expect(within(answer).getByTestId('ai-plain-details-tools').textContent).toBe('Looked at: profit_and_loss')
    expect(within(answer).getByTestId('ai-plain-details-context').textContent).toContain('Screen: Gateway (gateway)')
  })

  it('what is sent is said before the first answer, the screen-context lines one click away', async () => {
    useAssistantPanel.setState({ pending: null })
    await escalate('Anything unusual?')
    const sent = await screen.findByTestId('ai-plain-sent')
    expect(screen.queryByTestId('ai-plain-answer')).toBeNull()
    expect(sent.textContent).toContain('What is sent with each question: your question')
    expect(sent.textContent).toContain('what this screen shows (Home)')
    expect(sent.textContent).toContain('GST, PAN and bank numbers are hidden.')
    expect(sent.textContent).toContain('Customer and supplier names are sent as they are.')
    expect(sent.textContent).toContain('What Total remembers goes too.')
    expect(screen.getByTestId('ai-plain-sent-details').tagName).toBe('DETAILS')
  })

  it('a draft offer in plain words opens the SIMPLE flow pre-filled (never the accountant editor)', async () => {
    drafts[77] = {
      id: 77, threadId: 9, kind: 'voucher', summary: 'Payment of ₹2,500.00 to Shop Rent from Cash', status: 'open', voucherId: null, unrequested: true, source: 'chat', origin: null, createdAt: '', consumedAt: null,
      payload: { voucherTypeId: 3, voucherKind: 'payment', date: '2026-10-14', partyLedgerId: null, narration: 'Shop rent', reference: null, lines: [{ ledgerId: 12, drCr: 'dr', amount: 250000 }, { ledgerId: 1, drCr: 'cr', amount: 250000 }] }
    }
    await escalate('Pay 2,500 shop rent in cash')
    answerTurn([msg({ id: 53, role: 'tool', toolCallId: 'c2', toolName: 'draft_voucher', toolOk: true, draftId: 77 })])
    const card = await screen.findByTestId('ai-plain-draft')
    await waitFor(() => expect(within(card).getByTestId('ai-plain-draft-question').textContent).toBe('Save this as money paid?'))
    expect(within(card).getByTestId('ai-plain-draft-not-asked').textContent).toContain('You did not ask for this')
    expect(card.textContent).not.toMatch(/unrequested/i)
    // The server's accountant summary (Dr / Cr) only behind Details; the card says it plainly.
    expect(within(card).getByTestId('ai-plain-draft-what').textContent).toBe('Money paid: ₹2,500.00 on 14 Oct 2026.')
    const outside = card.textContent!.replace(within(card).getByTestId('ai-plain-draft-details').textContent!, '')
    expect(outside).not.toMatch(/\bDr\b|\bCr\b|Payment of/)
    fireEvent.click(within(card).getByTestId('ai-plain-draft-open'))
    await waitFor(() => expect(useNav.getState().stack.length).toBe(2))
    const top = useNav.getState().stack.at(-1) as { name: string; ask?: unknown }
    expect(top).toEqual({ name: 'simple-money-out', ask: { draftId: 77, prefill: { screen: 'simple-money-out', who: 'expense', payee: 12, amount: 250000, date: '2026-10-14', note: 'Shop rent' } } })
    expect(useAssistantPanel.getState().open).toBe(false)
  })

  it('a provider error in plain words, its wording behind Details', async () => {
    await escalate('Anything unusual?')
    act(() => {
      listener!(ev({ type: 'run-start', userMessage: msg({ id: 50, role: 'user', content: 'Anything unusual?' }) }))
      listener!(ev({ type: 'message', message: msg({ id: 61, status: 'error', content: 'Could not reach the provider (network error).' }) }))
      listener!(ev({ type: 'done' }))
    })
    const err = await screen.findByTestId('ai-plain-answer-error')
    expect(err.textContent).toContain('Could not reach the AI service — Total works without it')
    expect(err.querySelector('details')!.textContent).toContain('The AI service said: Could not reach the provider (network error).')
  })

  it('accountant mode keeps the accountant panel as it was (tokens, model, tool chips, context strip)', async () => {
    useSession.setState({ ui: { mode: 'accountant' } } as never)
    view = READY()
    wrap(<AssistantPanel />)
    expect(await screen.findByTestId('ai-panel')).toBeTruthy()
    expect(screen.queryByTestId('ai-panel-plain')).toBeNull()
    expect(screen.getByTestId('ai-context')).toBeTruthy()
    fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'sales?' } })
    fireEvent.click(screen.getByTestId('btn-ai-send'))
    await waitFor(() => expect(listener).not.toBeNull())
    answerTurn()
    expect((await screen.findByTestId('ai-cost')).textContent).toContain('tokens')
    expect(screen.getByTestId('ai-tool-chip-profit_and_loss')).toBeTruthy()
    expect(screen.queryByTestId('ai-plain-answer')).toBeNull()
  })
})

describe('the capture estimate in plain words', () => {
  const est: CaptureEstimate = { items: 3, ids: [1, 2, 3], maskIds: true, pseudonymise: false, pages: 4, inputTokens: 9000, outputTokens: 1500, costMicroUsd: 30_000, model: 'gpt-5', unmaskable: 1, blocker: null }
  it('"About ₹X to read N bills" first; pages, model and tokens behind Details', async () => {
    rates = [{ id: 1, date: '2026-01-01', currencyCode: 'USD', rateMicro: 84_100_000, note: null }]
    const onConfirm = vi.fn()
    wrap(<PlainCaptureEstimate estimate={est} onClose={() => {}} onConfirm={onConfirm} />)
    await waitFor(() => expect(screen.getByTestId('text-capture-cost').textContent).toBe('About ₹2.52 to read 3 bills.'))
    expect(screen.getByTestId('banner-capture-unmaskable').textContent).toContain('1 bill is a photo or scan')
    const details = screen.getByTestId('capture-estimate-details')
    expect(details.textContent).toContain('Pages: 4 · model: gpt-5')
    const outside = screen.getByTestId('capture-estimate').textContent!.replace(details.textContent!, '')
    expect(outside).not.toMatch(/gpt-5|token/i)
    expect(screen.getByTestId('text-capture-privacy').textContent).toContain('Customer and supplier names are sent as they are.')
    fireEvent.click(screen.getByTestId('btn-capture-confirm'))
    expect(onConfirm).toHaveBeenCalled()
  })
  it('without a dollar rate: dollars; without a price: not guessed', async () => {
    wrap(<PlainCaptureEstimate estimate={{ ...est, costMicroUsd: null }} onClose={() => {}} onConfirm={() => {}} />)
    expect((await screen.findByTestId('text-capture-cost')).textContent).toContain('Total doesn’t know the price yet')
    cleanup()
    wrap(<PlainCaptureEstimate estimate={est} onClose={() => {}} onConfirm={() => {}} />)
    expect((await screen.findByTestId('text-capture-cost')).textContent).toBe('About $0.0300 to read 3 bills.')
    expect(screen.getByTestId('capture-estimate').textContent).toContain('Your AI service charges in US dollars.')
  })
})

// WP 10.5: the AI helper screen and the plain AI drawer pass the simple a11y sweep; in the simple
// shell the drawer is an Esc layer that can overlay the screen.
describe('WP 10.5: keyboard and screen readers', () => {
  it('Settings → AI helper, off and on: every control named and labelled', async () => {
    wrap(<AiHelper />)
    await screen.findByTestId('simple-ai-intro')
    expect(a11yProblems()).toEqual([])
    cleanup()
    view = READY()
    wrap(<AiHelper />)
    await screen.findByTestId('simple-ai-intro')
    await waitFor(() => expect(screen.getByTestId('simple-ai-status').textContent).not.toBe('Off'))
    expect(a11yProblems()).toEqual([])
  })

  it('the plain AI drawer: a named complementary region, overlaying and an Esc layer in the simple shell', async () => {
    view = READY()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <DockModeContext.Provider value="overlay">
          <AssistantPanel />
        </DockModeContext.Provider>
      </QueryClientProvider>
    )
    await waitFor(() => expect(calls('ai:settings:get').length).toBeGreaterThan(0))
    act(() => useAssistantPanel.getState().ask('Anything unusual?'))
    await waitFor(() => expect(listener).not.toBeNull())
    const panel = await screen.findByTestId('ai-panel-plain')
    answerTurn()
    await screen.findByTestId('ai-plain-answer')
    expect(panel.tagName).toBe('ASIDE')
    expect(panel.hasAttribute('data-overlay')).toBe(true)
    expect(screen.getByRole('complementary', { name: panel.querySelector('h2')!.textContent! })).toBe(panel)
    expect(isPanelOpen()).toBe(true)
    expect(a11yProblems()).toEqual([])
  })
})
