/**
 * Serial-number tracking for high-value items (roadmap E #115).
 *
 * A batch answers "which lot did this come from". A serial answers "where is *that one*" — the
 * engine number, the IMEI, the compressor on the warranty card. It is the difference between an
 * item you count and an item you can point at, and it is what a service call, a warranty claim and
 * a police report all need.
 *
 * The shape of the problem is dated data, not a field. A serial is not an attribute of an item;
 * it is a thing with a history — received on this purchase at this cost, sold on that invoice to
 * that customer, and possibly returned. The question asked of it months later is always about a
 * date ("was this in stock in March?", "what did we pay for it?"), so what is stored is the
 * MOVEMENTS, and the current status is derived from them rather than kept as a second copy that
 * can disagree.
 *
 * This module is the part with no database in it: how serials are typed, how a range expands, and
 * what makes a set of them valid against a quantity.
 */

/** Where a serial is right now, derived from its movements — never stored as the truth. */
export type SerialStatus = 'in_stock' | 'issued'

/** Longest a serial may be. An IMEI is 15, a VIN is 17, an engine number is rarely past 25. */
export const SERIAL_MAX_LENGTH = 40

/**
 * A serial as it is stored and compared: trimmed, inner whitespace collapsed, upper-cased.
 *
 * Upper-cased because the same serial gets typed `ab12cd` on the purchase and `AB12CD` on the
 * sale, and a system that treats those as two things reports one unit missing and one unit that
 * was never bought. The ORIGINAL text is kept alongside for printing on the warranty card;
 * this is only ever the comparison key.
 */
export function normaliseSerial(serial: string): string {
  return serial.trim().replace(/\s+/g, ' ').toUpperCase()
}

export function isValidSerial(serial: string): boolean {
  const n = normaliseSerial(serial)
  // Printable ASCII only: a serial is transcribed off a metal plate, scanned, and printed on a
  // document. Anything that survives none of those round trips has no business being the key.
  return n.length > 0 && n.length <= SERIAL_MAX_LENGTH && /^[\x20-\x7e]+$/.test(n)
}

export interface SerialParse {
  /** Normalised serials, in the order they were typed, duplicates removed. */
  serials: string[]
  /** What was rejected and why — reported, never silently dropped. */
  errors: string[]
}

/**
 * Expand `SN0001-SN0010` into ten serials.
 *
 * The rule is deliberately narrow: identical prefix, identical digit width, ascending. A range is
 * a convenience for the case where a carton really is numbered consecutively; anything cleverer
 * (letters that roll over, a check digit that changes) would GUESS ten serial numbers, and a
 * guessed serial is one that will not match the unit when it comes back under warranty.
 */
export function expandSerialRange(text: string): string[] | null {
  const m = /^(.*?)(\d+)\s*[-–]\s*(.*?)(\d+)$/.exec(text.trim())
  if (!m) return null
  const [, prefixA, numA, prefixB, numB] = m as unknown as [string, string, string, string, string]
  if (normaliseSerial(prefixA) !== normaliseSerial(prefixB)) return null
  if (numA.length !== numB.length) return null
  const from = Number(numA)
  const to = Number(numB)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return null
  // A range is a shorthand, not a bulk-import format. Ten thousand serials from one line is
  // almost certainly a typo in the second number, and expanding it would hang the save.
  if (to - from + 1 > 1000) return null
  const out: string[] = []
  for (let n = from; n <= to; n++) out.push(`${prefixA}${String(n).padStart(numA.length, '0')}`)
  return out
}

/**
 * Read the box a person types serials into: one per line, or comma-separated, or a range, or any
 * mixture — which is what a paste off a supplier's packing list actually looks like.
 */
export function parseSerials(text: string): SerialParse {
  const seen = new Set<string>()
  const serials: string[] = []
  const errors: string[] = []
  const tokens = text
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  for (const token of tokens) {
    const expanded = expandSerialRange(token)
    for (const raw of expanded ?? [token]) {
      if (!isValidSerial(raw)) {
        errors.push(`"${raw}" is not a serial number this app can store (letters, digits and punctuation, up to ${SERIAL_MAX_LENGTH})`)
        continue
      }
      const key = normaliseSerial(raw)
      if (seen.has(key)) {
        errors.push(`${key} is listed twice`)
        continue
      }
      seen.add(key)
      serials.push(key)
    }
  }
  return { serials, errors }
}

