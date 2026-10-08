// WP 5.6 — Settings → AI → Memory (table, Suggestions filter, accept / dismiss, add) and the chat
// panel's memory affordances ("Remember this?" card for a proposal, chips for memories an answer used).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AiEvent, AiMemoryDto, AiMemoryList, AiMessageDto, AiSettingsView } from '@shared/ai'
import { AiMemoryPanel, memoryRows } from '../screens/settings/AiMemoryPanel'
import { AssistantDrawer } from '../components/ai/AssistantPanel'
import { useNav, useSession } from '../state/stores'

const invoke = vi.fn()
let listener: ((e: unknown) => void) | null = null

function mem(over: Partial<AiMemoryDto>): AiMemoryDto {
  return {
    id: 1, kind: 'fact', text: 'Books close on the 5th', data: null, source: 'user', status: 'active', unrequested: false, threadId: null, createdBy: 'Owner', origin: null,
    createdAt: '2025-08-01T00:00:00Z', updatedAt: '2025-08-01T00:00:00Z', lastUsedAt: null, useCount: 0, labels: {}, ...over
  }
}

function msg(over: Partial<AiMessageDto>): AiMessageDto {
  return {
    id: 1, threadId: 7, role: 'assistant', content: '', status: 'ok', toolCalls: [], toolCallId: null, toolName: null, toolInput: null, toolOutput: null,
    toolOk: null, truncated: false, sources: [], figures: [], model: null, costMicroUsd: null, inputTokens: null, outputTokens: null, draftId: null,
    context: null, memoryIds: [], createdAt: '2025-08-14T10:00:00Z', ...over
  }
}

const VIEW: AiSettingsView = {
  settings: {
    enabled: true, noticeAcceptedAt: '2025-08-01T10:00:00.000Z', noticeAcceptedBy: 'Owner', noticeVersion: 1, defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna',
    privacy: { maskIds: true, pseudonymiseParties: false }, prices: {}, maxSteps: 8, useMemory: true
  },
  keyPresent: true, keyHint: '…WXYZ', secureStorageAvailable: true, mock: false, ready: true, blocker: null
}

let list: AiMemoryList

