/**
 * GSTR-1A — the amendment return (roadmap #353).
 *
 * Correcting a filed GSTR-1 used to mean waiting for next month and using the amendment tables
 * (9A/9B/9C) of that month's return. GSTR-1A changed that: it is a return of its own, optional,
 * available after GSTR-1 is filed and before GSTR-3B for the same period, and what it carries is
 * the DIFFERENCE between what was filed and what the books now say.
 *
 * ---------------------------------------------------------------------------------------------
 * CHECKED AGAINST (August 2026):
 *   - Rule 59(4A), CGST Rules 2017, inserted by Notification No. 12/2024-Central Tax
 *     (10 July 2024), notified into effect for the tax period August 2024 onwards.
 *   - The window: GSTR-1A opens after GSTR-1 is filed (or after the due date, whichever is later)
 *     and closes when GSTR-3B for the same period is filed.
 *     ** THE PRECISE OPENING AND CLOSING CONDITIONS HAVE NOT BEEN VERIFIED against the current
 *        rule text by this author. `amendmentWindow` below states them as it understands them
 *        and marks itself unverified; treat it as a prompt, not as authority. **
 *   - A recipient's GSTIN cannot be amended through GSTR-1A. That is a real restriction with a
 *     real consequence — an invoice billed to the wrong registration has to be credit-noted and
 *     re-issued, not amended — so `diffGstr1` reports it as its own finding rather than as an
 *     ordinary amendment.
 *
 * This module is a pure diff. It does not decide what to file; it says what changed since the
 * snapshot, in the shape the amendment tables want.
 */

import type { GstDoc, GstDocRateItem } from './returns'

/** What happened to a document between the filed snapshot and the books now. */
export type Gstr1aChange =
  /** In the books, not in what was filed. Table 4 of GSTR-1A: a missed invoice. */
  | 'added'
  /** Filed, and no longer in the books at all — deleted or moved out of the period. */
  | 'removed'
  /** Same document, different figures. */
  | 'amended'
  /**
   * Same document number, different recipient GSTIN.
   *
   * Its own kind because GSTR-1A cannot carry it: the counter-party of a filed invoice is not
   * amendable. The fix is a credit note and a fresh invoice, and saying "amended" here would send
   * the user to a form that will reject it.
   */
  | 'counterPartyChanged'

export interface Gstr1aRow {
  change: Gstr1aChange
  /** The document number as filed (and, for an amendment, still). */
  number: string
  date: string
  partyName: string | null
  /** GSTIN as filed. Null for a document that was never filed. */
  filedGstin: string | null
  /** GSTIN in the books now. Null for a document no longer in the books. */
  bookGstin: string | null
  /** Filed figures, or null when the document was not in the filed return. */
  filed: Gstr1aTotals | null
  /** Book figures, or null when the document is gone from the books. */
  book: Gstr1aTotals | null
  /** book − filed, per head. The number the amendment actually carries. */
  delta: Gstr1aTotals
  /** Plain sentences describing what moved — shown next to the row. */
  reasons: string[]
}

