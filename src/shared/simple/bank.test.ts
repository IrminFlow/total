// WP 9.6 — the pure half of the simple Bank screen: choices per side, suggestions read as plain
// choices, "because …" keys, the one sentence, and the intents a choice becomes.
import { describe, expect, it } from 'vitest'
import { en } from '../i18n'
import { bannedWordsIn } from './bannedWords'
import { simpleIntentSchema } from './intents'
import {
  repeatedLines,
  BANK_CHOICE_KINDS, bankAcceptSchema, bankChoiceSchema, bankSentence, becauseFor, choiceComplete, choiceFitsSide, choiceForAccount, choiceLabelKey, choicesFor,
  intentForChoice, type BankAccountInfo, type BankLineFacts, type BankSuggestSource
} from './bank'

const BANK = 10
const acc = (id: number, cls: BankAccountInfo['cls'], extra: Partial<BankAccountInfo> = {}): BankAccountInfo => ({ id, name: `A${id}`, cls, category: null, owner: false, ...extra })
const deposit: BankLineFacts = { id: 1, date: '2025-08-12', description: 'NEFT-RAMESH TRADERS-UTR1', reference: 'N1', side: 'deposit', amount: 400_000 }
const withdrawal: BankLineFacts = { id: 2, date: '2025-08-14', description: 'SMS CHARGES', reference: '', side: 'withdrawal', amount: 5_900 }

describe('choices', () => {
  it('offers the plain answers for each side, "Already recorded" only with a match, "Skip for now" last', () => {
    expect(choicesFor('deposit', false)).toEqual(['customer', 'transfer', 'owner', 'charges', 'income', 'skip'])
    expect(choicesFor('withdrawal', true)).toEqual(['existing', 'supplier', 'expense', 'transfer', 'owner', 'charges', 'skip'])
    expect(choiceFitsSide('customer', 'withdrawal')).toBe(false)
    expect(choiceFitsSide('supplier', 'deposit')).toBe(false)
    expect(choiceFitsSide('expense', 'deposit')).toBe(false)
    expect(choiceFitsSide('income', 'withdrawal')).toBe(false)
    expect(choiceFitsSide('transfer', 'deposit')).toBe(true)
  })

  it('labels every choice on both sides with a catalogue key free of banned words', () => {
    for (const side of ['deposit', 'withdrawal'] as const) {
      for (const k of BANK_CHOICE_KINDS) {
        const text = (en as Record<string, string>)[choiceLabelKey(k, side)]
        expect(text, `${k}/${side}`).toBeTypeOf('string')
        expect(bannedWordsIn(text!), k).toEqual([])
      }
    }
    expect(choiceLabelKey('owner', 'deposit')).toBe('simple.bank.choice.ownerIn')
    expect(choiceLabelKey('charges', 'deposit')).toBe('simple.bank.choice.interest')
  })

  it('is complete once it names what it needs', () => {
    expect(choiceComplete(null)).toBe(false)
    expect(choiceComplete({ kind: 'skip' })).toBe(false)
    expect(choiceComplete({ kind: 'existing' })).toBe(true)
    expect(choiceComplete({ kind: 'customer', partyId: 0 })).toBe(false)
    expect(choiceComplete({ kind: 'expense', accountId: 7 })).toBe(true)
  })

  it('the accept schema refuses a skipped line and unknown shapes', () => {
    expect(bankAcceptSchema.safeParse({ bankLedgerId: 1, items: [{ lineId: 1, clientId: 'bank-1-abcdef', choice: { kind: 'skip' } }] }).success).toBe(false)
    expect(bankAcceptSchema.safeParse({ bankLedgerId: 1, items: [{ lineId: 1, clientId: 'bank-1-abcdef', choice: { kind: 'customer', partyId: 3 } }] }).success).toBe(true)
    expect(bankChoiceSchema.safeParse({ kind: 'customer', accountId: 3 }).success).toBe(false)
  })
})

describe('a suggested account as a plain choice', () => {
  it('reads each kind of account on its side', () => {
    expect(choiceForAccount(acc(1, 'debtor'), 'deposit', BANK)).toEqual({ kind: 'customer', partyId: 1 })
    expect(choiceForAccount(acc(1, 'debtor'), 'withdrawal', BANK)).toBeNull() // a refund: the user picks
    expect(choiceForAccount(acc(2, 'creditor'), 'withdrawal', BANK)).toEqual({ kind: 'supplier', partyId: 2 })
    expect(choiceForAccount(acc(3, 'cash'), 'withdrawal', BANK)).toEqual({ kind: 'transfer', accountId: 3 })
    expect(choiceForAccount(acc(4, 'expense'), 'withdrawal', BANK)).toEqual({ kind: 'expense', accountId: 4 })
    expect(choiceForAccount(acc(4, 'expense', { category: 'bank_charges' }), 'withdrawal', BANK)).toEqual({ kind: 'charges', accountId: 4 })
    expect(choiceForAccount(acc(5, 'income', { category: 'interest_received' }), 'deposit', BANK)).toEqual({ kind: 'charges', accountId: 5 })
    expect(choiceForAccount(acc(5, 'income'), 'deposit', BANK)).toEqual({ kind: 'income', accountId: 5 })
    expect(choiceForAccount(acc(6, 'other', { owner: true, category: 'owner_capital' }), 'deposit', BANK)).toEqual({ kind: 'owner', accountId: 6 })
    expect(choiceForAccount(acc(6, 'other', { owner: true, category: 'owner_capital' }), 'withdrawal', BANK)).toBeNull()
    expect(choiceForAccount(acc(7, 'other', { owner: true, category: 'owner_drawings' }), 'withdrawal', BANK)).toEqual({ kind: 'owner', accountId: 7 })
    expect(choiceForAccount(acc(8, 'other'), 'deposit', BANK)).toBeNull() // a loan: no plain choice
    expect(choiceForAccount(acc(BANK, 'bank'), 'deposit', BANK)).toBeNull() // never the bank itself
    expect(choiceForAccount(undefined, 'deposit', BANK)).toBeNull()
  })

  it('says why in plain words for every source', () => {
    const sources: BankSuggestSource[] = ['match', 'rule', 'learned', 'history', 'memory', 'party', 'ai']
    for (const s of sources) {
      const b = becauseFor(s, { name: 'Ramesh', words: 'SMS CHARGES', date: '12 Aug 2025' })
      const text = (en as Record<string, string>)[b.key]
      expect(text, s).toBeTypeOf('string')
      for (const v of text!.matchAll(/\{(\w+)\}/g)) expect(b.vars[v[1]!], `${s}: {${v[1]}}`).toBeDefined()
      expect(bannedWordsIn(text!), s).toEqual([])
    }
    expect(becauseFor('history', { name: 'Bank charges' })).toMatchObject({ key: 'simple.bank.because.learned' })
  })
})

