// WP 5.2 — the chat panel (markdown, figure chips, context strip, threads, Regenerate, navigation
// by search), "Explain this" on a DataTable cell, a StatTile and a statement line, and the
// palette's Ask AI row. The pure helpers (markdown, row ids, money detection, screen context)
// are tested here too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { AiEvent, AiFigure, AiMessageDto, AiSettingsView, AiThreadDto } from '@shared/ai'
import type { CompanyInfo } from '@shared/domain'
import { DEFAULT_FEATURES } from '@shared/features'
import { parseMarkdown, inlineText } from '../lib/markdown'
import { looksLikeMoney, nodeText, rowSourceIds, useExplain } from '../lib/explain'
import { screenContextFor } from '../lib/aiContext'
import { applyAiEvent, loadThread } from '../lib/aiThread'
import { AssistantDrawer, AssistantPanel, useAssistantPanel } from '../components/ai/AssistantPanel'
import { AnswerMarkdown, assignFigures } from '../components/ai/Markdown'
import { tileExplainSources } from '../screens/Gateway'
import { DataTable, defineColumns } from '../components/table'
import { StatTile } from '../components/kit'
import { Money } from '../components/ui'
import { StatementTree } from '../components/StatementTree'
import { CommandPalette } from '../components/CommandPalette'
import { useNav, useSession } from '../state/stores'

const INFO: CompanyInfo = {
  name: 'Demo Traders', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2025, email: null, phone: null, pan: null, tan: null
}

const invoke = vi.fn()
let listener: ((e: unknown) => void) | null = null

function msg(over: Partial<AiMessageDto>): AiMessageDto {
  return {
    id: 1, threadId: 7, role: 'assistant', content: '', status: 'ok', toolCalls: [], toolCallId: null, toolName: null, toolInput: null,
    toolOutput: null, toolOk: null, truncated: false, sources: [], figures: [], model: null, costMicroUsd: null, inputTokens: null,
    outputTokens: null, draftId: null, context: null, memoryIds: [], createdAt: '2025-08-14T10:00:00Z', ...over
  }
}

const VIEW: AiSettingsView = {
  settings: {
    enabled: true, noticeAcceptedAt: '2025-08-01T10:00:00.000Z', noticeAcceptedBy: 'Owner', noticeVersion: 1, defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna',
    privacy: { maskIds: true, pseudonymiseParties: true }, prices: {}, maxSteps: 8, useMemory: true
  },
  keyPresent: true, keyHint: '…WXYZ', secureStorageAvailable: true, mock: false, ready: true, blocker: null
}

const THREADS: AiThreadDto[] = [
  { id: 7, title: 'Rent question', createdAt: '', updatedAt: '', messageCount: 2, costMicroUsd: 12_300, running: false, pinned: false },
  { id: 8, title: 'Sales in July', createdAt: '', updatedAt: '', messageCount: 2, costMicroUsd: null, running: false, pinned: true }
]

