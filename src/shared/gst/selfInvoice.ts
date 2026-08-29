/**
 * The reverse-charge self-invoice (roadmap #356).
 *
 * When the recipient pays the tax, somebody still has to raise a tax invoice — and under section
 * 31(3)(f) of the CGST Act that somebody is the recipient. A registered person liable to pay tax
 * under section 9(3) or 9(4) has to issue an invoice "in respect of goods or services or both
 * received from a supplier who is not registered on the date of receipt", and section 31(3)(g)
 * asks for a payment voucher at the time of paying that supplier.
 *
 * `rcmAdvice` in reverseCharge.ts already recognises the supply. What nothing produced was the
 * document, and the document is what the auditor asks to see: without it the ITC on the reverse
 * charge tax has no invoice behind it, which is the expensive half of the mistake.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKED AGAINST (August 2026):
 *   - Section 31(3)(f) and 31(3)(g), CGST Act 2017 — invoice by the recipient, and the payment
 *     voucher. Unamended since enactment as far as this author could establish.
 *   - Rule 46, CGST Rules 2017 — particulars of a tax invoice. Rule 46(b) requires a consecutive
 *     serial number in one or more series for a financial year; that is why the number here is
 *     issued from its own dated series rather than borrowed from the purchase voucher.
 *   - Rule 46's second proviso permits a consolidated month-end invoice for supplies actually
 *     covered by section 9(4), where their aggregate exceeds ₹5,000 in a day from any or all
 *     suppliers. This is not authority to treat every unregistered purchase as 9(4): the amended
 *     section 9(4), effective 1 February 2019, applies only to notified classes and categories;
 *     Notification 07/2019-CTR currently targets promoters/real-estate inputs. The app does not
 *     model that regime or a multi-supplier schedule, so consolidation is deliberately unavailable.
 *
 * Nothing here posts and nothing here talks to a portal. It arranges facts already in the books
 * into the shape Rule 46 asks for, and says out loud which particulars are missing.
 */

import type { SupplyType } from './calc'

/**
 * Why the recipient is paying the tax.
 *
 * The distinction is retained for historical documents. New general-business self-invoices are
 * per-supply notified 9(3) documents; the app does not infer 9(4) from a blank GSTIN.
 */
export type RcmBasis =
  /** Section 9(4) — a notified class/category, retained for historical documents only. */
  | 'unregistered'
  /** Section 9(3) — a notified supply. A self-invoice is raised only if its supplier is unregistered. */
  | 'notified'

export interface SelfInvoiceLine {
  description: string
  /** HSN/SAC as recorded, or null. Rule 46(g). */
  hsn: string | null
  /** Integer thousandths, or null for a service with no quantity. */
  qtyMilli: number | null
  unit: string | null
  /** Taxable value, paise. */
  taxable: number
  /** Whole (or fractional) percent, as the masters hold it. */
  rate: number
  cessRate: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export interface SelfInvoiceTotals {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  /** Taxable plus every tax head. */
  total: number
}

export interface SelfInvoiceSupply {
  /** The purchase voucher this self-invoice documents. */
  voucherId: number
  /** Date of receipt — section 31(3)(f) ties the invoice to that date, not to the payment. */
  date: string
  /** The purchase voucher's own number, kept so the two can be tied together in an audit. */
  voucherNumber: string
  supplierName: string
  supplierGstin: string | null
  supplierStateCode: string | null
  supplierAddress: string | null
  basis: RcmBasis
  lines: SelfInvoiceLine[]
}

export interface SelfInvoiceDoc {
  /** Serial from the self-invoice series — Rule 46(b). */
  number: string
  date: string
  basis: RcmBasis
  supplierName: string
  supplierGstin: string | null
  supplierAddress: string | null
  /** GSTIN of the registration that raised this document. Optional only for documents stored by
   *  builds before multi-registration attribution was added. */
  recipientGstin?: string | null
  /** Recipient's own state — the place of supply for an inward reverse-charge supply. */
  placeOfSupply: string
  supplyType: SupplyType
  lines: SelfInvoiceLine[]
  totals: SelfInvoiceTotals
  /** Voucher ids folded into this document. New documents carry one; old consolidated records may carry many. */
  voucherIds: number[]
  /**
   * Particulars Rule 46 asks for that the books do not hold. Stated rather than invented: a
   * self-invoice with a blank HSN is a defective invoice, and a self-invoice with a guessed HSN
   * is a false one.
   */
  warnings: string[]
}

const ZERO_TOTALS = (): SelfInvoiceTotals => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 })

