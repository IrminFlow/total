// Bank, simple (WP 9.6, plan 2026-10-13 §3 "Bank"): the PURE half of the simple Bank screen —
// the plain "What is this?" choices a statement line offers on its side, what a choice becomes
// (a WP 9.1 intent through simple:post, or confirming the match the WP 4.1 matcher proposed),
// how a categoriser suggestion (WP 5.4 chain: rules → WP 5.6 memory → history → named party →
// the model only when AI is ready) reads as a choice with a plain "because …", and the one
// sentence the screen says about the books against the bank (computed from the BRS service's
// figures — nothing stored).
//
// No money arithmetic: amounts are the statement line's integer paise, passed through unchanged.

import { z } from 'zod'
import type { MessageKey } from '../i18n'
import type { StructuredError } from '../errors/appError'
import type { CategorySource } from '../capture/categorise'
import type { IntentLedgerClass, SimpleIntentInput } from './intents'

export type BankSide = 'deposit' | 'withdrawal'

/** The plain answers to "What is this?". `existing` = the entry is already in the books (the
 *  matcher's proposal); `skip` = leave the line for later (nothing is saved). */
export const BANK_CHOICE_KINDS = ['existing', 'customer', 'supplier', 'expense', 'income', 'transfer', 'owner', 'charges', 'skip'] as const
export type BankChoiceKind = (typeof BANK_CHOICE_KINDS)[number]

const id = z.number().int().positive()
export const bankChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing') }).strict(),
  z.object({ kind: z.literal('customer'), partyId: id }).strict(),
  z.object({ kind: z.literal('supplier'), partyId: id }).strict(),
  z.object({ kind: z.literal('expense'), accountId: id }).strict(),
  z.object({ kind: z.literal('income'), accountId: id }).strict(),
  z.object({ kind: z.literal('transfer'), accountId: id }).strict(),
  z.object({ kind: z.literal('owner'), accountId: id }).strict(),
  z.object({ kind: z.literal('charges'), accountId: id }).strict(),
  z.object({ kind: z.literal('skip') }).strict()
])
export type BankChoice = z.infer<typeof bankChoiceSchema>

/** simple:bank:accept — one item per line (`clientId` makes a retry safe; `skip` is never sent). */
export const bankAcceptSchema = z
  .object({
    bankLedgerId: id,
    items: z
      .array(z.object({ lineId: id, clientId: z.string().trim().min(8).max(80), choice: bankChoiceSchema.refine((c) => c.kind !== 'skip', { message: 'Nothing to save for a skipped line' }) }).strict())
      .min(1)
      .max(500)
  })
  .strict()

/** The choices offered for a line, in order (`existing` only when the matcher proposed one). */
export function choicesFor(side: BankSide, hasMatch: boolean): BankChoiceKind[] {
  const own: BankChoiceKind[] =
    side === 'deposit' ? ['customer', 'transfer', 'owner', 'charges', 'income', 'skip'] : ['supplier', 'expense', 'transfer', 'owner', 'charges', 'skip']
  return hasMatch ? ['existing', ...own] : own
}

/** The choice fits the line's side (a customer pays in, a supplier is paid out, …). */
export function choiceFitsSide(kind: BankChoiceKind, side: BankSide): boolean {
  return choicesFor(side, true).includes(kind)
}

/** The label key of a choice on a side ("Owner put money in" / "Owner took money out"). */
export function choiceLabelKey(kind: BankChoiceKind, side: BankSide): MessageKey {
  const d = side === 'deposit'
  switch (kind) {
    case 'existing':
      return 'simple.bank.choice.existing'
    case 'customer':
      return 'simple.bank.choice.customerPaid'
    case 'supplier':
      return 'simple.bank.choice.supplierPaid'
    case 'expense':
      return 'simple.bank.choice.expense'
    case 'income':
      return 'simple.bank.choice.income'
    case 'transfer':
      return d ? 'simple.bank.choice.transferIn' : 'simple.bank.choice.transferOut'
    case 'owner':
      return d ? 'simple.bank.choice.ownerIn' : 'simple.bank.choice.ownerOut'
    case 'charges':
      return d ? 'simple.bank.choice.interest' : 'simple.bank.choice.charges'
    case 'skip':
      return 'simple.bank.choice.skip'
  }
}

