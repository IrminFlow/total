/**
 * What people actually type into a quantity box (#34).
 *
 * The amount box has accepted arithmetic and Indian magnitude suffixes for a while
 * (src/shared/amountExpr.ts). The quantity box next to it has accepted a bare number and nothing
 * else, which is the wrong way round: the amount is usually one figure off an invoice, and the
 * quantity is the field where the mental arithmetic actually happens.
 *
 *   2 box       two boxes of twelve, when the item has an alternate unit
 *   2 box + 3   two boxes and three loose
 *   12*8        eight cartons, twelve apiece, off a delivery note that only totals by carton
 *   144/2       half a gross
 *
 * `parseQtyWithUnit` (src/shared/units.ts) already reads one term of that. This is the layer
 * above it, and it is deliberately the same restricted evaluator as amountExpr: left to right,
 * four operators, no parentheses and no precedence. A quantity box that silently applies
 * precedence to `2+3*4` is worse than one that refuses, because the resulting stock figure looks
 * perfectly reasonable and nothing downstream can tell it was not meant.
 *
 * Everything is integer thousandths throughout. A float never touches a quantity.
 */

import { parseQtyWithUnit, toAlt, validConversion, type AltUnit } from './units'

export interface QtyExpressionResult {
  /** Base units, thousandths — what gets stored. */
  baseQtyMilli: number
  /** True when any term was written in the alternate unit, so the UI can show the conversion. */
  usedAlt: boolean
}

/**
 * Evaluate a quantity expression to base thousandths, or null when it is not one.
 *
 * `alt` null means the item has no alternate unit; a term carrying a unit symbol then only parses
 * if it is the base symbol. Anything unreadable returns null rather than a partial answer — the
 * field shows the same inline error it shows for a typo, and nothing is stored.
 */
export function parseQtyExpression(
  input: string,
  baseSymbol: string,
  alt: AltUnit | null
): QtyExpressionResult | null {
  const text = input.trim()
  if (text === '') return null

  // Same tokeniser as amountExpr: terms and operators, a leading minus belonging to the first
  // term. '/' is an operator here and never part of a unit symbol, so nothing is ambiguous.
  const tokens = text.match(/^-?[^+\-*/]+|[+\-*/]|[^+\-*/]+/g)
  if (!tokens) return null

  let usedAlt = false
  const term = (raw: string): number | null => {
    const parsed = parseQtyWithUnit(raw, baseSymbol, alt)
    if (!parsed) return null
    if (parsed.usedAlt) usedAlt = true
    return parsed.baseQtyMilli
  }

  let total = term(tokens[0]!)
  if (total === null) return null

  for (let i = 1; i < tokens.length; i += 2) {
    const operator = tokens[i]
    const operand = tokens[i + 1]
    if (operator === undefined || operand === undefined) return null

    if (operator === '*' || operator === '/') {
      // A multiplier is a count, not a quantity: `2 box * 3` is three lots of two boxes, and
      // reading the 3 as a quantity in its own unit would be meaningless.
      const factor = Number(operand.trim().replace(/,/g, ''))
      if (!Number.isFinite(factor)) return null
      if (operator === '/' && factor === 0) return null
      // Rounded at each step so repeated division cannot drift below a thousandth, which is the
      // smallest quantity the engine can store anyway.
      total = Math.round(operator === '*' ? total * factor : total / factor)
      continue
    }

    if (operator === '+' || operator === '-') {
      const next = term(operand)
      if (next === null) return null
      total = operator === '+' ? total + next : total - next
      continue
    }

    return null
  }

  return Number.isSafeInteger(total) ? { baseQtyMilli: total, usedAlt } : null
}

/** True when the input is doing something a plain number parser would reject. */
export function isQtyExpression(input: string): boolean {
  const text = input.trim()
  return /[+*/]/.test(text.slice(1)) || /[a-z]/i.test(text)
}

/**
 * "2 box = 24 Pcs" — the line shown under the field while typing.
 *
 * Only produced when the alternate was actually used and divides evenly into the result; a
 * conversion caption on `2 box + 3` would have to read "2.25 box", which is not what was typed
 * and not what anyone wants confirmed back to them.
 */
export function conversionHint(
  result: QtyExpressionResult,
  baseSymbol: string,
  alt: AltUnit | null,
  decimals: number
): string | null {
  if (!result.usedAlt || !alt || !validConversion(alt.conversionMilli)) return null
  const altQty = toAlt(result.baseQtyMilli, alt.conversionMilli)
  const trim = (milli: number, dp: number): string => {
    const fixed = (milli / 1000).toFixed(dp)
    return dp === 0 ? fixed : fixed.replace(/\.?0+$/, '')
  }
  return `${trim(altQty, 3)} ${alt.symbol} = ${trim(result.baseQtyMilli, decimals)} ${baseSymbol}`
}
