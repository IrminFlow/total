// WP 10.1 Ask Total, end to end through the IPC handlers:
//   - a hand-worked company (every expected figure worked out by hand in the comments, NOT read
//     back from a service): who owes me, what I owe, profit / sales / expenses last month, GST due;
//   - the demo seed: each figure equals the service the matching screen uses (simple:home,
//     simple:taxes, the stock list);
//   - an entry request becomes an ai_drafts row (source 'assistant', origin 'ask-total') that the
//     simple flow's save (simple:post + aiDraftId) consumes; a viewer can ask but never draft;
//   - an unknown question gets suggestions; an ambiguous name is asked about, never guessed;
//   - assist:ask writes nothing (audit_log, ai_drafts unchanged).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { todayISO } from '@shared/dates'
import type { AssistAnswer, AssistDraftResult } from '@shared/assist'
import type { AiDraftDto } from '@shared/ai'
import type { SimpleHomeData } from '@shared/simple/home'
import type { SimpleTaxes } from '@shared/simple/taxes'
import type { StockList } from '@shared/simple/stock'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>>()

vi.mock('electron', () => ({
  app: { getVersion: () => '0.11.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<{ ok: boolean }>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  Notification: class {},
  BrowserWindow: class {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-ask-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'

async function call(channel: string, payload?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h({}, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error}`)
  return r.data as T
}

let ipc: typeof import('../ipc')
// WP 7.3: the ipc module graph is imported at collection, not inside the hook — on Windows CI the
// import alone (most of the hook's time, measured) ran past the 10 s hookTimeout.
const ipcModule = await import('../ipc')

beforeAll(async () => {
  ipc = ipcModule
  ipc.registerIpc()
})

/** A fixed working date (in the past, so as-on clamping keeps it): the 14th of October 2025 —
 *  the next GSTR-3B (20 Oct 2025) files September. */
const T = '2025-10-14'
const ask = (text: string, extra: Record<string, unknown> = {}): Promise<AssistAnswer> => ok<AssistAnswer>('assist:ask', { text, today: T, ...extra })
const paise = (a: AssistAnswer): number[] => a.figures.map((f) => f.paise)

let slug = ''
const ids: Record<string, number> = {}
let dbPath = ''
const count = (sql: string): number => {
  const db = new Database(dbPath, { readonly: true })
  try {
    return (db.prepare(sql).get() as { n: number }).n
  } finally {
    db.close()
  }
}

describe('Ask Total entry drafts for a bill and a purchase (stock on, not registered)', () => {
  it('"sold 3 bags to Sita for 900" → Make a bill pre-filled (₹300 a bag); its intent saves through simple:post and consumes the draft', async () => {
    const { slug: s2 } = await ok<{ slug: string }>('simple:setup', { name: 'Ask Stock Traders', stateCode: '27', businessType: 'trader', gst: 'no', stock: true, startDate: '2025-04-01', fresh: true })
    await ok('company:open', { slug: s2 })
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const sita = (await ok<{ id: number }>('master:ledgers:create', { name: 'Sita Stores', groupId: groups.find((g) => g.name === 'Sundry Debtors')!.id, stateCode: '27' })).id
    const mohan = (await ok<{ id: number }>('master:ledgers:create', { name: 'Mohan Wholesale', groupId: groups.find((g) => g.name === 'Sundry Creditors')!.id, stateCode: '27' })).id
    const units = await ok<{ id: number; symbol: string }[]>('master:units:list')
    const bag = (await ok<{ id: number }>('master:stockItems:create', { name: 'Bag', unitId: units[0]!.id })).id
    // Buy 10 bags for ₹2,000 (₹200 a bag) first, so the sale has stock.
    const buy = (await ask('bought 10 bags from Mohan Wholesale for 2000')).entry!
    expect(buy.prefill).toEqual({ screen: 'simple-buy', party: mohan, itemId: bag, qtyMilli: 10000, rate: 20000, how: 'credit' })
    expect(buy.missing).toBeNull()
    const bd = await ok<AssistDraftResult>('assist:draft', { text: 'bought 10 bags from Mohan Wholesale for 2000', today: T })
    await ok('simple:post', { intent: { ...(buy.intent as object), clientId: 'ask-buy-000001' }, today: T, aiDraftId: bd.draftId })
    const sale = (await ask('sold 3 bags to Sita for 900')).entry!
    // ₹900 for 3 bags = ₹300 a bag (as the user priced it).
    expect(sale.prefill).toEqual({ screen: 'simple-sell', party: sita, itemId: bag, qtyMilli: 3000, rate: 30000, how: 'credit' })
    expect(sale.missing).toBeNull()
    expect(sale.intent).toMatchObject({ kind: 'sale', customerId: sita, items: [{ itemId: bag, qty: 3000, rate: 30000 }] })
    const sd = await ok<AssistDraftResult>('assist:draft', { text: 'sold 3 bags to Sita for 900', today: T })
    await ok('simple:post', { intent: { ...(sale.intent as object), clientId: 'ask-sale-00001' }, today: T, aiDraftId: sd.draftId })
    const drafts = await ok<AiDraftDto[]>('ai:drafts', {})
    expect(drafts.filter((d) => [bd.draftId, sd.draftId].includes(d.id)).map((d) => d.status)).toEqual(['consumed', 'consumed'])
    // "at 250 each" is the price of ONE bag: 2 × ₹250 = ₹500, not ₹250 for both (review fix).
    const each = (await ask('sold 2 bags to Sita at 250 each')).entry!
    expect(each.prefill).toEqual({ screen: 'simple-sell', party: sita, itemId: bag, qtyMilli: 2000, rate: 25000, how: 'credit' })
    expect(each.intent).toMatchObject({ kind: 'sale', items: [{ itemId: bag, qty: 2000, rate: 25000 }] })
    // Sita owes ₹900; 7 bags left.
    expect(paise(await ask('does Sita owe me'))).toContain(90000)
    expect((await ask('how many bags left')).sentences[0]).toContain('7')
  })
})

describe('Ask Total on hand-worked books', () => {
  it('sets up a regular trader with one sale, one purchase and rent (all in September 2025)', async () => {
    slug = (
      await ok<{ slug: string }>('simple:setup', {
        name: 'Ask Hand Traders', stateCode: '27', businessType: 'trader', gst: 'regular', gstin: '27AAPFU0939F1ZV', filing: 'monthly', stock: false, startDate: '2025-04-01', fresh: true
      })
    ).slug
    await ok('company:open', { slug })
    dbPath = join(DATA_DIR, 'companies', slug, 'company.db')
    const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
    const g = (n: string): number => groups.find((x) => x.name === n)!.id
    for (const [key, name, group] of [['ramesh', 'Ramesh Traders', 'Sundry Debtors'], ['rameshK', 'Ramesh Kumar', 'Sundry Debtors'], ['mohan', 'Mohan Supplies', 'Sundry Creditors']] as const) {
      ids[key] = (await ok<{ id: number }>('master:ledgers:create', { name, groupId: g(group), stateCode: '27' })).id
    }
    const db = new Database(dbPath, { readonly: true })
    ids.rent = (db.prepare("SELECT id FROM ledgers WHERE simple_category = 'rent'").get() as { id: number }).id
    db.close()
    // Sale: ₹10,000 + 18% GST (CGST 900 + SGST 900) = ₹11,800, on credit.
    await ok('simple:post', { intent: { kind: 'sale', clientId: 'hand-sale-0001', date: '2025-09-05', customerId: ids.ramesh, amount: { amount: 1000000, gstRate: 18 }, payment: { how: 'credit' } }, today: T })
    // Purchase: ₹5,000 + 18% GST (input 450 + 450) = ₹5,900, on credit.
    await ok('simple:post', { intent: { kind: 'purchase', clientId: 'hand-buy-00001', date: '2025-09-06', supplierId: ids.mohan, billNo: 'M-1', amount: { amount: 500000, gstRate: 18 }, payment: { how: 'credit' } }, today: T })
    // Rent ₹2,000 paid in cash.
    await ok('simple:post', { intent: { kind: 'money_out', clientId: 'hand-rent-0001', date: '2025-09-07', amount: 200000, from: { how: 'cash' }, payeeId: ids.rent }, today: T })
  })

  it('who owes me = ₹11,800 (the one sale, unpaid); what I owe = ₹5,900', async () => {
    const owes = await ask('who owes me')
    expect(owes.intent).toBe('owed')
    expect(owes.answeredBy).toBe('total')
    expect(paise(owes)).toContain(1180000)
    expect(owes.sentences.join(' ')).toContain('₹11,800.00')
    expect(owes.figures.every((f) => f.sourced && f.tool === 'ask-total' && f.source)).toBe(true)
    const iOwe = await ask('mujhe kitna dena hai')
    expect(paise(iOwe)).toContain(590000)
  })

  it('profit last month = 10,000 − 5,000 − 2,000 = ₹3,000; sales ₹10,000; expenses ₹2,000', async () => {
    const p = await ask('pichle mahine kitna profit hua')
    expect(p.intent).toBe('figure')
    expect(p.figures[0]!.paise).toBe(300000)
    expect(p.sentences[0]).toContain('₹3,000.00')
    expect(p.sentences[0]).toContain('Sep 2025')
    expect(paise(await ask('sales last month'))[0]).toBe(1000000)
    const e = await ask('expenses last month')
    expect(e.figures[0]!.paise).toBe(200000)
    expect(e.sentences.join(' ')).toContain('Rent')
  })

  it('GST due: collected ₹1,800, on purchases ₹900, to pay ₹900 by 20 Oct (the Taxes figures)', async () => {
    const g = await ask('GST kitna bharna hai')
    expect(g.intent).toBe('gst')
    expect(g.figures.slice(0, 3).map((f) => f.paise)).toEqual([90000, 180000, 90000])
    expect(g.sentences.join(' ')).toContain('20 Oct')
    expect(g.links[0]!.target).toEqual({ screen: 'simple-taxes', params: { period: '2025-09' } })
  })

  it('an ambiguous name is asked about, never guessed; the pick answers', async () => {
    const a = await ask('does Ramesh owe me?')
    expect(a.choice?.slot).toBe('party')
    expect(a.choice!.options.map((o) => o.id).sort()).toEqual([ids.ramesh, ids.rameshK].sort())
    expect(a.figures).toEqual([])
    const picked = await ask('does Ramesh owe me?', { picks: { party: ids.ramesh } })
    expect(picked.sentences[0]).toBe('Ramesh Traders owes you ₹11,800.00 on 1 bill.')
    expect(picked.figures[0]).toMatchObject({ paise: 1180000, source: { kind: 'ledger', ledgerId: ids.ramesh } })
  })

  it('an unknown question gets three suggestions and a help search', async () => {
    const u = await ask('tell me a joke about vouchers')
    expect(u.understood).toBe(false)
    expect(u.suggestions).toHaveLength(3)
    expect(u.help?.[0]?.term).toBe('Voucher')
  })

  it('"open bank" / "open Ramesh Traders" are resolved by the app (place words, the search service)', async () => {
    expect((await ask('open bank')).open).toEqual({ screen: 'simple-bank' })
    expect((await ask('open Ramesh Traders')).open).toEqual({ screen: 'simple-person', params: { id: ids.ramesh } })
    expect((await ask('open taxes')).open).toEqual({ screen: 'simple-taxes' })
  })

  it('an entry that still needs an answer says what it understood (review fix)', async () => {
    // A sale with "each": 3 × ₹300 = ₹900, and who it was to.
    const sale = await ask('sold 3 bags to Ramesh Traders at 300 each')
    expect(sale.entry?.prefill).toMatchObject({ screen: 'simple-sell', party: ids.ramesh, amount: 90000 })
    expect(sale.sentences[0]).toBe('You sold 3 bags to Ramesh Traders for ₹900.00.')
    // Paying a customer: Money out pays suppliers and costs — it says Ramesh is a customer.
    const out = await ask('Ramesh Traders ko 5000 diya')
    expect(out.entry?.kind).toBe('money_out')
    expect(out.sentences.join(' ')).toContain('Ramesh Traders is one of your customers, not a supplier')
    // "Ramesh Traders paid me 2000" is money IN from Ramesh Traders.
    expect((await ask('Ramesh Traders paid me 2000')).entry?.prefill).toMatchObject({ screen: 'simple-money-in', party: ids.ramesh, amount: 200000 })
  })

  it('asking writes nothing — not even for an entry request', async () => {
    const audit = count('SELECT COUNT(*) AS n FROM audit_log')
    const vouchers = count('SELECT COUNT(*) AS n FROM vouchers')
    const offer = await ask('Ramesh Traders se 5000 mile')
    expect(offer.entry?.kind).toBe('money_in')
    expect(offer.entry?.missing).toBeNull()
    expect(offer.entry?.sentences.length).toBeGreaterThan(0)
    await ask('who owes me')
    expect(count('SELECT COUNT(*) AS n FROM audit_log')).toBe(audit)
    expect(count('SELECT COUNT(*) AS n FROM vouchers')).toBe(vouchers)
    expect(count('SELECT COUNT(*) AS n FROM ai_drafts')).toBe(0)
  })

  it('an entry request → an ask-total draft the simple flow opens; its save (simple:post) consumes it', async () => {
    const text = 'Ramesh Traders se 5000 mile'
    const offer = (await ask(text)).entry!
    expect(offer.prefill).toEqual({ screen: 'simple-money-in', who: 'customer', party: ids.ramesh, amount: 500000, how: 'cash' })
    const d = await ok<AssistDraftResult>('assist:draft', { text, today: T })
    expect(d.prefill).toEqual(offer.prefill)
    // Asking again while it is open returns the same draft.
    expect((await ok<AssistDraftResult>('assist:draft', { text, today: T })).draftId).toBe(d.draftId)
    const drafts = await ok<AiDraftDto[]>('ai:drafts', {})
    const draft = drafts.find((x) => x.id === d.draftId)!
    expect(draft).toMatchObject({ source: 'assistant', origin: 'ask-total', status: 'open' })
    expect(draft.payload.origin).toBe('ask-total')
    expect(draft.payload.simple?.intent).toEqual(offer.intent)
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'ai_draft' AND action = 'create'")).toBe(1)
    // The flow saves the same intent (what its Save sends) with the draft id.
    const saved = await ok<{ voucherIds: number[] }>('simple:post', { intent: { ...(offer.intent as object), clientId: 'ask-flow-0001' }, today: T, aiDraftId: d.draftId })
    const after = (await ok<AiDraftDto[]>('ai:drafts', {})).find((x) => x.id === d.draftId)!
    expect(after.status).toBe('consumed')
    expect(after.voucherId).toBe(saved.voucherIds[0])
    // ₹11,800 − ₹5,000 received = ₹6,800 still owed.
    expect(paise(await ask('who owes me'))).toContain(680000)
  })

  it('a draft id of another kind, or one already used, is left alone by simple:post', async () => {
    const d = await ok<AssistDraftResult>('assist:draft', { text: 'paid 2000 to Mohan Supplies by bank', today: T })
    await ok('simple:post', { intent: { kind: 'money_in', clientId: 'ask-other-0001', date: T, amount: 10000, into: { how: 'cash' }, customerId: ids.ramesh }, today: T, aiDraftId: d.draftId })
    expect((await ok<AiDraftDto[]>('ai:drafts', {})).find((x) => x.id === d.draftId)!.status).toBe('open')
  })

  it('WP 10.6: a chat (AI panel) draft opened in its simple flow is consumed by the save; other drafts are left alone', async () => {
    const { insertDraft } = await import('../ai/store')
    const receipt = (extra: Record<string, unknown> = {}): number => {
      const db = new Database(dbPath)
      try {
        return insertDraft(db, {
          threadId: null, messageId: null, summary: 'Receipt from Ramesh', source: 'chat',
          payload: { voucherTypeId: 1, voucherKind: 'receipt', date: T, partyLedgerId: ids.ramesh!, narration: null, reference: null, lines: [], form: 'accounting', ...extra }
        }).id
      } finally {
        db.close()
      }
    }
    const status = async (id: number): Promise<AiDraftDto> => (await ok<AiDraftDto[]>('ai:drafts', {})).find((x) => x.id === id)!
    const moneyIn = (clientId: string, aiDraftId: number): Promise<{ voucherIds: number[] }> =>
      ok('simple:post', { intent: { kind: 'money_in', clientId, date: T, amount: 100, into: { how: 'cash' }, customerId: ids.ramesh }, today: T, aiDraftId })
    // A receipt draft → Money in: consumed, linked to the receipt it became.
    const fits = receipt()
    const saved = await moneyIn('chat-flow-0001', fits)
    expect(await status(fits)).toMatchObject({ status: 'consumed', voucherId: saved.voucherIds[0] })
    // Another flow's kind, a statement-line draft (reconciled through voucher:save only): left open.
    const other = receipt({ voucherKind: 'payment' })
    const bank = receipt({ bankLine: { bankLedgerId: 1, statementLineId: 1 } })
    await moneyIn('chat-flow-0002', other)
    await moneyIn('chat-flow-0003', bank)
    expect((await status(other)).status).toBe('open')
    expect((await status(bank)).status).toBe('open')
    // Each money-in above was ₹1 received: ₹6,700 (after the ₹100 test) − ₹1 × 3 = ₹6,697.
    expect(paise(await ask('who owes me'))).toContain(669700)
  })

  it('gate polish: GST asked while October runs also says October so far (the Taxes service’s running period)', async () => {
    // A cash sale on 3 Oct 2025: ₹1,000 + 18% = ₹180 of GST collected (CGST 90 + SGST 90); paid,
    // so who owes me is unchanged for the test below.
    await ok('simple:post', { intent: { kind: 'sale', clientId: 'hand-sale-oct1', date: '2025-10-03', amount: { amount: 100000, gstRate: 18 }, payment: { how: 'cash' } }, today: T })
    const g = await ask('GST kitna dena hai')
    expect(g.intent).toBe('gst')
    // September's return first (unchanged), then October so far.
    expect(g.figures.slice(0, 3).map((f) => f.paise)).toEqual([90000, 180000, 90000])
    const text = g.sentences.join(' ')
    expect(text).toContain('Oct 2025 so far')
    expect(text).toContain('₹180.00')
    expect(paise(g)).toContain(18000)
    expect(g.links.map((l) => l.target)).toContainEqual({ screen: 'simple-taxes', params: { period: '2025-10' } })
  })

  it('gate polish: "what does X mean" follows the question’s language', async () => {
    const hinglish = await ask('GSTR-3B kya hai')
    expect(hinglish.intent).toBe('meaning')
    expect(hinglish.sentences.join(' ')).toContain('taiyaar karta hai, file aap karte hain')
    const hindi = await ask('GSTR-3B क्या है')
    expect(hindi.sentences.join(' ')).toMatch(/तैयार करता है/)
    const english = await ask('what is GSTR-3B')
    expect(english.sentences.join(' ')).toContain('Total prepares it, you file it')
    // No translation in the glossary: the English explanation inside the Hinglish sentence.
    expect((await ask('godown kya hai')).sentences.join(' ')).toContain('A place where you keep stock')
  })

  it('a viewer can ask (entries come back as not recordable) but cannot draft', async () => {
    expect(ipc.CHANNEL_ROLES.get('assist:ask')).toBe('viewer')
    expect(ipc.CHANNEL_ROLES.get('assist:draft')).toBe('accountant')
    await ok('users:save', { data: { name: 'Owner', pin: '1111', role: 'owner', active: true } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Looker', pin: '3333', role: 'viewer', active: true } })
    await ok('auth:login', { userId: viewer.id, pin: '3333' })
    const before = count('SELECT COUNT(*) AS n FROM ai_drafts')
    const a = await ask('paid 500 to Mohan Supplies in cash')
    expect(a.entry?.canDraft).toBe(false)
    expect(a.sentences.join(' ')).toContain('not record entries')
    const r = await call('assist:draft', { text: 'paid 500 to Mohan Supplies in cash', today: T })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('not_permitted')
    expect(count('SELECT COUNT(*) AS n FROM ai_drafts')).toBe(before)
    // ₹6,800 − the ₹100 and the 3 × ₹1 received in the tests above = ₹6,697.
    expect(paise(await ask('who owes me'))).toContain(669700)
    expect((await call('assist:ask', { text: '' })).ok).toBe(false)
    expect((await call('assist:ask', { text: 'hi', extra: 1 })).ok).toBe(false)
  })
})

describe('Ask Total on the demo seed: every figure is the screen service’s', () => {
  const TODAY = todayISO()
  const askNow = (text: string): Promise<AssistAnswer> => ok<AssistAnswer>('assist:ask', { text, today: TODAY })

  it('equals simple:home / simple:taxes / the stock list', async () => {
    const { slug: demo } = await ok<{ slug: string }>('company:createDemo', { mode: 'simple' })
    await ok('company:open', { slug: demo })
    const home = await ok<SimpleHomeData>('simple:home', { today: TODAY })
    expect(paise(await askNow('who owes me'))[0]).toBe(home.receivables.total)
    expect(paise(await askNow('what do I owe'))[0]).toBe(home.payables.total)
    expect(paise(await askNow('kitna profit hua is mahine'))[0]).toBe(Math.abs(home.profit.month.netProfit))
    expect(paise(await askNow('profit this year'))[0]).toBe(Math.abs(home.profit.year.netProfit))
    expect(paise(await askNow('how much cash do I have'))[0]).toBe(Math.abs(home.cash.cash))
    expect(paise(await askNow('bank balance'))[0]).toBe(home.cash.bank)
    const taxes = await ok<SimpleTaxes>('simple:taxes', { today: TODAY })
    const gst = await askNow('how much GST do I have to pay')
    if (taxes.kind === 'regular') expect(paise(gst).slice(0, 3)).toEqual([Math.max(0, taxes.figures.toPay), taxes.figures.collected, taxes.figures.onPurchases])
    const stock = await ok<StockList>('simple:stock:list', { today: TODAY })
    expect(paise(await askNow('stock'))[0]).toBe(stock.rows.reduce((s, r) => s + r.value, 0))
    // Gate polish: "<product> kitna bacha hai" is that product's stock (it read as SALES before —
    // "bacha" was "fixed" into "becha").
    const row = stock.rows.find((r) => r.value > 0)!
    const left = await askNow(`${row.name} kitna bacha hai`)
    expect(left.intent).toBe('stock')
    expect(paise(left)[0]).toBe(row.value)
    // "<not a product> kitna hai" is not understood (never "no such product").
    expect((await askNow('Zzyzx kitna hai')).understood).toBe(false)
  })
})
