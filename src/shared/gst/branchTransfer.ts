/**
 * The branch-transfer invoice — stock moved between two registrations of one PAN (roadmap #108).
 *
 * Nothing is sold, no money moves, and the books do not change. It is still a supply, and it is
 * still taxable: Schedule I para 2 of the CGST Act makes a supply of goods or services between
 * *distinct persons* as specified in section 25 a supply even when made without consideration,
 * and section 25(4) makes two registrations of the same PAN distinct persons. So the sending
 * registration raises a tax invoice under section 31(1), values it under rule 28, and reports it
 * in its GSTR-1; the receiving registration takes the credit in its own return.
 *
 * This is the single most common thing multi-GSTIN software gets wrong, usually by treating the
 * movement as an internal stock journal and stopping there.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKED AGAINST (August 2026):
 *   - Schedule I, para 2, CGST Act 2017 — "Supply of goods or services or both between related
 *     persons or between distinct persons as specified in section 25, when made in the course or
 *     furtherance of business." Unamended as far as this author could establish.
 *   - Section 25(4)/(5), CGST Act 2017 — separate registrations of one person are distinct
 *     persons.
 *   - Section 10(1)(a), IGST Act 2017 — place of supply where the movement of goods terminates
 *     for delivery to the recipient, i.e. the RECEIVING registration's state. That is what makes
 *     an inter-state branch transfer IGST and a same-state one CGST+SGST.
 *   - Rule 46(b), CGST Rules 2017 — a consecutive serial number in one or more series for a
 *     financial year. The number here comes from the SENDER's own branch-transfer series.
 *   - Rule 55 does NOT cover this. A delivery challan is for the movements listed there (supply
 *     of liquid gas, transport before supply, job work, and other notified cases); a Schedule I
 *     branch transfer needs a tax invoice.
 *   - Rule 28, CGST Rules 2017 — valuation between distinct or related persons. See RULE28_HISTORY
 *     below for the dated text and the provisos.
 *
 * **NEEDS VERIFICATION:** whether a state has notified anything additional for stock transfers
 * within one state between two registrations under section 25(2) has not been checked. The
 * same-state case is modelled as CGST+SGST on the plain reading of section 10(1)(a).
 *
 * Nothing here posts to the books and nothing here talks to a portal — see `BOOKS_NOTE`.
 */

import type { SupplyType } from './calc'

// ---------------------------------------------------------------------------------------------
// Rule 28, as dated data
// ---------------------------------------------------------------------------------------------

/**
 * A basis on which the taxable value of a branch transfer may be fixed under rule 28.
 *
 * `declared-full-itc` is the one that matters in practice and the reason this feature can exist
 * at all: where the recipient is entitled to full input tax credit, whatever the invoice says is
 * *deemed* to be the open market value. Almost every branch transfer between two registrations of
 * one ordinary business falls there, which makes the honest answer "the value you put on it" —
 * and the app says so instead of pretending to compute something.
 */
export type Rule28Basis =
  /** Second proviso to rule 28(1): recipient eligible for full ITC → the declared value IS the OMV. */
  | 'declared-full-itc'
  /** Rule 28(1)(a): the open market value. */
  | 'open-market'
  /** Rule 28(1)(b): value of goods of like kind and quality. */
  | 'like-kind'
  /** First proviso to rule 28(1): 90% of the price the recipient charges an unrelated customer. */
  | 'ninety-percent'
  /** Rule 30 (via rule 28(1)(c)): 110% of cost of production or acquisition. */
  | 'cost-110'

/**
 * A dated statement of what rule 28 said, and which bases it offered.
 *
 * Rates and rules are dated data, never constants — the same pattern as `src/shared/statutory.ts`.
 * Rule 28 has been renumbered once in a way that changes every citation written against it, and a
 * document raised in 2019 must keep citing the text that was in force in 2019.
 */
export interface Rule28Version {
  /** ISO date this text took effect. */
  effectiveFrom: string
  /** How to cite the sub-rule the provisos hang off, e.g. 'rule 28' or 'rule 28(1)'. */
  citation: string
  /** Bases available under this text, in the statutory order of preference. */
  bases: Rule28Basis[]
  note: string
  /** True when the entry has not been checked against the notification that made it. */
  unverified?: boolean
}

