// WP 10.6: the AI helper's plain sentences, the model pick and the error mapping (pure).
import { describe, expect, it } from 'vitest'
import { en, translator } from '../i18n'
import type { AiMessageDto, AiUsageRow } from '../ai'
import type { FxRate } from '../cashFinance'
import { bannedWordsIn } from './bannedWords'
import {
  classifyAiError, costText, draftOffer, figuresFromSentence, microUsdToPaise, monthSpend, monthSpendSentence, pickModels, rateNote, toolPlace, turnCostText, usdRateOn
} from './aiPlain'

const t = translator('en')

describe('pickModels — never a hard-coded id when the key listed its models', () => {
  it('keeps the current models when the key offers them', () => {
    expect(pickModels(['gpt-6.1-sol', 'gpt-6-luna', 'mock-model'], { defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna' })).toEqual({
      defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna', changed: false
    })
  })
  it('picks the newest undated chat model, and a small one for the fast model', () => {
    const models = ['text-embedding-3-large', 'whisper-1', 'gpt-4o-2024-08-06', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini', 'dall-e-3', 'tts-1', 'gpt-5-nano-2025-08-07', 'gpt-5', 'gpt-5-mini', 'omni-moderation-latest']
    expect(pickModels(models, { defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna' })).toEqual({ defaultModel: 'gpt-5', fastModel: 'gpt-5-mini', changed: true })
  })
  it('only the missing one changes', () => {
    expect(pickModels(['gpt-6.1-sol', 'gpt-5-mini'], { defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-6-luna' })).toEqual({ defaultModel: 'gpt-6.1-sol', fastModel: 'gpt-5-mini', changed: true })
  })
  it('no small model: the fast model is the default', () => {
    expect(pickModels(['gpt-5'], { defaultModel: 'x', fastModel: 'y' })).toEqual({ defaultModel: 'gpt-5', fastModel: 'gpt-5', changed: true })
  })
  it('only odd ids: the first listed (still from the list)', () => {
    expect(pickModels(['acme-chat'], { defaultModel: 'x', fastModel: 'y' }).defaultModel).toBe('acme-chat')
  })
  it('an empty list keeps the current ids', () => {
    expect(pickModels([], { defaultModel: 'x', fastModel: 'y' })).toEqual({ defaultModel: 'x', fastModel: 'y', changed: false })
  })
})

describe('classifyAiError — the provider in plain words, with the field', () => {
  const cases: [string, string, 'key' | null][] = [
    ['The provider rejected the API key (401). Check the key in Settings → AI.', 'key', 'key'],
    ['Incorrect API key provided: sk-…', 'key', 'key'],
    ['The provider is rate-limiting this key (429): You exceeded your current quota, please check your plan and billing details.', 'quota', null],
    ['The provider is rate-limiting this key (429): Rate limit reached for requests', 'busy', null],
    ['Could not reach the provider (network error).', 'network', null],
    ['The provider did not answer in time.', 'network', null],
    ['The provider does not know this model or endpoint (404): model gpt-6.1-sol does not exist', 'model', null],
    ['The API key is shared by every company on this computer. Another company here has users — open it and sign in as its owner to change the key.', 'sharedKey', null],
    ['No company on this computer has users, so anyone using it can change the shared API key. Confirm to continue.', 'sharedKeyConfirm', null],
    ['Something odd', 'other', null]
  ]
  it.each(cases)('%s → %s', (message, kind, field) => {
    const e = classifyAiError(message)
    expect(e.kind).toBe(kind)
    expect(e.field).toBe(field)
    expect(e.detail).toBe(message)
    expect(t(e.key).length).toBeGreaterThan(10)
  })
  it('the quota and network wording is the plan’s', () => {
    expect(t(classifyAiError('insufficient_quota').key)).toContain('you have run out of credit')
    expect(t(classifyAiError('fetch failed').key)).toContain('Could not reach the AI service — Total works without it')
  })
})

describe('costs — rupees only with the company’s own dollar rate', () => {
  const rates: FxRate[] = [
    { id: 1, date: '2026-09-01', currencyCode: 'USD', rateMicro: 83_500_000, note: null },
    { id: 2, date: '2026-10-01', currencyCode: 'USD', rateMicro: 84_100_000, note: null },
    { id: 3, date: '2026-11-01', currencyCode: 'USD', rateMicro: 85_000_000, note: null },
    { id: 4, date: '2026-10-05', currencyCode: 'EUR', rateMicro: 97_000_000, note: null }
  ]
  it('the newest USD rate on or before today', () => {
    expect(usdRateOn(rates, '2026-10-14')?.id).toBe(2)
    expect(usdRateOn(rates, '2026-08-01')).toBeNull()
    expect(usdRateOn([], '2026-10-14')).toBeNull()
  })
  it('micro-USD → paise, half-up', () => {
    // $0.015 × ₹84.10 = ₹1.2615 → 126 paise
    expect(microUsdToPaise(15_000, 84_100_000)).toBe(126)
    // $1 × ₹84.10 = 8410 paise
    expect(microUsdToPaise(1_000_000, 84_100_000)).toBe(8410)
    // $0.00005 × ₹84.10 = 0.4205 paise → 0; $0.0001 → 0.841 → 1
    expect(microUsdToPaise(50, 84_100_000)).toBe(0)
    expect(microUsdToPaise(100, 84_100_000)).toBe(1)
  })
  it('the cost sentence', () => {
    const rate = usdRateOn(rates, '2026-10-14')
    expect(costText(1_000_000, rate, t)).toBe('about ₹84.10')
    expect(costText(15_000, null, t)).toBe('about $0.0150 (in US dollars)')
    expect(rateNote(rate, t)).toBe('At your dollar rate of ₹84.10 from 1 Oct 2026.')
    expect(rateNote(null, t)).toBe('Your AI service charges in US dollars.')
    expect(turnCostText(null, rate, t)).toBeNull()
    expect(turnCostText(2_000_000, rate, t)).toBe('This answer cost about ₹168.20.')
  })
  it('this month’s spend', () => {
    const row = (day: string, cost: number | null): AiUsageRow => ({
      id: 1, at: `${day}T10:00:00Z`, day, threadId: 1, threadTitle: 'x', model: 'm', inputTokens: 1000, cachedTokens: 0, outputTokens: 200, costMicroUsd: cost, durationMs: 1, ok: true
    })
    const rows = [row('2026-10-02', 500_000), row('2026-10-09', 500_000), row('2026-10-10', null), row('2026-09-30', 9_000_000)]
    const s = monthSpend(rows, '2026-10')
    expect(s).toEqual({ calls: 3, priced: 2, microUsd: 1_000_000, inputTokens: 3000, outputTokens: 600 })
    expect(monthSpendSentence(s, usdRateOn(rates, '2026-10-14'), t)).toBe('3 questions so far — about ₹84.10. 1 question has no price yet and is not counted.')
    expect(monthSpendSentence(monthSpend(rows, '2026-08'), null, t)).toBe('Nothing asked yet this month.')
    expect(monthSpendSentence(monthSpend([row('2026-10-10', null)], '2026-10'), null, t)).toBe('1 question so far. Total doesn’t know the price yet, so the cost isn’t shown.')
  })
})

const msg = (over: Partial<AiMessageDto>): AiMessageDto => ({
  id: 1, threadId: 1, role: 'assistant', content: '', status: 'ok', toolCalls: [], toolCallId: null, toolName: null, toolInput: null, toolOutput: null, toolOk: null,
  truncated: false, sources: [], figures: [], model: null, costMicroUsd: null, inputTokens: null, outputTokens: null, draftId: null, context: null, memoryIds: [], createdAt: '', ...over
})

describe('figuresFromSentence — the places, never tool names', () => {
  const thread = [
    msg({ id: 1, role: 'user', content: 'old' }),
    msg({ id: 2, role: 'tool', toolName: 'trial_balance', toolOk: true }),
    msg({ id: 3, content: 'old answer' }),
    msg({ id: 4, role: 'user', content: 'how am I doing and who owes me' }),
    msg({ id: 5, toolCalls: [{ callId: 'a', name: 'profit_and_loss', input: {} }] }),
    msg({ id: 6, role: 'tool', toolName: 'profit_and_loss', toolOk: true }),
    msg({ id: 7, role: 'tool', toolName: 'outstandings', toolOk: true }),
    msg({ id: 8, role: 'tool', toolName: 'profit_and_loss', toolOk: true }),
    msg({ id: 9, role: 'tool', toolName: 'stock_summary', toolOk: false }),
    msg({ id: 10, role: 'tool', toolName: 'draft_voucher', toolOk: true }),
    msg({ id: 11, content: 'answer' })
  ]
  it('this turn only, each place once, failed and draft tools left out', () => {
    expect(figuresFromSentence(thread, 11, t)).toBe('This answer used figures from: How your business is doing, Who owes you and whom you owe.')
    expect(figuresFromSentence(thread, 3, t)).toBe('This answer used figures from: Your balances.')
    expect(figuresFromSentence([msg({ id: 1, role: 'user' }), msg({ id: 2 })], 2, t)).toBeNull()
  })
  it('an unknown read tool is "Your books"; draft / memory tools are not places', () => {
    expect(t(toolPlace('some_new_tool')!)).toBe('Your books')
    expect(toolPlace('draft_invoice')).toBeNull()
    expect(toolPlace('remember')).toBeNull()
  })
})

describe('draftOffer — the simple flow, pre-filled', () => {
  const base = { voucherTypeId: 1, date: '2026-10-14', partyLedgerId: null, narration: 'Pay 2,500 shop rent in cash', reference: null }
  it('a payment to an expense → Money out (who: expense, payee, amount)', () => {
    const o = draftOffer({ payload: { ...base, voucherKind: 'payment', lines: [{ ledgerId: 9, drCr: 'dr', amount: 250000 }, { ledgerId: 2, drCr: 'cr', amount: 250000 }] } })
    expect(t(o.question)).toBe('Save this as money paid?')
    expect(o.prefill).toEqual({ screen: 'simple-money-out', who: 'expense', payee: 9, amount: 250000, date: '2026-10-14', note: 'Pay 2,500 shop rent in cash' })
  })
  it('a payment to a supplier → Money out (who: supplier)', () => {
    const o = draftOffer({ payload: { ...base, voucherKind: 'payment', partyLedgerId: 5, total: 100000, lines: [] } })
    expect(o.prefill).toMatchObject({ screen: 'simple-money-out', who: 'supplier', party: 5, amount: 100000 })
  })
  it('a receipt → Money in', () => {
    const o = draftOffer({ payload: { ...base, voucherKind: 'receipt', partyLedgerId: 7, total: 5000, lines: [] } })
    expect(t(o.question)).toBe('Save this as money received?')
    expect(o.prefill).toMatchObject({ screen: 'simple-money-in', who: 'customer', party: 7, amount: 5000 })
  })
  it('a one-product sales invoice → Make a bill with the product and quantity (the flow prices it)', () => {
    const state = { partyId: 7, rows: [{ itemId: 3, qtyText: '2.5', rate: 10000 }, { itemId: null, qtyText: '', rate: null }] }
    const o = draftOffer({ payload: { ...base, voucherKind: 'sales', form: 'invoice', state, total: 29500, lines: [] } })
    expect(t(o.question)).toBe('Save this as a bill?')
    expect(o.prefill).toEqual({ screen: 'simple-sell', party: 7, itemId: 3, qtyMilli: 2500, date: '2026-10-14', note: 'Pay 2,500 shop rent in cash' })
  })
  it('several products → the customer only; an amount-only purchase → the amount', () => {
    const state = { partyId: 7, rows: [{ itemId: 3, qtyText: '1' }, { itemId: 4, qtyText: '1' }] }
    expect(draftOffer({ payload: { ...base, voucherKind: 'sales', form: 'invoice', state, lines: [] } }).prefill).toEqual({ screen: 'simple-sell', party: 7, date: '2026-10-14', note: 'Pay 2,500 shop rent in cash' })
    const buy = draftOffer({ payload: { ...base, voucherKind: 'purchase', form: 'accounting', partyLedgerId: 5, total: 11800, lines: [] } })
    expect(t(buy.question)).toBe('Save this as a purchase bill?')
    expect(buy.prefill).toMatchObject({ screen: 'simple-buy', party: 5, amount: 11800 })
  })
  it('other kinds have no simple flow', () => {
    expect(draftOffer({ payload: { ...base, voucherKind: 'journal', lines: [] } })).toEqual({ question: 'simple.ai.draft.noFlow', prefill: null })
  })
})

describe('the catalogue', () => {
  it('every simple.ai.* message is banned-word clean', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('simple.ai.'))
    expect(keys.length).toBeGreaterThan(100)
    for (const k of keys) expect(bannedWordsIn(en[k as keyof typeof en]), k).toEqual([])
  })
})
