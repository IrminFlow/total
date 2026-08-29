/**
 * TCS on the sale of goods — section 206C(1H).
 *
 * A seller whose turnover exceeded ₹10 crore in the preceding financial year must collect 0.1%
 * from any buyer once receipts from that buyer pass ₹50 lakh in the year. It is collected on
 * *receipt*, not on sale, which is what makes it easy to miss: nothing about the invoice tells
 * you, and the threshold is crossed by a payment arriving.
 *
 * Deliberately modelled as detection rather than automatic collection. Whether 206C(1H) applies
 * at all depends on the buyer too — it does not apply where the buyer is deducting TDS under
 * 194Q on the same transaction, which is now the common case and which the seller cannot know
 * from their own books. Adding 0.1% to an invoice on that assumption would be collecting tax
 * that should not have been collected.
 */

import type { TurnoverBand } from './gst/turnover'
import { bandFloorPaise } from './gst/turnover'

/** Preceding-year turnover above which the seller falls under 206C(1H). */
export const TCS_SELLER_TURNOVER_PAISE = 10_00_00_000 * 100

/** Receipts from one buyer, per financial year, above which collection starts. */
export const TCS_THRESHOLD_PAISE = 50_00_000 * 100

/** 0.1%, on the excess over the threshold. Rate is 1% where the buyer has no PAN. */
export const TCS_RATE_PERCENT = 0.1
export const TCS_RATE_NO_PAN_PERCENT = 1

/**
 * Does the seller fall under 206C(1H) at all?
 *
 * Undeclared turnover answers false. The section applies above ₹10 crore, and warning a business
 * that never told us its turnover about a threshold that probably does not apply to it is noise
 * that gets the whole feature ignored.
 */
export function tcsAppliesToSeller(band: TurnoverBand | null): boolean {
  return band !== null && bandFloorPaise(band) >= TCS_SELLER_TURNOVER_PAISE
}

export interface TcsInput {
  /** Total received from this buyer so far this financial year, in paise. */
  receiptsThisFy: number
  /** Whether the buyer's PAN is on record. Without it the rate is ten times higher. */
  hasPan: boolean
  /** Amount already collected from this buyer this year, in paise. */
  alreadyCollected?: number
}

export interface TcsLiability {
  /** Receipts above ₹50 lakh — the base the rate applies to. Zero below the threshold. */
  excess: number
  ratePercent: number
  /** Total collectible for the year on receipts so far. */
  collectible: number
  /** collectible − alreadyCollected, floored at zero. What is still to be collected. */
  outstanding: number
  crossed: boolean
}

/**
 * What is collectible from one buyer, given receipts so far.
 *
 * Computed on the year's cumulative receipts rather than per receipt, because the threshold is
 * annual: a buyer who pays ₹49 lakh and then ₹2 lakh owes on ₹1 lakh, not on ₹2 lakh, and
 * computing per receipt would get that wrong in whichever direction the payments happened to
 * arrive.
 */
export function computeTcs(input: TcsInput): TcsLiability {
  const excess = Math.max(0, input.receiptsThisFy - TCS_THRESHOLD_PAISE)
  const ratePercent = input.hasPan ? TCS_RATE_PERCENT : TCS_RATE_NO_PAN_PERCENT
  // Integer paise: multiply into tenths of a percent before dividing, so 0.1% never becomes a
  // float. 0.1% of X is X / 1000.
  const collectible = input.hasPan ? Math.floor(excess / 1000) : Math.floor(excess / 100)
  const alreadyCollected = input.alreadyCollected ?? 0
  return {
    excess,
    ratePercent,
    collectible,
    outstanding: Math.max(0, collectible - alreadyCollected),
    crossed: excess > 0
  }
}
