import type { DrCr, VoucherKind } from './domain'
import { isValidISODate } from './dates'

export interface CostAllocationInput {
  costCentreId: number
  amount: number
}

export interface VoucherLineInput {
  ledgerId: number
  drCr: DrCr
  amount: number
  /** Optional split of this line's amount across cost centres; must sum to at most `amount`. */
  costAllocations?: CostAllocationInput[]
}

export interface InventoryLineInput {
  stockItemId: number
  godownId: number | null
  /** Batch this quantity moves in/out of; null/absent = untracked. */
  batchId?: number | null
  qtyMilli: number
  ratePaise: number
  amount: number
  direction: 'in' | 'out'
  /** Physical Stock line: qtyMilli is the counted closing quantity (may be 0), not a movement. */
  isAbsolute?: boolean
}

export interface BillRefInput {
  kind: 'new' | 'against'
  name: string
  amount: number
  dueDate: string | null
}

export interface TdsInput {
  sectionId: number
  baseAmount: number
  tdsAmount: number
}

export interface VoucherInput {
  voucherTypeId: number
  date: string
  /** Required when the voucher type uses manual numbering; ignored for auto. */
  number?: string
  partyLedgerId: number | null
  narration: string | null
  reference: string | null
  lines: VoucherLineInput[]
  inventory: InventoryLineInput[]
  /** Bill-by-bill references against the party ledger line; must sum to that line's amount. */
  billRefs?: BillRefInput[]
  /** TDS deducted on this voucher, if any. Not yet validated beyond schema-level shape. */
  tds?: TdsInput | null
}

/** What the validator needs to know about a ledger, resolved by the caller. */
export interface LedgerFacts {
  exists: boolean
  isCashOrBank: boolean
}

export interface PostingError {
  code: string
  message: string
  /** Index into lines[] when the error is line-specific. */
  line?: number
}

export function sumDebits(lines: VoucherLineInput[]): number {
  return lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
}

export function sumCredits(lines: VoucherLineInput[]): number {
  return lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
}

/**
 * Validate a voucher against double-entry and Tally voucher-kind rules.
 * Pure: ledger facts are supplied by the caller. Returns [] when postable.
 */
export function validateVoucher(
  input: VoucherInput,
  kind: VoucherKind,
  ledgerFacts: (ledgerId: number) => LedgerFacts
): PostingError[] {
  const errors: PostingError[] = []

  if (!isValidISODate(input.date)) {
    errors.push({ code: 'bad_date', message: `Invalid date: ${input.date}` })
  }

  if (kind === 'physical_stock' || kind === 'stock_journal') {
    if (input.inventory.length === 0) {
      errors.push({ code: 'no_inventory', message: 'Stock vouchers need at least one stock item line' })
    }
  } else {
    if (input.lines.length < 2) {
      errors.push({ code: 'too_few_lines', message: 'A voucher needs at least one debit and one credit' })
    }
  }

  input.lines.forEach((line, i) => {
    if (!Number.isSafeInteger(line.amount) || line.amount <= 0) {
      errors.push({ code: 'bad_amount', message: 'Line amounts must be positive', line: i })
    }
    if (!ledgerFacts(line.ledgerId).exists) {
      errors.push({ code: 'unknown_ledger', message: `Unknown ledger on line ${i + 1}`, line: i })
    }
    const allocated = (line.costAllocations ?? []).reduce((s, a) => s + a.amount, 0)
    if (allocated > line.amount) {
      errors.push({ code: 'over_allocated', message: `Cost allocations on line ${i + 1} exceed the line amount`, line: i })
    }
  })

  // Bill-by-bill references ride on the party ledger's line: they need a party, and must add
  // up to exactly what's posted to that ledger.
  const billRefs = input.billRefs ?? []
  if (billRefs.length > 0) {
    if (input.partyLedgerId === null) {
      errors.push({ code: 'bill_refs_no_party', message: 'Bill references require a party ledger' })
    } else {
      // Sum EVERY line posted to the party ledger, not just the first — a voucher can legitimately
      // split the party's amount across multiple lines (e.g. part cash-part-credit journals).
      const partyLinesTotal = input.lines
        .filter((l) => l.ledgerId === input.partyLedgerId)
        .reduce((s, l) => s + l.amount, 0)
      const billRefsTotal = billRefs.reduce((s, b) => s + b.amount, 0)
      if (partyLinesTotal === 0 || billRefsTotal !== partyLinesTotal) {
        errors.push({ code: 'bill_refs_mismatch', message: "Bill references must add up to the party ledger's amount" })
      }
    }
  }

  input.inventory.forEach((inv) => {
    if (!Number.isSafeInteger(inv.amount) || inv.amount < 0) {
      errors.push({ code: 'bad_inventory_amount', message: 'Inventory amounts cannot be negative' })
    }
    const minQtyOk = inv.isAbsolute ? inv.qtyMilli >= 0 : inv.qtyMilli > 0
    if (!Number.isSafeInteger(inv.qtyMilli) || !minQtyOk) {
      errors.push({ code: 'bad_qty', message: 'Inventory quantity must be positive' })
    }
  })

  // Double-entry invariant — the one rule that never bends.
  if (kind !== 'physical_stock') {
    const dr = sumDebits(input.lines)
    const cr = sumCredits(input.lines)
    if (dr !== cr) {
      errors.push({
        code: 'unbalanced',
        message: `Debits (${dr}) and credits (${cr}) differ by ${Math.abs(dr - cr)} paise`
      })
    }
    if (dr === 0 && input.lines.length >= 2) {
      errors.push({ code: 'zero_voucher', message: 'Voucher total cannot be zero' })
    }
  }

  // Tally kind rules: which side must be cash/bank.
  const cashBankRule: Partial<Record<VoucherKind, { side: DrCr | 'both'; message: string }>> = {
    contra: { side: 'both', message: 'Contra vouchers move money between cash and bank ledgers only' },
    payment: { side: 'cr', message: 'Payment vouchers must credit a cash or bank ledger' },
    receipt: { side: 'dr', message: 'Receipt vouchers must debit a cash or bank ledger' }
  }
  const rule = cashBankRule[kind]
  if (rule) {
    const relevant = input.lines.filter((l) => rule.side === 'both' || l.drCr === rule.side)
    const violating = relevant.some((l) => ledgerFacts(l.ledgerId).exists && !ledgerFacts(l.ledgerId).isCashOrBank)
    if (relevant.length > 0 && violating) {
      errors.push({ code: 'cash_bank_rule', message: rule.message })
    }
  }

  return errors
}
