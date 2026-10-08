// WP 5.2 — the screen tools on a real (in-memory) company: every new read tool returns capped,
// sourced data; current_screen_data follows the screen context; explain_figure breaks a figure
// down (largest entries, previous period, anomalies) with every amount computed by the tool; the
// role gate; and end to end with the MockProvider: an "Explain this" turn sends the screen context
// (masked / pseudonymised), logs it in the outbound log, and its figures come back sourced to the
// ledger / voucher rows they were found in. Plus Regenerate, rename / pin and drafts per thread.
import { describe, expect, it } from 'vitest'
import type { CompanyInfo } from '@shared/domain'
import type { AiContext, AiEvent, AiSettings } from '@shared/ai'
import { explainContextFor } from '@shared/aiExplain'
import { TEST_INFO } from '../db/testdb'
import { saveVoucher } from '../services/vouchers'
import { tradeBooks, item, ledger, grn, dc, trade, typeId, type TradeBooks } from '../services/tradeFixture.testutil'
import type { Role } from '../services/roles'
import { AgentRuns, startTurn, type AgentDeps } from './agent'
import { MockProvider, demoScript } from './mockProvider'
import { createToolRegistry } from './tools'
import { SCREEN_CAPS, SCREEN_TOOLS, changePct, previousPeriod, sharePct } from './tools/screenTools'
import type { ToolContext } from './tools/registry'
import { defaultAiSettings } from './settings'
import * as store from './store'

const INFO: CompanyInfo = { ...TEST_INFO, name: 'Screen Tools Co' }
const PERIOD = { from: '2025-04-01', to: '2026-03-31' }

interface Books extends TradeBooks {
  cash: number
  bank: number
  rent: number
  widget: number
  rentVouchers: number[]
}

function journal(b: TradeBooks, date: string, dr: number, cr: number, amount: number, narration: string | null = null): number {
  return saveVoucher(b.db, {
    voucherTypeId: typeId(b.db, 'journal'), date, partyLedgerId: null, narration, reference: null, instrumentNo: null, instrumentDate: null,
    transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
    lines: [
      { ledgerId: dr, drCr: 'dr', amount, costAllocations: [] },
      { ledgerId: cr, drCr: 'cr', amount, costAllocations: [] }
    ],
    inventory: [], billRefs: [], tds: null
  }).id
}

