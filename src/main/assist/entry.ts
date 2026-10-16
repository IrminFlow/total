// Ask Total — entry requests (WP 10.1): "paid 2,500 rent in cash", "Ramesh ko 5000 mila", "sold 3
// bags to Sita for 900". The words become the SIMPLE FLOW's own form (Money out / Money in / Make a
// bill / Record a purchase — shared/simple/money.ts, sell.ts, buy.ts) and that form's own
// `*IntentFrom` builds the WP 9.1 intent the screen's Save would send — so the flow opens
// pre-filled with exactly this, and simple:post saves it through saveVoucher. The intent is
// rehearsed with simple:preview (always rolled back) for the plain sentences and any refusal.
//
// Nothing posts here: `assist:draft` stores an `ai_drafts` row (source 'assistant', origin
// 'ask-total', the prefill + intent in the payload) and the flow's Save consumes it
// (settleAskDraft, called by simple:post with `aiDraftId`). Names go through the search service
// (names.ts) — several close ones are asked about, never guessed.
import type { DB } from '../db/connection'
import type { CompanyInfo, VoucherKind } from '@shared/domain'
import type { AiVoucherDraftPayload } from '@shared/ai'
import {
  ASK_TOTAL_ORIGIN, type AssistAnswer, type AssistChoice, type AssistDraftResult, type AssistEntryOffer, type AssistEntrySlots, type AssistIntent, type AssistPrefill
} from '@shared/assist'
import type { MessageKey, Translate } from '@shared/i18n'
import { gstRegistrationOf } from '@shared/gst/registration'
import { mapError, type CaughtError } from '@shared/errors'
import type { SimpleIntentInput } from '@shared/simple/intents'
import { emptyMoneyInForm, emptyMoneyOutForm, moneyInErrors, moneyInIntentFrom, moneyOutErrors, moneyOutIntentFrom, type MoneyInForm, type MoneyOutForm } from '@shared/simple/money'
import { emptySellForm, saleIntentFrom, sellFormErrors, sellTotals, type SellContext, type SellForm } from '@shared/simple/sell'
import { buyFormErrors, emptyBuyForm, purchaseIntentFrom, type BuyContext, type BuyForm } from '@shared/simple/buy'
import { money } from '@shared/simple/explain'
import { formatQtyMilli } from '@shared/money'
import { buyFromAsk, moneyInFromAsk, moneyOutFromAsk, sellFromAsk } from '@shared/simple/askPrefill'
import { listLedgers, listStockItems, listVoucherTypes } from '../services/masters'
import { moneyBills, moneySetup } from '../services/simpleMoney'
import { sellSetup } from '../services/simpleSell'
import { buySetup } from '../services/simpleBuy'
import { previewIntent } from '../services/simplePost'
import { pricingLoader } from '../services/pricing'
import { getFeatures } from '../services/config'
import { writeAudit } from '../services/audit'
import { insertDraft, listDrafts } from '../ai/store'
import { discardOlderAskDrafts } from './settle'
import { EXPENSE_WORDS } from './classify'
import { findItem, findLedger, type NameResult } from './names'
import type { AskEnv, AskInput } from './answer'

type EntryIntent = Extract<AssistIntent, { kind: 'entry' }>
type Intent = Omit<SimpleIntentInput, 'clientId'>

const OWNER_WORDS = /\b(?:owner|personal|ghar|home|self|drawings|khud|apne liye|family)\b/

const VOUCHER_KIND: Record<AssistEntrySlots['action'], VoucherKind> = { money_out: 'payment', money_in: 'receipt', sale: 'sales', purchase: 'purchase' }

const SCREEN_NAME: Record<AssistPrefill['screen'], MessageKey> = {
  'simple-money-out': 'assist.place.moneyOut',
  'simple-money-in': 'assist.place.moneyIn',
  'simple-sell': 'assist.place.makeBill',
  'simple-buy': 'assist.place.recordPurchase'
}

interface Built {
  prefill: AssistPrefill
  intent: Intent | null
  /** A plain reason the flow will ask about (a simple.* key's text), null = complete. */
  missing: string | null
  choice?: AssistChoice
  /** What the words were read as, before the preview's sentences. */
  readAs: string[]
}

const choose = (slot: AssistChoice['slot'], question: string, r: Extract<NameResult, { status: 'choose' }>): AssistChoice => ({ slot, question, options: r.options })

