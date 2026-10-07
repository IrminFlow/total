// Shapes the trade-cycle IPC channels return (WP 2.5a) — shared so the renderer's typed client
// can name them (it can't import main-process modules).

import type { LinkType, TradePurpose, VoucherKind } from '../domain'
import type { TradeSideKind } from './rules'

export interface VoucherKindRow {
  kind: VoucherKind
  stockOnly: boolean
}

export interface VoucherLinkRow {
  linkId: number
  linkType: LinkType
  qtyMilli: number
  reprices: boolean
  /** This voucher's line (upstream: the target line; downstream: the source line). */
  lineUid: string
  /** The other document's line. */
  otherLineUid: string
  otherVoucherId: number | null
  otherTradeDocId: number | null
  /** "Delivery Note 12 line 2". */
  otherLabel: string
  otherDate: string | null
  /** The other side counts (upstream: the source is not binned; downstream: the target is live). */
  live: boolean
}

export interface VoucherLinks {
  /** Lines this voucher draws on (it is the target). */
  upstream: VoucherLinkRow[]
  /** Documents drawing on this voucher's lines (it is the source). */
  downstream: VoucherLinkRow[]
}

/** A source line a party could still draw on (links:openSourceLines — the 2.5b "Add from…"). */
export interface OpenSourceLine {
  lineUid: string
  voucherId: number | null
  tradeDocId: number | null
  kind: TradeSideKind
  label: string
  date: string
  stockItemId: number
  godownId: number | null
  batchId: number | null
  serials: string[]
  qtyMilli: number
  /** Live quantity already linked (fulfil + return for challans / GRNs; the asked link type otherwise). */
  doneMilli: number
  pendingMilli: number
  ratePaise: number
  amount: number
}

/** One open line of a delivery challan not yet invoiced / GRN not yet billed (trade:pending). */
export interface PendingNoteRow {
  voucherId: number
  number: string
  date: string
  purpose: TradePurpose
  partyLedgerId: number | null
  partyName: string | null
  lineUid: string
  /** 1-based line number on the note. */
  lineNo: number
  stockItemId: number
  itemName: string
  unit: string | null
  /** The unit's display decimals. */
  decimals: number
  godownId: number | null
  godownName: string | null
  qtyMilli: number
  /** Invoiced / billed (plus returned) by documents dated on or before the as-on date. */
  doneMilli: number
  pendingMilli: number
  ratePaise: number
  /** Taxable value of the pending quantity (pro rata of the line's value). */
  pendingValue: number
  /** Days since the note's date, as on the report date. */
  ageDays: number
}