export function sumSelfInvoiceLines(lines: SelfInvoiceLine[]): SelfInvoiceTotals {
  const t = ZERO_TOTALS()
  for (const l of lines) {
    t.taxable += l.taxable
    t.igst += l.igst
    t.cgst += l.cgst
    t.sgst += l.sgst
    t.cess += l.cess
  }
  t.total = t.taxable + t.igst + t.cgst + t.sgst + t.cess
  return t
}

/**
 * The serial number for a self-invoice.
 *
 * Its own series, restarting each financial year, because Rule 46(b) wants a consecutive serial
 * "for a financial year" and because mixing these into the sales series would put a document the
 * business did not sell anything for into the middle of GSTR-1's numbering. `RCM/2026-27/0007`.
 */
export function selfInvoiceNumber(fyLabel: string, sequence: number, prefix = 'RCM'): string {
  return `${prefix}/${fyLabel}/${String(sequence).padStart(4, '0')}`
}

/**
 * Rule 46 particulars this document cannot supply from the books.
 *
 * Deliberately not fatal. A missing HSN on a services purchase is common and fixable; refusing to
 * produce the document at all would leave the user with nothing to show, which is worse than a
 * document that names its own gaps.
 */
export function selfInvoiceWarnings(supply: SelfInvoiceSupply, recipientGstin: string | null): string[] {
  const out: string[] = []
  if (!recipientGstin) {
    out.push('The company has no GSTIN on record — Rule 46(b) requires the recipient’s GSTIN on a self-invoice.')
  }
  if (!supply.supplierAddress) {
    out.push('No supplier address on the party ledger — Rule 46(c) asks for it.')
  }
  const missingHsn = supply.lines.filter((l) => !l.hsn).length
  if (missingHsn > 0) {
    out.push(`${missingHsn} line${missingHsn === 1 ? '' : 's'} have no HSN/SAC — Rule 46(g).`)
  }
  const zeroRated = supply.lines.filter((l) => l.rate === 0).length
  if (zeroRated > 0 && supply.lines.length === zeroRated) {
    out.push(
      'Every line carries a nil rate. A reverse-charge self-invoice for a wholly nil-rated supply ' +
        'is unusual — check the rate on the item or the purchase ledger.'
    )
  }
  return out
}

export interface BuildSelfInvoiceInput {
  supply: SelfInvoiceSupply
  number: string
  /** The company's own state code — the place of supply for an inward supply. */
  recipientStateCode: string
  recipientGstin: string | null
}

/**
 * One self-invoice for one inward reverse-charge supply.
 *
 * The document is dated on the date of receipt rather than the day it was printed: section
 * 31(3)(f) fixes the date, and printing it late does not move it. That also keeps the invoice in
 * the same tax period as the liability it evidences, which is what makes the 3B row tie.
 */
export function buildSelfInvoice(input: BuildSelfInvoiceInput): SelfInvoiceDoc {
  const { supply } = input
  // Inward reverse charge: the recipient is the place of supply, so an intra-state supply is one
  // where the supplier sits in the same state. An unregistered supplier with no state on record
  // is treated as intra-state — the ordinary case (a local unregistered vendor), and the one that
  // does not silently create an IGST liability nobody can claim.
  const supplierState = supply.supplierStateCode ?? input.recipientStateCode
  const supplyType: SupplyType = supplierState === input.recipientStateCode ? 'intra' : 'inter'

  return {
    number: input.number,
    date: supply.date,
    basis: supply.basis,
    supplierName: supply.supplierName,
    supplierGstin: supply.supplierGstin,
    supplierAddress: supply.supplierAddress,
    recipientGstin: input.recipientGstin,
    placeOfSupply: input.recipientStateCode,
    supplyType,
    lines: supply.lines,
    totals: sumSelfInvoiceLines(supply.lines),
    voucherIds: [supply.voucherId],
    warnings: selfInvoiceWarnings(supply, input.recipientGstin)
  }
}