export const RULE28_HISTORY: Rule28Version[] = [
  {
    effectiveFrom: '2017-07-01',
    citation: 'rule 28',
    bases: ['open-market', 'like-kind', 'cost-110', 'ninety-percent', 'declared-full-itc'],
    note:
      'Rule 28 as notified: open market value; failing that, goods of like kind and quality; failing that, ' +
      'rule 30/31. First proviso — 90% of the recipient’s onward price where the recipient will supply the ' +
      'goods as such, at the supplier’s option. Second proviso — where the recipient is eligible for full ' +
      'input tax credit, the value declared in the invoice is deemed to be the open market value.'
  },
  {
    effectiveFrom: '2023-10-26',
    citation: 'rule 28(1)',
    bases: ['open-market', 'like-kind', 'cost-110', 'ninety-percent', 'declared-full-itc'],
    note:
      'Rule 28 renumbered as rule 28(1) and a new rule 28(2) inserted for corporate guarantees ' +
      '(Notification 52/2023-Central Tax). The provisos that govern a stock transfer are unchanged; only ' +
      'the sub-rule they hang off moved, so a citation written after this date says “rule 28(1)”. ' +
      'Rule 28(2) does not apply to goods.',
    unverified: true
  }
]

/** The rule 28 text in force on `date`. Dates before the first entry get the first entry. */
export function rule28On(date: string, history: Rule28Version[] = RULE28_HISTORY): Rule28Version {
  let current = history[0] as Rule28Version
  for (const v of history) {
    if (v.effectiveFrom <= date) current = v
    else break
  }
  return current
}

/** What a basis means, in the words the user needs rather than the words of the rule. */
export function rule28BasisLabel(basis: Rule28Basis): string {
  switch (basis) {
    case 'declared-full-itc':
      return 'Value declared (recipient takes full credit)'
    case 'open-market':
      return 'Open market value'
    case 'like-kind':
      return 'Goods of like kind and quality'
    case 'ninety-percent':
      return '90% of the recipient’s onward price'
    case 'cost-110':
      return '110% of cost'
  }
}

/** The citation to print on the face of a document valued on this basis, on this date. */
export function rule28BasisCitation(basis: Rule28Basis, date: string): string {
  const v = rule28On(date)
  switch (basis) {
    case 'declared-full-itc':
      return `Second proviso to ${v.citation} — recipient eligible for full input tax credit, so the declared value is deemed to be the open market value.`
    case 'open-market':
      return `${v.citation}(a) — open market value.`
    case 'like-kind':
      return `${v.citation}(b) — value of goods of like kind and quality.`
    case 'ninety-percent':
      return `First proviso to ${v.citation} — 90% of the price charged by the recipient to an unrelated customer for goods of like kind and quality, the recipient supplying the goods as such.`
    case 'cost-110':
      return `${v.citation}(c) read with rule 30 — 110% of the cost of production or acquisition.`
  }
}

/**
 * The taxable value a basis produces, given what the books know.
 *
 * `bookValue` is what the stock journal moved at — cost, in this app. It is the input to the
 * 110%-of-cost basis and the DEFAULT declared value under the second proviso, and it is not the
 * answer to any of the others: an open market value or a recipient's onward price is a fact about
 * the market that no set of books holds. Those bases therefore return null unless the user has
 * supplied the number, and the caller must ask rather than guess.
 */
export function rule28Value(
  basis: Rule28Basis,
  input: { bookValuePaise: number; declaredPaise?: number | null; recipientPricePaise?: number | null }
): number | null {
  switch (basis) {
    case 'declared-full-itc':
      return input.declaredPaise ?? input.bookValuePaise
    case 'cost-110':
      // Integer paise throughout: 110% of cost, rounded half-up, never a float result.
      return Math.round(input.bookValuePaise * 1.1)
    case 'ninety-percent':
      return input.recipientPricePaise == null ? null : Math.round(input.recipientPricePaise * 0.9)
    case 'open-market':
    case 'like-kind':
      return input.declaredPaise ?? null
  }
}

/**
 * What this app does NOT do with the tax on a branch transfer, printed where it will be read.
 *
 * The constraint that shapes the whole feature: one business, one set of books. A transfer
 * between its own branches creates a tax liability in one registration and a matching credit in
 * another, but it creates no revenue, no expense and no change in the closing stock value — so
 * this document does not post, and the trial balance does not move. The two amounts are equal and
 * opposite across one PAN, so where the receiving registration takes full credit the net effect on
 * the books really is nil, which is the same case the second proviso to rule 28 is written for.
 *
 * Where the receiving registration CANNOT take full credit, the tax is a real cost and it is not
 * in the books. `branchTransferWarnings` says so on the face of the document.
 */
