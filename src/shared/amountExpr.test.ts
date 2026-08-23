import { describe, it, expect } from 'vitest'
import { parseAmountExpression, isExpression } from './amountExpr'
import { formatPaise } from './money'

const rupees = (paise: number | null): string | null => (paise === null ? null : formatPaise(paise))

describe('plain numbers still work exactly as before', () => {
  it('parses what parseRupees parses', () => {
    expect(parseAmountExpression('1200')).toBe(120000)
    expect(parseAmountExpression('1,200.50')).toBe(120050)
    expect(parseAmountExpression('0')).toBe(0)
    expect(parseAmountExpression('-500')).toBe(-50000)
  })

  it('rejects what parseRupees rejects', () => {
    expect(parseAmountExpression('')).toBeNull()
    expect(parseAmountExpression('abc')).toBeNull()
    expect(parseAmountExpression('.')).toBeNull()
  })
})

describe('Indian magnitude shorthand', () => {
  it('reads k, L and cr', () => {
    expect(rupees(parseAmountExpression('12k'))).toBe('12,000.00')
    expect(rupees(parseAmountExpression('1.5L'))).toBe('1,50,000.00')
    expect(rupees(parseAmountExpression('2cr'))).toBe('2,00,00,000.00')
  })

  it('is case-insensitive and tolerates a space', () => {
    expect(parseAmountExpression('12K')).toBe(parseAmountExpression('12 k'))
    expect(parseAmountExpression('3lakh')).toBe(parseAmountExpression('3L'))
  })

  it('stays exact: 1.5L is not a float approximation', () => {
    expect(parseAmountExpression('1.5L')).toBe(15_000_000)
    expect(parseAmountExpression('0.01k')).toBe(1000)
  })
})

describe('arithmetic', () => {
  it('multiplies a quantity by a rate', () => {
    expect(rupees(parseAmountExpression('1200*3'))).toBe('3,600.00')
    expect(rupees(parseAmountExpression('1200 * 3'))).toBe('3,600.00')
  })

  it('adds and subtracts money terms', () => {
    expect(rupees(parseAmountExpression('45000+5000'))).toBe('50,000.00')
    expect(rupees(parseAmountExpression('50000-1250.50'))).toBe('48,749.50')
  })

  it('divides, rounding to the paisa the engine can store', () => {
    expect(rupees(parseAmountExpression('100/3'))).toBe('33.33')
    expect(parseAmountExpression('100/0')).toBeNull()
  })

  it('runs left to right with no precedence, which is what a calculator does', () => {
    // 100 + 50 = 150, then * 2 = 300. NOT 100 + 100.
    expect(rupees(parseAmountExpression('100+50*2'))).toBe('300.00')
  })

  it('combines shorthand with arithmetic', () => {
    expect(rupees(parseAmountExpression('12k*3'))).toBe('36,000.00')
    expect(rupees(parseAmountExpression('1L+50k'))).toBe('1,50,000.00')
  })

  it('refuses anything it cannot read with certainty', () => {
    for (const bad of ['1200*', '*3', '1200**3', '12k+', '1200+abc', '(100+50)*2']) {
      expect(parseAmountExpression(bad), bad).toBeNull()
    }
  })

  it('never returns a fraction of a paisa', () => {
    for (const input of ['100/3', '10/7', '1/3*3']) {
      const paise = parseAmountExpression(input)
      expect(Number.isInteger(paise), input).toBe(true)
    }
  })
})

describe('isExpression', () => {
  it('spots input a plain number parser would reject', () => {
    expect(isExpression('1200*3')).toBe(true)
    expect(isExpression('12k')).toBe(true)
    expect(isExpression('1200')).toBe(false)
    // A leading minus is a sign, not an operator.
    expect(isExpression('-1200')).toBe(false)
  })
})
