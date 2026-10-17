/**
 * Statutory text behind the TCS additions after WP 3.3 — the s.206C(1G) overseas tour programme
 * package slab (5 % up to ₹10 lakh a year, 20 % above) and s.206C(1C) (parking lot / toll plaza /
 * mine or quarry) — quoted, with where it was read and when. "Tax rules are never written from
 * memory": every number below points at a source key, and anything that could not be read in an
 * official copy is in TCS_UNVERIFIED (shown on TCS → Sections).
 *
 * The WP 3.3 sources (the s.206C(1) Table, (1F), (1H), s.206CC, rule 37CA, the 27EQ / Form 143
 * layouts) stay with migration 027's seeds. Renumbering: from 1 Apr 2026 the 1961 Act's s.206C is
 * s.394 of the Income-tax Act, 2025 (s.206C(1G) tour package = s.394(1) Table Sl. 8, s.206C(1C) =
 * Sl. 9) — the same note as src/shared/fixedAssetSources.ts for depreciation.
 *
 * Pure data: no I/O.
 */

export interface TcsSource {
  key: string
  title: string
  /** The words relied on, quoted exactly as read (line breaks / page furniture of the copy removed). */
  quote: string
  url: string
  /** Where the text was read, when it was not the official copy itself. */
  readIn?: string
  accessed: string
}

const ACCESSED = '2026-10-17'

