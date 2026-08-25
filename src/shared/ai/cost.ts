/**
 * What an assistant run costs, and the caps that stop it.
 *
 * Bring-your-own-key means Total never bills anyone — but it does spend the user's money, and a
 * tool loop against a large model is the only part of this app that can cost anything at all.
 * So the run is capped in main, in rupees, per session and per day.
 *
 * Everything here is an ESTIMATE and is labelled as one in the UI. The provider's invoice is the
 * truth; this exists so that a runaway loop stops at ₹100 instead of ₹10,000. Three consequences
 * follow, and each is a deliberate choice rather than an oversight:
 *
 *  - Prices are list prices in USD, converted at a fixed assumed rate. A real FX lookup would
 *    need the network, on a machine whose whole promise is that it does not need one.
 *  - An unrecognised model is charged at a FALLBACK rate rather than at zero. A cap that stops
 *    counting the moment it meets a model it has not heard of is not a cap.
 *  - A local endpoint costs nothing, so caps never apply to it. That is the configuration this
 *    feature is happiest in.
 */

/** When the price table below was last checked against published list prices. */
export const PRICES_CHECKED_ON = '2026-08'

/**
 * Rupees per US dollar, in paise. Fixed rather than fetched: see the header. Generous on
 * purpose — over-estimating the cost makes the cap bite earlier, which is the safe direction.
 */
export const ASSUMED_USD_PAISE = 9_000

export interface ModelPrice {
  /** Matched against the model id, lower-cased, as a substring. */
  prefix: string
  /** US dollars per million input tokens. */
  inUsd: number
  /** US dollars per million output tokens. */
  outUsd: number
}

/**
 * List prices per million tokens, longest match wins.
 *
 * Kept deliberately short. This is not a price-comparison feature — it is the denominator of a
 * spend cap, and a table nobody maintains that is confidently wrong about forty models is worse
 * than a small one that falls back honestly.
 */
export const MODEL_PRICES: ModelPrice[] = [
  { prefix: 'gpt-4o-mini', inUsd: 0.15, outUsd: 0.6 },
  { prefix: 'gpt-4o', inUsd: 2.5, outUsd: 10 },
  { prefix: 'gpt-4.1-mini', inUsd: 0.4, outUsd: 1.6 },
  { prefix: 'gpt-4.1-nano', inUsd: 0.1, outUsd: 0.4 },
  { prefix: 'gpt-4.1', inUsd: 2, outUsd: 8 },
  { prefix: 'o4-mini', inUsd: 1.1, outUsd: 4.4 },
  { prefix: 'claude-3-5-haiku', inUsd: 0.8, outUsd: 4 },
  { prefix: 'claude-haiku', inUsd: 0.8, outUsd: 4 },
  { prefix: 'claude-sonnet', inUsd: 3, outUsd: 15 },
  { prefix: 'claude-opus', inUsd: 15, outUsd: 75 },
  { prefix: 'deepseek', inUsd: 0.3, outUsd: 1.2 },
  { prefix: 'llama', inUsd: 0.2, outUsd: 0.8 },
  { prefix: 'mistral', inUsd: 0.3, outUsd: 0.9 },
  { prefix: 'qwen', inUsd: 0.2, outUsd: 0.8 }
]

/**
 * Charged when the model id matches nothing. Roughly a mid-market hosted model: high enough
 * that a loop on an exotic model still trips the cap, low enough not to block a cheap one after
 * two questions.
 */
export const FALLBACK_PRICE: ModelPrice = { prefix: '', inUsd: 1, outUsd: 4 }

export function priceFor(model: string): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase()
  // Longest match first, so 'gpt-4o-mini' is not charged at 'gpt-4o' rates.
  const hit = [...MODEL_PRICES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((p) => id.includes(p.prefix))
  return hit ? { price: hit, known: true } : { price: FALLBACK_PRICE, known: false }
}

export interface CostEstimate {
  paise: number
  /** False when the model was not in the table and the fallback rate was used. */
  known: boolean
}

/**
 * Estimated cost of one exchange, in integer paise, rounded up.
 *
 * Rounded UP because a cap that under-counts by a fraction of a paisa on every call is a cap
 * that drifts in the user's disfavour over a long session.
 */
export function estimateCostPaise(
  model: string,
  promptTokens: number,
  completionTokens: number,
  opts: { local?: boolean } = {}
): CostEstimate {
  if (opts.local) return { paise: 0, known: true }
  const { price, known } = priceFor(model)
  const usd = (promptTokens / 1_000_000) * price.inUsd + (completionTokens / 1_000_000) * price.outUsd
  return { paise: Math.ceil(usd * ASSUMED_USD_PAISE), known }
}

export interface SpendCheck {
  /** Spent so far in this app session, in paise. */
  sessionPaise: number
  /** Spent so far today, across sessions on this machine, in paise. */
  todayPaise: number
  sessionCapPaise: number
  dailyCapPaise: number
  local?: boolean
}

export type CapVerdict = { blocked: false } | { blocked: true; scope: 'session' | 'day'; message: string }

/**
 * Whether a new run may start.
 *
 * A cap of 0 blocks outright, and the settings copy says so: it is the second off-switch, for
 * someone who wants the feature configured but not spending. A local endpoint is never blocked
 * — there is nothing to spend.
 */
export function capVerdict(s: SpendCheck): CapVerdict {
  if (s.local) return { blocked: false }
  if (s.sessionCapPaise <= 0 || s.dailyCapPaise <= 0) {
    return {
      blocked: true,
      scope: s.sessionCapPaise <= 0 ? 'session' : 'day',
      message: 'The assistant spend cap is set to zero. Raise it in Settings → AI to ask anything.'
    }
  }
  if (s.sessionPaise >= s.sessionCapPaise) {
    return {
      blocked: true,
      scope: 'session',
      message: 'This session has reached its spend cap. Clear the conversation, or raise the cap in Settings → AI.'
    }
  }
  if (s.todayPaise >= s.dailyCapPaise) {
    return {
      blocked: true,
      scope: 'day',
      message: "Today's assistant spend cap has been reached. It resets tomorrow, or raise it in Settings → AI."
    }
  }
  return { blocked: false }
}
