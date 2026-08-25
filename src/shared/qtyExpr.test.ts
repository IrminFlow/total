import { describe, expect, it } from 'vitest'
import { conversionHint, isQtyExpression, parseQtyExpression } from './qtyExpr'

const BOX = { symbol: 'box', conversionMilli: 12_000 }

describe('parseQtyExpression', () => {
  it('reads a plain number as base units', () => {
    expect(parseQtyExpression('24', 'Pcs', BOX)).toEqual({ baseQtyMilli: 24_000, usedAlt: false })
    expect(parseQtyExpression('1.5', 'Kg', null)).toEqual({ baseQtyMilli: 1_500, usedAlt: false })
  })

  it('converts the alternate unit — the whole point of the item', () => {
    expect(parseQtyExpression('2 box', 'Pcs', BOX)).toEqual({ baseQtyMilli: 24_000, usedAlt: true })
    expect(parseQtyExpression('2box', 'Pcs', BOX)).toEqual({ baseQtyMilli: 24_000, usedAlt: true })
    expect(parseQtyExpression('2 BOX', 'Pcs', BOX)).toEqual({ baseQtyMilli: 24_000, usedAlt: true })
  })

  it('accepts the base symbol spelled out too', () => {
    expect(parseQtyExpression('7 Pcs', 'Pcs', BOX)).toEqual({ baseQtyMilli: 7_000, usedAlt: false })
  })

  it('adds a part quantity to a whole one', () => {
    expect(parseQtyExpression('2 box + 3', 'Pcs', BOX)).toEqual({ baseQtyMilli: 27_000, usedAlt: true })
  })

  it('multiplies and divides left to right', () => {
    expect(parseQtyExpression('12*8', 'Pcs', null)).toEqual({ baseQtyMilli: 96_000, usedAlt: false })
    expect(parseQtyExpression('144/2', 'Pcs', null)).toEqual({ baseQtyMilli: 72_000, usedAlt: false })
    // No precedence, deliberately: 2+3 then *4, the way a calculator behaves.
    expect(parseQtyExpression('2+3*4', 'Pcs', null)?.baseQtyMilli).toBe(20_000)
  })

  it('treats the operand of * and / as a count, not a quantity', () => {
    expect(parseQtyExpression('2 box * 3', 'Pcs', BOX)).toEqual({ baseQtyMilli: 72_000, usedAlt: true })
  })

  it('subtracts, including into negative territory (a return line is negative)', () => {
    expect(parseQtyExpression('1 box - 2', 'Pcs', BOX)?.baseQtyMilli).toBe(10_000)
    expect(parseQtyExpression('-3', 'Pcs', null)?.baseQtyMilli).toBe(-3_000)
  })

  it('never lets a float touch the result', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; in thousandths it is exactly 300.
    expect(parseQtyExpression('0.1+0.2', 'Kg', null)?.baseQtyMilli).toBe(300)
    expect(parseQtyExpression('1/3', 'Kg', null)?.baseQtyMilli).toBe(333)
  })

  it('refuses a unit the item does not have rather than guessing', () => {
    expect(parseQtyExpression('2 crate', 'Pcs', BOX)).toBeNull()
    expect(parseQtyExpression('2 box', 'Pcs', null)).toBeNull()
  })

  it('refuses a broken expression instead of returning half of it', () => {
    expect(parseQtyExpression('2 +', 'Pcs', null)).toBeNull()
    expect(parseQtyExpression('*3', 'Pcs', null)).toBeNull()
    expect(parseQtyExpression('12/0', 'Pcs', null)).toBeNull()
    expect(parseQtyExpression('', 'Pcs', null)).toBeNull()
    expect(parseQtyExpression('   ', 'Pcs', null)).toBeNull()
    expect(parseQtyExpression('abc', 'Pcs', null)).toBeNull()
  })

  it('refuses a conversion that is not a positive whole number of thousandths', () => {
    expect(parseQtyExpression('2 box', 'Pcs', { symbol: 'box', conversionMilli: 0 })).toBeNull()
  })
})

describe('isQtyExpression', () => {
  it('spots arithmetic and units but not a plain number', () => {
    expect(isQtyExpression('24')).toBe(false)
    expect(isQtyExpression('-24')).toBe(false)
    expect(isQtyExpression('1.5')).toBe(false)
    expect(isQtyExpression('2 box')).toBe(true)
    expect(isQtyExpression('12*8')).toBe(true)
  })
})

describe('conversionHint', () => {
  it('states the conversion when the alternate was used', () => {
    const r = parseQtyExpression('2 box', 'Pcs', BOX)!
    expect(conversionHint(r, 'Pcs', BOX, 0)).toBe('2 box = 24 Pcs')
  })

  it('says nothing when the quantity was typed in base units', () => {
    const r = parseQtyExpression('24', 'Pcs', BOX)!
    expect(conversionHint(r, 'Pcs', BOX, 0)).toBeNull()
  })

  it('says nothing when there is no alternate to convert from', () => {
    const r = parseQtyExpression('24', 'Pcs', null)!
    expect(conversionHint(r, 'Pcs', null, 0)).toBeNull()
  })
})