let view: AiSettingsView = VIEW
const ev = (e: Partial<AiEvent>): AiEvent => ({ threadId: 7, runId: 'r1', ...e }) as AiEvent

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear()
  invoke.mockReset()
  listener = null
  view = VIEW
  invoke.mockImplementation(async (channel: string, payload?: unknown) => {
    switch (channel) {
      case 'ai:settings:get': return { ok: true, data: view }
      case 'ai:threads': return { ok: true, data: THREADS }
      case 'ai:drafts': return { ok: true, data: [] }
      case 'ai:thread': return { ok: true, data: { thread: { id: 7, title: 'Rent question' }, messages: [msg({ id: 1, role: 'user', content: 'q' }), msg({ id: 2, content: 'Rent was ₹1,000.00.', figures: [{ text: '₹1,000.00', paise: 100_000, sourced: true, tool: 'ledger_statement', source: { kind: 'ledger', ledgerId: 5, label: 'Rent' } }] })], running: false } }
      case 'ai:send': {
        const p = payload as { text: string }
        return { ok: true, data: { threadId: 9, runId: 'r9', userMessage: msg({ id: 50, threadId: 9, role: 'user', content: p.text }) } }
      }
      case 'ai:regenerate': return { ok: true, data: { threadId: 7, runId: 'r2', userMessage: msg({ id: 1, role: 'user', content: 'q' }) } }
      case 'ai:thread:rename': return { ok: true, data: null }
      case 'ai:thread:pin': return { ok: true, data: null }
      case 'search:query':
        return { ok: true, data: { chips: [], unknown: [], terms: [], kinds: ['ledger'], ledgers: { total: 1, offset: 0, rows: [{ kind: 'ledger', id: 31, name: 'Acme Traders', groupName: 'Sundry Debtors', gstin: null, pan: null, matchField: 'name', matchText: 'Acme' }] }, items: null, vouchers: null } }
      case 'config:features:get': return { ok: true, data: DEFAULT_FEATURES }
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
  useSession.getState().setCompany('demo', INFO)
  useSession.setState({ user: null, from: '2025-04-01', to: '2026-03-31', workingDate: '2025-07-31' })
  useNav.setState({ stack: [{ name: 'trial-balance' }] })
  useAssistantPanel.setState({ open: false, pending: null, width: 460 })
  useExplain.setState({ ready: false, handler: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function wrap(node: ReactNode): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const sends = (): unknown[] => invoke.mock.calls.filter((c) => c[0] === 'ai:send').map((c) => c[1])

// ---------- pure ----------

describe('markdown (safe subset)', () => {
  it('parses tables, lists, headings and inline marks', () => {
    const blocks = parseMarkdown('# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n| A | B |\n|---|--:|\n| x | ₹1.00 |')
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'ul', 'ol', 'table'])
    const p = blocks[1]!
    expect(p.t === 'p' && p.v.map((x) => x.t)).toEqual(['text', 'strong', 'text', 'em', 'text', 'code', 'text'])
    const t = blocks[4]!
    expect(t.t === 'table' && t.align).toEqual(['left', 'right'])
    expect(t.t === 'table' && inlineText(t.rows[0]![1]!)).toBe('₹1.00')
  })

  it('renders HTML as text — never markup', () => {
    wrap(<AnswerMarkdown text={'<img src=x onerror=alert(1)> <b>bold</b> [link](http://evil)'} />)
    const md = screen.getByTestId('ai-markdown')
    expect(md.querySelector('img, b, a')).toBeNull()
    expect(md.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(md.textContent).toContain('[link](http://evil)')
  })
})

describe('explain helpers', () => {
  it('row ids: voucher first, then ledger (or party), then item', () => {
    expect(rowSourceIds({ voucherId: 3, ledgerId: 4 })).toEqual({ voucherId: 3 })
    expect(rowSourceIds({ ledgerId: 4, itemId: 2 })).toEqual({ ledgerId: 4 })
    expect(rowSourceIds({ partyLedgerId: 6 })).toEqual({ ledgerId: 6 })
    expect(rowSourceIds({ stockItemId: 2 })).toEqual({ itemId: 2 })
    expect(rowSourceIds({ ledgerId: 0, name: 'x' })).toEqual({})
  })
  it('money detection and node text', () => {
    expect(looksLikeMoney('₹1,234.00')).toBe(true)
    expect(looksLikeMoney('1,23,456.00 Dr')).toBe(true)
    expect(looksLikeMoney('₹1.2L')).toBe(true)
    expect(looksLikeMoney('3 overdue')).toBe(false)
    expect(looksLikeMoney('12')).toBe(false)
    expect(nodeText(<span>Cash <Money paise={150_000} signed /></span>)).toBe('Cash ₹1,500.00 Dr')
  })
  it('screen context: nav params, title, registered params', () => {
    expect(screenContextFor({ name: 'ledger-statement', ledgerId: 5 }, '2025-04-01', '2026-03-31', { tab: 'x' })).toEqual({
      screen: 'ledger-statement', label: 'Ledger statement', from: '2025-04-01', to: '2026-03-31', params: { ledgerId: 5, tab: 'x' }
    })
    const draft = screenContextFor({ name: 'voucher-entry', draft: { lines: [] } as never }, '2025-04-01', '2026-03-31')
    expect(draft.params).toBeUndefined()
  })
})

describe('Regenerate in the reducer', () => {
  it('a run-start for a question already in the list drops its old answer', () => {
    const s0 = loadThread(7, [msg({ id: 1, role: 'user', content: 'q' }), msg({ id: 2, content: 'old answer' })], false)
    const s1 = applyAiEvent(s0, ev({ type: 'run-start', runId: 'r2', userMessage: msg({ id: 1, role: 'user', content: 'q' }) }))
    expect(s1.messages.map((m) => m.id)).toEqual([1])
    expect(s1.running).toBe(true)
  })
})

// ---------- the panel ----------

describe('chat panel', () => {
  it('context strip shows the company, period, screen and what the model will be told', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    const strip = await screen.findByTestId('ai-context')
    expect(strip.textContent).toContain('Demo Traders')
    expect(screen.getByTestId('ai-context-screen').textContent).toBe('Trial balance')
    fireEvent.click(screen.getByTestId('btn-ai-context'))
    const detail = screen.getByTestId('ai-context-detail')
    expect(detail.textContent).toContain('Screen: Trial balance (trial-balance)')
    expect(detail.textContent).toContain('Period on screen: 01-Apr-25 to 31-Mar-26')
    await waitFor(() => expect(detail.textContent).toContain('party names are replaced by aliases'))
  })

  it('sends with the screen context; Enter sends, Shift+Enter does not; Esc closes', async () => {
    const onClose = vi.fn()
    wrap(<AssistantDrawer onClose={onClose} />)
    const input = await screen.findByTestId('ai-input')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'why is this high?' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(sends()).toHaveLength(0)
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(sends()).toEqual([{ threadId: undefined, text: 'why is this high?', context: { screen: 'trial-balance', label: 'Trial balance', from: '2025-04-01', to: '2026-03-31', workingDate: '2025-07-31' } }]))
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('"open the ledger for Acme" resolves through search and navigates — never sent to the model', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    const input = await screen.findByTestId('ai-input')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'open the ledger for Acme' } })
    fireEvent.click(screen.getByTestId('btn-ai-send'))
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'ledger-statement', ledgerId: 31 }))
    expect(invoke.mock.calls.find((c) => c[0] === 'search:query')![1]).toMatchObject({ q: 'Acme' })
    expect(sends()).toHaveLength(0)
  })

  it('answers render markdown with figure chips linking to their source; Copy and Regenerate', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    wrap(<AssistantDrawer onClose={() => {}} />)
    const input = await screen.findByTestId('ai-input')
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: 'Explain rent' } })
    fireEvent.click(screen.getByTestId('btn-ai-send'))
    await screen.findByTestId('ai-msg-user')
    act(() =>
      listener!(ev({
        type: 'message', threadId: 9, runId: 'r9',
        message: msg({
          id: 52, threadId: 9, content: '**Rent** closed at ₹2,20,000.00 Dr.\n\n| Voucher | Amount |\n|---|--:|\n| Journal 5 | ₹90,000.00 |\n\nMaybe ₹7.00 more.',
          figures: [
            { text: '₹2,20,000.00 Dr', paise: 22_000_000, sourced: true, tool: 'explain_figure', source: { kind: 'ledger', ledgerId: 5, label: 'Rent' } },
            { text: '₹90,000.00', paise: 9_000_000, sourced: true, tool: 'explain_figure', source: { kind: 'voucher', voucherId: 12, label: 'Journal 5' } },
            { text: '₹7.00', paise: 700, sourced: false, tool: null }
          ]
        })
      }))
    )
    act(() => listener!(ev({ type: 'done', threadId: 9, runId: 'r9' })))
    const answer = screen.getByTestId('ai-msg-answer')
    expect(within(answer).getByTestId('ai-md-table')).toBeTruthy()
    const chips = within(answer).getAllByTestId('ai-figure')
    expect(chips.map((c) => [c.textContent, c.getAttribute('data-sourced'), c.getAttribute('data-source-kind')])).toEqual([
      ['₹2,20,000.00 Dr', 'true', 'ledger'],
      ['₹90,000.00', 'true', 'voucher'],
      ['₹7.00? (unsourced)', 'false', null]
    ])
    expect(within(answer).getByTestId('ai-unsourced').textContent).toContain('₹7.00')
    fireEvent.click(chips[0]!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'ledger-statement', ledgerId: 5 }))
    fireEvent.click(chips[1]!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', voucherId: 12 }))

    fireEvent.click(within(answer).getByTestId('btn-ai-copy'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('**Rent** closed at')))
    fireEvent.click(within(answer).getByTestId('btn-ai-regenerate'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:regenerate', expect.objectContaining({ threadId: 9 })))
  })

  it('conversations: search, open, rename, pin; the thread cost shows', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    fireEvent.click(await screen.findByTestId('btn-ai-threads'))
    const list = await screen.findByTestId('ai-thread-list')
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2))
    fireEvent.change(screen.getByTestId('input-ai-thread-search'), { target: { value: 'rent' } })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('btn-ai-pin-7'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:thread:pin', { id: 7, pinned: true }))
    fireEvent.click(screen.getByTestId('btn-ai-rename-7'))
    const title = screen.getByTestId('input-ai-thread-title')
    fireEvent.change(title, { target: { value: 'Rent in September' } })
    fireEvent.keyDown(title, { key: 'Enter' })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:thread:rename', { id: 7, title: 'Rent in September' }))
    fireEvent.click(screen.getByTestId('btn-ai-open-thread-7'))
    await waitFor(() => expect(screen.getByTestId('ai-thread-subtitle').textContent).toBe('Rent question · $0.0123'))
    expect(screen.getByTestId('ai-msg-answer').textContent).toContain('Rent was ₹1,000.00.')
  })
})