export const TCS_SOURCES: readonly TcsSource[] = [
  {
    key: 'ACT25-394-1',
    title: 'Income-tax Act, 2025 — s.394(1) and its Table, Sl. 8 (overseas tour programme package) and Sl. 9 (parking lot / toll plaza / mine or quarry)',
    quote:
      '394. (1) Every person, as specified in column C of the Table below shall collect tax–– (a) on receipts specified in column B; ' +
      '(b) at the rate as specified in column D; and (c) at the time of debiting of the amount payable by the buyer or licensee or ' +
      'lessee to the account of the buyer or licensee or lessee or at the time of receipt of such amount from the said buyer or ' +
      'licensee or lessee in cash or by way of a cheque or a draft or any other mode, whichever is earlier. … ' +
      '8. Sale of “overseas tour programme package” including expenses for travel or hotel stay or boarding or lodging or any such ' +
      'similar or related expenditure. | Seller. | (a) 5% of amount or aggregate of amounts up to ten lakh rupees; (b) 20% of amount ' +
      'or aggregate of amounts exceeding ten lakh rupees. ' +
      '9. Use of parking lot or toll plaza or mine or quarry for the purpose of business, excluding mining and quarrying of mineral ' +
      'oil (including petroleum and natural gas). | Licensor or Lessor. | 2%',
    url: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf',
    readIn: 'Gazette of India Extraordinary, Part II s.1 — the Income-tax Act, 2025 as published (pages 417–418, text layer)',
    accessed: ACCESSED
  },
  {
    key: 'ACT25-402',
    title: 'Income-tax Act, 2025 — s.402 (interpretation for the TDS / TCS chapter), clauses (21), (22), (26)',
    quote:
      '(21) “licensee or lessee” means any person, other than a public sector company, who has been granted a lease or a licence or ' +
      'entered into a contract or otherwise received any right or interest either in whole or in part in any parking lot or toll ' +
      'plaza or mine or quarry, from the licensor or lessor for the use of parking lot or toll plaza or mine or quarry for the ' +
      'purposes of business; (22) “licensor or lessor” means any person who grants a lease or a licence or enters into a contract ' +
      'or otherwise transfers any right or interest either in whole or in part in any parking lot or toll plaza or mine or quarry, ' +
      'to another person, other than a public sector company for the use of such parking lot or toll plaza or mine or quarry for ' +
      'the purposes of business; … (26) “overseas tour programme package” means any tour package which offers visit to any country ' +
      'or territory outside India and includes expenses for travel or hotel stay or boarding or lodging or any other expenditure of ' +
      'similar nature or in relation thereto;',
    url: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf',
    readIn: 'Gazette copy of the Income-tax Act, 2025 (s.402, text layer)',
    accessed: ACCESSED
  },
  {
    key: 'FA25-72',
    title: 'Finance Act, 2025 (No. 7 of 2025) — s.72(b) and (e) amending s.206C of the 1961 Act; s.1(2)(a) commencement',
    quote:
      '72. In section 206C of the Income-tax Act,–– … (b) in sub-section (1G),–– (i) in the first, second and fourth provisos, for ' +
      'the words “seven lakh rupees” wherever they occur, the words “ten lakh rupees” shall be substituted; (ii) for the third ' +
      'proviso, the following proviso shall be substituted, namely:— “Provided also that the authorised dealer shall not collect ' +
      'the sum if the amount being remitted out is a loan obtained from any financial institution as defined in clause (b) of ' +
      'sub-section (3) of section 80E, for the purpose of pursuing any education:”; … (e) in sub-section (9), for the words, ' +
      'brackets, figures and letters “, sub-section (1C) or sub-section (1H)” at both the places where they occur, the words, ' +
      'brackets, figure and letter “or sub-section (1C)” shall be substituted; … 1. (2) Save as otherwise provided in this Act,–– ' +
      '(a) sections 2 to 91, 104 to 120, 125 and 136 shall come into force on the 1st day of April, 2025;',
    url: 'https://egazette.gov.in/WriteReadData/2025/262125.pdf',
    readIn: 'Gazette of India Extraordinary No. 7, 29 March 2025 (pages 34–35, text layer)',
    accessed: ACCESSED
  },
  {
    key: 'FA23-94',
    title: 'Finance Act, 2023 (No. 8 of 2023) — s.94 amending s.206C(1G) of the 1961 Act',
    quote:
      '94. In section 206C of the Income-tax Act, in sub-section (1G), with effect from the 1st day of July, 2023,— (i) in clause (a), ' +
      'the words “out of India” at both the places where they occur shall be omitted; (ii) in the long line, for the word "five", the ' +
      'word "twenty" shall be substituted; (iii) in the first proviso, for the words "and is for a purpose other than purchase of ' +
      'overseas tour program package", the words "and is for the purposes of education or medical treatment" shall be substituted; ' +
      '(iv) in the second proviso, for the words "is for a purpose other than purchase of overseas tour program package", the words ' +
      '"is for the purposes of education or medical treatment" shall be substituted.',
    url: 'https://egazette.gov.in/WriteReadData/2023/244830.pdf',
    readIn: 'Gazette of India Extraordinary No. 8, 31 March 2023 (text layer)',
    accessed: ACCESSED
  },
  {
    key: 'FA26-85',
    title: 'Finance Act, 2026 (No. 4 of 2026) — s.85(f) (Sl. 8 tour package to a flat 2 %); s.1(2)(a) commencement',
    quote:
      '85. In section 394 of the Income-tax Act, in sub-section (1), in the Table,— … (e) against Sl. No. 7, in column D, in clause ' +
      '(a), for the figure and symbol “5%”, the figure and symbol “2%” shall be substituted; (f) against Sl. No. 8, in column D, for ' +
      'clauses (a) and (b), the figure and symbol “2%” shall be substituted. … 1. (2) … (a) sections 2 to 129, clause (b) of ' +
      'section 152 and section 156 shall come into force on the 1st day of April, 2026;',
    url: 'https://egazette.gov.in/WriteReadData/2026/271439.pdf',
    readIn: 'Gazette of India Extraordinary, 30 March 2026 (pages 56–57, text layer). s.85 does not touch Sl. 9.',
    accessed: ACCESSED
  },
  {
    key: 'F27EQ-A2',
    title: 'Protean Form 27EQ file format v6.9 (27-05-2025) — Annexure 2 collection codes',
    quote:
      'Parking Lot | F; Toll Plaza | G; Mining and Quarrying | H; … Collection at source for purchase of overseas tour program ' +
      'package. Applicable for the statements pertains to FY 2020-21 and Q3 onwards only. | O',
    url: 'https://tinpan.proteantech.in/downloads/e-tds/File_Format_27EQ_Regular_Q1_to_Q4_Version_6.9_%2027052025_201011.xls',
    readIn: 'sheet "File Format_R", Annexure 2 (rows 265–267, 274)',
    accessed: ACCESSED
  },
  {
    key: 'F143-A2',
    title: 'Protean Form 143 file format (Form Number 143-27EQ, Q1 to Q4, 22-07-2026) — Annexure 2 collection codes',
    quote:
      'Sale of “overseas tour programme package” … with amount or aggregate of amounts up to threshold limit. | 394(1) [Table: Sl. ' +
      'No. 8.D(a)] | 1088; … above threshold limit. | 394(1) [Table: Sl. No. 8.D(b)] | 1089; Use of parking lot for the purpose of ' +
      'business, excluding mining and quarrying of mineral oil (including petroleum and natural gas). | 394(1) [Table: Sl. No. 9] | ' +
      '1090; Use of toll plaza … | 394(1) [Table: Sl. No. 9] | 1091; Use of mine or quarry … | 394(1) [Table: Sl. No. 9] | 1092',
    url: 'https://tinpan.proteantech.in/downloads/e-tds/Form%20Number%20143-27EQ%20-%20Q1%20to%20Q4_22072026.xlsx',
    readIn: 'sheet "FIleformat_R", Annexure 2 (rows 262–266)',
    accessed: ACCESSED
  },
  {
    key: 'S206C-1961',
    title: 'Income-tax Act, 1961 — s.206C(1C) and s.206C(1G)(b) as in force for FY 2025-26 (NOT quoted: the official page could not be read)',
    quote:
      'No quotation. The department\'s section page refused every automated read (HTTP 403); a web search index of it gives ' +
      's.206C(1C) as: the person granting a lease / licence of a parking lot, toll plaza or mine or quarry for business (licensee ' +
      'other than a public sector company) collects 2 % for each of the three, at debit or receipt whichever is earlier. The tour ' +
      'package slab is taken from the official texts only: FA 2023 s.94 (FA23-94), FA 2025 s.72(b) (FA25-72) and the 2025 Act ' +
      'Table Sl. 8 (ACT25-394-1).',
    url: 'https://www.incometaxindia.gov.in/w/section-206c-36',
    readIn: 'not read — see TCS_UNVERIFIED "1961-text"',
    accessed: ACCESSED
  }
]