export const BOOKS_NOTE =
  'This invoice is a GST document, not a book entry. The transfer moved stock between two of your own ' +
  'registrations: it creates output tax in one return and input credit in the other, but no revenue, no ' +
  'expense and no change in stock value — so nothing is posted and the trial balance is unchanged.'

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

export interface BranchTransferLine {
  description: string
  /** HSN as recorded on the item, or null. Rule 46(g). */
  hsn: string | null
  /** Integer thousandths. */
  qtyMilli: number
  unit: string | null
  /** Book value of this line's stock, paise — what the journal moved at. */
  bookValue: number
  /** Taxable value under rule 28, paise. */
  taxable: number
  rate: number
  cessRate: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export interface BranchTransferTotals {
  bookValue: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  total: number
}

/** One registration, as it appears on the face of the invoice. */
export interface BranchTransferParty {
  registrationId: number
  gstin: string | null
  stateCode: string
  tradeName: string
  address: string | null
}

/** The movement, as the books recorded it, before it is valued. */
export interface BranchTransferMovement {
  /** The stock journal that moved the goods. */
  voucherId: number
  date: string
  voucherNumber: string
  from: BranchTransferParty
  to: BranchTransferParty
  lines: {
    description: string
    hsn: string | null
    qtyMilli: number
    unit: string | null
    bookValue: number
    rate: number
    cessRate: number
  }[]
}

export interface BranchTransferDoc {
  /** Serial from the sending registration's branch-transfer series — Rule 46(b). */
  number: string
  date: string
  from: BranchTransferParty
  to: BranchTransferParty
  /** Section 10(1)(a) IGST Act — where the movement terminates, i.e. the recipient's state. */
  placeOfSupply: string
  supplyType: SupplyType
  basis: Rule28Basis
  /** The citation for the basis, resolved against the rule text in force on the document's date. */
  basisCitation: string
  lines: BranchTransferLine[]
  totals: BranchTransferTotals
  voucherId: number
  /** What this document cannot say for itself. Stated, never invented. */
  warnings: string[]
}

const ZERO_TOTALS = (): BranchTransferTotals => ({
  bookValue: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0
})

export function sumBranchTransferLines(lines: BranchTransferLine[]): BranchTransferTotals {
  const t = ZERO_TOTALS()
  for (const l of lines) {
    t.bookValue += l.bookValue
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
 * The serial for a branch-transfer invoice.
 *
 * Its own series per financial year, and — this is the part that is easy to get wrong in a
 * multi-GSTIN book — per SENDING registration. Rule 46(b) asks for a consecutive serial for a
 * financial year on the invoices of a registered person, and two registrations are two registered
 * persons; one shared counter would give the Gujarat GSTIN a series with gaps in it, which is
 * exactly the finding a document-series check (Table 13) picks up. `BT/27/2026-27/0003`.
 */
export function branchTransferNumber(
  senderStateCode: string,
  fyLabel: string,
  sequence: number,
  prefix = 'BT'
): string {
  return `${prefix}/${senderStateCode}/${fyLabel}/${String(sequence).padStart(4, '0')}`
}

/**
 * Value one line under rule 28 and split the tax across heads.
 *
 * The rate is the item's own — the same goods carry the same rate whoever they move between.
 */
export function valueLine(
  line: BranchTransferMovement['lines'][number],
  basis: Rule28Basis,
  supply: SupplyType,
  overrides: { declaredPaise?: number | null; recipientPricePaise?: number | null } = {}
): BranchTransferLine {
  const taxable = rule28Value(basis, { bookValuePaise: line.bookValue, ...overrides }) ?? line.bookValue
  const cess = line.cessRate ? Math.round((taxable * line.cessRate) / 100) : 0
  if (supply === 'inter') {
    return {
      ...line,
      taxable,
      igst: Math.round((taxable * line.rate) / 100),
      cgst: 0,
      sgst: 0,
      cess
    }
  }
  const half = Math.round((taxable * (line.rate / 2)) / 100)
  return { ...line, taxable, igst: 0, cgst: half, sgst: half, cess }
}

/**
 * What this invoice cannot say for itself.
 *
 * None of these is fatal. A document that names its own gaps is worth more than no document, and
 * far more than one that fills them in with a guess.
 */
export function branchTransferWarnings(
  movement: BranchTransferMovement,
  basis: Rule28Basis,
  opts: { recipientFullItc: boolean }
): string[] {
  const out: string[] = []
  if (!movement.from.gstin) {
    out.push(
      `The sending registration (${movement.from.stateCode}) has no GSTIN on record — Rule 46(b) requires the supplier’s GSTIN.`
    )
  }
  if (!movement.to.gstin) {
    out.push(
      `The receiving registration (${movement.to.stateCode}) has no GSTIN on record. Without it this is not a supply between distinct persons and this document should not be raised.`
    )
  }
  const missingHsn = movement.lines.filter((l) => !l.hsn).length
  if (missingHsn > 0) out.push(`${missingHsn} line${missingHsn === 1 ? '' : 's'} have no HSN — Rule 46(g).`)
  const unrated = movement.lines.filter((l) => l.rate === 0).length
  if (unrated > 0) {
    out.push(
      `${unrated} line${unrated === 1 ? '' : 's'} carry a nil rate. A branch transfer is taxed at the goods’ own rate — check the rate on the item master.`
    )
  }
  if (basis === 'declared-full-itc' && !opts.recipientFullItc) {
    out.push(
      'Valued on the declared value under the second proviso to rule 28, but the receiving registration is not marked as taking full input tax credit. That proviso is only available where it does.'
    )
  }
  if (!opts.recipientFullItc) {
    out.push(
      'The receiving registration does not take full credit on this transfer, so the tax on it is a real cost. It is NOT in your books — this document does not post. Journal it yourself.'
    )
  }
  return out
}

export interface BuildBranchTransferInput {
  movement: BranchTransferMovement
  number: string
  basis: Rule28Basis
  /** Whether the receiving registration takes full ITC — decides the second proviso and the warning. */
  recipientFullItc: boolean
  /** A value the user fixed by hand, for the bases the books cannot answer. Per-line pro rata. */
  declaredPaise?: number | null
  recipientPricePaise?: number | null
}

/**
 * One branch-transfer invoice for one movement between two registrations.
 *
 * Dated on the movement, not on the day it was printed. Section 31(1) ties the invoice for a
 * supply of goods involving movement to the time of removal, and printing it late does not move
 * it — which also keeps the sender's output tax and the receiver's credit in the same tax period,
 * so the two returns tie.
 *
 * A user-supplied total value is spread across the lines PRO RATA on book value, in integer paise,
 * with the rounding residue landing on the last line. Money is paise: the parts sum to the whole
 * exactly, or the invoice does not add up to its own total.
 */
export function buildBranchTransferInvoice(input: BuildBranchTransferInput): BranchTransferDoc {
  const { movement } = input
  const supplyType: SupplyType = movement.from.stateCode === movement.to.stateCode ? 'intra' : 'inter'

  const bookTotal = movement.lines.reduce((t, l) => t + l.bookValue, 0)
  const declaredTotal = input.declaredPaise ?? null
  const priceTotal = input.recipientPricePaise ?? null

  // Pro-rata split of a hand-fixed total, in paise, residue on the last line.
  const share = (total: number | null, index: number): number | null => {
    if (total == null) return null
    if (bookTotal === 0) return index === movement.lines.length - 1 ? total : 0
    if (index === movement.lines.length - 1) {
      let assigned = 0
      for (let i = 0; i < movement.lines.length - 1; i++) {
        assigned += Math.round((total * (movement.lines[i] as { bookValue: number }).bookValue) / bookTotal)
      }
      return total - assigned
    }
    return Math.round((total * (movement.lines[index] as { bookValue: number }).bookValue) / bookTotal)
  }

  const lines = movement.lines.map((l, i) =>
    valueLine(l, input.basis, supplyType, {
      declaredPaise: share(declaredTotal, i),
      recipientPricePaise: share(priceTotal, i)
    })
  )

  return {
    number: input.number,
    date: movement.date,
    from: movement.from,
    to: movement.to,
    placeOfSupply: movement.to.stateCode,
    supplyType,
    basis: input.basis,
    basisCitation: rule28BasisCitation(input.basis, movement.date),
    lines,
    totals: sumBranchTransferLines(lines),
    voucherId: movement.voucherId,
    warnings: branchTransferWarnings(movement, input.basis, { recipientFullItc: input.recipientFullItc })
  }
}