// ---------- Explain this ----------

interface TbRow {
  ledgerId: number
  ledgerName: string
  debit: number
}
const TB_COLUMNS = defineColumns<TbRow>([
  { id: 'ledger', header: 'Ledger', kind: 'text', value: (r) => r.ledgerName },
  { id: 'debit', header: 'Debit', kind: 'money', value: (r) => r.debit },
  { id: 'count', header: 'Count', kind: 'number', value: () => 3 }
])

describe('Explain this', () => {
  it('hidden while the assistant is off; on a DataTable money cell it asks about the figure with its source', async () => {
    wrap(
      <>
        <DataTable testId="tb" columns={TB_COLUMNS} rows={[{ ledgerId: 5, ledgerName: 'Shop Rent', debit: 22_000_000 }, { ledgerId: 6, ledgerName: 'Zero', debit: 0 }]} rowKey={(r) => r.ledgerId} />
      </>
    )
    expect(screen.queryByTestId('tb-explain-debit')).toBeNull()
    cleanup()
    wrap(
      <>
        <AssistantPanel />
        <DataTable testId="tb" columns={TB_COLUMNS} rows={[{ ledgerId: 5, ledgerName: 'Shop Rent', debit: 22_000_000 }, { ledgerId: 6, ledgerName: 'Zero', debit: 0 }]} rowKey={(r) => r.ledgerId} />
      </>
    )
    // One per non-zero money cell; none on the number column.
    const buttons = await screen.findAllByTestId('tb-explain-debit')
    expect(buttons).toHaveLength(1)
    expect(screen.queryByTestId('tb-explain-count')).toBeNull()
    fireEvent.click(buttons[0]!)
    expect(useAssistantPanel.getState().open).toBe(true)
    await waitFor(() => expect(sends()).toHaveLength(1))
    expect(sends()[0]).toEqual({
      threadId: undefined,
      text: 'Explain this figure: Shop Rent — Debit = ₹2,20,000.00 on Trial balance, as on 31-Mar-26. Which vouchers and ledgers make it up, how does it compare with the previous period, and is anything unusual?',
      context: {
        screen: 'trial-balance', label: 'Trial balance', from: '2025-04-01', to: '2026-03-31',
        explain: { label: 'Shop Rent', value: '₹2,20,000.00', paise: 22_000_000, column: 'Debit', ledgerId: 5, asOn: '2026-03-31' }
      }
    })
    expect(screen.getByTestId('ai-panel')).toBeTruthy()
  })

  it('on a tile: label and value from the tile (plus its ids); not on a count tile', async () => {
    useNav.setState({ stack: [{ name: 'gateway' }] })
    wrap(
      <>
        <AssistantPanel />
        <StatTile testId="tile-recv" label="Receivables" value={<Money paise={4_000_000} />} explain={{ groupName: 'Sundry Debtors' }} onClick={() => {}} openLabel="Open Outstandings" />
        <StatTile testId="tile-count" label="Overdue" value="3 bills" />
      </>
    )
    const btn = await screen.findByTestId('tile-recv-explain')
    expect(screen.queryByTestId('tile-count-explain')).toBeNull()
    // The action is beside the tile button, not inside it.
    expect(screen.getByTestId('tile-recv').contains(btn)).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(sends()).toHaveLength(1))
    expect((sends()[0] as { context: unknown }).context).toEqual({
      screen: 'gateway', label: 'Gateway', from: '2025-04-01', to: '2026-03-31',
      explain: { label: 'Receivables', value: '₹40,000.00', groupName: 'Sundry Debtors', from: '2025-04-01', to: '2026-03-31' }
    })
  })

  it('on a statement line: a ledger by id, a group by name', async () => {
    useNav.setState({ stack: [{ name: 'profit-loss' }] })
    wrap(
      <>
        <AssistantPanel />
        <StatementTree nodes={[{ kind: 'group', id: 3, name: 'Indirect Expenses', amount: 500_000, children: [{ kind: 'ledger', id: 5, name: 'Shop Rent', amount: 500_000, children: [] }] }]} expandAll />
      </>
    )
    const btns = await screen.findAllByTestId('statement-explain')
    expect(btns).toHaveLength(2)
    fireEvent.click(btns[1]!)
    await waitFor(() => expect(sends()).toHaveLength(1))
    expect((sends()[0] as { context: { explain: unknown } }).context.explain).toEqual({ label: 'Shop Rent', value: '₹5,000.00', paise: 500_000, ledgerId: 5, from: '2025-04-01', to: '2026-03-31' })
  })
})

