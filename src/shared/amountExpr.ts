/**
 * What people actually type into an amount box.
 *
 * `parseRupees` is the strict parser for stored values and stays that way: it accepts a number
 * and nothing else, because a stored amount must never be the result of a guess. This is the
 * layer above it, used only by the amount INPUT, where a person is doing mental arithmetic they
 * would otherwise do on a calculator and re-type.
 *
 * Three things people type that a plain number parser rejects:
 *   1200*3        twelve hundred, three of them
 *   45000+5000    a figure plus a known addition
 *   12k, 1.5L     Indian shorthand: thousand and lakh
 *
 * Deliberately NOT a general expression evaluator. No parentheses, no precedence, no functions:
 * left to right, four operators, because an amount box that silently applies operator precedence
 * to `100+50*2` is worse than one that refuses. Anything it cannot read with certainty returns
 * null, and the field shows the same inline error it always did.
 */

import { parseRupees } from './money'

/** Indian shorthand multipliers. Case-insensitive; `cr` is crore, not credit, in this context. */
const SUFFIXES: [RegExp, number][] = [
  [/^(-?[\d.,]+)\s*k$/i, 1_000],
  [/^(-?[\d.,]+)\s*l$/i, 100_000],
  [/^(-?[\d.,]+)\s*lakh?s?$/i, 100_000],
  [/^(-?[\d.,]+)\s*cr$/i, 10_000_000],
  [/^(-?[\d.,]+)\s*crore?s?$/i, 10_000_000]
]

/** One term: a plain number, or a number with an Indian magnitude suffix. Returns paise. */
function term(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null

  for (const [pattern, multiplier] of SUFFIXES) {
    const match = pattern.exec(text)
    if (!match) continue
    const base = Number(match[1]!.replace(/,/g, ''))
    if (!Number.isFinite(base)) return null
    // Multiply in paise so 1.5L is exactly 15,00,000.00 rather than a float approximation.
    const paise = Math.round(base * multiplier * 100)
    return Number.isSafeInteger(paise) ? paise : null
  }

  return parseRupees(text)
}

/**
 * Evaluate an amount expression to paise, or null when it is not one.
 *
 * Left to right with no precedence, which is how a calculator behaves and how someone typing
 * into a ledger expects it to behave.
 */
export function parseAmountExpression(input: string): number | null {
  const text = input.trim()
  if (text === '') return null

  // Split into terms and operators, keeping both. A leading minus belongs to the first term.
  const tokens = text.match(/^-?[^+\-*/]+|[+\-*/]|[^+\-*/]+/g)
  if (!tokens) return null

  let total = term(tokens[0]!)
  if (total === null) return null

  for (let i = 1; i < tokens.length; i += 2) {
    const operator = tokens[i]
    const operand = tokens[i + 1]
    if (operator === undefined || operand === undefined) return null

    if (operator === '*' || operator === '/') {
      // A multiplier is a count, not a money value, so it is read as a plain number.
      const factor = Number(operand.trim().replace(/,/g, ''))
      if (!Number.isFinite(factor)) return null
      if (operator === '/' && factor === 0) return null
      // Round once, at the end of each step, so repeated halving cannot drift into fractions of
      // a paisa that the engine could not store anyway.
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

  return Number.isSafeInteger(total) ? total : null
}

/** True when the input is doing something a plain number parser would reject. */
export function isExpression(input: string): boolean {
  return /[+*/]/.test(input.trim().slice(1)) || /[a-z]/i.test(input)
}
