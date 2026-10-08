// Cost estimate for one model call (WP 5.1) — integer micro-USD, from the per-company price
// table in Settings → AI (micro-USD per 1,000,000 tokens). Prices are not guessed: a model with
// no price row (or a null field the call needs) gives `null`, shown as "—". Pure; tested.
import type { AiModelPrice } from '@shared/ai'
import type { ChatUsage } from './types'

/** Reasoning tokens are already part of output tokens in the provider's usage; cached input is
 *  billed at the cached rate (the input rate when no cached rate is set). */
export function estimateCostMicroUsd(usage: ChatUsage, price: AiModelPrice | undefined | null): number | null {
  if (!price || price.inputPerM == null || price.outputPerM == null) return null
  const cached = Math.min(usage.cachedTokens, usage.inputTokens)
  const uncached = usage.inputTokens - cached
  const cachedRate = price.cachedInputPerM ?? price.inputPerM
  const total = uncached * price.inputPerM + cached * cachedRate + usage.outputTokens * price.outputPerM
  return Math.round(total / 1_000_000)
}

/** Sum that stays null only when every part is null. */
export function sumCosts(costs: readonly (number | null)[]): number | null {
  const known = costs.filter((c): c is number => c != null)
  return known.length ? known.reduce((s, c) => s + c, 0) : null
}
