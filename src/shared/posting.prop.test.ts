import { describe, it, expect } from 'vitest'
import { VOUCHER_KINDS, type VoucherKind } from './domain'
import {
  validateVoucher,
  sumDebits,
  sumCredits,
  type VoucherInput,
  type VoucherLineInput,
  type InventoryLineInput,
  type LedgerFacts
} from './posting'
import { forAll, seedFromEnv, type Rng } from './proptest'

/**
 * Property tests for the posting rules (roadmap Q328).
 *
 * The example tests in engine.test.ts pin down the cases we thought of. These state the rules as
 * laws that must hold for every voucher the generators can build — the point is the cases nobody
 * thought of. Each `it()` name is the rule in plain words.
 *
 * Seed is fixed so CI never flakes; POSTING_PROP_SEED overrides it for a soak run
 * (`POSTING_PROP_SEED=$RANDOM npm test`), which is how new counterexamples get found.
 */
const SEED = seedFromEnv('POSTING_PROP_SEED', 20260824)
const RUNS = seedFromEnv('POSTING_PROP_RUNS', 250) || 250
/** The deep-compare properties are the slow ones; a soak run raises RUNS far past the 5s default. */
const SLOW = 120_000

// A small fixed ledger world. 1–2 are cash/bank, 3–5 are not, anything else does not exist.
const CASH_BANK = [1, 2]
const OTHER = [3, 4, 5]
const KNOWN = [...CASH_BANK, ...OTHER]
const UNKNOWN = [90, 91, 92]
const facts = (ledgerId: number): LedgerFacts => ({
  exists: KNOWN.includes(ledgerId),
  isCashOrBank: CASH_BANK.includes(ledgerId)
})

const codesOf = (errors: { code: string }[]): string[] => errors.map((e) => e.code).sort()
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const BASE: VoucherInput = {
  voucherTypeId: 1,
  date: '2025-08-15',
  partyLedgerId: null,
  narration: null,
  reference: null,
  lines: [],
  inventory: []
}

/** A balanced set of lines: one paise total, split across a debit side and a credit side. */
function genBalancedLines(rng: Rng, pool: number[] = KNOWN): VoucherLineInput[] {
  const total = rng.int(1_00, 50_00_000) // ₹1 … ₹5 lakh, in paise
  const drCount = rng.int(1, 3)
  const crCount = rng.int(1, 3)
  const lines: VoucherLineInput[] = [
    ...rng.partition(total, drCount).map((amount) => ({ ledgerId: rng.pick(pool), drCr: 'dr' as const, amount })),
    ...rng.partition(total, crCount).map((amount) => ({ ledgerId: rng.pick(pool), drCr: 'cr' as const, amount }))
  ]
  return rng.shuffle(lines)
}

/** Cost allocations that sum to at most the line's amount — the shape the schema lets through. */
function withAllocations(rng: Rng, line: VoucherLineInput): VoucherLineInput {
  const parts = rng.int(1, 3)
  const allocated = rng.int(parts, line.amount)
  return {
    ...line,
    costAllocations: rng.partition(allocated, parts).map((amount, i) => ({ costCentreId: i + 1, amount }))
  }
}

function genInventoryLine(rng: Rng): InventoryLineInput {
  const isAbsolute = rng.bool(0.3)
  return {
    stockItemId: rng.int(1, 5),
    godownId: rng.bool(0.5) ? rng.int(1, 3) : null,
    qtyMilli: isAbsolute ? rng.int(0, 5_000) : rng.int(1, 5_000),
    ratePaise: rng.int(1, 100_00),
    amount: rng.int(0, 10_00_000),
    direction: rng.bool() ? 'in' : 'out',
    ...(isAbsolute ? { isAbsolute: true } : {})
  }
}

