/**
 * Statutory text behind the fixed-asset events added after WP 3.6 (partial disposals, GST on the
 * sale of a capital good, the rule 25(2) 40 % cap, extra-shift depreciation, component lives) —
 * quoted, with where it was read and when. "Tax rules are never written from memory": every
 * number the code uses for these events points at a key here, and anything that could not be read
 * in an official (or faithful) copy is in FIXED_ASSET_UNVERIFIED below.
 *
 * The WP 3.6 sources themselves (Schedule II Part C lives, Appendix I rates, s.32 / s.33) stay
 * with migration 026's seeds and FIXED_ASSET_SOURCES in ./fixedAssets.ts.
 */

export interface FixedAssetSource {
  key: string
  title: string
  /** The words relied on, quoted exactly as read (line breaks of the copy removed). */
  quote: string
  url: string
  /** Where the text was read, when it was not the official site itself. */
  readIn?: string
  accessed: string
}

export const FIXED_ASSET_EVENT_SOURCES: readonly FixedAssetSource[] = [
  {
    key: 'SCH2-N2',
    title: 'Companies Act, 2013 — Schedule II, Notes after Part C, para 2 (pro rata up to the date of sale)',
    quote:
      'Where, during any financial year, any addition has been made to any asset, or where any asset has been sold, discarded, ' +
      'demolished or destroyed, the depreciation on such assets shall be calculated on a pro rata basis from the date of such ' +
      'addition or, as the case may be, up to the date on which such asset has been sold, discarded, demolished or destroyed.',
    url: 'https://www.mca.gov.in/content/mca/global/en/acts-rules/ebooks/acts.html',
    readIn: 'MCA e-book text of Schedule II Part C ("Source: mca.gov.in"), https://oss-data-in.vaquill.ai/legislation/REG_MCA_mcaacts28232scheduleiiusefullivestocompu/act.pdf',
    accessed: '2026-10-17'
  },
  {
    key: 'SCH2-N4',
    title: 'Companies Act, 2013 — Schedule II, Notes after Part C, para 4 (significant parts / component lives)',
    quote:
      '4(a) Useful life specified in Part C of the Schedule is for whole of the asset. Where cost of a part of the asset is ' +
      'significant to total cost of the asset and useful life of that part is different from the useful life of the remaining ' +
      'asset, useful life of that significant part shall be determined separately. (b) The requirement under sub-paragraph (a) ' +
      'shall be voluntary in respect of the financial year commencing on or after the 1st April, 2014 and mandatory for financial ' +
      'statements in respect of financial years commencing on or after the 1st April, 2015',
    url: 'https://www.mca.gov.in/content/mca/global/en/acts-rules/ebooks/acts.html',
    readIn: 'MCA e-book text of Schedule II Part C, as substituted by the notification of 29 August 2014 (same copy as SCH2-N2)',
    accessed: '2026-10-17'
  },
  {
    key: 'SCH2-N6',
    title: 'Companies Act, 2013 — Schedule II, Notes after Part C, para 6 (extra-shift depreciation)',
    quote:
      'The useful lives of assets working on shift basis have been specified in the Schedule based on their single shift working. ' +
      'Except for assets in respect of which no extra shift depreciation is permitted (indicated by NESD in Part C above), if an ' +
      'asset is used for any time during the year for double shift, the depreciation will increase by 50% for that period and in ' +
      'case of the triple shift the depreciation shall be calculated on the basis of 100% for that period.',
    url: 'https://www.mca.gov.in/content/mca/global/en/acts-rules/ebooks/acts.html',
    readIn: 'MCA e-book text of Schedule II Part C (same copy as SCH2-N2); NESD marks read from the same Part C table',
    accessed: '2026-10-17'
  },
  {
    key: 'IT61-S50',
    title: 'Income-tax Act, 1961 — s.50 (capital gains on depreciable assets; block of assets)',
    quote:
      'where the capital asset is an asset forming part of a block of assets in respect of which depreciation has been allowed ' +
      'under this Act … where the full value of the consideration received or accruing as a result of the transfer of the asset ' +
      'together with the full value of such consideration received or accruing as a result of the transfer of any other capital ' +
      'asset falling within the block of the assets during the previous year, exceeds the aggregate of [expenditure on the ' +
      'transfer, the opening WDV of the block and the actual cost of assets acquired in the year], such excess shall be deemed ' +
      'to be the capital gains arising from the transfer of short-term capital assets',
    url: 'https://www.incometaxindia.gov.in/w/section-50-62',
    readIn: 'incometaxindia.gov.in section page as returned by a web search (bracketed words summarise clauses (i)–(iii)); not opened directly',
    accessed: '2026-10-17'
  },
  {
    key: 'IT25-S41',
    title: 'Income-tax Act, 2025 — s.41(1)(c) (WDV of a block: moneys payable reduce it)',
    quote:
      '(c) in case of block of assets, the written down value computed in the following manner: [(A-D) + B-C]-E, where … ' +
      'C = moneys payable together with scrap value, if any, in respect of any asset falling within the block, which is sold, ' +
      'transferred, demolished, destroyed or discarded during the tax year, where "C" shall not exceed (A-D)+B;',
    url: 'https://prsindia.org/files/bills_acts/bills_parliament/2025/Bill_as_passed_by_LS_Income_Tax_(No.2)_Bill.pdf',
    readIn: 'Income-tax (No.2) Bill, 2025 as passed by Lok Sabha (the copy migration 026 cites as [IT25])',
    accessed: '2026-10-17'
  },
  {
    key: 'IT25-S74',
    title: 'Income-tax Act, 2025 — s.74(2)-(3) (capital gains on depreciable assets of a block)',
    quote:
      '(2) If, during the tax year, the full value of consideration received or accruing for the transfer of one or more assets in ' +
      'a block of assets exceeds the total of the following:–– (a) expenditure incurred wholly and exclusively in connection with ' +
      'such transfer; (b) the written down value of the block of assets at the start of the tax year; and (c) the actual cost of ' +
      'any asset falling within the block of assets acquired during the tax year, such excess shall be deemed to be capital gains ' +
      'arising from the transfer of short-term capital assets.',
    url: 'https://prsindia.org/files/bills_acts/bills_parliament/2025/Bill_as_passed_by_LS_Income_Tax_(No.2)_Bill.pdf',
    readIn: 'Income-tax (No.2) Bill, 2025 as passed by Lok Sabha',
    accessed: '2026-10-17'
  }
]

