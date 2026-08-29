/**
 * GSTR-9 working papers: the year's books beside the year's returns.
 *
 * GSTR-9 is not a return you compute so much as one you reconcile. The portal auto-populates it
 * from the GSTR-1s and GSTR-3Bs already filed; what a business (or its accountant) actually needs
 * before signing is the answer to one question — do the books for the year agree with what was
 * filed month by month, and if not, where.
 *
 * So this is deliberately a comparison rather than a return builder. It does not emit portal
 * JSON: GSTR-9 has no offline utility worth targeting, the tables are heavily judgement-driven
 * (Table 8's ITC reconciliation, Table 10-13's amendments), and a filled-in annual return
 * generated from books alone would be a confident answer to a question that requires a human.
 *
 * What it does give is every figure that CAN be computed, with its source named, so the person
 * filling the portal form is transcribing rather than deriving.
 */

/** One line of the working papers: what the books say, what was filed, and the gap. */
export interface Gstr9Line {
  /** GSTR-9 table this feeds, e.g. '4A' or '6B'. */
  table: string
  label: string
  /** Computed from the year's vouchers. */
  perBooks: number
  /**
   * The same figure as filed, when it can be known. Null where nothing filed carries it — an
   * honest gap rather than a zero that would read as "filed nil".
   */
  perReturns: number | null
  /** perBooks − perReturns, or null when there is nothing to compare against. */
  difference: number | null
}

export interface Gstr9Section {
  key: 'outward' | 'itc' | 'tax'
  title: string
  note: string
  lines: Gstr9Line[]
}

export interface Gstr9Working {
  financialYear: string
  sections: Gstr9Section[]
  /** Months in the year with no GSTR-3B recorded as filed — the first thing to fix. */
  unfiledMonths: string[]
  /** True when every comparable line agrees to the rupee. */
  reconciled: boolean
}

export interface Gstr9Inputs {
  financialYear: string
  /** Summed over the year's outward extractions. */
  outward: {
    b2bTaxable: number
    b2cTaxable: number
    exportTaxable: number
    nilExemptTaxable: number
    creditNoteTaxable: number
    debitNoteTaxable: number
    igst: number
    cgst: number
    sgst: number
    cess: number
  }
  /** Summed over the year's ITC. */
  itc: { igst: number; cgst: number; sgst: number; cess: number; blocked: number }
  /** Reverse-charge inward liability for the year. */
  rcm: { igst: number; cgst: number; sgst: number; cess: number }
  /** Tax recorded as paid on the filing register, and which months have no 3B filed. */
  filed: { taxPaid: number | null; unfiledMonths: string[] }
}

const line = (table: string, label: string, perBooks: number, perReturns: number | null = null): Gstr9Line => ({
  table,
  label,
  perBooks,
  perReturns,
  difference: perReturns === null ? null : perBooks - perReturns
})

/**
 * Assemble the working papers.
 *
 * Pure, so the tables are testable without a database and the same figures can be produced from a
 * consolidated set of books later without touching this.
 */
export function buildGstr9(inputs: Gstr9Inputs): Gstr9Working {
  const { outward, itc, rcm, filed } = inputs

  const outwardTax = outward.igst + outward.cgst + outward.sgst + outward.cess
  const rcmTax = rcm.igst + rcm.cgst + rcm.sgst + rcm.cess
  const itcTotal = itc.igst + itc.cgst + itc.sgst + itc.cess

  const sections: Gstr9Section[] = [
    {
      key: 'outward',
      title: 'Table 4 & 5 — outward supplies',
      note: 'Taxable value by type, summed over the year from the same extraction GSTR-1 uses.',
      lines: [
        line('4B', 'Supplies to registered persons (B2B)', outward.b2bTaxable),
        line('4A', 'Supplies to unregistered persons (B2C)', outward.b2cTaxable),
        line('4C', 'Exports and zero-rated supplies', outward.exportTaxable),
        line('4I', 'Credit notes issued', outward.creditNoteTaxable),
        line('4J', 'Debit notes issued', outward.debitNoteTaxable),
        line('5D', 'Nil-rated and exempt supplies', outward.nilExemptTaxable),
        line('4N', 'Tax on outward supplies', outwardTax),
        line('4G', 'Inward supplies liable to reverse charge', rcmTax)
      ]
    },
    {
      key: 'itc',
      title: 'Table 6 — input tax credit availed',
      note: 'From purchases in the books. Table 8 reconciles this against GSTR-2A/2B, which is a separate exercise.',
      lines: [
        line('6B', 'ITC on inward supplies — IGST', itc.igst),
        line('6B', 'ITC on inward supplies — CGST', itc.cgst),
        line('6B', 'ITC on inward supplies — SGST', itc.sgst),
        line('6B', 'ITC on inward supplies — cess', itc.cess),
        line('7', 'Ineligible ITC, not availed', itc.blocked),
        line('6O', 'Total ITC availed', itcTotal)
      ]
    },
    {
      key: 'tax',
      title: 'Table 9 — tax paid',
      note:
        filed.taxPaid === null
          ? 'Nothing recorded on the filing register, so there is nothing to compare against yet.'
          : 'Books against what the filing register says was actually paid.',
      lines: [
        line('9', 'Tax payable on outward supplies and reverse charge', outwardTax + rcmTax, filed.taxPaid)
      ]
    }
  ]

  const comparable = sections.flatMap((s) => s.lines).filter((l) => l.difference !== null)
  return {
    financialYear: inputs.financialYear,
    sections,
    unfiledMonths: filed.unfiledMonths,
    // Reconciled means every comparable line agrees AND nothing is unfiled. A year with three
    // months missing is not reconciled however well the filed months tie out.
    reconciled: comparable.every((l) => l.difference === 0) && filed.unfiledMonths.length === 0
  }
}