/** A rate slab on a TCS section: the seeded row's rate applies to the buyer's financial-year
 *  aggregate up to `limitPaise`, `aboveRateBp` to the part above it. */
export interface TcsSlab {
  /** tds_sections.code the slab belongs to (the seeded code). */
  sectionCode: string
  effectiveFrom: string
  /** Inclusive; null = open-ended. */
  effectiveTo: string | null
  /** Aggregate (per buyer, per financial year) the lower rate covers, paise. */
  limitPaise: number
  /** Rate on the part of the aggregate above the limit, basis points. */
  aboveRateBp: number
  /** TCS_SOURCES keys. */
  sources: readonly string[]
}

/**
 * s.206C(1G) overseas tour programme package, FY 2025-26: 5 % (the seeded rate row, migration 027)
 * up to ₹10 lakh (= 1,00,00,000 paise) of the buyer's aggregate for the year, 20 % on the excess.
 * From 1 Apr 2026 FA 2026 s.85(f) makes Sl. 8 a flat 2 % — no slab (the seeded 2 % row alone).
 * FY 2024-25 and earlier (₹7 lakh, from 1 Oct 2023 / 2024) are not modelled — see TCS_NOT_MODELLED.
 */
export const TCS_SLABS: readonly TcsSlab[] = [
  {
    sectionCode: '206C(1G) TOUR',
    effectiveFrom: '2025-04-01',
    effectiveTo: '2026-03-31',
    limitPaise: 100000000,
    aboveRateBp: 2000,
    sources: ['FA25-72', 'FA23-94', 'ACT25-394-1', 'S206C-1961']
  }
]

/** One statutory rate row of a section TCS → Sections can add (see services/tcs.ts addStatutoryTcsSections). */
export interface TcsStatutoryRate {
  effectiveFrom: string
  effectiveTo: string | null
  rateBp: number
  /** s.206CC(1) / 2025 s.397(2)(b)(ii): the 5 % floor (the engine also takes twice the rate, max 20 %). */
  noPanRateBp: number
  /** 27EQ section code / Form 143 collection code for the period. */
  returnCode: string
  source: string
}

export interface TcsStatutorySection {
  code: string
  description: string
  nature: string
  legacyCode: string
  newReference: string
  rates: readonly TcsStatutoryRate[]
}

const S1C_1961 = (what: string, code: string): string =>
  `1961 s.206C(1C) Table (${what}) 2% of the amount payable by the licensee / lessee, at debit or receipt whichever is earlier ` +
  `[https://www.incometaxindia.gov.in/w/section-206c-36 — read via a search index, UNVERIFIED verbatim]; kept in s.206C(9) by ` +
  `Finance Act 2025 s.72(e) [https://egazette.gov.in/WriteReadData/2025/262125.pdf]; no PAN s.206CC (5%); 27EQ code ${code} ` +
  `[Protean 27EQ v6.9 Annexure 2]; base incl. GST UNVERIFIED; accessed ${ACCESSED}`
