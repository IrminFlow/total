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
    key: 'CGST-S18-6',
    title: 'CGST Act, 2017 — s.18(6) (supply of capital goods on which input tax credit was taken)',
    quote:
      'In case of supply of capital goods or plant and machinery, on which input tax credit has been taken, the registered person ' +
      'shall pay an amount equal to the input tax credit taken on the said capital goods or plant and machinery reduced by such ' +
      'percentage points as may be prescribed or the tax on the transaction value of such capital goods or plant and machinery ' +
      'determined under section 15, whichever is higher: Provided that where refractory bricks, moulds and dies, jigs and fixtures ' +
      'are supplied as scrap, the taxable person may pay tax on the transaction value of such goods determined under section 15.',
    url: 'https://cbic-gst.gov.in/hindi/CGST-bill-e.html',
    readIn: 'CBIC GST site, CGST Act text page',
    accessed: '2026-10-17'
  },
  {
    key: 'CGST-R40-2',
    title: 'CGST Rules, 2017 — rule 40(2) (percentage points for s.18(6))',
    quote:
      'The amount of credit in the case of supply of capital goods or plant and machinery, for the purposes of sub-section (6) of ' +
      'section 18, shall be calculated by reducing the input tax on the said goods at the rate of five percentage points for every ' +
      'quarter or part thereof from the date of the issue of the invoice for such goods.',
    url: 'https://cbic-gst.gov.in/gst-acts.html',
    readIn: 'gstzen.in reproduction of rule 40 (as substituted by Notification 22/2017-CT), https://gstzen.in/a/manner-of-claiming-credit-in-special-circumstances-cgst-rule-40.html — the CBIC text itself was not opened',
    accessed: '2026-10-17'
  },
  {
    key: 'CGST-R44-6',
    title: 'CGST Rules, 2017 — rule 44(6) with 44(1)(b) (credit for s.18(6) on capital goods; excess is output tax)',
    quote:
      '(6) The amount of input tax credit for the purposes of sub-section (6) of section 18 relating to capital goods shall be ' +
      'determined in the same manner as specified in clause (b) of sub-rule (1) and the amount shall be determined separately for ' +
      'input tax credit of central tax, State tax, Union territory tax and integrated tax: Provided that where the amount so ' +
      'determined is more than the tax determined on the transaction value of the capital goods, the amount determined shall form ' +
      'part of the output tax liability and the same shall be furnished in FORM GSTR-1. — (1)(b): for capital goods held in stock, ' +
      'the input tax credit involved in the remaining useful life in months shall be computed on pro-rata basis, taking the useful ' +
      'life as five years.',
    url: 'https://cbic-gst.gov.in/gst-acts.html',
    readIn: 'gstzen.in reproduction of rule 44 (sub-rule (6) as substituted by Notification 15/2017-CT), https://gstzen.in/a/manner-of-reversal-of-credit-under-special-circumstances-cgst-rule-44.html — the CBIC text itself was not opened',
    accessed: '2026-10-17'
  },
  {
    key: 'R2026-R25-2',
    title: 'Income-tax Rules, 2026 — rule 25(2) (40% cap on block depreciation for the concessional regimes)',
    quote:
      '(2) The allowance under section 33(3) in respect of depreciation of any block of assets with respect to the persons mentioned ' +
      'in Column B of the following Table shall not exceed 40% of the written down value of such block of assets, if conditions ' +
      'mentioned in column C thereof are fulfilled:— 1. Domestic company — Which has exercised option under– (a) section 199(3); or ' +
      '(b) section 200(5); or (c) section 201(2). 2. (a) Individual or Hindu undivided family; or (b) association of persons or a ' +
      'body of individuals, whether incorporated or not; or (c) artificial juridical person referred to in section 2(77)(g). — ' +
      'Whose income is chargeable to tax under section 202(1). 3. Cooperative society resident in India — Which has exercised ' +
      'option under– (a) section 203(5); or (b) section 204(2).',
    url: 'https://simpliance.in/download/file/dXBsb2Fkcy9nb3Z0bm90aWZpY2F0aW9uL1RoZSBJbmNvbWUtdGF4IFJ1bGVzLCAyMDI2LnBkZg==',
    readIn: 'Gazette of India, G.S.R. 198(E) of 20 March 2026 (scan, p. 1552–1553), the copy migration 026 cites as [R2026]',
    accessed: '2026-10-17'
  },
  {
    key: 'IT25-S202',
    title: 'Income-tax Act, 2025 — s.202(2)(a)(vi) (new regime: no deduction under s.33(8), additional depreciation)',
    quote: '(2) For the purposes of sub-section (1), the total income of the assessee shall be computed— (a) without any exemption or deduction under–– … (vi) section 33(8);',
    url: 'https://prsindia.org/files/bills_acts/bills_parliament/2025/Bill_as_passed_by_LS_Income_Tax_(No.2)_Bill.pdf',
    readIn: 'Income-tax (No.2) Bill, 2025 as passed by Lok Sabha',
    accessed: '2026-10-17'
  },
  {
    key: 'IT25-S205',
    title: 'Income-tax Act, 2025 — s.205(1)(a) (company / co-operative regimes: no deduction under s.33(8))',
    quote:
      '205. (1) For the purposes of sections 199(1)(c)(i)(C), 200(1)(a)(iii), 201(3)(a)(iii), 203(1)(a)(ii) and 204(3)(a)(ii), the ' +
      'total income shall be computed without any deduction or exemption, under the following provisions:–– (a) section 33(8), ' +
      'determined in such manner, as may be prescribed;',
    url: 'https://prsindia.org/files/bills_acts/bills_parliament/2025/Bill_as_passed_by_LS_Income_Tax_(No.2)_Bill.pdf',
    readIn: 'Income-tax (No.2) Bill, 2025 as passed by Lok Sabha',
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
    key: 'cg-two-rules',
    text:
      'Rule 40(2) (five points per quarter) and rule 44(6) (remaining months of a five-year life) both prescribe the s.18(6) ' +
      'credit and give different figures; practitioners disagree which governs. Total computes both and uses the HIGHER, so it ' +
      'never pays less than either rule asks.'
  },
  {
    key: 'cg-quarters',
    text: 'Quarters "or part thereof" are counted as three-month periods from the invoice date (not calendar quarters); a sale on the invoice date is in the first quarter.'
  },
  {
    key: 'cg-months',
    text: 'Rule 44(1)(b) "remaining useful life in months": months used are counted in whole months from the invoice date (a part month is not counted as used).'
  },
  {
    key: 'cg-compare',
    text:
      '"Whichever is higher" is compared on the GST total (CGST + SGST + IGST), cess on its own. The extra output tax is paid under ' +
      'the sale\'s own heads (CGST + SGST within the State, the odd paisa to CGST; IGST between States), whatever heads the credit was taken in.'
  },
  {
    key: 'cg-where',
    text:
      'Rule 44(6) puts the extra amount in the output tax liability and says to furnish it in GSTR-1 without naming a table. Total ' +
      'posts it as output tax (Dr "GST on Sale of Capital Goods (s.18(6))", Cr Output GST) in the disposal journal and adds it to ' +
      'GSTR-3B 3.1(a) tax (taxable value 0); the GSTR-1 export and GSTR-9 show only the invoice — enter the extra on the portal as ' +
      'your CA advises. It is not an ITC reversal, so it is not in 3B 4(B)(1).'
  },
  {
    key: 'cg-itc',
    text:
      'Credit taken defaults to the input-tax lines of the asset\'s purchase voucher in the share the asset\'s cost bears to the ' +
      'voucher\'s fixed-asset lines (a part: its share). Credit on later additions / improvements is not counted — enter the credit ' +
      'by hand when it differs.'
  },
  {
    key: 'cg-hsn',
    text: 'The invoice credits one "Sale of Fixed Assets" account (no GST rate or HSN of its own — the rate is read back from the posted tax), so GSTR-1\'s HSN summary flags it until an HSN is set on that account.'
  },
  {
    key: 'r25-1961',
    text:
      'Rule 25(2) is applied to 2025-Act years (FY 2026-27 on) only. The 1961 Act\'s equivalent for s.115BAA / 115BAB / 115BAC ' +
      'taxpayers (FY 2025-26 and earlier) was not re-read, so the "concessional regime" switch changes nothing for those years ' +
      '(the seeded 1961 rates are 40% at most anyway).'
  },
  {
    key: 'r25-regime',
    text:
      'The switch applies to every 2025-Act year of the carried-forward chain; the regime is the taxpayer\'s own (and, for a ' +
      'company, a once-for-all) choice. Under it, additional depreciation — including any half brought forward — is shown as nil ' +
      '(s.202(2)(a)(vi) / s.205(1)(a) read as covering each row of the rule 25(2) Table); s.205(1)(a)\'s "determined in such manner, ' +
      'as may be prescribed" was not followed into the rules.'
  },
  {
    key: 'shift-formula',
    text:
      'Extra shift: the period\'s single-shift charge × (½ × double-shift days + 1 × triple-shift days) ÷ the days depreciated in ' +
      'the period, one rounding. Where cost layers start on different days the single-shift charge per day is not uniform and ' +
      'the formula averages it over the period. SLM keeps its yearly charge, so an asset worked in shifts reaches its residual ' +
      'value before the end of its life and then stops. The days are given per run (kept in the run\'s audit row and narration, ' +
      'no column); a disposal\'s catch-up is single shift.'
  },
  {
    key: 'shift-user-class',
    text: 'NESD is checked for the seeded Schedule II classes only (of those, only general plant and machinery IV(i)(a) allows extra shift). A class you add, or a group without a class, is not checked — Part C\'s NESD marks decide.'
  },
  {
    key: 's50-text',
    text: 'Income-tax Act, 1961 s.50 was read through the department\'s section page in a search result, not opened directly, and s.43(6)(c) (moneys payable reduce the block, FY 2025-26 and earlier) was not re-read — the block computation is WP 3.6\'s; the 2025 Act s.41(1)(c) / s.74 text is from the Bill as passed by Lok Sabha.'
  }
]