/** Thousandths that make a whole unit. A serial-tracked item cannot move in halves. */
const MILLI = 1000

export interface SerialCountCheck {
  ok: boolean
  /** How many serials the quantity calls for; null when the quantity is not a whole number. */
  required: number | null
  message: string | null
}

/**
 * A serial-tracked line must name exactly as many serials as it moves units.
 *
 * Both halves matter. Too few and one unit has silently left the building with no record of which;
 * too many and a serial has been marked sold that is still on the shelf, which is the version that
 * gets found six months later when a customer brings it in.
 *
 * A fractional quantity is refused outright rather than rounded: half a laptop has no serial.
 */
export function checkSerialCount(serialCount: number, qtyMilli: number): SerialCountCheck {
  if (qtyMilli <= 0) return { ok: false, required: null, message: 'A serial-tracked line must move at least one unit' }
  if (qtyMilli % MILLI !== 0) {
    return {
      ok: false,
      required: null,
      message: 'A serial-tracked item moves in whole units — half of one has no serial number'
    }
  }
  const required = qtyMilli / MILLI
  if (serialCount === required) return { ok: true, required, message: null }
  return {
    ok: false,
    required,
    message:
      serialCount < required
        ? `${required} units, but only ${serialCount} serial ${serialCount === 1 ? 'number' : 'numbers'} given`
        : `${serialCount} serial numbers for ${required} ${required === 1 ? 'unit' : 'units'}`
  }
}

export interface SerialMovementFact {
  serial: string
  /** What the books already know about this serial, or null when it has never been seen. */
  status: SerialStatus | null
  /** The item it belongs to, when it exists — a serial cannot change what it is. */
  stockItemId: number | null
}

export interface SerialPlan {
  serials: string[]
  errors: string[]
}

/**
 * Decide whether a set of serials may move in the direction asked, given what is already known.
 *
 * Inward (a purchase, a return from a customer): the serial must be either new or currently
 * issued. Receiving one that the books say is already on the shelf means the same physical unit
 * has been received twice, which is either a duplicate entry or two different units wearing the
 * same number — and both need a person, not a resolution rule.
 *
 * Outward (a sale, a delivery): the serial must exist and be in stock. Selling a serial that is
 * already out is the case that matters most, because it is the one that produces two warranty
 * cards for one compressor.
 */
export function planSerialMovement(input: {
  direction: 'in' | 'out'
  stockItemId: number
  qtyMilli: number
  serials: string[]
  facts: Map<string, SerialMovementFact>
  itemName?: string
}): SerialPlan {
  const errors: string[] = []
  const count = checkSerialCount(input.serials.length, input.qtyMilli)
  if (!count.ok && count.message) errors.push(`${input.itemName ? `${input.itemName}: ` : ''}${count.message}`)

  for (const serial of input.serials) {
    const fact = input.facts.get(serial)
    if (input.direction === 'in') {
      if (fact && fact.stockItemId !== null && fact.stockItemId !== input.stockItemId) {
        errors.push(`${serial} is already recorded against a different item`)
        continue
      }
      if (fact?.status === 'in_stock') errors.push(`${serial} is already in stock — it cannot be received again`)
    } else {
      // No fact at all, or a fact with no live movement behind it — the voucher that received it
      // is in the bin — are the same situation: there is nothing on the shelf to sell. Saying
      // "already issued" here would be a confident lie about a unit that was never received.
      if (!fact || fact.status === null) {
        errors.push(`${serial} was never received into stock`)
        continue
      }
      if (fact.stockItemId !== null && fact.stockItemId !== input.stockItemId) {
        errors.push(`${serial} belongs to a different item`)
        continue
      }
      if (fact.status !== 'in_stock') errors.push(`${serial} has already been issued`)
    }
  }
  return { serials: input.serials, errors }
}

/** The status a serial is in after a movement in `direction` — the derivation, in one place. */
export function statusAfter(direction: 'in' | 'out'): SerialStatus {
  return direction === 'in' ? 'in_stock' : 'issued'
}
