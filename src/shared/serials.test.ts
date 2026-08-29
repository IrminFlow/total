import { describe, expect, it } from 'vitest'
import {
  SERIAL_MAX_LENGTH,
  checkSerialCount,
  expandSerialRange,
  isValidSerial,
  normaliseSerial,
  parseSerials,
  planSerialMovement,
  statusAfter,
  type SerialMovementFact
} from './serials'

describe('normaliseSerial', () => {
  it('makes the purchase spelling and the sale spelling the same key', () => {
    expect(normaliseSerial(' ab12cd ')).toBe('AB12CD')
    expect(normaliseSerial('AB  12')).toBe('AB 12')
  })
})

describe('isValidSerial', () => {
  it('takes what is stamped on a plate and refuses what is not', () => {
    expect(isValidSerial('IMEI-353918091234567')).toBe(true)
    expect(isValidSerial('')).toBe(false)
    expect(isValidSerial('   ')).toBe(false)
    expect(isValidSerial('क1234')).toBe(false)
    expect(isValidSerial('A'.repeat(SERIAL_MAX_LENGTH))).toBe(true)
    expect(isValidSerial('A'.repeat(SERIAL_MAX_LENGTH + 1))).toBe(false)
  })
})

describe('expandSerialRange', () => {
  it('expands a consecutively numbered carton, keeping the padding', () => {
    expect(expandSerialRange('SN0001-SN0004')).toEqual(['SN0001', 'SN0002', 'SN0003', 'SN0004'])
  })

  it('reads an en-dash and spaces around the separator', () => {
    expect(expandSerialRange('SN01 – SN03')).toEqual(['SN01', 'SN02', 'SN03'])
  })

  it('refuses to guess when the two ends do not agree', () => {
    // Different prefix, different width, backwards: all three would be a GUESS at ten serials,
    // and a guessed serial does not match the unit that comes back under warranty.
    expect(expandSerialRange('SNA001-SNB010')).toBeNull()
    expect(expandSerialRange('SN1-SN0010')).toBeNull()
    expect(expandSerialRange('SN0010-SN0001')).toBeNull()
  })

  it('is not a bulk import: a range of ten thousand is a typo', () => {
    expect(expandSerialRange('SN00001-SN10000')).toBeNull()
  })

  it('leaves a serial that merely contains a dash alone', () => {
    expect(expandSerialRange('PLAIN-SERIAL')).toBeNull()
  })
})

describe('parseSerials', () => {
  it('reads a paste off a packing list: lines, commas and a range together', () => {
    const p = parseSerials('SN01, SN02\nSN05-SN07\n')
    expect(p.serials).toEqual(['SN01', 'SN02', 'SN05', 'SN06', 'SN07'])
    expect(p.errors).toEqual([])
  })

  it('reports a duplicate rather than quietly counting it once', () => {
    const p = parseSerials('SN01\nsn01')
    expect(p.serials).toEqual(['SN01'])
    expect(p.errors[0]).toContain('listed twice')
  })

  it('reports what it could not store', () => {
    const p = parseSerials('SN01\nचावल')
    expect(p.serials).toEqual(['SN01'])
    expect(p.errors).toHaveLength(1)
  })

  it('is empty, not an error, for an empty box', () => {
    expect(parseSerials('   \n ')).toEqual({ serials: [], errors: [] })
  })
})

describe('checkSerialCount', () => {
  it('wants exactly one serial per unit', () => {
    expect(checkSerialCount(3, 3000).ok).toBe(true)
    expect(checkSerialCount(2, 3000).message).toContain('only 2 serial numbers')
    expect(checkSerialCount(4, 3000).message).toContain('4 serial numbers for 3 units')
  })

  it('refuses half a laptop instead of rounding it', () => {
    const c = checkSerialCount(1, 1500)
    expect(c.ok).toBe(false)
    expect(c.message).toContain('whole units')
  })

  it('refuses a zero line', () => {
    expect(checkSerialCount(0, 0).ok).toBe(false)
  })
})