/** Anything at all, valid or not — used for the laws that must hold even for junk. */
function genJunkVoucher(rng: Rng): { voucher: VoucherInput; kind: VoucherKind } {
  const lineCount = rng.int(0, 5)
  const lines: VoucherLineInput[] = Array.from({ length: lineCount }, () => ({
    ledgerId: rng.pick([...KNOWN, ...UNKNOWN]),
    drCr: rng.bool() ? ('dr' as const) : ('cr' as const),
    amount: rng.pick([rng.int(-5_000, 5_000), rng.int(1, 10_00_000), 0, rng.int(1, 1000) + 0.5])
  }))
  for (const line of lines) {
    if (rng.bool(0.3) && Number.isSafeInteger(line.amount) && line.amount > 1) {
      line.costAllocations = [{ costCentreId: 1, amount: rng.int(1, line.amount * 2) }]
    }
  }
  const party = rng.bool(0.5) ? rng.pick([...KNOWN, ...UNKNOWN]) : null
  const voucher: VoucherInput = {
    ...BASE,
    date: rng.pick(['2025-08-15', '2025-02-30', 'not-a-date', '2024-13-01', '2025-1-1']),
    partyLedgerId: party,
    lines,
    inventory: Array.from({ length: rng.int(0, 2) }, () => genInventoryLine(rng)),
    billRefs: rng.bool(0.3)
      ? Array.from({ length: rng.int(1, 2) }, (_, i) => ({
          kind: 'new' as const,
          name: `B${i}`,
          amount: rng.int(1, 10_00_000),
          dueDate: null
        }))
      : []
  }
  return { voucher, kind: rng.pick(VOUCHER_KINDS as readonly VoucherKind[]) }
}

