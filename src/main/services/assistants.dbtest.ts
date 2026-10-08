// WP 5.5 — the assistants on a real (in-memory) company: the close checklist computed from the
// books (and its marks persisted + audited), anomalies (binned vouchers out, dismissals kept),
// GSTR-2B mismatches from a stored statement with a draft that is ONLY a draft (the books do not
// change until the user saves it — and then the mismatch is gone), build_report equal to the
// report builder, the AI tools equal to the services, and "Run with AI" pre-calling a tool.
import { describe, expect, it } from 'vitest'
import type { CompanyInfo } from '@shared/domain'
import type { AiEvent, AiSettings } from '@shared/ai'
import { TEST_INFO } from '../db/testdb'
import { createLedger } from './masters'
import { saveVoucher, deleteVoucher } from './vouchers'
import { runReport } from './reportBuilder'
import { tradeBooks, item, ledger, trade, typeId, type TradeBooks } from './tradeFixture.testutil'
import * as assist from './assistants'
import { createToolRegistry } from '../ai/tools'
import { AgentRuns, startTurn } from '../ai/agent'
import { MockProvider, demoScript } from '../ai/mockProvider'
import { defaultAiSettings } from '../ai/settings'
import { insertPlanDraft } from '../ai/assistantDrafts'
import { consumeDraft } from '../ai/drafts'
import * as store from '../ai/store'
import type { ToolContext } from '../ai/tools/registry'
import type { Role } from './roles'
import { parseReportQuestion, requestToModel } from '@shared/reportBuilder/nl'
import { nameLookup } from '../ai/tools/assistantTools'

const GSTIN = '27AAPFU0939F1ZV'
const INFO: CompanyInfo = { ...TEST_INFO, name: 'Assist Co', gstin: '27AAACR5055K1Z7' }
const PERIOD = { from: '2025-04-01', to: '2026-03-31' }
const TODAY = '2025-06-25'

interface Books extends TradeBooks {
  cash: number
  bank: number
  rent: number
  vendor: number
  cgst: number
  sgst: number
  suspense: number
}

const header = { narration: null as string | null, reference: null as string | null, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null }

function voucher(b: TradeBooks, kind: 'journal' | 'payment' | 'purchase', date: string, lines: [number, 'dr' | 'cr', number][], extra: { narration?: string | null; reference?: string | null; party?: number | null } = {}): number {
  return saveVoucher(b.db, {
    ...header, voucherTypeId: typeId(b.db, kind), date, partyLedgerId: extra.party ?? null,
    narration: extra.narration === undefined ? 'entry' : extra.narration, reference: extra.reference ?? null,
    lines: lines.map(([ledgerId, drCr, amount]) => ({ ledgerId, drCr, amount, costAllocations: [] })), inventory: [], billRefs: [], tds: null
  }).id
}

function books(): Books {
  const b = tradeBooks()
  const db = b.db
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const bank = ledger(db, 'HDFC Current', 'Bank Accounts')
  const rent = ledger(db, 'Shop Rent', 'Indirect Expenses')
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const mk = (name: string, group: string, over: Record<string, unknown> = {}): number =>
    createLedger(db, { name, groupId: g(group), openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null, ...over }).id
  const vendor = mk('Acme Supplies', 'Sundry Creditors', { gstin: GSTIN, stateCode: '27' })
  const cgst = mk('Input CGST', 'Duties & Taxes', { taxType: 'cgst' })
  const sgst = mk('Input SGST', 'Duties & Taxes', { taxType: 'sgst' })
  const suspense = mk('Suspense', 'Suspense A/c', { openingBalance: 50_000 })
  return { ...b, cash, bank, rent, vendor, cgst, sgst, suspense }
}

const ctxFor = (b: Books, over: Partial<ToolContext> = {}): ToolContext => ({
  db: b.db, company: INFO, role: 'viewer' as Role, userName: null, threadId: null, messageId: null, today: TODAY, period: PERIOD, ...over
})

const booksDigest = (b: Books): string =>
  JSON.stringify([
    b.db.prepare('SELECT id, date, deleted_at FROM vouchers ORDER BY id').all(),
    b.db.prepare('SELECT voucher_id, ledger_id, dr_cr, amount FROM voucher_lines ORDER BY id').all()
  ])