const S1C_2025 = (code: string): string =>
  `2025 Act s.394(1) Table Sl. 9, 2%, licensor or lessor [https://egazette.gov.in/WriteReadData/2025/265620.pdf]; not amended by ` +
  `Finance Act 2026 s.85; no PAN s.397(2)(b)(ii); Form 143 code ${code} [Protean Form 143 22-07-2026 Annexure 2]; accessed ${ACCESSED}`

/**
 * Sections TCS → Sections can add to a company that does not have them (no migration: an owner
 * action through the audited section / rate writes). s.206C(1C) — one section per row of its
 * Table, since the 27EQ / Form 143 codes differ (F / G / H, 1090 / 1091 / 1092).
 */
export const TCS_STATUTORY_SECTIONS: readonly TcsStatutorySection[] = [
  {
    code: '206C(1C) PARKING',
    description: 'Licence / lease of a parking lot for business',
    nature: 'Use of parking lot for the purpose of business (licensee other than a public sector company)',
    legacyCode: '206C(1C)',
    newReference: '394(1) Sl. 9',
    rates: [
      { effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31', rateBp: 200, noPanRateBp: 500, returnCode: 'F', source: S1C_1961('i) Parking lot', 'F') },
      { effectiveFrom: '2026-04-01', effectiveTo: null, rateBp: 200, noPanRateBp: 500, returnCode: '1090', source: S1C_2025('1090') }
    ]
  },
  {
    code: '206C(1C) TOLL',
    description: 'Licence / lease of a toll plaza for business',
    nature: 'Use of toll plaza for the purpose of business (licensee other than a public sector company)',
    legacyCode: '206C(1C)',
    newReference: '394(1) Sl. 9',
    rates: [
      { effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31', rateBp: 200, noPanRateBp: 500, returnCode: 'G', source: S1C_1961('ii) Toll plaza', 'G') },
      { effectiveFrom: '2026-04-01', effectiveTo: null, rateBp: 200, noPanRateBp: 500, returnCode: '1091', source: S1C_2025('1091') }
    ]
  },
  {
    code: '206C(1C) MINE',
    description: 'Licence / lease of a mine or quarry for business',
    nature: 'Use of mine or quarry for the purpose of business, excluding mining and quarrying of mineral oil (including petroleum and natural gas); licensee other than a public sector company',
    legacyCode: '206C(1C)',
    newReference: '394(1) Sl. 9',
    rates: [
      { effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31', rateBp: 200, noPanRateBp: 500, returnCode: 'H', source: S1C_1961('iii) Mining and quarrying', 'H') },
      { effectiveFrom: '2026-04-01', effectiveTo: null, rateBp: 200, noPanRateBp: 500, returnCode: '1092', source: S1C_2025('1092') }
    ]
  }
]

/** What is deliberately not modelled, with the reason (shown on TCS → Sections). */
export const TCS_NOT_MODELLED: readonly { key: string; text: string }[] = [
  {
    key: 'lrs',
    text:
      's.206C(1G)(a) / 2025 Act s.394(1) Sl. 7 — TCS on remittances under the Liberalised Remittance Scheme (₹10 lakh threshold ' +
      'from 1 Apr 2025, 5 % / 2 % for education or medical treatment, nil on an education loan from a s.80E institution, 20 % ' +
      'otherwise; 27EQ codes P / Q / T, Form 143 1086 / 1087). It is collected only by an AUTHORISED DEALER (a bank) when it ' +
      'remits money abroad — never by a business selling goods or services, which is what Total keeps the books of.'
  },
  {
    key: 'tour-before-2025',
    text:
      's.206C(1G) tour packages before 1 Apr 2025 (5 % to 30 Sep 2023, then 20 % from FA 2023 s.94 with the ₹7 lakh slab) — no ' +
      'rate rows are seeded for FY 2024-25 or earlier (as for the rest of WP 3.3): such a sale is refused "no rate in force" ' +
      'unless you add a row or mark the collection manual.'
  },
  {
    key: '1c-before-2025',
    text: 's.206C(1C) before 1 Apr 2025 — the added sections start on 1 Apr 2025; add an earlier row under the section if you need one.'
  },
  {
    key: 'tour-206c-1g-provisos',
    text:
      'The 1G provisos that switch collection off — the seller need not collect where the buyer is liable to deduct TDS on the ' +
      'package, or the Central Government notifies a buyer (Form 143 remark F, s.394(5)) — are judged by you: mark such a sale ' +
      '"Not applicable" with the reason.'
  }
]

