// WP 10.6: the AI helper in plain words (simple mode). Pure: the sentences the simple AI settings
// screen, the simple AI panel and the simple capture estimate show, built through t() from what
// main already returned (settings view, the key check's model list, usage rows, a turn's tool
// calls, a draft) — never a new figure, never a model. Also the one rule that picks a model from
// the list the key check returned (never a hard-coded id when the list is there) and the one
// mapping from a provider error to a plain message + the field it belongs to.
//
// Costs are integer micro-USD everywhere (shared/ai.ts). They become rupees ONLY with a dollar
// rate the company itself entered (fx_rates, WP 4.4) — no rate is ever assumed; without one the
// cost is said in dollars.

import type { AiDraftDto, AiMessageDto, AiUsageRow } from '../ai'
import type { AssistPrefill } from '../assist'
import type { FxRate } from '../cashFinance'
import type { MessageKey, Translate } from '../i18n'
import { formatPaise } from '../money'
import { toPlainDate } from '../dates'

// ---------- the model pick ----------

/** Model ids that are not chat models (embeddings, speech, images, moderation …). */
const NOT_CHAT = /(embed|whisper|tts|audio|speech|transcri|dall-?e|image|moderation|realtime|search|computer-use|instruct|babbage|davinci|codex)/i
/** Small / quick variants — good for the fast model, not the default. */
const SMALL = /(mini|nano|luna|lite|small|fast|haiku|flash)/i
/** A dated snapshot (…-2025-08-06 / …-0613) — the undated alias is preferred. */
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{4})$/