function books(): Books {
  const b = tradeBooks()
  const cash = (b.db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const bank = ledger(b.db, 'HDFC Current', 'Bank Accounts')
  const rent = ledger(b.db, 'Shop Rent', 'Indirect Expenses')
  const widget = item(b.db, 'Widget', { opening: [10, 100_000] })
  journal(b, '2025-04-05', bank, b.buyer, 50_000_000, 'Capital via buyer') // money into the bank
  // Rent: four ordinary months last year and this year, one outsized entry, and a duplicate.
  const rentVouchers: number[] = []
  for (const m of ['05', '06', '07', '08']) rentVouchers.push(journal(b, `2025-${m}-01`, rent, cash, 1_000_000))
  rentVouchers.push(journal(b, '2025-09-01', rent, bank, 9_000_000, 'Deposit and arrears'))
  rentVouchers.push(journal(b, '2025-09-01', rent, bank, 9_000_000, 'Deposit and arrears'))
  for (const m of ['05', '06']) journal(b, `2024-${m}-01`, rent, cash, 800_000)
  grn(b, '2025-06-10', [{ item: widget, qty: 5, amount: 50_000 }])
  trade(b, 'sales', '2025-06-20', [{ item: widget, qty: 3, amount: 60_000 }])
  dc(b, '2025-07-01', [{ item: widget, qty: 2, amount: 0 }])
  return { ...b, cash, bank, rent, widget, rentVouchers }
}

const ctxFor = (b: Books, over: Partial<ToolContext> = {}): ToolContext => ({
  db: b.db, company: INFO, role: 'viewer' as Role, userName: null, threadId: null, messageId: null, today: '2025-10-15', period: PERIOD, ...over
})

type Data = Record<string, unknown>

describe('the WP 5.2 read tools run on a real company — capped, sourced, role-checked', () => {
  it('every screen tool returns data and sources', async () => {
    const b = books()
    const registry = createToolRegistry()
    const ctx = ctxFor(b, { role: 'accountant', screen: { screen: 'trial-balance', from: PERIOD.from, to: PERIOD.to } })
    const calls: [string, unknown][] = [
      ['current_screen_data', {}],
      ['explain_figure', { ledgerId: b.rent, from: '2025-04-01', to: '2026-03-31' }],
      ['item_movements', { itemId: b.widget }],
      ['manufacture_register', {}],
      ['trade_pending', { stage: 'grns' }],
      ['bank_unreconciled', {}],
      ['tds_eligible', {}],
      ['budget_variance', {}],
      ['forecast_summary', {}],
      ['audit_log_recent', {}]
    ]
    expect(calls.map((c) => c[0]).sort()).toEqual(SCREEN_TOOLS.map((t) => t.name).sort())
    for (const [name, args] of calls) {
      const r = await registry.run(name, JSON.stringify(args), ctx)
      expect(r.ok, `${name}: ${r.ok ? '' : r.error}`).toBe(true)
      if (r.ok) expect(r.sources.length, name).toBeGreaterThan(0)
      expect(registry.get(name)!.kind).toBe('read')
    }
  })

  it('item movements: opening, values and quantities formatted; voucher sources', async () => {
    const b = books()
    const r = await createToolRegistry().run('item_movements', JSON.stringify({ itemId: b.widget, from: '2025-04-01', to: '2025-12-31' }), ctxFor(b))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = r.data as Data
    expect(d.opening).toMatchObject({ value: '₹1,000.00' })
    expect((d.rows as Data[]).length).toBe(3)
    expect(r.sources).toContainEqual({ kind: 'item', itemId: b.widget, label: 'Widget' })
    expect(r.sources.some((s) => s.kind === 'voucher')).toBe(true)
  })

  it('caps rows with an explicit marker', async () => {
    const b = books()
    for (let i = 0; i < SCREEN_CAPS.movements + 5; i++) grn(b, '2025-11-02', [{ item: b.widget, qty: 1, amount: 1000 }])
    const r = await createToolRegistry().run('item_movements', JSON.stringify({ itemId: b.widget, from: '2025-11-01', to: '2025-11-30' }), ctxFor(b))
    expect(r.ok && (r.data as { rows: unknown[] }).rows.length).toBe(SCREEN_CAPS.movements)
    expect(r.ok && (r.data as { truncated: string }).truncated).toMatch(new RegExp(`showing ${SCREEN_CAPS.movements} of ${SCREEN_CAPS.movements + 5} rows`))
    const p = await createToolRegistry().run('trade_pending', JSON.stringify({ stage: 'grns', asOn: '2025-12-31' }), ctxFor(b))
    expect(p.ok && (p.data as { truncated: string }).truncated).toMatch(/showing 150 of/)
  })

  it('the audit log needs an accountant — refused for a viewer, also through current_screen_data', async () => {
    const b = books()
    const registry = createToolRegistry()
    const viewer = await registry.run('audit_log_recent', '{}', ctxFor(b))
    expect(viewer.ok).toBe(false)
    expect(!viewer.ok && viewer.error).toMatch(/needs accountant/)
    expect(registry.available('viewer').some((t) => t.name === 'audit_log_recent')).toBe(false)
    const viaScreen = await registry.run('current_screen_data', '{}', ctxFor(b, { screen: { screen: 'audit-trail' } }))
    expect(!viaScreen.ok && viaScreen.error).toMatch(/accountant/)
    const acc = await registry.run('audit_log_recent', JSON.stringify({ entity: 'voucher', limit: 5 }), ctxFor(b, { role: 'accountant' }))
    expect(acc.ok && (acc.data as { rows: Data[] }).rows.length).toBe(5)
    expect(acc.ok && (acc.data as { truncated: string }).truncated).toMatch(/showing the latest 5 of/)
  })
})

describe('current_screen_data follows the screen context', () => {
  it('returns the rows of the screen the user is on', async () => {
    const b = books()
    const registry = createToolRegistry()
    const tb = await registry.run('current_screen_data', '{}', ctxFor(b, { screen: { screen: 'trial-balance', label: 'Trial balance', from: PERIOD.from, to: '2025-09-30' } }))
    expect(tb.ok && (tb.data as Data).title).toBe('Trial balance')
    expect(tb.ok && (tb.data as Data).asOn).toBe('2025-09-30')
    const st = await registry.run('current_screen_data', '{}', ctxFor(b, { screen: { screen: 'ledger-statement', from: '2025-04-01', to: '2025-12-31', params: { ledgerId: b.rent } } }))
    expect(st.ok && (st.data as Data).ledger).toBe('Shop Rent')
    expect(st.ok && (st.data as Data).closing).toBe('₹2,20,000.00 Dr')
    const bank = await registry.run('current_screen_data', '{}', ctxFor(b, { screen: { screen: 'banking', params: { ledgerId: b.bank } } }))
    expect(bank.ok && (bank.data as Data).bank).toBe('HDFC Current')
    const voucher = await registry.run('current_screen_data', '{}', ctxFor(b, { screen: { screen: 'voucher-entry', params: { voucherId: b.rentVouchers[4]! } } }))
    expect(voucher.ok && (voucher.data as Data).total).toBe('₹90,000.00')
    const none = await registry.run('current_screen_data', '{}', ctxFor(b))
    expect(none.ok && (none.data as Data).note).toMatch(/did not say which screen/)
    const unknown = await registry.run('current_screen_data', '{}', ctxFor(b, { screen: { screen: 'settings' } }))
    expect(unknown.ok && (unknown.data as Data).note).toMatch(/no data tool/)
  })
})

describe('explain_figure', () => {
  it('pure helpers: share, change, previous period', () => {
    expect(sharePct(25, 200)).toBe(13)
    expect(sharePct(5, 0)).toBeNull()
    expect(changePct(150, 100)).toBe(50)
    expect(changePct(-50, 100)).toBe(-150)
    expect(changePct(1, 0)).toBeNull()
    expect(previousPeriod('2025-04-01', '2026-03-31')).toEqual({ from: '2024-04-01', to: '2025-03-31' })
    expect(previousPeriod('2025-07-01', '2025-07-31')).toEqual({ from: '2025-06-01', to: '2025-06-30' })
    expect(previousPeriod('2025-07-10', '2025-07-19')).toEqual({ from: '2025-06-30', to: '2025-07-09' })
  })

  it('a ledger: largest vouchers with shares, other sides, previous period and anomalies', async () => {
    const b = books()
    const r = await createToolRegistry().run('explain_figure', JSON.stringify({ ledgerId: b.rent, from: '2025-04-01', to: '2026-03-31' }), ctxFor(b))
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
    if (!r.ok) return
    const d = r.data as Data
    expect(d.closing).toBe('₹2,20,000.00 Dr')
    const top = d.largestVouchers as Data[]
    expect(top[0]).toMatchObject({ debit: '₹90,000.00', shareOfTurnover: '41%' })
    expect((d.byOtherSide as Data[])[0]).toMatchObject({ name: 'HDFC Current', vouchers: 2, debit: '₹1,80,000.00', ledgerId: b.bank })
    expect(d.previousPeriod).toMatchObject({ from: '2024-04-01', to: '2025-03-31', closing: '₹16,000.00 Dr', closingChangePct: '1275%' })
    const anomalies = (d.anomalies as Data[]).map((a) => a.what as string)
    expect(anomalies.some((a) => /at least 5 times the usual entry/.test(a))).toBe(true)
    expect(anomalies.some((a) => /Possible duplicate/.test(a))).toBe(true)
    expect(r.sources[0]).toEqual({ kind: 'screen', screen: 'ledger-statement', label: 'Shop Rent statement', params: { ledgerId: b.rent } })
    expect(r.sources.filter((s) => s.kind === 'voucher').length).toBeGreaterThan(0)
  })

  it('cash going negative is flagged', async () => {
    const b = books()
    journal(b, '2025-10-01', b.rent, b.cash, 100_000_000)
    const r = await createToolRegistry().run('explain_figure', JSON.stringify({ ledgerId: b.cash, from: '2025-04-01', to: '2026-03-31' }), ctxFor(b))
    expect(r.ok && ((r.data as Data).anomalies as Data[]).some((a) => /credit balance/.test(a.what as string))).toBe(true)
  })

  it('defaults to the screen’s figure: a group line, a voucher, an as-on balance', async () => {
    const b = books()
    const registry = createToolRegistry()
    const group: AiContext = { screen: 'profit-loss', from: '2025-04-01', to: '2026-03-31', explain: { label: 'Indirect Expenses', value: '₹2,20,000.00', groupName: 'Indirect Expenses', from: '2025-04-01', to: '2026-03-31' } }
    const g = await registry.run('explain_figure', '{}', ctxFor(b, { screen: group }))
    expect(g.ok, g.ok ? '' : g.error).toBe(true)
    expect(g.ok && (g.data as Data).amount).toBe('₹2,20,000.00')
    expect(g.ok && ((g.data as Data).madeUpOf as Data[])[0]).toMatchObject({ ledgerId: b.rent, name: 'Shop Rent', share: '100%', previous: '₹16,000.00' })
    const v = await registry.run('explain_figure', '{}', ctxFor(b, { screen: { screen: 'daybook', explain: { label: 'Journal', value: '₹90,000.00', voucherId: b.rentVouchers[4]! } } }))
    expect(v.ok && ((v.data as Data).lines as Data[]).map((l) => l.ledger)).toEqual(['Shop Rent', 'HDFC Current'])
    const asOn = await registry.run('explain_figure', '{}', ctxFor(b, { screen: { screen: 'trial-balance', explain: { label: 'Shop Rent', value: '₹2,20,000.00 Dr', ledgerId: b.rent, asOn: '2025-12-31' } } }))
    expect(asOn.ok && (asOn.data as Data).period).toEqual({ from: '2025-04-01', to: '2025-12-31' })
    const nothing = await registry.run('explain_figure', '{}', ctxFor(b))
    expect(!nothing.ok && nothing.error).toMatch(/Nothing to explain/)
  })
})

// ---------- end to end with the mock provider ----------

const ON: AiSettings = {
  ...defaultAiSettings(),
  enabled: true,
  noticeAcceptedAt: '2025-08-01T00:00:00.000Z',
  noticeAcceptedBy: 'Owner',
  noticeVersion: 1,
  privacy: { maskIds: true, pseudonymiseParties: true }
}

function deps(b: Books, provider: MockProvider, over: Partial<AgentDeps> = {}): AgentDeps & { events: AiEvent[] } {
  const events: AiEvent[] = []
  return {
    db: b.db, company: INFO, provider, registry: createToolRegistry(), settings: ON, user: { name: 'Arun', role: 'accountant' },
    emit: (e) => events.push(e), runs: new AgentRuns(), today: '2025-10-15', period: PERIOD, events, ...over
  }
}

describe('Explain this, end to end (MockProvider demo script)', () => {
  it('sends the screen context (pseudonymised), logs it, and answers with figures sourced to their rows', async () => {
    const b = books()
    const provider = new MockProvider(demoScript)
    const d = deps(b, provider)
    const { question, context } = explainContextFor({
      screen: 'trial-balance', screenLabel: 'Trial balance', label: 'Buyer', value: '₹4,99,400.00 Cr', ledgerId: b.buyer, asOn: '2026-03-31', from: PERIOD.from, to: PERIOD.to
    })
    const t = startTurn(d, { text: question, context })
    expect(await t.finished).toEqual({ status: 'done' })
    // The tool the explain asked for, with the figure's ids.
    const msgs = store.listMessages(b.db, t.threadId)
    const call = msgs.find((m) => m.role === 'assistant' && m.toolCalls.length)!.toolCalls[0]!
    expect(call).toMatchObject({ name: 'explain_figure', input: { ledgerId: b.buyer, asOn: '2026-03-31' } })
    // What was sent: the context lines, with the party name (a debtor) replaced by its alias.
    const sent = provider.requests[0]!.instructions
    expect(sent).toContain('Screen: Trial balance (trial-balance)')
    expect(sent).toContain('Figure to explain (JSON):')
    expect(sent).toMatch(/"label":"Party-\d{4}"/)
    expect(sent).not.toContain('"label":"Buyer"')
    expect(JSON.stringify(provider.requests[0]!.input)).not.toContain('Buyer =')
    // The outbound log records the context that went out.
    const out = store.listOutbound(b.db)
    expect(out.length).toBe(2)
    expect(out.every((o) => o.context?.explain?.ledgerId === b.buyer && o.context.screen === 'trial-balance')).toBe(true)
    // The answer: real names locally, every figure sourced and traced to a ledger or voucher.
    const answer = msgs.at(-1)!
    expect(answer.content).toContain('**Buyer** closed at ₹4,99,400.00 Cr')
    expect(answer.content).toContain('| Voucher | Date |')
    expect(answer.figures.length).toBeGreaterThan(2)
    expect(answer.figures.every((f) => f.sourced)).toBe(true)
    expect(answer.figures.find((f) => f.text.startsWith('₹4,99,400.00'))!.source).toEqual({ kind: 'ledger', ledgerId: b.buyer, label: 'Buyer' })
    // ₹5,00,000.00 is the journal's credit (a voucher row); the closing balance is the ledger's.
    expect(answer.figures.find((f) => f.text === '₹5,00,000.00')!.source).toMatchObject({ kind: 'voucher', label: 'Journal 1' })
    expect(answer.sources).toContainEqual({ kind: 'screen', screen: 'ledger-statement', label: 'Buyer statement', params: { ledgerId: b.buyer } })
  })

  it('"what is on this screen?" reads current_screen_data — no restating', async () => {
    const b = books()
    const provider = new MockProvider(demoScript)
    const t = startTurn(deps(b, provider), { text: 'What is on this screen?', context: { screen: 'ledger-statement', label: 'Ledger statement', from: '2025-04-01', to: '2025-12-31', params: { ledgerId: b.rent } } })
    await t.finished
    const msgs = store.listMessages(b.db, t.threadId)
    expect(msgs.some((m) => m.toolName === 'current_screen_data' && m.toolOk)).toBe(true)
    expect(msgs.at(-1)!.content).toContain('closing: ₹2,20,000.00 Dr')
    expect(provider.requests[0]!.instructions).toContain(`Screen parameters: ledgerId=${b.rent}`)
  })

  it('Regenerate answers the last question again without repeating it', async () => {
    const b = books()
    const d = deps(b, new MockProvider(demoScript))
    const t = startTurn(d, { text: 'What is on this screen?', context: { screen: 'trial-balance', from: PERIOD.from, to: PERIOD.to } })
    await t.finished
    const before = store.listMessages(b.db, t.threadId)
    const r = startTurn(d, { threadId: t.threadId, text: '', regenerate: true, context: { screen: 'trial-balance', from: PERIOD.from, to: PERIOD.to } })
    expect(r.userMessage.id).toBe(before[0]!.id)
    await r.finished
    const after = store.listMessages(b.db, t.threadId)
    expect(after.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(after.at(-1)!.content).toBe(before.at(-1)!.content)
    expect(after.at(-1)!.id).toBeGreaterThan(before.at(-1)!.id)
    expect(() => startTurn(d, { text: '', regenerate: true })).toThrow(/new conversation/)
  })
})

describe('threads: rename, pin, drafts per thread', () => {
  it('pinned threads sort first; renames are trimmed; drafts filter by thread', () => {
    const b = books()
    const a = store.createThread(b.db, 'First', null)
    const c = store.createThread(b.db, 'Second', null)
    store.setThreadPinned(b.db, a, true)
    expect(store.listThreads(b.db).map((t) => [t.id, t.pinned])).toEqual([[a, true], [c, false]])
    store.renameThread(b.db, c, '  Rent   question ')
    expect(store.getThread(b.db, c)!.title).toBe('Rent question')
    expect(() => store.renameThread(b.db, c, '   ')).toThrow(/needs a title/)
    const payload = { voucherTypeId: 1, voucherKind: 'payment', date: '2025-10-01', partyLedgerId: null, narration: null, reference: null, lines: [] }
    store.insertDraft(b.db, { threadId: a, messageId: null, summary: 'a', payload })
    store.insertDraft(b.db, { threadId: c, messageId: null, summary: 'c', payload })
    expect(store.listDrafts(b.db, undefined, a).map((x) => x.summary)).toEqual(['a'])
    expect(store.listDrafts(b.db, 'open', c).map((x) => x.summary)).toEqual(['c'])
  })
})