export interface Gstr1aTotals {
  invoiceValue: number
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export interface Gstr1aResult {
  period: string
  /** True when nothing changed — a filed return that still matches the books needs no GSTR-1A. */
  clean: boolean
  rows: Gstr1aRow[]
  /** Net movement across every row. Positive means more tax is payable than was filed. */
  net: Gstr1aTotals
  /** Rows the amendment return cannot carry — see `counterPartyChanged`. */
  notAmendable: Gstr1aRow[]
}

const ZERO = (): Gstr1aTotals => ({ invoiceValue: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 })

function totalsOf(doc: GstDoc): Gstr1aTotals {
  const t = ZERO()
  t.invoiceValue = doc.invoiceValue
  for (const i of doc.items as GstDocRateItem[]) {
    t.taxable += i.taxable
    t.igst += i.igst
    t.cgst += i.cgst
    t.sgst += i.sgst
    t.cess += i.cess
  }
  return t
}

function subtract(book: Gstr1aTotals | null, filed: Gstr1aTotals | null): Gstr1aTotals {
  const b = book ?? ZERO()
  const f = filed ?? ZERO()
  return {
    invoiceValue: b.invoiceValue - f.invoiceValue,
    taxable: b.taxable - f.taxable,
    igst: b.igst - f.igst,
    cgst: b.cgst - f.cgst,
    sgst: b.sgst - f.sgst,
    cess: b.cess - f.cess
  }
}

function add(into: Gstr1aTotals, d: Gstr1aTotals): void {
  into.invoiceValue += d.invoiceValue
  into.taxable += d.taxable
  into.igst += d.igst
  into.cgst += d.cgst
  into.sgst += d.sgst
  into.cess += d.cess
}

function nonZero(t: Gstr1aTotals): boolean {
  return t.invoiceValue !== 0 || t.taxable !== 0 || t.igst !== 0 || t.cgst !== 0 || t.sgst !== 0 || t.cess !== 0
}

/**
 * Documents are matched on number AND kind.
 *
 * Not on voucher id: the snapshot is what was FILED, and a voucher that was deleted and re-entered
 * carries the same invoice number to the portal but a different row in the books. The portal
 * knows the number; matching on anything else would report a re-keyed invoice as one deletion and
 * one addition, which is two amendments where there is one.
 */
function keyOf(doc: { number: string; kind: string }): string {
  return `${doc.kind}|${doc.number.trim().toUpperCase()}`
}

/**
 * The difference between a filed GSTR-1 and the books as they now stand.
 *
 * `filed` is the snapshot taken when the return was filed — see `gstFilingSnapshot` in the
 * filings service. Without a snapshot there is nothing to amend against, and the caller must say
 * so rather than diffing the books against themselves and reporting a clean return.
 */
export function diffGstr1(filed: GstDoc[], books: GstDoc[], period: string): Gstr1aResult {
  const filedByKey = new Map(filed.map((d) => [keyOf(d), d]))
  const bookByKey = new Map(books.map((d) => [keyOf(d), d]))

  const rows: Gstr1aRow[] = []
  const net = ZERO()

  for (const [key, f] of filedByKey) {
    const b = bookByKey.get(key)
    const filedTotals = totalsOf(f)
    if (!b) {
      const delta = subtract(null, filedTotals)
      rows.push({
        change: 'removed',
        number: f.number,
        date: f.date,
        partyName: f.partyName,
        filedGstin: f.partyGstin,
        bookGstin: null,
        filed: filedTotals,
        book: null,
        delta,
        reasons: ['Filed, but no longer in the books for this period.']
      })
      add(net, delta)
      continue
    }

    const bookTotals = totalsOf(b)
    const delta = subtract(bookTotals, filedTotals)
    const gstinMoved = (f.partyGstin ?? null) !== (b.partyGstin ?? null)
    const reasons: string[] = []
    if (f.date !== b.date) reasons.push(`Date moved from ${f.date} to ${b.date}.`)
    if (f.pos !== b.pos) reasons.push(`Place of supply moved from ${f.pos} to ${b.pos}.`)
    if (delta.taxable !== 0) reasons.push('Taxable value changed.')
    if (delta.igst !== 0 || delta.cgst !== 0 || delta.sgst !== 0 || delta.cess !== 0) reasons.push('Tax changed.')
    if (gstinMoved) {
      reasons.push(
        `Recipient GSTIN changed from ${f.partyGstin ?? 'none'} to ${b.partyGstin ?? 'none'}. ` +
          'GSTR-1A cannot amend the counter-party — this needs a credit note and a fresh invoice.'
      )
    }

    if (!gstinMoved && !nonZero(delta) && f.date === b.date && f.pos === b.pos) continue

    rows.push({
      change: gstinMoved ? 'counterPartyChanged' : 'amended',
      number: f.number,
      date: b.date,
      partyName: b.partyName,
      filedGstin: f.partyGstin,
      bookGstin: b.partyGstin,
      filed: filedTotals,
      book: bookTotals,
      delta,
      reasons
    })
    add(net, delta)
  }

  for (const [key, b] of bookByKey) {
    if (filedByKey.has(key)) continue
    const bookTotals = totalsOf(b)
    const delta = subtract(bookTotals, null)
    rows.push({
      change: 'added',
      number: b.number,
      date: b.date,
      partyName: b.partyName,
      filedGstin: null,
      bookGstin: b.partyGstin,
      filed: null,
      book: bookTotals,
      delta,
      reasons: ['In the books but missing from the filed return.']
    })
    add(net, delta)
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))

  return {
    period,
    clean: rows.length === 0,
    rows,
    net,
    notAmendable: rows.filter((r) => r.change === 'counterPartyChanged')
  }
}

export interface AmendmentWindow {
  open: boolean
  reason: string
  /** True until the window rules in the header have been checked against the current rule text. */
  unverified: true
}

/**
 * Whether GSTR-1A is available for a period.
 *
 * Stated as advice with `unverified` permanently set — see the header. The mechanism (a filed
 * GSTR-1, an unfiled GSTR-3B) is what the app can actually observe, and observing it is useful
 * even while the exact rule is being confirmed.
 */
export function amendmentWindow(input: { gstr1FiledAt: string | null; gstr3bFiledAt: string | null }): AmendmentWindow {
  if (!input.gstr1FiledAt) {
    return {
      open: false,
      reason: 'GSTR-1 for this period has not been recorded as filed. There is nothing to amend yet.',
      unverified: true
    }
  }
  if (input.gstr3bFiledAt) {
    return {
      open: false,
      reason:
        `GSTR-3B for this period was filed on ${input.gstr3bFiledAt}, which closes the GSTR-1A window. ` +
        'Corrections now go in a later period’s amendment tables.',
      unverified: true
    }
  }
  return {
    open: true,
    reason: `GSTR-1 was filed on ${input.gstr1FiledAt} and GSTR-3B is still open — GSTR-1A can be filed.`,
    unverified: true
  }
}