/** gpt-6.1-sol → [6, 1]; o3 → [3]; anything else → []. */
function versionOf(id: string): number[] {
  const m = /^(?:gpt-|o)(\d+(?:\.\d+)*)/i.exec(id)
  return m ? m[1]!.split('.').map(Number) : []
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

/** Best first: chat models, undated, newest version, then by name (stable). */
function rank(models: readonly string[], small: boolean): string[] {
  return models
    .filter((m) => !NOT_CHAT.test(m) && SMALL.test(m) === small)
    .sort((a, b) => {
      const dated = Number(DATED.test(a)) - Number(DATED.test(b))
      if (dated !== 0) return dated
      const v = compareVersions(versionOf(b), versionOf(a))
      return v !== 0 ? v : a.localeCompare(b)
    })
}

export interface ModelPick {
  defaultModel: string
  fastModel: string
  /** Either differs from the current settings (the screen saves it). */
  changed: boolean
}

/**
 * The key check listed `models`: keep the current default / fast model when the key offers it,
 * else pick from the list — the newest undated chat model for the default, the newest small one
 * for the fast model (else the default). An empty list keeps the current ids (nothing to pick from).
 */
export function pickModels(models: readonly string[], current: { defaultModel: string; fastModel: string }): ModelPick {
  if (models.length === 0) return { ...current, changed: false }
  const big = rank(models, false)
  const small = rank(models, true)
  const defaultModel = models.includes(current.defaultModel) ? current.defaultModel : (big[0] ?? small[0] ?? models[0]!)
  const fastModel = models.includes(current.fastModel) ? current.fastModel : (small[0] ?? defaultModel)
  return { defaultModel, fastModel, changed: defaultModel !== current.defaultModel || fastModel !== current.fastModel }
}

/** "gpt-5, gpt-5-mini, gpt-4.1 and 9 more" — the chat models first (best first), at most `max`. */
export function modelsListText(models: readonly string[], t: Translate, max = 5): string {
  const chat = [...rank(models, false), ...rank(models, true)]
  const ordered = [...chat, ...models.filter((m) => !chat.includes(m))]
  const shown = ordered.slice(0, max).join(', ')
  return ordered.length > max ? t('simple.ai.key.more', { list: shown, count: ordered.length - max }) : shown
}

// ---------- provider errors → plain words + a field ----------

export type AiPlainErrorKind = 'key' | 'quota' | 'busy' | 'network' | 'model' | 'sharedKey' | 'sharedKeyConfirm' | 'noSecureStorage' | 'other'

export interface AiPlainError {
  kind: AiPlainErrorKind
  /** 'key' = shown under the key box; null = a message for the screen / panel. */
  field: 'key' | null
  key: MessageKey
  /** The provider's own wording — behind Details only. */
  detail: string
}

const ERROR_KEYS: Record<AiPlainErrorKind, MessageKey> = {
  key: 'simple.ai.error.key',
  quota: 'simple.ai.error.quota',
  busy: 'simple.ai.error.busy',
  network: 'simple.ai.error.network',
  model: 'simple.ai.error.model',
  sharedKey: 'simple.ai.error.sharedKey',
  sharedKeyConfirm: 'simple.ai.error.sharedKeyConfirm',
  noSecureStorage: 'simple.ai.error.noSecureStorage',
  other: 'simple.ai.error.other'
}

/** Reads the messages main sends (provider.ts plainMessage, ai/ipc.ts key rules, OpenAI's own
 *  error text) — order matters: a 429 that says "quota" is out of credit, not busy. */
export function classifyAiError(message: string): AiPlainError {
  const m = message ?? ''
  const kind: AiPlainErrorKind =
    /another company here has users/i.test(m) ? 'sharedKey'
      : /confirm to continue/i.test(m) ? 'sharedKeyConfirm'
        : /secure storage/i.test(m) ? 'noSecureStorage'
          : /\b401\b|rejected the api key|incorrect api key|invalid api key|invalid_api_key|no api key/i.test(m) ? 'key'
            : /insufficient_quota|exceeded your current quota|\bquota\b|billing|out of credit|credit balance/i.test(m) ? 'quota'
              : /\b429\b|rate[- ]limit/i.test(m) ? 'busy'
                : /network|could not reach|did not answer in time|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|sent nothing for/i.test(m) ? 'network'
                  : /\b404\b|does not know this model|model_not_found|does not exist/i.test(m) ? 'model'
                    : 'other'
  return { kind, field: kind === 'key' ? 'key' : null, key: ERROR_KEYS[kind], detail: m }
}

// ---------- money: micro-USD → rupees with the company's own dollar rate ----------

/** The newest USD rate on or before `today` the company entered (fx_rates), else null. */
export function usdRateOn(rates: readonly FxRate[] | null | undefined, today: string): FxRate | null {
  let best: FxRate | null = null
  for (const r of rates ?? []) {
    if (r.currencyCode !== 'USD' || r.date > today || !(r.rateMicro > 0)) continue
    if (!best || r.date > best.date) best = r
  }
  return best
}

/** micro-USD × (rupees per dollar × 10⁶) → paise, half-up, BigInt (no float touches it). */
export function microUsdToPaise(microUsd: number, rateMicro: number): number {
  const n = BigInt(Math.round(microUsd)) * BigInt(Math.round(rateMicro))
  const d = 10_000_000_000n // 10⁶ (micro-USD) × 10⁶ (rate) / 100 (paise)
  return Number((n + d / 2n) / d)
}

/** '$0.0123' — dollars to 4 places, integer maths. */
function dollars(microUsd: number): string {
  const tenThousandths = Math.round(microUsd / 100)
  return `$${Math.floor(tenThousandths / 10000)}.${String(tenThousandths % 10000).padStart(4, '0')}`
}

/** "₹1.25" with the company's dollar rate, else "$0.0150" (say it with `rateNote`). */
export function moneyText(microUsd: number, rate: FxRate | null): string {
  return rate ? formatPaise(microUsdToPaise(microUsd, rate.rateMicro), { symbol: true }) : dollars(microUsd)
}

/** "about ₹1.25" with the company's dollar rate, else "about $0.0150 (in US dollars)". */
export function costText(microUsd: number, rate: FxRate | null, t: Translate): string {
  if (rate) return t('simple.ai.cost.rupees', { amount: formatPaise(microUsdToPaise(microUsd, rate.rateMicro), { symbol: true }) })
  return t('simple.ai.cost.dollars', { amount: dollars(microUsd) })
}

export interface MonthSpend {
  calls: number
  /** Calls with a price (their cost is in `microUsd`). */
  priced: number
  microUsd: number
  inputTokens: number
  outputTokens: number
}

/** The usage rows of `month` ('2026-10'). */
export function monthSpend(rows: readonly AiUsageRow[], month: string): MonthSpend {
  const s: MonthSpend = { calls: 0, priced: 0, microUsd: 0, inputTokens: 0, outputTokens: 0 }
  for (const r of rows) {
    if (!r.day.startsWith(month)) continue
    s.calls++
    s.inputTokens += r.inputTokens
    s.outputTokens += r.outputTokens
    if (r.costMicroUsd != null) {
      s.priced++
      s.microUsd += r.costMicroUsd
    }
  }
  return s
}

/** The settings screen's spend sentence: nothing yet / the cost (+ a note for unpriced calls) /
 *  "not priced" (tokens are behind Details). */
export function monthSpendSentence(s: MonthSpend, rate: FxRate | null, t: Translate): string {
  if (s.calls === 0) return t('simple.ai.spend.none')
  if (s.priced === 0) return t('simple.ai.spend.unpriced', { count: s.calls })
  const cost = t('simple.ai.spend.cost', { count: s.calls, cost: costText(s.microUsd, rate, t) })
  return s.priced < s.calls ? `${cost} ${t('simple.ai.spend.someUnpriced', { count: s.calls - s.priced })}` : cost
}

/** The rate sentence under a rupee cost ("At your dollar rate of ₹84.10 from 1 Oct 2026"). */
export function rateNote(rate: FxRate | null, t: Translate): string {
  if (!rate) return t('simple.ai.cost.noRate')
  return t('simple.ai.cost.rate', { rate: formatPaise(Math.round(rate.rateMicro / 10_000), { symbol: true }), date: toPlainDate(rate.date) })
}

// ---------- a turn: where its figures came from, its cost ----------

const TOOL_PLACES: Record<string, MessageKey> = {
  get_company_info: 'simple.ai.from.business',
  list_ledgers: 'simple.ai.from.accounts',
  ledger_statement: 'simple.ai.from.accountHistory',
  trial_balance: 'simple.ai.from.balances',
  profit_and_loss: 'simple.ai.from.profit',
  balance_sheet: 'simple.ai.from.worth',
  outstandings: 'simple.ai.from.owed',
  search_books: 'simple.ai.from.search',
  day_book: 'simple.ai.from.daily',
  stock_summary: 'simple.ai.from.stock',
  item_movements: 'simple.ai.from.stock',
  gst_summary: 'simple.ai.from.gst',
  tds_summary: 'simple.ai.from.tds',
  tds_eligible: 'simple.ai.from.tds',
  current_screen_data: 'simple.ai.from.screen',
  explain_figure: 'simple.ai.from.screen',
  manufacture_register: 'simple.ai.from.made',
  trade_pending: 'simple.ai.from.orders',
  bank_unreconciled: 'simple.ai.from.bank',
  budget_variance: 'simple.ai.from.budget',
  forecast_summary: 'simple.ai.from.cashAhead',
  audit_log_recent: 'simple.ai.from.history',
  close_checklist: 'simple.ai.from.monthEnd',
  gst_2b_mismatches: 'simple.ai.from.supplierBills',
  find_anomalies: 'simple.ai.from.unusual',
  build_report: 'simple.ai.from.report',
  categorise_statement: 'simple.ai.from.bank'
}

/** The plain place a read tool's figures come from; null for draft / memory tools. */
export function toolPlace(name: string): MessageKey | null {
  if (TOOL_PLACES[name]) return TOOL_PLACES[name]!
  if (name.startsWith('draft_') || name === 'remember') return null
  return 'simple.ai.from.books'
}

/** The messages of the turn that ends with `finalId` (from its question on). */
function turnOf(messages: readonly AiMessageDto[], finalId: number): AiMessageDto[] {
  const at = messages.findIndex((m) => m.id === finalId)
  if (at < 0) return []
  let start = at
  while (start > 0 && messages[start - 1]!.role !== 'user') start--
  return messages.slice(start, at + 1)
}

/** "This answer used figures from: How your business is doing, Who owes you." — the places of
 *  the read tools that answered without an error in this turn (each once); null when none did. */
export function figuresFromSentence(messages: readonly AiMessageDto[], finalId: number, t: Translate): string | null {
  const places: string[] = []
  for (const m of turnOf(messages, finalId)) {
    if (m.role !== 'tool' || !m.toolName || m.toolOk === false) continue
    const k = toolPlace(m.toolName)
    if (!k) continue
    const p = t(k) // i18n-technical: keys from TOOL_PLACES
    if (!places.includes(p)) places.push(p)
  }
  return places.length ? t('simple.ai.panel.figuresFrom', { places: places.join(', ') }) : null
}

/** The cost of the turn when priced (null = not priced: the panel says nothing; tokens are in Details). */
export function turnCostText(costMicroUsd: number | null, rate: FxRate | null, t: Translate): string | null {
  if (costMicroUsd == null) return null
  return t('simple.ai.panel.cost', { cost: costText(costMicroUsd, rate, t) })
}

// ---------- a draft → its simple flow ----------

export interface DraftOffer {
  /** "Save this as a bill?" */
  question: MessageKey
  /** The simple flow's prefill (opened with `ask: { draftId: null, prefill }`), or null = no
   *  simple flow for this kind of entry (the panel says so). */
  prefill: AssistPrefill | null
}

type Line = { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }
type InvoiceRow = { itemId?: number | null; qtyMilli?: number | null; qtyText?: string | null }

/** The single goods row of an invoice draft's form state (several rows / none → null). */
function singleItemRow(state: unknown): { itemId: number; qtyMilli?: number } | null {
  const rows = (state as { rows?: InvoiceRow[] } | null)?.rows
  if (!Array.isArray(rows)) return null
  const goods = rows.filter((r) => typeof r?.itemId === 'number' && r.itemId > 0)
  if (goods.length !== 1) return null
  const r = goods[0]!
  const q = typeof r.qtyMilli === 'number' && r.qtyMilli > 0 ? r.qtyMilli : /^\d+(\.\d{1,3})?$/.test(String(r.qtyText ?? '').trim()) ? Math.round(Number(String(r.qtyText).trim()) * 1000) : undefined
  return { itemId: r.itemId!, ...(q ? { qtyMilli: q } : {}) }
}

/**
 * The plain offer for a draft the AI made: a sale → "Save this as a bill?" (Make a bill), a
 * purchase → Record a purchase, a payment → Money out, a receipt → Money in — pre-filled with the
 * party, the one product + quantity (the flow prices it; several products → the party only, the
 * user adds them) or the amount, the date and the note. Every other kind has no simple flow.
 * The flow saves through simple:post as always (the draft itself stays in the AI's list).
 */
export function draftOffer(d: Pick<AiDraftDto, 'payload'>): DraftOffer {
  const p = d.payload
  const note = p.narration?.trim() ? { note: p.narration.trim().slice(0, 200) } : {}
  const date = p.date ? { date: p.date } : {}
  const statePartyId = (p.state as { partyId?: unknown } | null | undefined)?.partyId
  const partyId = p.partyLedgerId ?? (typeof statePartyId === 'number' && statePartyId > 0 ? statePartyId : null)
  const party = partyId ? { party: partyId } : {}
  const lines: Line[] = Array.isArray(p.lines) ? p.lines : []
  const total = p.total ?? lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const amount = total > 0 ? { amount: total } : {}
  switch (p.voucherKind) {
    case 'sales':
    case 'purchase': {
      const screen = p.voucherKind === 'sales' ? 'simple-sell' : 'simple-buy' // i18n-technical
      const row = p.form === 'invoice' ? singleItemRow(p.state) : null
      const goods = p.form === 'invoice' ? (row ? { itemId: row.itemId, ...(row.qtyMilli ? { qtyMilli: row.qtyMilli } : {}) } : {}) : amount
      return {
        question: p.voucherKind === 'sales' ? 'simple.ai.draft.asBill' : 'simple.ai.draft.asPurchase',
        prefill: { screen, ...party, ...goods, ...date, ...note } as AssistPrefill
      }
    }
    case 'payment': {
      const payee = partyId ? null : (lines.find((l) => l.drCr === 'dr')?.ledgerId ?? null)
      return {
        question: 'simple.ai.draft.asMoneyOut',
        prefill: partyId
          ? { screen: 'simple-money-out', who: 'supplier', party: partyId, ...amount, ...date, ...note }
          : { screen: 'simple-money-out', who: 'expense', ...(payee ? { payee } : {}), ...amount, ...date, ...note }
      }
    }
    case 'receipt':
      return { question: 'simple.ai.draft.asMoneyIn', prefill: { screen: 'simple-money-in', who: 'customer', ...party, ...amount, ...date, ...note } }
    default:
      return { question: 'simple.ai.draft.noFlow', prefill: null }
  }
}