describe('planSerialMovement', () => {
  const facts = (entries: SerialMovementFact[]): Map<string, SerialMovementFact> =>
    new Map(entries.map((e) => [e.serial, e]))

  it('receives serials the books have never seen', () => {
    const plan = planSerialMovement({
      direction: 'in',
      stockItemId: 1,
      qtyMilli: 2000,
      serials: ['SN01', 'SN02'],
      facts: facts([])
    })
    expect(plan.errors).toEqual([])
  })

  it('refuses to receive one that is already on the shelf', () => {
    const plan = planSerialMovement({
      direction: 'in',
      stockItemId: 1,
      qtyMilli: 1000,
      serials: ['SN01'],
      facts: facts([{ serial: 'SN01', status: 'in_stock', stockItemId: 1 }])
    })
    expect(plan.errors[0]).toContain('already in stock')
  })

  it('receives back one that had been issued — a sales return is not a duplicate', () => {
    const plan = planSerialMovement({
      direction: 'in',
      stockItemId: 1,
      qtyMilli: 1000,
      serials: ['SN01'],
      facts: facts([{ serial: 'SN01', status: 'issued', stockItemId: 1 }])
    })
    expect(plan.errors).toEqual([])
  })

  it('refuses to sell a serial that was never received', () => {
    const plan = planSerialMovement({
      direction: 'out',
      stockItemId: 1,
      qtyMilli: 1000,
      serials: ['SN99'],
      facts: facts([])
    })
    expect(plan.errors[0]).toContain('never received')
  })

  it('says "never received" — not "already issued" — when the receipt went to the bin', () => {
    // A known serial with no live movement behind it. Calling that "already issued" would be a
    // confident statement about a unit that, as far as the books go, was never bought.
    const plan = planSerialMovement({
      direction: 'out',
      stockItemId: 1,
      qtyMilli: 1000,
      serials: ['SN01'],
      facts: facts([{ serial: 'SN01', status: null, stockItemId: 1 }])
    })
    expect(plan.errors[0]).toContain('never received')
  })

  it('refuses to sell the same unit twice — the two-warranty-cards bug', () => {
    const plan = planSerialMovement({
      direction: 'out',
      stockItemId: 1,
      qtyMilli: 1000,
      serials: ['SN01'],
      facts: facts([{ serial: 'SN01', status: 'issued', stockItemId: 1 }])
    })
    expect(plan.errors[0]).toContain('already been issued')
  })

  it('refuses a serial that belongs to a different item, in either direction', () => {
    const other = facts([{ serial: 'SN01', status: 'in_stock', stockItemId: 7 }])
    expect(planSerialMovement({ direction: 'out', stockItemId: 1, qtyMilli: 1000, serials: ['SN01'], facts: other }).errors[0])
      .toContain('different item')
    expect(planSerialMovement({ direction: 'in', stockItemId: 1, qtyMilli: 1000, serials: ['SN01'], facts: other }).errors[0])
      .toContain('different item')
  })

  it('names the item when it has one, so a ten-line invoice says which line', () => {
    const plan = planSerialMovement({
      direction: 'out',
      stockItemId: 1,
      qtyMilli: 2000,
      serials: ['SN01'],
      facts: facts([{ serial: 'SN01', status: 'in_stock', stockItemId: 1 }]),
      itemName: 'Compressor 2 HP'
    })
    expect(plan.errors[0]).toContain('Compressor 2 HP')
  })

  it('reports every bad serial, not just the first', () => {
    const plan = planSerialMovement({
      direction: 'out',
      stockItemId: 1,
      qtyMilli: 2000,
      serials: ['SN01', 'SN02'],
      facts: facts([
        { serial: 'SN01', status: 'issued', stockItemId: 1 },
        { serial: 'SN02', status: 'issued', stockItemId: 1 }
      ])
    })
    expect(plan.errors).toHaveLength(2)
  })
})

describe('statusAfter', () => {
  it('is the whole derivation, in one place', () => {
    expect(statusAfter('in')).toBe('in_stock')
    expect(statusAfter('out')).toBe('issued')
  })
})