function categoryAccount(db: DB, what: string | undefined, today: string): number | null {
  if (!what) return null
  const word = what.split(' ')[0]!
  const key = EXPENSE_WORDS[word] ?? EXPENSE_WORDS[word.replace(/s$/, '')]
  if (key) {
    const row = db.prepare('SELECT id FROM ledgers WHERE simple_category = ? ORDER BY id LIMIT 1').get(key) as { id: number } | undefined
    if (row) return row.id
  }
  const found = findLedger(db, what, ['expense'], today)
  return found.status === 'match' ? found.id : null
}

/** "sold 3 bags for 900": the rate per unit as the user priced it (GST included when it applies),
 *  half-up to the paisa with integer maths. */
function rateFor(amount: number, qtyMilli: number): number {
  const num = BigInt(amount) * 1000n
  const den = BigInt(qtyMilli)
  return Number((num * 2n + den) / (den * 2n))
}

/** What the words come to: the amount said, or — "3 bags at 300 each" — the price of one × the
 *  quantity (integer maths, half-up to the paisa). */
export function saidTotal(s: AssistEntrySlots): number | undefined {
  if (s.amount == null) return undefined
  if (!s.perUnit || s.qtyMilli == null) return s.amount
  const num = BigInt(s.amount) * BigInt(s.qtyMilli)
  return Number((num * 2n + 1000n) / 2000n)
}

function firstError(errs: Partial<Record<string, MessageKey>>, t: Translate): string | null {
  const k = Object.values(errs).find(Boolean)
  return k ? t(k as 'simple.money.err.amount') : null
}

function moneyOut(db: DB, company: CompanyInfo, s: AssistEntrySlots, input: AskInput, t: Translate): Built {
  const today = input.today
  const date = s.date ?? today
  const setup = moneySetup(db)
  const readAs: string[] = []
  let who: 'supplier' | 'expense' | 'owner' = 'expense'
  let supplierId: number | null = null
  let payeeId: number | null = null
  let missing: string | null = null
  const ownerish = OWNER_WORDS.test(`${s.what ?? ''} ${s.party ?? ''}`)
  if (input.picks?.party) {
    who = 'supplier'
    supplierId = input.picks.party
  } else if (ownerish) {
    who = 'owner'
  } else if (s.party) {
    const found = findLedger(db, s.party, ['creditor'], today)
    if (found.status === 'choose') return { prefill: { screen: 'simple-money-out', who: 'supplier' }, intent: null, missing: null, choice: choose('party', t('assist.which', { name: s.party }), found), readAs }
    if (found.status === 'match') {
      who = 'supplier'
      supplierId = found.id
    } else {
      payeeId = categoryAccount(db, s.party, today)
      if (payeeId == null) {
        who = 'supplier'
        // "Ramesh ko 5000 diya" where Ramesh is a customer: say so rather than "no supplier".
        const customer = findLedger(db, s.party, ['debtor'], today)
        missing = customer.status === 'match' ? t('assist.entry.customerNotSupplier', { name: customer.name }) : t('assist.entry.noSupplier', { name: s.party })
      }
    }
  }
  if (who === 'expense' && payeeId == null) {
    payeeId = categoryAccount(db, s.what, today)
    if (payeeId == null && !missing) missing = s.what ? t('assist.entry.pickWhat', { what: s.what }) : null
  }
  const note = s.what && who !== 'supplier' ? s.what : ''
  const prefill: Extract<AssistPrefill, { screen: 'simple-money-out' }> = {
    screen: 'simple-money-out', who, ...(supplierId != null ? { party: supplierId } : {}), ...(payeeId != null ? { payee: payeeId } : {}),
    ...(s.amount != null ? { amount: s.amount } : {}), how: s.how ?? 'cash', ...(s.date ? { date: s.date } : {}), ...(note ? { note } : {})
  }
  // The flow's own form, pre-filled the way the screen pre-fills it (askPrefill.ts).
  const form: MoneyOutForm = moneyOutFromAsk(emptyMoneyOutForm(today), prefill)
  const facts = gstRegistrationOf(company)
  const ctx = { facts, companyStateCode: company.stateCode, supplierState: (id: number) => setup.suppliers.find((x) => x.id === id)?.stateCode ?? null, drawingsId: setup.drawingsId }
  const open = supplierId != null ? moneyBills(db, supplierId, date) : []
  const errs = moneyOutErrors(form, open, setup.defaultsOut, ctx)
  missing ??= firstError(errs, t)
  const intent = missing ? null : (moneyOutIntentFrom(form, open, setup.defaultsOut, ctx) as Intent)
  return { prefill, intent, missing, readAs }
}