/** A choice is complete when it names what it needs (the customer, the category, the account). */
export function choiceComplete(c: BankChoice | null): c is Exclude<BankChoice, { kind: 'skip' }> {
  if (!c || c.kind === 'skip') return false
  if (c.kind === 'existing') return true
  return 'partyId' in c ? c.partyId > 0 : c.accountId > 0
}

/** What the screen knows about an account (setup): its class (ai/ledgerClass.ts), its simple
 *  category key, and whether it is one of the owner's (under Capital Account). */
export interface BankAccountInfo {
  id: number
  name: string
  cls: IntentLedgerClass
  category: string | null
  owner: boolean
}

/** A suggested account read as a plain choice on this side, or null when no plain choice fits
 *  (a customer refund out, a loan …) — the user picks then. */
export function choiceForAccount(acc: BankAccountInfo | undefined, side: BankSide, bankLedgerId: number): BankChoice | null {
  if (!acc || acc.id === bankLedgerId) return null
  const d = side === 'deposit'
  if (acc.cls === 'debtor') return d ? { kind: 'customer', partyId: acc.id } : null
  if (acc.cls === 'creditor') return d ? null : { kind: 'supplier', partyId: acc.id }
  if (acc.cls === 'cash' || acc.cls === 'bank') return { kind: 'transfer', accountId: acc.id }
  if (acc.owner) {
    // Money in from the owner goes to the owner's money, never to the drawings — and back.
    if (d && acc.category === 'owner_drawings') return null
    if (!d && acc.category === 'owner_capital') return null
    return { kind: 'owner', accountId: acc.id }
  }
  if (acc.cls === 'expense') {
    if (d) return null
    return acc.category === 'bank_charges' ? { kind: 'charges', accountId: acc.id } : { kind: 'expense', accountId: acc.id }
  }
  if (acc.cls === 'income') {
    if (!d) return null
    return acc.category === 'interest_received' ? { kind: 'charges', accountId: acc.id } : { kind: 'income', accountId: acc.id }
  }
  return null
}

/** "Because …" in plain words: a key and its variables (names are the user's own). */
export interface BankBecause {
  key: MessageKey
  vars: Record<string, string | number>
}

/** Where a suggestion came from: the WP 4.1 matcher (`match`) or a categoriser source. */
export type BankSuggestSource = 'match' | Exclude<CategorySource, 'none'>

export function becauseFor(source: BankSuggestSource, v: { name: string; words?: string; date?: string; amount?: string }): BankBecause {
  switch (source) {
    case 'match':
      return { key: 'simple.bank.because.match', vars: { name: v.name, date: v.date ?? '' } }
    case 'rule':
      return { key: 'simple.bank.because.rule', vars: { name: v.name } }
    case 'learned':
      return { key: 'simple.bank.because.learned', vars: { name: v.name } }
    case 'history':
      return v.words ? { key: 'simple.bank.because.history', vars: { name: v.name, words: v.words } } : { key: 'simple.bank.because.learned', vars: { name: v.name } }
    case 'memory':
      return { key: 'simple.bank.because.memory', vars: { name: v.name } }
    case 'party':
      return { key: 'simple.bank.because.party', vars: { name: v.name } }
    case 'ai':
      return { key: 'simple.bank.because.ai', vars: { name: v.name } }
  }
}

export interface BankSuggestion {
  choice: BankChoice
  source: BankSuggestSource
  because: BankBecause
}

/** One statement line as the simple screen shows it. */
export interface BankLineView {
  id: number
  date: string
  description: string
  reference: string
  side: BankSide
  /** Paise, positive. */
  amount: number
  status: 'open' | 'done' | 'left_out'
  /** Done: the entries it is matched to (the first one's other account names it). */
  done: { voucherId: number; name: string }[]
  suggestion: BankSuggestion | null
  /** The matcher proposed an entry already in the books (offered as "Already recorded"). */
  match: { name: string; date: string; amount: number } | null
}