/** Points that could not be confirmed in an official text, or readings the law leaves open, with
 *  what the code does about each. Shown on TCS → Sections. */
export const TCS_UNVERIFIED: readonly { key: string; text: string }[] = [
  {
    key: '1961-text',
    text:
      'The 1961 Act\'s own text of s.206C(1C) and of the s.206C(1G) tour-package proviso could not be opened (incometaxindia.gov.in ' +
      'refuses automated reads, HTTP 403). For FY 2025-26: the 1C rate of 2 % is from a search index of that page; the tour slab ' +
      '(5 % up to ₹10 lakh, 20 % above) from FA 2023 s.94 (long line five → twenty), FA 2025 s.72(b) (seven → ten lakh in the ' +
      'first, second and fourth provisos — which proviso carries the tour slab was not read) and the 2025 Act Table Sl. 8, which ' +
      'restates it. From 1 Apr 2026 both are official (2025 Act Sl. 8 / Sl. 9, FA 2026 s.85).'
  },
  {
    key: 'tour-aggregate',
    text:
      'Tour slab: the ₹10 lakh is measured per buyer per financial year over everything recorded under the 206C(1G) TOUR section ' +
      '(the same aggregate the section\'s threshold uses — sales and advances, first of debit or receipt), base incl. GST as the ' +
      'seeded row says. One collection that crosses ₹10 lakh is computed in two parts (5 % below, 20 % above) and rounded to the ' +
      'rupee once. Without a PAN each part takes the higher of twice its rate and 5 %, at most 20 % (s.206CC).'
  },
  {
    key: 'tour-user-row',
    text:
      'The slab applies only while the rate row in force is a cited (seeded) one: a row you add yourself (no source) is taken as ' +
      'it stands, so a hand-made 20 % row keeps working as before. The FY 2025-26 row\'s own source text still says "collect it ' +
      'manually" — the slab now does it.'
  },
  {
    key: 'tour-certificate',
    text:
      'A lower-collection certificate is a s.206C(9) one, which (FA 2025 s.72(e)) covers sub-sections (1) and (1C) only — not ' +
      '(1G). Total still applies a certificate you record against the tour section (its cap first, the slab on the rest).'
  },
  {
    key: 'tour-27eq-split',
    text:
      'Form 27EQ has one rate per collectee row, and code O covers both slabs. A collection that crosses ₹10 lakh is exported as ' +
      'two rows of the same entry (the part at 5 %, the part at 20 %, flagged in the Note column); a collection wholly above the ' +
      'limit carries 20 %. Whether TRACES expects this split is not verified.'
  },
  {
    key: 'tour-1089',
    text:
      'The Form 143 file format (22-07-2026) still lists code 1089 "above threshold limit" (Sl. 8.D(b)), though FA 2026 s.85(f) ' +
      'replaced clauses (a) and (b) with a flat 2 % from 1 Apr 2026. Total keeps exporting 1088 for every 2026-27 tour collection.'
  },
  {
    key: '1c-gst',
    text:
      's.206C(1C) base: "the amount payable by the licensee or lessee" — whether that includes the GST on the licence fee is not ' +
      'settled by any circular found; the added rows include GST (as every WP 3.3 TCS row does — collecting on the larger figure ' +
      'is recoverable, short collection is a default). Edit the row if your CA reads it otherwise.'
  },
  {
    key: '1c-psu',
    text:
      's.206C(1C) does not apply where the licensee / lessee is a public sector company (s.402(21) / the 1961 definition), nor to ' +
      'mining or quarrying of mineral oil (petroleum, natural gas). Total does not know which buyers are PSUs: mark such a bill ' +
      '"Not applicable" with the reason.'
  },
  {
    key: '1c-declaration',
    text:
      'The Form 27C / Form 127 declaration (s.206C(1A) / s.394(2)) is for the goods of Sl. 1–5 only; a "Not applicable" mark on a ' +
      '1C or 1G sale is reported without remark B only when its reason does not read as such a declaration.'
  }
]