function moneyIn(db: DB, s: AssistEntrySlots, input: AskInput, t: Translate): Built {
  const today = input.today
  const date = s.date ?? today
  const setup = moneySetup(db)
  const readAs: string[] = []
  let who: 'customer' | 'owner' = 'customer'
  let customerId: number | null = null
  let missing: string | null = null
  if (input.picks?.party) customerId = input.picks.party
  else if (OWNER_WORDS.test(`${s.party ?? ''} ${s.what ?? ''}`)) who = 'owner'
  else if (s.party) {
    const found = findLedger(db, s.party, ['debtor'], today)
    if (found.status === 'choose') return { prefill: { screen: 'simple-money-in', who: 'customer' }, intent: null, missing: null, choice: choose('party', t('assist.which', { name: s.party }), found), readAs }
    if (found.status === 'match') customerId = found.id
    else missing = t('assist.entry.noCustomer', { name: s.party })
  }
  if (s.readAs === 'koMila' && s.party && s.amount != null) readAs.push(t('assist.entry.koMila', { name: s.party, amount: money(s.amount) }))
  const prefill: Extract<AssistPrefill, { screen: 'simple-money-in' }> = {
    screen: 'simple-money-in', who, ...(customerId != null ? { party: customerId } : {}), ...(s.amount != null ? { amount: s.amount } : {}), how: s.how ?? 'cash',
    ...(s.date ? { date: s.date } : {}), ...(s.what ? { note: s.what } : {})
  }
  const form: MoneyInForm = moneyInFromAsk(emptyMoneyInForm(today), prefill)
  const open = customerId != null ? moneyBills(db, customerId, date) : []
  const errs = moneyInErrors(form, open, setup.defaultsIn, { ownerId: setup.ownerId })
  missing ??= firstError(errs, t)
  const intent = missing ? null : (moneyInIntentFrom(form, open, setup.defaultsIn, { ownerId: setup.ownerId }) as Intent)
  return { prefill, intent, missing, readAs }
}

