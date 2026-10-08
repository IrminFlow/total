/**
 * WP 6.5 — the consolidation rules the engine applies, each with its source. Nothing here is
 * written from memory: the AS 21 quotations were read from ICAI's published text (AS 21,
 * "Consolidated Financial Statements", indasaccess.icai.org) on 2026-10-08. Items marked
 * `verified: false` are either paragraph numbers that were not checked against the official
 * text, or practice choices the cited text does not settle — the app makes those visible
 * (reconciliation statement, warnings) rather than hiding them.
 *
 * Basis: AS 21 / AS 23 (Companies (Accounting Standards) Rules). Ind AS 110 / Ind AS 28 differ
 * (fair-value goodwill, NCI at fair value, etc.) and are NOT implemented.
 */

export interface ConsolidationSource {
  id: string
  /** Column label ("AS 21 para 16"). */
  short: string
  /** What the app does because of it. */
  rule: string
  /** The cited text (verbatim where quoted). */
  citation: string
  url: string
  verified: boolean
}

const AS21_URL = 'https://indasaccess.icai.org/Volume-III/AS/asb.html?a=122'
const AS23_URL = 'https://indasaccess.icai.org/Volume-III/AS/asb.html?a=124'

export const CONSOLIDATION_SOURCES = [
  {
    id: 'as21-13',
    short: 'AS 21 para 13',
    rule: 'Member trial balances / statements are added line by line after mapping each member ledger to a group chart line.',
    citation: 'AS 21 para 13: "the financial statements of the parent and its subsidiaries should be combined on a line by line basis by adding together like items of assets, liabilities, income and expenses."',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'as21-13ab',
    short: 'AS 21 para 13(a)(b)',
    rule: 'The parent\'s cost of investment (its investment ledger) and its share of the subsidiary\'s equity at the date of investment are eliminated; the excess cost is "Goodwill on consolidation" (asset).',
    citation: 'AS 21 para 13(a): "the cost to the parent of its investment in each subsidiary and the parent\'s portion of equity of each subsidiary, at the date on which investment in each subsidiary is made, should be eliminated"; 13(b): "any excess of the cost to the parent of its investment in a subsidiary over the parent\'s portion of equity of the subsidiary, at the date on which investment in the subsidiary is made, should be described as goodwill to be recognised as an asset".',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'as21-13c',
    short: 'AS 21 para 13(c)',
    rule: 'When the cost is less than the parent\'s share of equity at the date of investment, the difference is "Capital reserve on consolidation".',
    citation: 'AS 21 para 13(c): "when the cost to the parent of its investment in a subsidiary is less than the parent\'s portion of equity of the subsidiary, at the date on which investment in the subsidiary is made, the difference should be treated as a capital reserve".',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'as21-13d',
    short: 'AS 21 para 13(d)',
    rule: 'Minority share of the subsidiary\'s profit for the period = (100% − ownership) × that profit; shown below consolidated net profit.',
    citation: 'AS 21 para 13(d): "minority interests in the net income of consolidated subsidiaries for the reporting period should be identified and adjusted against the income of the group in order to arrive at the net income attributable to the owners of the parent".',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'as21-13e',
    short: 'AS 21 para 13(e), 25',
    rule: 'Minority interest in net assets = (100% − ownership) × the subsidiary\'s whole equity on the reporting date (its equity at acquisition plus movements since), computed once and identical in the trial balance and the balance sheet; carved out of each equity line in signed proportion (a loss line takes its share of the loss); a separate line, not part of the parent\'s equity.',
    citation: 'AS 21 para 13(e): minority interests in net assets "consist of: (i) the amount of equity attributable to minorities at the date on which investment in a subsidiary is made; and (ii) the minorities\' share of movements in equity since the date the parent-subsidiary relationship came in existence". Para 25: "Minority interests should be presented in the consolidated balance sheet separately from liabilities and the equity of the parent\'s shareholders."',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'as21-16',
    short: 'AS 21 para 16',
    rule: 'Inter-company balances (receivable/payable, loans) and inter-company transactions (sales/purchases, interest) are eliminated in full; a difference between the two sides is never eliminated silently — it is carried to "Unreconciled inter-company" (or, within the group tolerance, "Inter-company rounding").',
    citation: 'AS 21 para 16: "Intragroup balances and intragroup transactions and resulting unrealised profits should be eliminated in full. Unrealised losses resulting from intragroup transactions should also be eliminated unless cost cannot be recovered."',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'ups-estimate',
    short: 'Estimate (practice)',
    rule: 'Unrealised profit in closing stock (optional): buyer\'s closing stock × (inter-company purchases ÷ its Purchase Accounts of the period), capped at 100 %, × the configured margin %, and never more than the seller\'s inter-company sales × its own gross margin for the period (nothing when it sold at a loss). It is charged in full to the group (not shared with the minority) and the opening-stock reversal of a prior period is not computed.',
    citation: 'Practice choice — AS 21 para 16 requires the elimination but gives no measurement method. The proportionate estimate, full charge to the group and no opening reversal are UNVERIFIED simplifications; enter 0% to switch it off.',
    url: '',
    verified: false
  },
  {
    id: 'as21-22',
    short: 'AS 21 para 22',
    rule: 'A member\'s income and expenses are included only from its "include from" date (default: the acquisition date) to its "include to" date (disposal); its balance sheet only when it is a member on the reporting date.',
    citation: 'AS 21 para 22: "The results of operations of a subsidiary are included in the consolidated financial statements as from the date on which parent-subsidiary relationship came in existence."',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'as21-18',
    short: 'AS 21 para 18',
    rule: 'Every member is reported for the same period and reporting date (the group\'s). Different member year-ends are not adjusted for.',
    citation: 'AS 21 para 18: "The financial statements used in the consolidation should be drawn up to the same reporting date." Adjustments for differing dates (para 18, at most six months apart) are NOT implemented.',
    url: AS21_URL,
    verified: true
  },
  {
    id: 'as21-20',
    short: 'AS 21 para 20',
    rule: 'Uniform accounting policies are assumed; each member\'s own year-opening rule and stock valuation apply as in its own books.',
    citation: 'AS 21 para 20: "Consolidated financial statements should be prepared using uniform accounting policies for like transactions." Policy alignment adjustments are NOT computed (UNVERIFIED that members share policies).',
    url: AS21_URL,
    verified: false
  },
  {
    id: 'equity-at-acquisition',
    short: 'Book value (practice)',
    rule: 'Equity at acquisition = the subsidiary\'s Capital Account group (incl. Reserves & Surplus) plus its accumulated P&L as on the day before the acquisition date, from its own books; or the amount entered on the member (override). Before the books begin only the Capital Account openings are counted.',
    citation: 'Practice choice (book values at acquisition; AS 21 has no fair-value remeasurement). Using the day before the acquisition date and Capital Account openings for an acquisition before the books begin are UNVERIFIED simplifications — enter the figure from the acquisition accounts when known.',
    url: '',
    verified: false
  },
  {
    id: 'as21-26',
    short: 'AS 21 para 26',
    rule: 'Minority losses beyond the minority\'s interest are NOT re-allocated to the parent: the minority share is always the plain percentage.',
    citation: 'AS 21 para 26: "The losses applicable to the minority in a consolidated subsidiary may exceed the minority interest in the equity of the subsidiary." The re-allocation to the majority that follows in the standard is NOT implemented (UNVERIFIED wording beyond the quoted sentence).',
    url: AS21_URL,
    verified: false
  },
  {
    id: 'as23-equity',
    short: 'AS 23 equity method',
    rule: 'Associates are not added line by line: the group recognises ownership % × the associate\'s profit for the period ("Share of profit of associates") and, when an investment ledger is set, adds its share of post-acquisition equity to that investment. Inter-company eliminations with associates are not computed.',
    citation: 'AS 23 (equity method): the investment "is initially recorded at cost, identifying any goodwill/capital reserve arising at the time of acquisition and the carrying amount is increased or decreased to recognise the investor\'s share of the profits or losses of the investee after the date of acquisition." Paragraph number UNVERIFIED; partial elimination of unrealised profits with associates ("to the extent of the investor\'s interest") is NOT implemented.',
    url: AS23_URL,
    verified: false
  },
  {
    id: 'currency',
    short: 'AS 11 (not applied)',
    rule: 'Every member\'s books are in INR. A presentation currency other than INR is stored but no translation is applied (warned).',
    citation: 'AS 11 translation of non-integral foreign operations is NOT implemented.',
    url: '',
    verified: false
  }
] as const satisfies readonly ConsolidationSource[]

export type ConsolidationSourceId = (typeof CONSOLIDATION_SOURCES)[number]['id']

export function sourceOf(id: ConsolidationSourceId): ConsolidationSource {
  return CONSOLIDATION_SOURCES.find((s) => s.id === id)!
}
