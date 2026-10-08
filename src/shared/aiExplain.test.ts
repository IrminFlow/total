// WP 5.2 — the pure pieces behind "Explain this", the context strip and the palette's Ask AI row.
import { describe, expect, it } from 'vitest'
import { aiContextSchema, explainContextFor, paletteQuestion, parseNavIntent, screenContextLines } from './aiExplain'

describe('explainContextFor', () => {
  it('names the figure, its screen and period, and carries the ids for the tools', () => {
    const { question, context } = explainContextFor({
      screen: 'trial-balance', screenLabel: 'Trial balance', label: 'Cash', column: 'Debit', value: '₹12,500.00', paise: 1_250_000, ledgerId: 4,
      asOn: '2026-03-31', from: '2025-04-01', to: '2026-03-31'
    })
    expect(question).toBe(
      'Explain this figure: Cash — Debit = ₹12,500.00 on Trial balance, as on 31-Mar-26. Which vouchers and ledgers make it up, how does it compare with the previous period, and is anything unusual?'
    )
    expect(context).toEqual({
      screen: 'trial-balance', label: 'Trial balance', from: '2025-04-01', to: '2026-03-31',
      explain: { label: 'Cash', value: '₹12,500.00', paise: 1_250_000, column: 'Debit', ledgerId: 4, asOn: '2026-03-31' }
    })
    expect(aiContextSchema.parse(context)).toEqual(context)
  })

  it('a period figure (P&L line) keeps from/to; a tile without ids keeps only the label; params pass through', () => {
    const pnl = explainContextFor({ screen: 'profit-loss', label: 'Sales Accounts', value: '₹1,00,000.00', groupName: 'Sales Accounts', from: '2025-04-01', to: '2025-09-30' })
    expect(pnl.question).toContain('on profit-loss, 01-Apr-25 to 30-Sep-25.')
    expect(pnl.context.explain).toEqual({ label: 'Sales Accounts', value: '₹1,00,000.00', groupName: 'Sales Accounts', from: '2025-04-01', to: '2025-09-30' })
    const tile = explainContextFor({ screen: 'gateway', screenLabel: 'Gateway', label: 'Receivables', value: '₹40,000.00', params: { tab: 'x' } })
    expect(tile.question).toBe(
      'Explain this figure: Receivables = ₹40,000.00 on Gateway. Which vouchers and ledgers make it up, how does it compare with the previous period, and is anything unusual?'
    )
    expect(tile.context).toEqual({ screen: 'gateway', label: 'Gateway', params: { tab: 'x' }, explain: { label: 'Receivables', value: '₹40,000.00' } })
  })

  it('never asks the model to compute: the question asks for the breakdown, not a sum', () => {
    const { question } = explainContextFor({ screen: 'daybook', label: 'Sales 12', value: '₹500.00', voucherId: 12 })
    expect(question).not.toMatch(/\b(add|sum|total up|calculate|compute)\b/i)
  })
})

describe('screenContextLines (the prompt and the context strip share them)', () => {
  it('lists the screen, its period, parameters and the figure', () => {
    expect(
      screenContextLines({ screen: 'ledger-statement', label: 'Ledger statement', from: '2025-04-01', to: '2026-03-31', params: { ledgerId: 7 }, explain: { label: 'Rent', value: '₹1.00', ledgerId: 7 } })
    ).toEqual([
      'Screen: Ledger statement (ledger-statement)',
      'Period on screen: 01-Apr-25 to 31-Mar-26 (2025-04-01 to 2026-03-31)',
      'Screen parameters: ledgerId=7',
      'Figure to explain (JSON): {"label":"Rent","value":"₹1.00","ledgerId":7}'
    ])
    expect(screenContextLines(null)).toEqual([])
    expect(screenContextLines({ screen: 'gateway' })).toEqual(['Screen: gateway'])
  })

  it('the schema caps parameters', () => {
    const params = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`p${i}`, i]))
    expect(aiContextSchema.safeParse({ screen: 'x', params }).success).toBe(false)
    expect(aiContextSchema.safeParse({ screen: 'x', params: { 'bad key': 1 } }).success).toBe(false)
  })
})

describe('paletteQuestion — when the palette offers "Ask AI"', () => {
  it.each([
    ['why is rent so high?', 'why is rent so high?'],
    ['What were sales in July?', 'What were sales in July?'],
    ['ask: sales in july', 'sales in july'],
    ['ASK:who owes me the most', 'who owes me the most'],
    ['  rent?  ', 'rent?']
  ])('%s → a question', (text, q) => expect(paletteQuestion(text)).toBe(q))

  it.each(['Acme', 'amount>5000', 'type:sales party:"Acme"', '?', 'x?', '12?', 'ask:', 'ask: a', 'Trial balance'])('%s → not a question', (text) =>
    expect(paletteQuestion(text)).toBeNull()
  )
})

describe('parseNavIntent — navigation the app resolves through search, never the model', () => {
  it.each([
    ['open the ledger for Acme Traders', { kind: 'ledger', target: 'Acme Traders' }],
    ['Go to Acme Traders statement', { kind: 'ledger', target: 'Acme Traders' }],
    ['show me the statement of Shop Rent?', { kind: 'ledger', target: 'Shop Rent' }],
    ['open item Widget', { kind: 'item', target: 'Widget' }],
    ['open invoice S/12', { kind: 'voucher', target: 'S/12' }],
    ['take me to trial balance', { kind: null, target: 'trial balance' }],
    ["open Acme's ledger", { kind: 'ledger', target: 'Acme' }]
  ])('%s', (text, intent) => expect(parseNavIntent(text)).toEqual(intent))

  it.each(['why is rent high?', 'Acme Traders', 'open', 'open the ledger for x'])('%s → none', (text) => expect(parseNavIntent(text)).toBeNull())
})
