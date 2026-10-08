/**
 * WP 4.2 — the rules the receivables module applies, with their sources. Every tax statement in
 * the module points here; nothing is written from memory. Items marked UNVERIFIED are practice
 * questions the cited text does not settle — the app makes them options rather than rules.
 */

export interface RuleSource {
  id: string
  /** What the app does because of it. */
  rule: string
  /** The cited text (verbatim where quoted). */
  citation: string
  /** Where the text was read ('' = none). */
  url: string
  verified: boolean
}

export const RECEIVABLES_SOURCES: readonly RuleSource[] = [
  {
    id: 'cgst-15-2-d',
    rule:
      'Interest charged to a customer for paying an invoice late is part of the value of that supply, so it is taxable at the ' +
      'GST rate of the supply it was charged on (apportioned by taxable value when the invoice carried several rates).',
    citation:
      'CGST Act 2017 s.15(2)(d): the value of supply shall include "interest or late fee or penalty for delayed payment of any ' +
      'consideration for any supply". CBIC Circular No. 102/21/2019-GST dated 28 June 2019, para 5 (Case 1): "the amount of ' +
      'penal interest is to be included in the value of supply ... the penal interest would be taxable as it would be included ' +
      'in the value of the mobile, irrespective of the manner of invoicing."',
    url: 'https://gstcouncil.gov.in/sites/default/files/2024-06/circular-cgst-102.pdf',
    verified: true
  },
  {
    id: 'cgst-34-3',
    rule: 'The interest (with its GST) is raised on a debit note to the customer.',
    citation:
      'CGST Act 2017 s.34(3): "Where one or more tax invoices have been issued for supply of any goods or services or both and ' +
      'the taxable value or tax charged in that tax invoice is found to be less than the taxable value or tax payable in respect ' +
      'of such supply, the registered person, who has supplied such goods or services or both, shall issue to the recipient one ' +
      'or more debit notes ..." (read from a reproduction of the Act, not the Gazette).',
    url: 'https://www.knowyourgst.com/gstlaw/cgst-act/34-credit-and-debit-notes-34/',
    verified: true
  },
  {
    id: 'cgst-12-6',
    rule:
      'UNVERIFIED (timing): the time of supply of such interest is the date it is RECEIVED, not the date it is charged. Whether ' +
      'to put GST on the debit note when the interest is claimed (the default: the note carries the GST split, so the tax is ' +
      'paid early, never late) or to raise the GST only on receipt is a practice question — hence the "GST on interest" option.',
    citation:
      'CGST Act 2017 s.12(6) (goods; s.13(6) for services): "The time of supply to the extent it relates to an addition in the ' +
      'value of supply by way of interest, late fee or penalty for delayed payment of any consideration shall be the date on ' +
      'which the supplier receives such addition in value." (read from a secondary reproduction).',
    url: 'https://www.taxheal.com/?p=81488',
    verified: false
  },
  {
    id: 'hsn-of-interest',
    rule:
      'UNVERIFIED (reporting): the interest debit note reaches GSTR-1 through its interest income ledger (one per GST rate, ' +
      'gst_rate set, no HSN). The HSN summary (Table 12) may want the HSN of the original goods — set the ledger\'s HSN by hand ' +
      'if your CA wants it there.',
    citation: 'No CBIC text found on how interest debit notes are reported in the GSTR-1 HSN summary.',
    url: '',
    verified: false
  },
  {
    id: 'sac-of-interest',
    rule:
      'UNVERIFIED: a SAC for the interest ledgers is a company setting (blank by default). 9971 ("Financial and related ' +
      'services") is offered as a suggestion only; since the interest is part of the value of the original supply ' +
      '(s.15(2)(d)), many practitioners report it under the HSN of the goods instead. Ask your CA.',
    citation: 'Scheme of Classification of Services (Notification 11/2017-CT(Rate) Annexure) — heading 9971; not re-read for this point.',
    url: '',
    verified: false
  },
  {
    id: 'no-invoice-bills',
    rule:
      'A bill with no invoice behind it (opening balance, journal) has no supply rate to follow. With GST on interest on, it ' +
      'is charged at the company\'s default rate (Settings → Receivables, flagged in the preview) or, with no default set, ' +
      'not charged — the preview says why.',
    citation: 'App rule (s.15(2)(d) needs the rate of the supply the interest belongs to).',
    url: '',
    verified: true
  },
  {
    id: 'zero-rated',
    rule:
      'Interest follows the class of the original invoice: SEZ / export with payment of tax → IGST; without payment → no tax; ' +
      'the invoice\'s place-of-supply override carries onto the note. The same classification the GSTR-1 extraction uses.',
    citation: 'IGST Act 2017 s.16 (zero-rated supply) and s.7(5)(b) (supplies to SEZ are inter-state), as already applied in services/gst.ts.',
    url: '',
    verified: true
  },
  {
    id: 'no-gst-unregistered',
    rule: 'A company that is not a regular GST registrant (composition / unregistered) never charges GST on the interest.',
    citation:
      'CGST Act 2017 s.10(4): a composition taxable person "shall not collect any tax from the recipient on supplies made by him"; ' +
      'an unregistered person cannot issue a tax invoice or debit note charging GST (s.31, s.34 apply to registered persons).',
    url: 'https://www.knowyourgst.com/gstlaw/cgst-act/10-composition-levy-10/',
    verified: false
  },
  {
    id: 'day-count',
    rule:
      'Simple interest, actual days / 365 (no leap-year adjustment), rounded half up to the paisa per bill: ' +
      'interest = pending × annual rate × days ÷ 365. Days run from the day after (due date + grace days) to the as-on date, ' +
      'both inclusive; a period already charged on a live debit note is never charged again.',
    citation: 'App convention — no statute fixes a day count for trade-credit interest; the party agreement does.',
    url: '',
    verified: true
  }
]