/** Points that could not be confirmed in an official text, or readings the law leaves open. Shown
 *  in Fixed assets → Groups & blocks and in docs; keep the code's behaviour next to each. */
export const FIXED_ASSET_UNVERIFIED: readonly { key: string; text: string }[] = [
  {
    key: 'part-split',
    text:
      'Partial disposal: the part sold is split off as its own register record carrying the same share (quantity sold ÷ quantity ' +
      'held) of the cost, every addition, the opening accumulated depreciation and every depreciation line booked so far, each ' +
      'share rounded half away from zero to the paisa and the remainder left on the asset. A proportionate split is the usual ' +
      'reading of Sch II Note 2 / AS 10 derecognition for identical units; a part of different value (one machine of a set) needs ' +
      'its cost as the share.'
  },
  {
    key: 'part-undo',
    text: 'Binning a partial disposal\'s journal reinstates the part as its own record next to the remainder — the split itself is not undone (the totals are the same).'
  },
  {
    key: 's50-text',
    text: 'Income-tax Act, 1961 s.50 was read through the department\'s section page in a search result, not opened directly, and s.43(6)(c) (moneys payable reduce the block, FY 2025-26 and earlier) was not re-read — the block computation is WP 3.6\'s; the 2025 Act s.41(1)(c) / s.74 text is from the Bill as passed by Lok Sabha.'
  }
]