export interface BankSentenceFacts {
  /** The latest statement line's date (the BRS is as on it); null = no statement yet. */
  asOn: string | null
  /** BRS entries in the books the bank has not shown by `asOn` (uncredited + unpresented). */
  differ: number
  /** Their net effect on the balance: uncredited − unpresented (= book − bank balance), paise. */
  difference: number
  /** Statement lines up to `asOn` that still need an answer. */
  open: number
}

/** The one sentence about the books against the bank. Only "agree" when nothing differs either
 *  way: no BRS entry and no statement line left without an answer. */
export function bankSentence(f: BankSentenceFacts): { key: MessageKey; vars: Record<string, string | number>; tone: 'none' | 'agree' | 'differ' | 'open' } {
  if (!f.asOn) return { key: 'simple.bank.sentence.none', vars: {}, tone: 'none' }
  if (f.differ > 0) return { key: 'simple.bank.differ', vars: { count: f.differ }, tone: 'differ' }
  if (f.open > 0) return { key: 'simple.bank.sentence.open', vars: { count: f.open }, tone: 'open' }
  return { key: 'simple.bank.sentence.agree', vars: { date: f.asOn }, tone: 'agree' }
}

export interface BankView {
  bankLedgerId: number
  bankName: string
  lines: BankLineView[]
  sentence: BankSentenceFacts
  /** The most recent statement added (for "Added … lines"). */
  lastImport: { id: number; fileName: string; lineCount: number } | null
}

export interface BankSetup {
  banks: { id: number; name: string }[]
  accounts: BankAccountInfo[]
  /** Category accounts the shortcuts use (null = not there yet; the screen adds it on the click). */
  ids: { bankCharges: number | null; interest: number | null; ownerMoney: number | null; drawings: number | null }
}

/** What accepting a line sends. */
export type BankAcceptItem = z.infer<typeof bankAcceptSchema>['items'][number]

export interface BankAcceptResult {
  done: { lineId: number; voucherIds: number[] }[]
  /** The error as the IPC envelope carries it (message + code / field / params / issues), for mapError. */
  failed: { lineId: number; error: { message: string } & Partial<StructuredError> }[]
}

/** The statement line an intent is made from. */
export interface BankLineFacts {
  id: number
  date: string
  description: string
  reference: string
  side: BankSide
  amount: number
}

/** The WP 9.1 intent a choice becomes (null for `existing` / `skip`, which save no new entry):
 *  dated the line's date, for exactly its amount, on this bank on the line's side, the bank's
 *  description as the note and its reference as the cheque / UTR number. A customer's money is
 *  set against their bills oldest first, a supplier's likewise (simple:post's money in / out). */
export function intentForChoice(line: BankLineFacts, choice: BankChoice, bankLedgerId: number, clientId: string): SimpleIntentInput | null {
  if (choice.kind === 'existing' || choice.kind === 'skip') return null
  const into = line.side === 'deposit'
  const money = { how: 'bank' as const, accountId: bankLedgerId, ...(line.reference.trim() ? { reference: line.reference.trim().slice(0, 60) } : {}) }
  const base = { clientId, date: line.date, amount: line.amount, ...(line.description.trim() ? { narration: line.description.trim().slice(0, 500) } : {}) }
  switch (choice.kind) {
    case 'customer':
      return { kind: 'money_in', ...base, into: money, customerId: choice.partyId }
    case 'supplier':
      return { kind: 'money_out', ...base, from: money, supplierId: choice.partyId }
    case 'transfer': {
      const ref = money.reference ? { reference: money.reference } : {}
      return into
        ? { kind: 'move_money', ...base, fromId: choice.accountId, toId: bankLedgerId, ...ref }
        : { kind: 'move_money', ...base, fromId: bankLedgerId, toId: choice.accountId, ...ref }
    }
    case 'expense':
    case 'income':
    case 'owner':
    case 'charges':
      return into ? { kind: 'money_in', ...base, into: money, sourceId: choice.accountId } : { kind: 'money_out', ...base, from: money, payeeId: choice.accountId }
  }
}

/** Statement files Total reads (WP 4.1 parsers), as the screen explains them. */
export const STATEMENT_EXTENSIONS = ['csv', 'txt', 'tsv', 'xlsx', 'sta', 'mt940', '940', 'xml'] as const
/** The largest statement file (the import channel's own cap). */
export const STATEMENT_MAX_BYTES = 15 * 1024 * 1024