describe('the one sentence', () => {
  it('agrees only when nothing differs either way', () => {
    expect(bankSentence({ asOn: null, differ: 0, difference: 0, open: 0 })).toMatchObject({ tone: 'none', key: 'simple.bank.sentence.none' })
    expect(bankSentence({ asOn: '2025-08-18', differ: 0, difference: 0, open: 0 })).toMatchObject({ tone: 'agree', vars: { date: '2025-08-18' } })
    expect(bankSentence({ asOn: '2025-08-18', differ: 3, difference: 12_000, open: 2 })).toMatchObject({ tone: 'differ', key: 'simple.bank.differ', vars: { count: 3 } })
    expect(bankSentence({ asOn: '2025-08-18', differ: 0, difference: 0, open: 2 })).toMatchObject({ tone: 'open', vars: { count: 2 } })
  })
})

describe('the intent a choice becomes', () => {
  const parse = (x: unknown) => simpleIntentSchema.parse(x)
  it('posts exactly the line: its date, amount, this bank on its side, the bank text as the note', () => {
    const inC = parse(intentForChoice(deposit, { kind: 'customer', partyId: 3 }, BANK, 'bank-1-abcdef'))
    expect(inC).toMatchObject({ kind: 'money_in', date: '2025-08-12', amount: 400_000, into: { how: 'bank', accountId: BANK, reference: 'N1' }, customerId: 3, narration: deposit.description })
    expect(inC).not.toHaveProperty('bills') // oldest first
    expect(parse(intentForChoice(withdrawal, { kind: 'supplier', partyId: 4 }, BANK, 'bank-2-abcdef'))).toMatchObject({ kind: 'money_out', supplierId: 4, from: { how: 'bank', accountId: BANK } })
    expect(parse(intentForChoice(withdrawal, { kind: 'charges', accountId: 5 }, BANK, 'bank-2-abcdef'))).toMatchObject({ kind: 'money_out', payeeId: 5, amount: 5_900 })
    expect(parse(intentForChoice(withdrawal, { kind: 'owner', accountId: 6 }, BANK, 'bank-2-abcdef'))).toMatchObject({ kind: 'money_out', payeeId: 6 })
    expect(parse(intentForChoice(deposit, { kind: 'owner', accountId: 7 }, BANK, 'bank-1-abcdef'))).toMatchObject({ kind: 'money_in', sourceId: 7 })
    expect(parse(intentForChoice(deposit, { kind: 'transfer', accountId: 8 }, BANK, 'bank-1-abcdef'))).toMatchObject({ kind: 'move_money', fromId: 8, toId: BANK, reference: 'N1' })
    expect(parse(intentForChoice(withdrawal, { kind: 'transfer', accountId: 8 }, BANK, 'bank-2-abcdef'))).toMatchObject({ kind: 'move_money', fromId: BANK, toId: 8 })
    expect(parse(intentForChoice(withdrawal, { kind: 'transfer', accountId: 8 }, BANK, 'bank-2-abcdef'))).not.toHaveProperty('reference')
    expect(intentForChoice(deposit, { kind: 'existing' }, BANK, 'bank-1-abcdef')).toBeNull()
    expect(intentForChoice(deposit, { kind: 'skip' }, BANK, 'bank-1-abcdef')).toBeNull()
  })
})

describe('repeatedLines (WP 9.6 review)', () => {
  const l = (id: number, over: Partial<{ date: string; side: 'deposit' | 'withdrawal'; amount: number; reference: string; description: string }> = {}) => ({
    id, date: '2025-08-12', side: 'deposit' as const, amount: 400_000, reference: 'N1', description: 'NEFT-RAMESH', ...over
  })
  it('flags only a later exact repeat with a reference', () => {
    expect([...repeatedLines([l(1), l(2), l(3, { amount: 1 }), l(4, { reference: 'N2' }), l(5, { date: '2025-08-13' }), l(6, { side: 'withdrawal' })])]).toEqual([2])
    expect([...repeatedLines([l(1, { reference: '' }), l(2, { reference: ' ' })])]).toEqual([])
  })
})