// ---------- the palette ----------

describe('palette: Ask AI', () => {
  function palette(): void {
    wrap(
      <>
        <AssistantPanel />
        <CommandPalette onClose={() => {}} />
      </>
    )
  }

  it('a question offers Ask AI first; it opens the panel and asks with the screen context', async () => {
    palette()
    await waitFor(() => expect(useExplain.getState().ready).toBe(true))
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: 'why is rent so high?' } })
    const row = await screen.findByTestId('palette-ask-ai')
    expect(row.textContent).toContain('Ask AI: why is rent so high?')
    fireEvent.keyDown(screen.getByTestId('input-palette'), { key: 'Enter' })
    await waitFor(() => expect(sends()).toHaveLength(1))
    expect(sends()[0]).toMatchObject({ text: 'why is rent so high?', context: { screen: 'trial-balance' } })
  })

  it('no Ask AI row while the assistant is off, or for a plain search', async () => {
    view = { ...VIEW, ready: false, blocker: 'Add an API key' }
    palette()
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: 'why is rent so high?' } })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('palette-ask-ai')).toBeNull()
    cleanup()
    view = VIEW
    palette()
    await waitFor(() => expect(useExplain.getState().ready).toBe(true))
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: 'Acme' } })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('palette-ask-ai')).toBeNull()
  })

  it('"open the ledger for Acme" searches for Acme (the search service resolves it)', async () => {
    palette()
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: 'open the ledger for Acme' } })
    await screen.findByTestId('palette-hit-ledger-31')
    expect(invoke.mock.calls.filter((c) => c[0] === 'search:query').at(-1)![1]).toMatchObject({ q: 'Acme' })
  })
})

