// Ask Total (WP 10.1, plan 2026-10-13 §5): the shapes the deterministic assistant (src/main/assist/)
// returns to the renderer. Pure types + Zod for the IPC payloads. Nothing here talks to a model or
// the network: every answer is a templated sentence over figures the EXISTING read services
// computed, and an entry request becomes an `ai_drafts` row (source 'assistant', origin
// 'ask-total') that opens in the simple flow pre-filled — it never posts by itself.
import { z } from 'zod'
import type { AiFigure } from './ai'
import type { MoneyHow } from './simple/intents'
import type { SimpleIntentInput } from './simple/intents'

/** The origin stored on an Ask Total draft (ai_drafts.origin is free text — the CHECK covers
 *  `source` only, which already allows 'assistant'; no migration). */
export const ASK_TOTAL_ORIGIN = 'ask-total'

/** What the classifier understood (src/main/assist/classify.ts). */
export type AssistMeasure = 'profit' | 'sales' | 'purchases' | 'expenses'
export type AssistPeriodRule = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'lastQuarter' | 'fyToDate' | 'lastFy' | 'month'

export interface AssistPeriod {
  rule: AssistPeriodRule
  from: string
  to: string
}

export type AssistHowTo =
  | 'bill' | 'purchase' | 'moneyIn' | 'moneyOut' | 'moveMoney' | 'returnSale' | 'returnPurchase' | 'bank' | 'customer' | 'product'
  | 'stockCount' | 'gst' | 'backup' | 'language' | 'openings' | 'undo' | 'features' | 'reminder'

/** An entry the user asked to record, as typed (names and words — resolved in main). */
export interface AssistEntrySlots {
  action: 'money_out' | 'money_in' | 'sale' | 'purchase'
  /** Paise (parseAmountText), absent = not said. */
  amount?: number
  /** Quantity in thousandths (3 bags = 3000). */
  qtyMilli?: number
  /** The product ("bags"), or what it was for ("rent", "tea"). */
  what?: string
  /** A person / business named ("Ramesh", "Sita"). */
  party?: string
  how?: MoneyHow
  /** ISO (resolveDateText against the working date). */
  date?: string
  /** "Ramesh ko 5000 mila" — read as money in from Ramesh; the answer says so. */
  readAs?: 'koMila'
  /** "3 bags at 300 each" / "@ 300" / "300 per bag": `amount` is the price of ONE, not the total. */
  perUnit?: boolean
}

export type AssistIntent =
  | { kind: 'owed'; side: 'receivable' | 'payable'; party?: string }
  | { kind: 'gst' }
  | { kind: 'figure'; measure: AssistMeasure; period: AssistPeriod; periodSaid: boolean }
  | { kind: 'money'; which: 'cash' | 'bank' | 'both' }
  | { kind: 'stock'; item?: string; low?: boolean }
  | { kind: 'open'; target: string }
  | { kind: 'howto'; task: AssistHowTo }
  | { kind: 'meaning'; term: string }
  | { kind: 'entry'; entry: AssistEntrySlots }
  | { kind: 'unknown' }

export type AssistIntentKind = AssistIntent['kind']

/** Where a link / chip goes — a screen name + params the renderer maps through a whitelist
 *  (src/renderer/src/simple/askTargets.ts), never a free-form route. */
export interface AssistTarget {
  screen: string
  params?: Record<string, string | number | boolean>
}

export interface AssistLink {
  label: string
  target: AssistTarget
}

/** A figure in an answer: an AiFigure (the AI panel's chip shape) whose `source` names the
 *  service row / report it came from, plus where the chip opens. Always `sourced` — the number
 *  IS the service's figure, never typed by anyone. */
export interface AssistFigure extends AiFigure {
  target?: AssistTarget
}

/** "Which Ramesh?" — the options re-ask with the pick (never a guess). */
export interface AssistChoice {
  slot: 'party' | 'item'
  question: string
  options: { id: number; label: string; sub?: string }[]
}

/** What the simple flow opens with (the screen's own params). */
export type AssistPrefill =
  | { screen: 'simple-money-out'; who: 'supplier' | 'expense' | 'owner'; party?: number; payee?: number; amount?: number; how?: MoneyHow; date?: string; note?: string }
  | { screen: 'simple-money-in'; who: 'customer' | 'owner'; party?: number; amount?: number; how?: MoneyHow; date?: string; note?: string }
  | { screen: 'simple-sell'; party?: number; itemId?: number; qtyMilli?: number; rate?: number; amount?: number; how?: MoneyHow | 'credit'; date?: string; note?: string }
  | { screen: 'simple-buy'; party?: number; itemId?: number; qtyMilli?: number; rate?: number; amount?: number; how?: MoneyHow | 'credit'; date?: string; note?: string }

export interface AssistEntryOffer {
  /** The intent kind the flow will save (simple:post). */
  kind: 'money_out' | 'money_in' | 'sale' | 'purchase'
  prefill: AssistPrefill
  /** The flow's own intent built from the prefill (what Save would send), when complete. */
  intent: Omit<SimpleIntentInput, 'clientId'> | null
  /** Plain sentences from simple:preview (rehearsed, nothing saved), when complete. */
  sentences: string[]
  /** Why it can't be saved as it stands (the flow asks) — a plain sentence; null = ready. */
  missing: string | null
  /** The signed-in role may record entries (accountant / owner, or a company without users). */
  canDraft: boolean
}

export interface AssistAnswer {
  intent: AssistIntentKind
  /** Always 'total': the deterministic assistant answered (the panel says "Total answered this
   *  itself"); model answers come through the AI panel's own events. */
  answeredBy: 'total'
  sentences: string[]
  figures: AssistFigure[]
  links: AssistLink[]
  choice?: AssistChoice
  entry?: AssistEntryOffer
  /** "I can't answer that yet; try these" — 3 questions. */
  suggestions?: string[]
  /** Help search over the plain glossary (WP 10.3 help articles are not there yet). */
  help?: { term: string; plain: string; explain: string }[]
  /** "Open X": where the panel goes right away (resolved by the search service / the place words). */
  open?: AssistTarget
  /** Not understood: with AI on, the panel may pass the question to the model. */
  understood: boolean
}

export interface AssistDraftResult {
  draftId: number
  prefill: AssistPrefill
}

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const picks = z
  .object({ party: z.number().int().positive().optional(), item: z.number().int().positive().optional() })
  .strict()
  .optional()

/** assist:ask (viewer) and assist:draft (accountant+): the question as typed, the working date
 *  and any answers to an earlier "Which …?". */
export const assistAskSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
    today: iso.optional(),
    picks,
    lang: z.enum(['en', 'hi', 'hinglish']).optional()
  })
  .strict()
export type AssistAskInput = z.input<typeof assistAskSchema>