function invoiceCtx(db: DB, company: CompanyInfo): SellContext['invoice'] {
  return {
    companyStateCode: company.stateCode,
    ...gstRegistrationOf(company),
    items: new Map(listStockItems(db).map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(listLedgers(db).map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
  }
}

/** The product, its quantity and price — shared by sales and purchases. */
function goods(
  db: DB,
  s: AssistEntrySlots,
  input: AskInput,
  t: Translate,
  side: 'sale' | 'purchase',
  partyId: number | null
): { itemId: number | null; qtyMilli: number; rate: number | null; incl: boolean; choice?: AssistChoice; missing: string | null } {
  const inventory = getFeatures(db).inventory
  let itemId: number | null = input.picks?.item ?? null
  if (itemId == null && s.what && inventory) {
    const found = findItem(db, s.what, input.today)
    if (found.status === 'choose') return { itemId: null, qtyMilli: 0, rate: null, incl: false, choice: choose('item', t('assist.whichItem', { name: s.what }), found), missing: null }
    if (found.status === 'match') itemId = found.id
    else if (s.qtyMilli != null) return { itemId: null, qtyMilli: s.qtyMilli, rate: null, incl: false, missing: t('assist.entry.noProduct', { name: s.what }) }
  }
  const qtyMilli = s.qtyMilli ?? 1000
  if (itemId == null) return { itemId: null, qtyMilli, rate: null, incl: false, missing: null }
  if (s.amount != null) return { itemId, qtyMilli, rate: s.perUnit ? s.amount : rateFor(s.amount, qtyMilli), incl: true, missing: null }
  if (side === 'purchase') return { itemId, qtyMilli, rate: null, incl: false, missing: null }
  // No price said: the price list's (resolvePrice — the bill's own prefill).
  const p = pricingLoader(db)({ date: s.date ?? input.today, partyLedgerId: partyId, currency: 'INR', supply: 'intra' }, itemId, qtyMilli)
  return { itemId, qtyMilli, rate: p.ratePaise != null && p.ratePaise > 0 && p.source !== 'none' ? p.ratePaise : null, incl: false, missing: null }
}

function sale(db: DB, company: CompanyInfo, s: AssistEntrySlots, input: AskInput, t: Translate): Built {
  const today = input.today
  const date = s.date ?? today
  const setup = sellSetup(db)
  let customerId: number | null = input.picks?.party ?? null
  let missing: string | null = null
  if (customerId == null && s.party) {
    const found = findLedger(db, s.party, ['debtor'], today)
    if (found.status === 'choose') return { prefill: { screen: 'simple-sell' }, intent: null, missing: null, choice: choose('party', t('assist.which', { name: s.party }), found), readAs: [] }
    if (found.status === 'match') customerId = found.id
    else missing = t('assist.entry.noCustomer', { name: s.party })
  }
  const g = goods(db, s, input, t, 'sale', customerId ?? setup.walkInId)
  if (g.choice) return { prefill: { screen: 'simple-sell' }, intent: null, missing: null, choice: g.choice, readAs: [] }
  missing ??= g.missing
  const prefill: Extract<AssistPrefill, { screen: 'simple-sell' }> = {
    screen: 'simple-sell', ...(customerId != null ? { party: customerId } : {}), ...(g.itemId != null ? { itemId: g.itemId, qtyMilli: g.qtyMilli } : {}),
    ...(g.itemId != null && s.amount != null && g.rate != null ? { rate: g.rate } : {}), ...(g.itemId == null && s.amount != null ? { amount: saidTotal(s)! } : {}),
    how: s.how ?? (customerId == null ? 'cash' : 'credit'), ...(s.date ? { date: s.date } : {})
  }
  let form: SellForm = sellFromAsk(emptySellForm(today, { mode: 'amount', ratesIncludeGst: false }), prefill, (l) => ({ ...l, key: 1 }))
  // A line without a said price takes the price list's — what the screen's own prefill does.
  if (g.rate != null && prefill.rate == null) form = { ...form, lines: form.lines.map((l) => (l.auto && l.rate == null ? { ...l, rate: g.rate } : l)) }
  const ctx: SellContext = { invoice: invoiceCtx(db, company), salesAccountId: setup.salesAccountId }
  const totals = sellTotals(form, ctx)
  const customer = setup.customers.find((c) => c.id === customerId)
  const errs = sellFormErrors(form, ctx, { onHold: !!customer?.creditHold, regular: totals.charges })
  missing ??= firstError(errs, t)
  const intent = missing ? null : (saleIntentFrom(form, ctx, setup.defaults) as Intent)
  return { prefill, intent, missing, readAs: [] }
}

function purchase(db: DB, company: CompanyInfo, s: AssistEntrySlots, input: AskInput, t: Translate): Built {
  const today = input.today
  const date = s.date ?? today
  const setup = buySetup(db)
  let supplierId: number | null = input.picks?.party ?? null
  let missing: string | null = null
  if (supplierId == null && s.party) {
    const found = findLedger(db, s.party, ['creditor'], today)
    if (found.status === 'choose') return { prefill: { screen: 'simple-buy' }, intent: null, missing: null, choice: choose('party', t('assist.which', { name: s.party }), found), readAs: [] }
    if (found.status === 'match') supplierId = found.id
    else missing = t('assist.entry.noSupplier', { name: s.party })
  }
  const g = goods(db, s, input, t, 'purchase', supplierId)
  if (g.choice) return { prefill: { screen: 'simple-buy' }, intent: null, missing: null, choice: g.choice, readAs: [] }
  missing ??= g.missing
  const regular = company.gstRegistrationType === 'regular'
  const prefill: Extract<AssistPrefill, { screen: 'simple-buy' }> = {
    screen: 'simple-buy', ...(supplierId != null ? { party: supplierId } : {}), ...(g.itemId != null ? { itemId: g.itemId, qtyMilli: g.qtyMilli } : {}),
    ...(g.rate != null && g.itemId != null ? { rate: g.rate } : {}), ...(g.itemId == null && s.amount != null ? { amount: saidTotal(s)! } : {}),
    how: s.how ?? 'credit', ...(s.date ? { date: s.date } : {})
  }
  // The screen's blank form: bills print prices before GST for a regular registration.
  const form: BuyForm = buyFromAsk(emptyBuyForm(today, { mode: 'amount', ratesIncludeGst: !regular }), prefill, (l) => ({ ...l, key: 1 }))
  const ctx: BuyContext = { invoice: invoiceCtx(db, company), purchaseAccountId: setup.purchaseAccountId }
  const errs = buyFormErrors(form, ctx)
  missing ??= firstError(errs, t)
  const intent = missing ? null : (purchaseIntentFrom(form, ctx, setup.defaults) as Intent)
  return { prefill, intent, missing, readAs: [] }
}

let previewSeq = 0

/** The offer for an entry request: the flow's prefill, its intent and the rehearsed sentences. */
export function buildEntry(db: DB, company: CompanyInfo, slots: AssistEntrySlots, input: AskInput, env: AskEnv, t: Translate): { offer: AssistEntryOffer | null; choice?: AssistChoice; readAs: string[] } {
  const built =
    slots.action === 'money_out' ? moneyOut(db, company, slots, input, t)
      : slots.action === 'money_in' ? moneyIn(db, slots, input, t)
        : slots.action === 'sale' ? sale(db, company, slots, input, t)
          : purchase(db, company, slots, input, t)
  if (built.choice) return { offer: null, choice: built.choice, readAs: built.readAs }
  let sentences: string[] = []
  let missing = built.missing
  let intent = built.intent
  if (intent) {
    try {
      const p = previewIntent(db, company, { ...intent, clientId: `ask-total-preview-${++previewSeq}` }, input.today)
      sentences = p.sentences
    } catch (err) {
      const m = mapError(err as CaughtError, { simple: true, t })
      missing = [m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || t('assist.entry.cannotSave')
      intent = null
    }
  }
  return { offer: { kind: slots.action, prefill: built.prefill, intent, sentences, missing, canDraft: env.canDraft }, readAs: built.readAs }
}

export function entryAnswer(db: DB, company: CompanyInfo, intent: EntryIntent, input: AskInput, env: AskEnv, t: Translate): AssistAnswer {
  const r = buildEntry(db, company, intent.entry, input, env, t)
  const base = { intent: 'entry' as const, answeredBy: 'total' as const, figures: [], links: [], understood: true }
  if (r.choice) return { ...base, sentences: [r.choice.question], choice: r.choice }
  const offer = r.offer!
  const screen = t(SCREEN_NAME[offer.prefill.screen])
  const sentences = [...r.readAs]
  if (offer.sentences.length) sentences.push(...offer.sentences)
  else {
    const vars = readVars(db, offer, intent.entry, t)
    const key = (offer.kind === 'sale' || offer.kind === 'purchase') && !vars.amount ? READ_NO_AMOUNT[offer.kind] : READ[offer.kind]
    sentences.push(t(key, vars))
  }
  if (offer.missing) sentences.push(t('assist.entry.missing', { reason: offer.missing, screen }))
  sentences.push(env.canDraft ? t('assist.entry.notSaved', { screen }) : t('assist.entry.viewer'))
  return { ...base, sentences, entry: offer }
}

const HOW_TEXT = { cash: 'assist.entry.how.cash', upi: 'assist.entry.how.upi', card: 'assist.entry.how.card', bank: 'assist.entry.how.bank' } as const

/** "You paid ₹500.00 in cash for tea (Office expenses)" — what the words were read as. */
function readVars(db: DB, offer: AssistEntryOffer, s: AssistEntrySlots, t: Translate): Record<string, string> {
  const p = offer.prefill
  const nameOf = (id: number | undefined): string | null => (id ? ((db.prepare('SELECT name FROM ledgers WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null) : null)
  const how = 'how' in p && p.how && p.how !== 'credit' ? t(HOW_TEXT[p.how]) : ''
  const account = p.screen === 'simple-money-out' ? nameOf(p.payee ?? p.party) : p.screen === 'simple-money-in' ? nameOf(p.party) : null
  if (p.screen === 'simple-sell' || p.screen === 'simple-buy') {
    // "You sold 3 bags to Ramesh Traders for ₹900.00" — the person as found (or as said).
    const who = nameOf(p.party) ?? s.party ?? null
    const items = s.qtyMilli != null && s.what ? ` ${formatQtyMilli(s.qtyMilli)} ${s.what}` : ''
    return {
      amount: s.amount != null ? money(saidTotal(s)!) : '',
      items,
      who: who ? t(p.screen === 'simple-sell' ? 'assist.entry.to' : 'assist.entry.from', { what: who }) : ''
    }
  }
  // A person paid (Money out to someone who is not an account) reads "to Ramesh", not "for".
  const toPerson = p.screen === 'simple-money-out' && !account && !s.what && !!s.party
  const said = s.what ?? s.party ?? null
  const what = said && account && said.toLowerCase() !== account.toLowerCase() ? `${said} (${account})` : (account ?? said)
  return {
    amount: s.amount != null ? money(saidTotal(s)!) : '',
    how,
    what: what ? t(p.screen === 'simple-money-in' ? 'assist.entry.from' : toPerson ? 'assist.entry.to' : 'assist.entry.for', { what }) : ''
  }
}

const READ_NO_AMOUNT = { sale: 'assist.entry.read.saleNoAmount', purchase: 'assist.entry.read.purchaseNoAmount' } as const

const READ: Record<AssistEntrySlots['action'], MessageKey> = {
  money_out: 'assist.entry.read.moneyOut',
  money_in: 'assist.entry.read.moneyIn',
  sale: 'assist.entry.read.sale',
  purchase: 'assist.entry.read.purchase'
}

// ---------------------------------------------------------------- the draft

const SUMMARY: Record<AssistEntrySlots['action'], MessageKey> = {
  money_out: 'assist.draft.summary.moneyOut',
  money_in: 'assist.draft.summary.moneyIn',
  sale: 'assist.draft.summary.sale',
  purchase: 'assist.draft.summary.purchase'
}

/** assist:draft — store the entry request as an `ai_drafts` row the simple flow opens. The
 *  question is classified again here (never trusted from the renderer). Re-asking the same thing
 *  while its draft is still open returns that draft. */
export function createAskDraft(
  db: DB,
  company: CompanyInfo,
  input: AskInput,
  env: AskEnv,
  t: Translate,
  classifyFn: (text: string, today: string) => AssistIntent,
  askedBy: number | null = null
): AssistDraftResult {
  const intent = classifyFn(input.text, input.today)
  if (intent.kind !== 'entry') throw new Error('That is not something to record — ask it as a question instead')
  const r = buildEntry(db, company, intent.entry, input, env, t)
  if (!r.offer) throw new Error(r.choice?.question ?? 'Say which one you mean first')
  const offer = r.offer
  const question = input.text.trim()
  const existing = listDrafts(db, 'open', undefined, ['assistant']).find(
    (d) =>
      d.origin === ASK_TOTAL_ORIGIN && (d.payload.simple?.askedBy ?? null) === askedBy && d.payload.simple?.question === question &&
      JSON.stringify(d.payload.simple.prefill) === JSON.stringify(offer.prefill)
  )
  if (existing) return { draftId: existing.id, prefill: offer.prefill }
  const kind = VOUCHER_KIND[offer.kind]
  const type = listVoucherTypes(db).find((v) => v.kind === kind)
  if (!type) throw new Error(`There is no ${kind} entry type in this company`)
  const preview = offer.intent ? previewLines(db, company, offer.intent, input.today) : null
  const amount = saidTotal(intent.entry) ?? preview?.total ?? 0
  const summary = t(SUMMARY[offer.kind], { amount: money(amount) })
  const payload: AiVoucherDraftPayload = {
    voucherTypeId: type.id,
    voucherKind: kind,
    date: intent.entry.date ?? input.today,
    partyLedgerId: 'party' in offer.prefill && offer.prefill.party != null ? offer.prefill.party : null,
    narration: null,
    reference: null,
    lines: preview?.lines ?? [],
    ...(preview ? { total: preview.total } : {}),
    sources: [],
    assumptions: offer.missing ? [offer.missing] : [],
    origin: ASK_TOTAL_ORIGIN,
    simple: { kind: offer.kind, question, prefill: offer.prefill, intent: offer.intent, askedBy }
  }
  return db.transaction((): AssistDraftResult => {
    const d = insertDraft(db, { threadId: null, messageId: null, summary, payload, unrequested: false, source: 'assistant', origin: ASK_TOTAL_ORIGIN })
    writeAudit(db, 'ai_draft', d.id, 'create', null, { tool: 'ask-total', summary, payload, threadId: null, unrequested: false, origin: d.origin })
    // One open Ask Total draft per person: the older ones (flows left without saving) go.
    discardOlderAskDrafts(db, askedBy, d.id)
    return { draftId: d.id, prefill: offer.prefill }
  })()
}

/** The first entry's lines as the rehearsal posted them (for the accountant's drafts list). */
function previewLines(db: DB, company: CompanyInfo, intent: Intent, today: string): { lines: AiVoucherDraftPayload['lines']; total: number } | null {
  try {
    const p = previewIntent(db, company, { ...intent, clientId: `ask-total-preview-${++previewSeq}` }, today)
    const first = p.entries[0]
    if (!first) return null
    return { lines: first.lines.map((l) => ({ ledgerId: l.ledgerId, drCr: l.drCr, amount: l.amount })), total: p.facts.total }
  } catch {
    return null
  }
}