// ---------- WP 5.2 review ----------

describe('review: figures by occurrence, ambiguous chips, code spans', () => {
  const ten = (voucherId: number): AiFigure => ({ text: '₹10,000.00', paise: 1_000_000, sourced: true, tool: 'explain_figure', source: { kind: 'voucher', voucherId, label: `Journal ${voucherId}` } })

  it('three ₹10,000.00 rows: each chip opens its own voucher; an ambiguous one opens the report', async () => {
    const amb: AiFigure = { text: '₹10,000.00', paise: 1_000_000, sourced: true, tool: 'explain_figure', ambiguous: true, source: { kind: 'screen', screen: 'ledger-statement', label: 'Rent statement', params: { ledgerId: 7 } } }
    wrap(<AnswerMarkdown text={'| V | Amount |\n|---|--:|\n| Journal 3 | ₹10,000.00 |\n| Journal 4 | ₹10,000.00 |\n| Journal 5 | ₹10,000.00 |\n\nMedian ₹10,000.00.'} figures={[ten(3), ten(4), ten(5), amb]} />)
    const chips = screen.getAllByTestId('ai-figure')
    expect(chips.map((c) => c.getAttribute('data-voucher-id'))).toEqual(['3', '4', '5', null])
    expect(chips[3]!.getAttribute('data-ambiguous')).toBe('true')
    fireEvent.click(chips[1]!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'voucher-entry', voucherId: 4 }))
    fireEvent.click(chips[3]!)
    await waitFor(() => expect(useNav.getState().stack.at(-1)).toEqual({ name: 'ledger-statement', ledgerId: 7 }))
  })

  it('an unsourced figure inside a code span is still flagged', () => {
    wrap(<AnswerMarkdown text={'Total `₹7.00` here.'} figures={[{ text: '₹7.00', paise: 700, sourced: false, tool: null }]} />)
    const chip = screen.getByTestId('ai-figure')
    expect(chip.getAttribute('data-sourced')).toBe('false')
    expect(chip.closest('code')).not.toBeNull()
  })

  it('assignFigures keeps document order and tolerates extra occurrences', () => {
    const parts = assignFigures(['a ₹10,000.00 b', '₹10,000.00'], [ten(3), ten(4)])
    expect(parts.map((p) => p.filter((x) => typeof x !== 'string').map((f) => (f as AiFigure).source))).toEqual([[ten(3).source], [ten(4).source]])
  })
})