describe('posting rules — properties', () => {
  it('a balanced journal of positive integer-paise lines on known ledgers always posts clean', () => {
    forAll(
      SEED,
      RUNS,
      (rng) => {
        const lines = genBalancedLines(rng).map((l) => (rng.bool(0.4) ? withAllocations(rng, l) : l))
        return { ...BASE, lines }
      },
      (v) => expect(validateVoucher(v, 'journal', facts)).toEqual([]),
      { name: 'balanced journals validate' }
    )
  })

  it('moving exactly one line by any non-zero number of paise always breaks the voucher', () => {
    forAll(
      SEED + 1,
      RUNS,
      (rng) => {
        const lines = genBalancedLines(rng)
        const index = rng.int(0, lines.length - 1)
        const magnitude = rng.pick([1, rng.int(1, 99), rng.int(100, 10_00_000)])
        const delta = rng.bool() ? magnitude : -magnitude
        return { lines, index, delta }
      },
      ({ lines, index, delta }) => {
        const moved = lines.map((l, i) => (i === index ? { ...l, amount: l.amount + delta } : l))
        const errors = validateVoucher({ ...BASE, lines: moved }, 'journal', facts)
        expect(errors.length).toBeGreaterThan(0)
        // A perturbation that keeps the amount postable can only show up as an imbalance; one that
        // drives it to zero or below is caught earlier, as a bad amount.
        const expected = moved[index]!.amount > 0 ? 'unbalanced' : 'bad_amount'
        expect(errors.map((e) => e.code)).toContain(expected)
      },
      {
        name: 'one perturbed line unbalances the voucher',
        // Shrink the delta to ±1: the smallest move that must still be caught.
        shrink: ({ lines, index, delta }) => [{ lines, index, delta: Math.sign(delta) }]
      }
    )
  })

  it('shuffling the lines never changes the verdict', () => {
    forAll(SEED + 2, RUNS * 2, genJunkVoucher, ({ voucher, kind }) => {
      const before = codesOf(validateVoucher(voucher, kind, facts))
      const shuffled = { ...voucher, lines: [...voucher.lines].reverse() }
      expect(codesOf(validateVoucher(shuffled, kind, facts))).toEqual(before)
    })
  }, SLOW)

  it('the debit and credit totals ignore line order and between them account for every line', () => {
    forAll(SEED + 3, RUNS, genJunkVoucher, ({ voucher }) => {
      const lines = voucher.lines
      const reordered = [...lines].reverse()
      expect(sumDebits(reordered)).toBe(sumDebits(lines))
      expect(sumCredits(reordered)).toBe(sumCredits(lines))
      expect(sumDebits(lines) + sumCredits(lines)).toBe(lines.reduce((s, l) => s + l.amount, 0))
    })
  })

  it('a fractional-rupee amount is never accepted, however well the voucher otherwise balances', () => {
    forAll(
      SEED + 4,
      RUNS,
      (rng) => {
        const lines = genBalancedLines(rng)
        const index = rng.int(0, lines.length - 1)
        // A fraction of a paisa on one line: the kind of thing a stray `/ 100` produces.
        const fraction = rng.pick([0.5, 0.01, 0.25, 1 / 3])
        return lines.map((l, i) => (i === index ? { ...l, amount: l.amount + fraction } : l))
      },
      (lines) => {
        const codes = validateVoucher({ ...BASE, lines }, 'journal', facts).map((e) => e.code)
        expect(codes).toContain('bad_amount')
      },
      { name: 'money stays integer paise' }
    )
  })

  it('cost allocations are fine up to their line’s amount and rejected one paisa past it', () => {
    forAll(
      SEED + 5,
      RUNS,
      (rng) => {
        const lines = genBalancedLines(rng)
        const index = rng.int(0, lines.length - 1)
        const amount = lines[index]!.amount
        const parts = rng.int(1, 3)
        const over = rng.bool()
        // The boundary is the whole rule, so hit it deliberately: exactly the amount is legal,
        // exactly one paisa more is not.
        const allocated = over
          ? amount + rng.pick([1, 1, rng.int(1, 5_000)])
          : rng.bool(0.4)
            ? amount
            : rng.int(parts, amount)
        const costAllocations = rng
          .partition(allocated, parts)
          .map((a, i) => ({ costCentreId: i + 1, amount: a }))
        return { lines: lines.map((l, i) => (i === index ? { ...l, costAllocations } : l)), index, over }
      },
      ({ lines, index, over }) => {
        const errors = validateVoucher({ ...BASE, lines }, 'journal', facts)
        const overs = errors.filter((e) => e.code === 'over_allocated')
        if (!over) return overs.length === 0
        expect(overs).toHaveLength(1)
        // The error has to name the line, or the UI cannot point at anything.
        expect(overs[0]!.line).toBe(index)
        return true
      },
      { name: 'cost allocations may not exceed their line' }
    )
  })

  it('a contra voucher passes only when every single line is a cash or bank ledger', () => {
    forAll(
      SEED + 6,
      RUNS,
      (rng) => genBalancedLines(rng, rng.bool(0.5) ? CASH_BANK : KNOWN),
      (lines) => {
        const codes = validateVoucher({ ...BASE, lines }, 'contra', facts).map((e) => e.code)
        const allCashBank = lines.every((l) => CASH_BANK.includes(l.ledgerId))
        expect(codes.includes('cash_bank_rule')).toBe(!allCashBank)
      },
      { name: 'contra moves money between cash and bank only' }
    )
  })

  it('a payment or receipt passes only when its whole money side sits on cash or bank ledgers', () => {
    forAll(
      SEED + 7,
      RUNS,
      (rng) => ({
        lines: genBalancedLines(rng, rng.bool(0.4) ? CASH_BANK : KNOWN),
        kind: rng.bool() ? ('payment' as const) : ('receipt' as const)
      }),
      ({ lines, kind }) => {
        const moneySide = kind === 'payment' ? 'cr' : 'dr'
        const sideLines = lines.filter((l) => l.drCr === moneySide)
        const wholeSideIsMoney = sideLines.length > 0 && sideLines.every((l) => CASH_BANK.includes(l.ledgerId))
        const codes = validateVoucher({ ...BASE, lines }, kind, facts).map((e) => e.code)
        expect(codes.includes('cash_bank_rule')).toBe(!wholeSideIsMoney)
      },
      { name: 'payments credit cash/bank, receipts debit it' }
    )
  })

  it('bill references pass exactly when they add up to the party’s lines, and never without a party', () => {
    forAll(
      SEED + 8,
      RUNS,
      (rng) => {
        const partyLedgerId = rng.pick(OTHER)
        // Force at least one line onto the party ledger so there is something to reference.
        const lines = genBalancedLines(rng)
        lines[rng.int(0, lines.length - 1)]!.ledgerId = partyLedgerId
        const partyTotal = lines.filter((l) => l.ledgerId === partyLedgerId).reduce((s, l) => s + l.amount, 0)
        const off = rng.bool(0.5) ? 0 : rng.pick([1, -1, rng.int(2, 1000)])
        const refTotal = partyTotal + off
        const count = refTotal > 1 ? rng.int(1, 3) : 1
        const billRefs = rng
          .partition(Math.max(refTotal, count), count)
          .map((amount, i) => ({ kind: 'new' as const, name: `Bill-${i}`, amount, dueDate: null }))
        return { lines, partyLedgerId, billRefs, balanced: off === 0 }
      },
      ({ lines, partyLedgerId, billRefs, balanced }) => {
        const withParty = validateVoucher({ ...BASE, lines, partyLedgerId, billRefs }, 'journal', facts)
        expect(withParty.map((e) => e.code).includes('bill_refs_mismatch')).toBe(!balanced)

        const withoutParty = validateVoucher({ ...BASE, lines, partyLedgerId: null, billRefs }, 'journal', facts)
        expect(withoutParty.map((e) => e.code)).toContain('bill_refs_no_party')
      },
      { name: 'bill refs must reconcile to the party ledger' }
    )
  })

  it('a physical stock voucher never has to balance, but always needs a stock line', () => {
    forAll(
      SEED + 9,
      RUNS,
      (rng) => ({
        lines: genBalancedLines(rng).slice(0, rng.int(0, 2)), // deliberately lopsided
        inventory: Array.from({ length: rng.int(0, 2) }, () => genInventoryLine(rng))
      }),
      ({ lines, inventory }) => {
        const codes = validateVoucher({ ...BASE, lines, inventory }, 'physical_stock', facts).map((e) => e.code)
        expect(codes).not.toContain('unbalanced')
        expect(codes).not.toContain('too_few_lines')
        expect(codes.includes('no_inventory')).toBe(inventory.length === 0)
      },
      { name: 'a stock count is not a double entry' }
    )
  })

  it('a stock journal still has to balance even though it is a stock voucher', () => {
    forAll(
      SEED + 10,
      RUNS,
      (rng) => {
        const lines = genBalancedLines(rng)
        const index = rng.int(0, lines.length - 1)
        const skew = rng.bool(0.5) ? 0 : rng.int(1, 10_000)
        return {
          lines: lines.map((l, i) => (i === index ? { ...l, amount: l.amount + skew } : l)),
          inventory: [genInventoryLine(rng)],
          skewed: skew !== 0
        }
      },
      ({ lines, inventory, skewed }) => {
        const codes = validateVoucher({ ...BASE, lines, inventory }, 'stock_journal', facts).map((e) => e.code)
        expect(codes.includes('unbalanced')).toBe(skewed)
      },
      { name: 'stock journals balance' }
    )
  })

  it('an inventory quantity must be positive unless it is an absolute count, which may be zero', () => {
    forAll(
      SEED + 11,
      RUNS,
      (rng) => {
        const isAbsolute = rng.bool()
        const qtyMilli = rng.pick([0, rng.int(1, 10_000), rng.int(-10_000, -1), 1.5])
        return { ...genInventoryLine(rng), isAbsolute, qtyMilli }
      },
      (inv) => {
        const lines = [
          { ledgerId: 3, drCr: 'dr' as const, amount: 1000 },
          { ledgerId: 4, drCr: 'cr' as const, amount: 1000 }
        ]
        const codes = validateVoucher({ ...BASE, lines, inventory: [inv] }, 'journal', facts).map((e) => e.code)
        const ok = Number.isSafeInteger(inv.qtyMilli) && (inv.isAbsolute ? inv.qtyMilli >= 0 : inv.qtyMilli > 0)
        expect(codes.includes('bad_qty')).toBe(!ok)
      },
      { name: 'quantities are positive integer thousandths' }
    )
  })

  it('an invalid date is reported no matter what else the voucher gets wrong', () => {
    forAll(SEED + 12, RUNS, genJunkVoucher, ({ voucher, kind }) => {
      const bad = { ...voucher, date: '2025-02-30' }
      expect(validateVoucher(bad, kind, facts).map((e) => e.code)).toContain('bad_date')
    })
  }, SLOW)

  it('validating is pure: same answer twice, and the voucher handed in comes back untouched', () => {
    forAll(SEED + 13, RUNS * 2, genJunkVoucher, ({ voucher, kind }) => {
      const snapshot = clone(voucher)
      const first = validateVoucher(voucher, kind, facts)
      const second = validateVoucher(voucher, kind, facts)
      expect(second).toEqual(first)
      expect(voucher).toEqual(snapshot)
      expect(Array.isArray(first)).toBe(true)
      // Every error is usable by the UI: a code, a message, and a line index that exists if given.
      for (const e of first) {
        expect(typeof e.code).toBe('string')
        expect(e.message.length).toBeGreaterThan(0)
        if (e.line !== undefined) expect(voucher.lines[e.line]).toBeDefined()
      }
    })
  }, SLOW)
})
