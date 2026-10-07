// WP 2.6 — result shapes of the pricing and counter-billing IPC channels, shared by the main
// services (src/main/services/{priceLevels,pricing,counter}.ts) and the renderer's typed client.
import type { DiscountScheme, PriceResult } from './pricing'
import type { PaymentMode } from './pricingSchemas'
import type { PriceLevel } from './domain'

export interface RateGridCell {
  rateId: number
  rate: number
  effectiveFrom: string
  effectiveTo: string | null
  /** Further quantity slabs under the level for the item (shown as "+2 slabs"). */
  slabs: number
}

export interface RateGridRow {
  itemId: number
  itemName: string
  barcode: string | null
  unitSymbol: string
  gstRate: number | null
  mrpPaise: number | null
  standardCostPaise: number | null
  groupId: number | null
  /** levelId → the base ₹ row in force on the grid date. */
  rates: Record<number, RateGridCell | null>
}

export interface RateGrid {
  levels: PriceLevel[]
  rows: RateGridRow[]
}

export interface RatesImportResult {
  rows: number
  /** Levels the import creates (named in the file, not yet in the books). */
  newLevels: string[]
  errors: { line: number; message: string }[]
  applied: boolean
}

export interface PartyRate {
  id: number
  ledgerId: number
  ledgerName: string
  stockItemId: number
  itemName: string
  unitSymbol: string
  ratePaise: number
  discountBp: number
  effectiveFrom: string | null
  effectiveTo: string | null
  source: 'manual' | 'last_sale'
  lastSoldAt: string | null
  lastVoucherId: number | null
}

export interface DiscountSchemeRow extends DiscountScheme {
  targetName: string | null
}

export interface ResolvedLine {
  key: number
  itemId: number
  qtyMilli: number
  result: PriceResult
}

export interface CounterAccounts {
  walkInLedgerId: number | null
  salesLedgerId: number | null
  voucherTypeId: number | null
  receiptTypeId: number | null
  cashLedgerId: number | null
  upiLedgerId: number | null
  cardLedgerId: number | null
}

export interface CounterQuote {
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  roundOff: number
  total: number
  supply: 'intra' | 'inter'
}

export interface CheckoutResult {
  invoiceId: number
  invoiceNumber: string
  totalPaise: number
  receiptId: number | null
  receiptNumber: string | null
  paidPaise: number
  /** Total less payments — on the party's account (named parties only). */
  balancePaise: number
  changePaise: number
  negativeStock: { name: string }[]
}

export interface HeldBill {
  id: string
  label: string
  heldAt: string
  partyLedgerId: number | null
  lines: { itemId: number; qtyMilli: number; ratePaise: number; discountPaise: number; rateSource: 'auto' | 'manual' }[]
}

export interface DayEndSummary {
  date: string
  bills: number
  totalPaise: number
  taxablePaise: number
  taxPaise: number
  /** Payments received, per payment account (cash / UPI / card / other). */
  byMode: { mode: PaymentMode | 'other'; label: string; ledgerId: number; amountPaise: number }[]
  /** Billed but not received (named parties on account). */
  onAccountPaise: number
  changePaise: number
  items: { itemId: number; name: string; unitSymbol: string; qtyMilli: number; amountPaise: number }[]
  invoices: { voucherId: number; number: string; partyName: string; totalPaise: number; receiptVoucherId: number | null }[]
}