const audits = (b: Books, entity: string): { action: string; before_json: string | null; after_json: string | null }[] =>
  b.db.prepare('SELECT action, before_json, after_json FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as never

describe('month-end close checklist', () => {
  it('computes the checks from the books; tool output equals the service; marks persist and are audited', async () => {
    const b = books()
    const widget = item(b.db, 'Widget')
    // A bank payment without a bank date, a sale of stock never received (negative stock), a
    // voucher without narration, rent paid three months running but not in May.
    voucher(b, 'payment', '2025-05-10', [[b.rent, 'dr', 10_000_00], [b.bank, 'cr', 10_000_00]])
    trade(b, 'sales', '2025-05-12', [{ item: widget, qty: 3, amount: 30_000 }])
    voucher(b, 'journal', '2025-05-14', [[b.rent, 'dr', 5_00], [b.cash, 'cr', 5_00]], { narration: null })
    const c = assist.closeChecklist(b.db, INFO, '2025-05', TODAY)
    const by = new Map(c.checks.map((x) => [x.key, x]))
    expect(by.get('bank_reconciliation')).toMatchObject({ effective: 'warn' })
    expect(by.get('bank_reconciliation')!.rows[0]).toMatchObject({ amount: 10_000_00, ledgerId: b.bank })
    expect(by.get('negative_stock')).toMatchObject({ effective: 'fail', rows: [{ itemId: widget }] })
    expect(by.get('suspense')).toMatchObject({ effective: 'fail', rows: [{ ledgerId: b.suspense, amount: 50_000 }] })
    expect(by.get('narration')!.rows.map((r) => r.voucherId).length).toBeGreaterThanOrEqual(1)
    expect(by.get('gst_returns')).toMatchObject({ effective: 'fail', dueDate: '2025-06-11' }) // today is past the 11th
    expect(by.get('lock')!.effective).toBe('warn')

    // The AI tool returns the same statuses.
    const tool = createToolRegistry().get('close_checklist')!
    const out = (await tool.handler({ period: '2025-05' }, ctxFor(b))) as { data: { checks: { key: string; status: string }[] } }
    expect(out.data.checks.map((x) => [x.key, x.status])).toEqual(c.checks.map((x) => [x.key, x.effective]))

    // Mark done (audited, with the note), then undo (audited delete).
    assist.markCloseCheck(b.db, '2025-05', 'negative_stock', 'done', 'GRN entered late', 'Priya')
    const after = assist.closeChecklist(b.db, INFO, '2025-05', TODAY)
    expect(after.checks.find((x) => x.key === 'negative_stock')).toMatchObject({ status: 'fail', effective: 'done', mark: { by: 'Priya', note: 'GRN entered late' } })
    expect(after.progress.cleared).toBe(c.progress.cleared + 1)
    assist.markCloseCheck(b.db, '2025-05', 'negative_stock', null, null, 'Priya')
    expect(assist.closeChecklist(b.db, INFO, '2025-05', TODAY).checks.find((x) => x.key === 'negative_stock')!.mark).toBeNull()
    expect(audits(b, 'assistant_mark').map((a) => a.action)).toEqual(['create', 'delete'])
    expect(JSON.parse(audits(b, 'assistant_mark')[0]!.after_json!)).toMatchObject({ assistant: 'close', scope: '2025-05', key: 'negative_stock', status: 'done' })
  })
})

describe('anomalies', () => {
  it('finds a duplicate, ignores binned vouchers, and keeps dismissals (audited)', () => {
    const b = books()
    const a = voucher(b, 'payment', '2025-05-05', [[b.vendor, 'dr', 25_000_00], [b.bank, 'cr', 25_000_00]], { party: b.vendor })
    const dup = voucher(b, 'payment', '2025-05-06', [[b.vendor, 'dr', 25_000_00], [b.bank, 'cr', 25_000_00]], { party: b.vendor })
    const r = assist.anomalies(b.db, '2025-05-01', '2025-05-31')
    const d = r.rows.find((x) => x.kind === 'duplicate_party_amount')!
    expect(d).toMatchObject({ voucherId: dup, relatedVoucherIds: [a], severity: 'high' })

    assist.dismissAnomaly(b.db, d.key, true, 'two invoices', 'Priya')
    const again = assist.anomalies(b.db, '2025-05-01', '2025-05-31')
    expect(again.rows.some((x) => x.key === d.key)).toBe(false)
    expect(again.counts.dismissed).toBe(1)
    expect(assist.anomalies(b.db, '2025-05-01', '2025-05-31', { includeDismissed: true }).rows.find((x) => x.key === d.key)!.dismissed).toMatchObject({ by: 'Priya', note: 'two invoices' })
    expect(audits(b, 'assistant_mark').length).toBe(1)

    // A binned voucher is no longer in the books: the duplicate disappears.
    assist.dismissAnomaly(b.db, d.key, false, null, 'Priya')
    deleteVoucher(b.db, dup)
    expect(assist.anomalies(b.db, '2025-05-01', '2025-05-31').rows.some((x) => x.kind === 'duplicate_party_amount')).toBe(false)
  })

  it('the find_anomalies tool returns the service rows (formatted)', async () => {
    const b = books()
    voucher(b, 'payment', '2025-05-05', [[b.vendor, 'dr', 25_000_00], [b.bank, 'cr', 25_000_00]], { party: b.vendor })
    voucher(b, 'payment', '2025-05-06', [[b.vendor, 'dr', 25_000_00], [b.bank, 'cr', 25_000_00]], { party: b.vendor })
    const svc = assist.anomalies(b.db, '2025-05-01', '2025-05-31')
    const out = (await createToolRegistry().get('find_anomalies')!.handler({ from: '2025-05-01', to: '2025-05-31' }, ctxFor(b))) as { data: { anomalies: { key: string; amount?: string }[] } }
    expect(out.data.anomalies.map((x) => x.key)).toEqual(svc.rows.map((x) => x.key))
    expect(out.data.anomalies[0]!.amount).toBe('₹25,000.00')
  })
})

const TWO_B = JSON.stringify({
  data: {
    rtnprd: '052025',
    docdata: {
      b2b: [
        {
          ctin: GSTIN,
          inv: [
            { inum: 'A-1', idt: '10-05-2025', val: 11800, items: [{ txval: 10000, camt: 900, samt: 900 }] },
            { inum: 'A-2', idt: '12-05-2025', val: 5900, items: [{ txval: 5000, camt: 450, samt: 450 }] }
          ]
        }
      ]
    }
  }
})

describe('GSTR-2B mismatches', () => {
  it('stores the statement (audited), categorises, drafts without posting, and the saved draft clears the mismatch', async () => {
    const b = books()
    const purchase = (ref: string, taxable: number, tax: number): number =>
      voucher(b, 'purchase', '2025-05-10', [[b.purchases, 'dr', taxable], [b.cgst, 'dr', tax], [b.sgst, 'dr', tax], [b.vendor, 'cr', taxable + 2 * tax]], { party: b.vendor, reference: ref })
    purchase('A-1', 10_000_00, 900_00)
    const extra = purchase('B-5', 2_000_00, 180_00)

    expect(assist.gst2bMismatches(b.db, '2025-05').statement).toBeNull()
    const st = assist.store2bStatement(b.db, { jsonText: TWO_B, fileName: '2b.json', period: '2025-05' }, 'Priya')
    expect(st).toMatchObject({ period: '052025', documents: 2, importedBy: 'Priya' })
    expect(audits(b, 'gst2b_statement').map((a) => a.action)).toEqual(['create'])
    expect(audits(b, 'gst2b_statement')[0]!.after_json).not.toContain('docdata') // the JSON itself is not copied into the audit trail

    const r = assist.gst2bMismatches(b.db, '2025-05')
    expect(r.matched).toBe(1)
    expect(r.rows.map((m) => m.category).sort()).toEqual(['missing_in_2b', 'missing_in_books'])
    expect(r.rows.find((m) => m.category === 'missing_in_2b')!.book!.voucherId).toBe(extra)
    const missing = r.rows.find((m) => m.category === 'missing_in_books')!

    // The tool says the same, formatted.
    const tool = (await createToolRegistry().get('gst_2b_mismatches')!.handler({ period: '2025-05' }, ctxFor(b))) as { data: { mismatches: { key: string; canDraft?: boolean }[] } }
    expect(tool.data.mismatches.map((m) => m.key)).toEqual(r.rows.map((m) => m.key))
    expect(tool.data.mismatches.find((m) => m.key === missing.key)!.canDraft).toBe(true)

    // A viewer cannot draft; an accountant gets a DRAFT — the books are unchanged.
    const registry = createToolRegistry()
    const refused = await registry.run('draft_gst_2b_fix', JSON.stringify({ period: '2025-05', key: missing.key }), ctxFor(b))
    expect(refused.ok).toBe(false)
    const before = booksDigest(b)
    const run = await registry.run('draft_gst_2b_fix', JSON.stringify({ period: '2025-05', key: missing.key }), ctxFor(b, { role: 'accountant', userRequest: 'draft the missing purchase' }))
    expect(run.ok).toBe(true)
    expect(booksDigest(b)).toBe(before)
    const draft = store.getDraft(b.db, (run as { draftId: number }).draftId)!
    expect(draft).toMatchObject({ status: 'open', unrequested: false, payload: { voucherKind: 'purchase', partyLedgerId: b.vendor, reference: 'A-2', date: '2025-05-12' } })
    expect(draft.payload.lines).toEqual([
      { ledgerId: b.purchases, drCr: 'dr', amount: 5_000_00 },
      { ledgerId: b.cgst, drCr: 'dr', amount: 450_00 },
      { ledgerId: b.sgst, drCr: 'dr', amount: 450_00 },
      { ledgerId: b.vendor, drCr: 'cr', amount: 5_900_00 }
    ])

    // The user saves it through the normal path → the mismatch is gone.
    const saved = saveVoucher(b.db, {
      ...header, voucherTypeId: draft.payload.voucherTypeId, date: draft.payload.date, partyLedgerId: draft.payload.partyLedgerId, narration: draft.payload.narration, reference: draft.payload.reference,
      lines: draft.payload.lines.map((l) => ({ ...l, costAllocations: [] })), inventory: [], billRefs: [], tds: null
    })
    consumeDraft(b.db, draft.id, saved.id)
    const after = assist.gst2bMismatches(b.db, '2025-05')
    expect(after.matched).toBe(2)
    expect(after.rows.map((m) => m.category)).toEqual(['missing_in_2b'])

    // Resolve the remaining one: hidden unless asked for, audited.
    assist.resolve2bMismatch(b.db, '2025-05', after.rows[0]!.key, 'resolved', 'supplier files late', 'Priya')
    expect(assist.gst2bMismatches(b.db, '2025-05').rows).toEqual([])
    expect(assist.gst2bMismatches(b.db, '2025-05', { includeResolved: true }).rows[0]!.resolved).toMatchObject({ status: 'resolved', by: 'Priya' })
  })

  it('a screen draft (no AI) is a chat-source draft named for the assistant; a lock date refuses it', () => {
    const b = books()
    assist.store2bStatement(b.db, { jsonText: TWO_B, period: '2025-05' }, null)
    const m = assist.gst2bMismatches(b.db, '2025-05').rows.find((x) => x.category === 'missing_in_books')!
    const plan = m.actions.find((a) => a.kind === 'draft')!
    if (plan.kind !== 'draft') throw new Error('no plan')
    const d = insertPlanDraft(b.db, plan.plan, { threadId: null, messageId: null, source: 'chat', origin: 'GST 2B assistant' })
    expect(d).toMatchObject({ source: 'chat', origin: 'GST 2B assistant', status: 'open' })
    b.db.prepare("INSERT INTO meta (key, value) VALUES ('lock_before', '2025-05-31') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    expect(() => insertPlanDraft(b.db, plan.plan, { threadId: null, messageId: null })).toThrow(/locked up to 2025-05-31/)
  })
})

describe('build_report', () => {
  it('runs the validated model: totals equal the report builder; bad names come back as problems', async () => {
    const b = books()
    trade(b, 'sales', '2025-05-12', [{ item: item(b.db, 'Gadget', { opening: [10, 10_000] }), qty: 2, amount: 40_000 }])
    trade(b, 'sales', '2025-06-02', [{ item: item(b.db, 'Gizmo', { opening: [10, 10_000] }), qty: 1, amount: 25_000 }])
    const req = parseReportQuestion('sales by month', PERIOD)!
    const res = requestToModel(req, nameLookup(b.db))
    if (!res.ok) throw new Error(res.problems.join())
    const direct = runReport(b.db, res.model, { working: PERIOD, today: TODAY })
    const tool = createToolRegistry().get('build_report')!
    const out = (await tool.handler(req, ctxFor(b))) as { data: { totals: Record<string, string>; rowCount: number }; sources: { kind: string; screen?: string; params?: Record<string, string> }[] }
    expect(direct.totals[0]).toBe(65_000)
    expect(out.data.totals['Taxable value']).toBe('₹650.00')
    expect(out.data.rowCount).toBe(direct.rows.length)
    const link = out.sources.find((s) => s.screen === 'report-builder')!
    expect(JSON.parse(link.params!.model!)).toEqual(res.model)

    const bad = await createToolRegistry().run('build_report', JSON.stringify({ title: 'x', source: 'accounts', measures: ['net'], ledgers: ['No Such Ledger'] }), ctxFor(b))
    expect(bad).toMatchObject({ ok: false })
    expect((bad as { error: string }).error).toMatch(/No ledger called “No Such Ledger”/)
  })
})

describe('Run with AI — a pre-called assistant tool', () => {
  const ON: AiSettings = { ...defaultAiSettings(), enabled: true, noticeAcceptedAt: '2025-06-01T00:00:00.000Z', noticeAcceptedBy: 'Owner', noticeVersion: 1 }
  const deps = (b: Books, provider: MockProvider): Parameters<typeof startTurn>[0] & { events: AiEvent[] } => {
    const events: AiEvent[] = []
    return { db: b.db, company: INFO, provider, registry: createToolRegistry(), settings: ON, user: { name: 'Arun', role: 'viewer' }, emit: (e) => events.push(e), runs: new AgentRuns(), today: TODAY, period: PERIOD, events }
  }

  it('stores the tool call + result before the first model call; the answer quotes it with sourced figures', async () => {
    const b = books()
    voucher(b, 'payment', '2025-05-10', [[b.rent, 'dr', 10_000_00], [b.bank, 'cr', 10_000_00]])
    const provider = new MockProvider(demoScript)
    const t = startTurn(deps(b, provider), { text: 'Walk me through the month-end close for May 2025', preCall: { tool: 'close_checklist', input: { period: '2025-05' } } })
    expect(await t.finished).toEqual({ status: 'done' })
    const msgs = store.listMessages(b.db, t.threadId)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(msgs[1]!.toolCalls[0]).toMatchObject({ name: 'close_checklist', input: { period: '2025-05' } })
    // The model's FIRST request already carried the result.
    expect(provider.requests).toHaveLength(1)
    expect(JSON.stringify(provider.requests[0]!.input)).toContain('Bank accounts reconciled')
    const answer = msgs[3]!
    expect(answer.content).toMatch(/Close checklist — May 2025/)
    expect(answer.figures.length).toBeGreaterThan(0)
    expect(answer.figures.every((f) => f.sourced)).toBe(true)
  })

  it('only read tools can be pre-called; the mock maps "report of …" to build_report', async () => {
    const b = books()
    const bad = startTurn(deps(b, new MockProvider(demoScript)), { text: 'x', preCall: { tool: 'draft_gst_2b_fix' as never, input: {} } })
    expect(await bad.finished).toMatchObject({ status: 'error' })
    const provider = new MockProvider(demoScript)
    const t = startTurn(deps(b, provider), { text: 'Make a report of sales by month' })
    expect(await t.finished).toEqual({ status: 'done' })
    const call = store.listMessages(b.db, t.threadId).find((m) => m.toolCalls.length)!.toolCalls[0]!
    expect(call).toMatchObject({ name: 'build_report', input: { source: 'accounts', measures: ['taxable'], dimensions: [{ key: 'month' }] } })
  })
})
