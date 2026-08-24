/**
 * Alternate units of measure.
 *
 * A trade buys in boxes and sells in pieces, and the box is not a unit anybody wants to store
 * stock in — the books need one number for quantity, and it has to be the small one, or a part
 * box becomes unrepresentable.
 *
 * So: the base unit is what stock is kept in, and an alternate is a named multiple of it. Entry
 * accepts either; storage is always base. The conversion is itself in thousandths, so "1 box =
 * 12 pieces" is 12000 and "1 kg = 1000 g" is 1000000 without a float anywhere.
 */

export interface AltUnit {
  /** Display symbol of the alternate, e.g. 'box'. */
  symbol: string
  /** Base units in one alternate unit, in thousandths. 12 pieces per box = 12_000. */
  conversionMilli: number
}

/** A conversion must be a positive whole number of thousandths — 0 or a negative is a data error
 *  that would divide by zero or invert the stock. */
export function validConversion(conversionMilli: number): boolean {
  return Number.isInteger(conversionMilli) && conversionMilli > 0
}

/** Alternate quantity (thousandths) → base quantity (thousandths). */
export function toBase(altQtyMilli: number, conversionMilli: number): number {
  if (!validConversion(conversionMilli)) return altQtyMilli
  return Math.round((altQtyMilli * conversionMilli) / 1000)
}

/** Base quantity (thousandths) → alternate quantity (thousandths). */
export function toAlt(baseQtyMilli: number, conversionMilli: number): number {
  if (!validConversion(conversionMilli)) return baseQtyMilli
  return Math.round((baseQtyMilli * 1000) / conversionMilli)
}

/**
 * "2 box" → the base quantity it means.
 *
 * Accepts a bare number (already base units), or a number followed by the alternate's symbol.
 * Returns null on anything else rather than guessing: a typo that silently becomes a quantity is
 * how stock goes wrong in a way nobody can trace.
 */
export function parseQtyWithUnit(
  input: string,
  baseSymbol: string,
  alt: AltUnit | null
): { baseQtyMilli: number; usedAlt: boolean } | null {
  const text = input.trim().toLowerCase()
  if (!text) return null

  const match = /^(-?\d+(?:\.\d+)?)\s*([a-z%]*)$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const suffix = (match[2] ?? '').trim()
  const qtyMilli = Math.round(value * 1000)

  if (suffix === '' || suffix === baseSymbol.trim().toLowerCase()) {
    return { baseQtyMilli: qtyMilli, usedAlt: false }
  }
  if (alt && suffix === alt.symbol.trim().toLowerCase() && validConversion(alt.conversionMilli)) {
    return { baseQtyMilli: toBase(qtyMilli, alt.conversionMilli), usedAlt: true }
  }
  return null
}

/** "2 box = 24 pcs" — shown under the field so the conversion is visible while typing. */
export function describeConversion(altQtyMilli: number, baseSymbol: string, alt: AltUnit, decimals: number): string {
  const fmt = (milli: number, dp: number): string => (milli / 1000).toFixed(dp)
  return `${fmt(altQtyMilli, 3).replace(/\.?0+$/, '')} ${alt.symbol} = ${fmt(
    toBase(altQtyMilli, alt.conversionMilli),
    decimals
  )} ${baseSymbol}`
}