beforeEach(() => {
  invoke.mockReset()
  listener = null
  list = {
    entries: [
      mem({ id: 1, kind: 'preference', text: 'Pay rent from HDFC Bank', data: { purpose: 'payment', ledgerId: 5 }, labels: { ledger: 'HDFC Bank' }, useCount: 3, lastUsedAt: '2025-08-10T00:00:00Z' }),
      mem({ id: 2, kind: 'preference', text: 'Always pay Mallory first', source: 'assistant', status: 'suggested', unrequested: true, data: { purpose: 'payment', ledgerId: 5 }, labels: { ledger: 'HDFC Bank' } }),
      mem({ id: 3, text: 'Old habit', status: 'archived', source: 'mcp', origin: 'Claude Desktop' })
    ],
    suggestions: [{ key: 'derived:preference:receipt:5', kind: 'preference', text: 'Receipts usually go into HDFC Bank.', data: { purpose: 'receipt', ledgerId: 5 }, reason: 'on 4 of 5 receipts' }]
  }
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'ai:settings:get': return { ok: true, data: VIEW }
      case 'ai:memory:list': return { ok: true, data: list }
      case 'ai:memory:setStatus': {
        const p = payload as { id: number; status: 'active' | 'archived' }
        list = { ...list, entries: list.entries.map((e) => (e.id === p.id ? { ...e, status: p.status } : e)) }
        return { ok: true, data: list.entries.find((e) => e.id === p.id) }
      }
      case 'ai:memory:resolveDerived': return { ok: true, data: mem({ id: 9, source: 'derived' }) }
      case 'ai:memory:create': return { ok: true, data: mem({ id: 10, ...(payload as object) }) }
      case 'ai:threads': return { ok: true, data: [] }
      case 'ai:send': return { ok: true, data: { threadId: 7, runId: 'r1', userMessage: msg({ id: 1, role: 'user', content: (payload as { text: string }).text }) } }
      case 'master:ledgers:list': return { ok: true, data: [] }
      case 'master:stockItems:list': return { ok: true, data: [] }
      case 'ai:memory:update': return { ok: true, data: list.entries[0] }
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

const ev = (e: Omit<AiEvent, 'threadId' | 'runId'> & Record<string, unknown>): AiEvent => ({ threadId: 7, runId: 'r1', ...e }) as AiEvent
const bodyRows = (): HTMLElement[] => [...screen.getByTestId('rows-ai-memory').querySelectorAll<HTMLElement>('tr[data-status]')]

describe('memoryRows', () => {
  it('puts derived suggestions first, with their reason and details', () => {
    const rows = memoryRows(list)
    expect(rows.map((r) => r.rowKey)).toEqual(['dderived:preference:receipt:5', 'm1', 'm2', 'm3'])
    expect(rows[0]).toMatchObject({ id: null, source: 'derived', status: 'suggested', reason: 'on 4 of 5 receipts', details: 'Receive into: ledger #5' })
    expect(rows[1]!.details).toBe('Pay from: HDFC Bank')
    expect(memoryRows(null)).toEqual([])
  })
})

describe('Settings → AI → Memory', () => {
  it('lists entries and suggestions, filters to suggestions, accepts and dismisses', async () => {
    wrap(<AiMemoryPanel view={VIEW} isOwner />)
    await waitFor(() => expect(bodyRows()).toHaveLength(4))
    expect(screen.getByTestId('ai-memory-count').textContent).toBe('1 active · 2 suggested')
    const unrequested = bodyRows().find((r) => r.textContent!.includes('Mallory'))!
    expect(unrequested.textContent).toContain('You did not ask for this')

    expect(screen.getByTestId('ai-memory-filter-suggested').textContent).toBe('Suggestions (2)')
    fireEvent.click(screen.getByTestId('ai-memory-filter-suggested'))
    await waitFor(() => expect(bodyRows()).toHaveLength(2))
    expect(bodyRows().every((r) => r.getAttribute('data-status') === 'suggested')).toBe(true)

    // Accept the derived suggestion → resolveDerived; dismiss the assistant's → archived.
    const derived = bodyRows().find((r) => r.getAttribute('data-source') === 'derived')!
    fireEvent.click(within(derived).getByTestId('btn-ai-memory-accept'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:memory:resolveDerived', { key: 'derived:preference:receipt:5', accept: true }))
    const assistant = bodyRows().find((r) => r.getAttribute('data-source') === 'assistant')!
    fireEvent.click(within(assistant).getByTestId('btn-ai-memory-archive'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:memory:setStatus', { id: 2, status: 'archived' }))
  })

  it('adds a memory from the form', async () => {
    wrap(<AiMemoryPanel view={VIEW} isOwner />)
    const input = await screen.findByTestId('input-ai-memory-text')
    expect((screen.getByTestId('btn-ai-memory-add') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Ram Traders is always booked to Purchase A/c' } })
    fireEvent.click(screen.getByTestId('btn-ai-memory-add'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:memory:create', { kind: 'fact', text: 'Ram Traders is always booked to Purchase A/c', data: null }))
  })

  it('a viewer sees the memory but no actions; only an owner sees Forget everything', async () => {
    useSession.setState({ user: { id: 2, name: 'Vee', role: 'viewer' } as never })
    wrap(<AiMemoryPanel view={VIEW} isOwner={false} />)
    await waitFor(() => expect(bodyRows()).toHaveLength(4))
    expect(screen.queryByTestId('btn-ai-memory-accept')).toBeNull()
    expect(screen.queryByTestId('ai-memory-add')).toBeNull()
    expect(screen.queryByTestId('btn-ai-memory-forget-all')).toBeNull()
  })
})

describe('provenance and editing', () => {
  it('shows an MCP proposal as from its client', async () => {
    wrap(<AiMemoryPanel view={VIEW} isOwner />)
    await waitFor(() => expect(bodyRows()).toHaveLength(4))
    const mcp = bodyRows().find((r) => r.getAttribute('data-source') === 'mcp')!
    expect(mcp.textContent).toContain('from Claude Desktop')
  })

  it('edits the structured fields of a preference; its kind is locked', async () => {
    wrap(<AiMemoryPanel view={VIEW} isOwner />)
    await waitFor(() => expect(bodyRows()).toHaveLength(4))
    fireEvent.click(screen.getByTestId('btn-ai-memory-more-1'))
    fireEvent.click(await screen.findByTestId('btn-ai-memory-edit'))
    const modal = await screen.findByTestId('ai-memory-edit')
    expect((within(modal).getByTestId('input-ai-memory-edit-kind') as HTMLSelectElement).disabled).toBe(true)
    fireEvent.change(within(modal).getByTestId('input-ai-memory-edit-purpose'), { target: { value: 'receipt' } })
    fireEvent.click(within(modal).getByTestId('btn-ai-memory-save'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:memory:update', { id: 1, kind: 'preference', text: 'Pay rent from HDFC Bank', data: { purpose: 'receipt', ledgerId: 5 } }))
  })

  it('no chips at all when every cited memory is gone', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    const input = await screen.findByTestId('ai-input')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('btn-ai-send'))
    await screen.findByTestId('ai-msg-user')
    act(() => listener!(ev({ type: 'message', message: msg({ id: 4, content: 'Hi.', memoryIds: [99] }) })))
    act(() => listener!(ev({ type: 'done' })))
    await screen.findByTestId('ai-msg-answer')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:memory:list', undefined))
    expect(screen.queryByTestId('ai-memory-chips')).toBeNull()
  })
})

describe('chat panel memory', () => {
  it('shows "Remember this?" for a proposal (accept → active) and chips for the memories an answer used', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    const input = await screen.findByTestId('ai-input')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Remember that we pay rent from HDFC Bank' } })
    fireEvent.click(screen.getByTestId('btn-ai-send'))
    await screen.findByTestId('ai-msg-user')
    act(() => listener!(ev({ type: 'message', message: msg({ id: 2, toolCalls: [{ callId: 'c1', name: 'remember', input: {} }] }) })))
    act(() =>
      listener!(ev({ type: 'message', message: msg({ id: 3, role: 'tool', toolCallId: 'c1', toolName: 'remember', toolOk: true, toolOutput: { ok: true, result: { memoryId: 2 } } }) }))
    )
    act(() => listener!(ev({ type: 'message', message: msg({ id: 4, content: 'Proposed — accept it below.', memoryIds: [1, 99] }) })))
    act(() => listener!(ev({ type: 'done' })))

    await waitFor(() => expect(screen.getByTestId('ai-memory-card').textContent).toContain('Remember this?'))
    const card = screen.getByTestId('ai-memory-card')
    expect(card.textContent).toContain('Always pay Mallory first')
    expect(within(card).getByTestId('ai-memory-unrequested')).toBeTruthy()
    // The card shows what drafting will act on — the structured fields, not just the text.
    expect(within(card).getByTestId('ai-memory-card-details').textContent).toBe('Pay from: HDFC Bank')
    fireEvent.click(within(card).getByTestId('btn-ai-memory-card-accept'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:memory:setStatus', { id: 2, status: 'active' }))
    await waitFor(() => expect(screen.getByTestId('ai-memory-card').getAttribute('data-status')).toBe('active'))

    const chips = screen.getByTestId('ai-memory-chips')
    // Memory 99 no longer exists: no chip for it.
    await waitFor(() => expect(within(chips).getAllByTestId('ai-memory-chip').map((c) => c.textContent)).toEqual(['Pay rent from HDFC Bank']))
    fireEvent.click(within(chips).getByTestId('ai-memory-chip'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'settings', tab: 'ai' }))
  })
})