describe('review: dashboard tiles explain the dates they show', () => {
  it('balances as on the as-on date, month tiles over the clipped month, Net profit over the period', () => {
    const w = { from: '2026-04-01', to: '2027-03-31', asOn: '2026-10-08', focusMonth: '2026-10' }
    const ex = tileExplainSources(w)
    expect(ex.cash).toEqual({ groupName: 'Cash-in-Hand + Bank Accounts', asOn: '2026-10-08' })
    expect(ex.receivables).toEqual({ groupName: 'Sundry Debtors', asOn: '2026-10-08' })
    expect(ex.sales).toEqual({ groupName: 'Sales Accounts', from: '2026-10-01', to: '2026-10-08' })
    expect(ex.profit).toMatchObject({ from: '2026-04-01', to: '2026-10-08' })
    // a past period: everything as on its end
    const past = tileExplainSources({ from: '2025-04-01', asOn: '2026-03-31', focusMonth: '2026-03' })
    expect(past.profit).toMatchObject({ from: '2025-04-01', to: '2026-03-31' })
    expect(past.purchases).toMatchObject({ from: '2026-03-01', to: '2026-03-31' })
  })
})

describe('review: rename saves once; Esc cancels', () => {
  it('Enter then blur renames once; Esc then blur does not rename', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    fireEvent.click(await screen.findByTestId('btn-ai-threads'))
    await screen.findByTestId('btn-ai-rename-7')
    fireEvent.click(screen.getByTestId('btn-ai-rename-7'))
    let input = screen.getByTestId('input-ai-thread-title')
    fireEvent.change(input, { target: { value: 'Once' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    await waitFor(() => expect(invoke.mock.calls.filter((c) => c[0] === 'ai:thread:rename')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByTestId('input-ai-thread-title')).toBeNull())
    fireEvent.click(screen.getByTestId('btn-ai-rename-7'))
    input = screen.getByTestId('input-ai-thread-title')
    fireEvent.change(input, { target: { value: 'Never' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    await new Promise((r) => setTimeout(r, 20))
    expect(invoke.mock.calls.filter((c) => c[0] === 'ai:thread:rename')).toHaveLength(1)
  })
})

describe('review: keyboard and regenerate', () => {
  it('⌘⇧E explains the active table row (the buttons are not Tab stops)', async () => {
    wrap(
      <>
        <AssistantPanel />
        <DataTable testId="tb" columns={TB_COLUMNS} rows={[{ ledgerId: 5, ledgerName: 'Shop Rent', debit: 22_000_000 }]} rowKey={(r) => r.ledgerId} />
      </>
    )
    const btn = await screen.findByTestId('tb-explain-debit')
    expect(btn.getAttribute('tabindex')).toBe('-1')
    btn.closest('tr')!.setAttribute('data-active', 'true')
    fireEvent.keyDown(window, { key: 'E', metaKey: true, shiftKey: true })
    await waitFor(() => expect(sends()).toHaveLength(1))
    expect((sends()[0] as { context: { explain: { ledgerId: number } } }).context.explain.ledgerId).toBe(5)
  })

  it('Regenerate does not send the current screen (main re-asks with the question’s own context)', async () => {
    wrap(<AssistantDrawer onClose={() => {}} />)
    fireEvent.click(await screen.findByTestId('btn-ai-threads'))
    fireEvent.click(await screen.findByTestId('btn-ai-open-thread-7'))
    await screen.findByTestId('ai-msg-answer')
    useNav.setState({ stack: [{ name: 'daybook' }] })
    fireEvent.click(await screen.findByTestId('btn-ai-regenerate'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:regenerate', { threadId: 7 }))
  })
})

describe('review: palette — an exact hit keeps the Enter default', () => {
  it('"Acme Traders?" matching a ledger: the hit comes first, Ask AI last', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'search:query') {
        return { ok: true, data: { chips: [], unknown: [], terms: [], kinds: ['ledger'], ledgers: { total: 1, offset: 0, rows: [{ kind: 'ledger', id: 31, name: 'Acme Traders', groupName: 'Sundry Debtors', gstin: null, pan: null, matchField: 'name', matchText: 'Acme' }] }, items: null, vouchers: null } }
      }
      if (channel === 'ai:settings:get') return { ok: true, data: VIEW }
      if (channel === 'config:features:get') return { ok: true, data: DEFAULT_FEATURES }
      return { ok: true, data: [] }
    })
    wrap(
      <>
        <AssistantPanel />
        <CommandPalette onClose={() => {}} />
      </>
    )
    await waitFor(() => expect(useExplain.getState().ready).toBe(true))
    fireEvent.change(screen.getByTestId('input-palette'), { target: { value: 'Acme Traders?' } })
    await screen.findByTestId('palette-hit-ledger-31')
    const ask = await screen.findByTestId('palette-ask-ai')
    const hit = screen.getByTestId('palette-hit-ledger-31')
    expect(hit.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
