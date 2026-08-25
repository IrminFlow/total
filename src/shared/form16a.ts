/**
 * Form 16A — the deduction certificate for a vendor (roadmap #361).
 *
 * Sibling of the payroll Form 16 (#171): same data, different party. Where Form 16 tells an
 * employee what came off their salary, Form 16A tells a contractor, a landlord or a professional
 * what came off their bill — and without it they cannot reconcile their 26AS, which means they
 * chase the deductor's accounts department instead.
 *
 * ---------------------------------------------------------------------------------------------
 * THE HONEST PART, WHICH IS ALSO THE IMPORTANT PART.
 *
 * A deductor may not hand-make a Form 16A. Since the CBDT circulars of 2011 and 2012 the
 * certificate has to be DOWNLOADED FROM TRACES, generated from the quarterly statement actually
 * filed, carrying a TRACES certificate number and a verification the recipient can check. A
 * document produced by an accounting package is not that, whatever it looks like.
 *
 * So what this builds is a WORKING COPY, and it says so on its face: the figures the certificate
 * will carry once the statement is filed, in the layout of the form, for checking against TRACES
 * and for answering the vendor who is asking today. It carries no certificate number, and the
 * space where TRACES puts one is filled with a sentence explaining why.
 *
 * That is not a limitation to design around. A deductor who sends this instead of the TRACES
 * certificate has given their vendor something the vendor cannot use, and the app should say so
 * rather than let them find out.
 *
 * CHECKED AGAINST (August 2026):
 *   - Rule 31(1)(b) and 31(3), Income-tax Rules 1962: Form 16A, issued quarterly, within fifteen
 *     days of the due date for furnishing the quarterly statement. `form16aDueDate` in
 *     tdsReturn.ts computes that date.
 *   - Section 203, Income-tax Act 1961 — the obligation to furnish a certificate. From
 *     1 April 2026 this is an Income-tax Act 2025 obligation and the section reference on the
 *     certificate changes with it; see itAct2025.ts, which is where the dated number comes from.
 */

export interface Form16aDeduction {
  /** Section reference as it should be printed for this payment's date (see itAct2025.ts). */
  sectionCode: string
  sectionUnverified: boolean
  /** Date the amount was paid or credited. */
  paidOn: string
  amountPaid: number
  tds: number
  /** Rate applied, percent. 20% where section 206AA bit. */
  rate: number
  voucherNumber: string
  /** The challan the tax was paid under, or null while unlinked. */
  challan: { bsrCode: string; paidOn: string; serial: string } | null
}

export interface Form16a {
  deducteeLedgerId: number
  deducteeName: string
  deducteePan: string | null
  deductorName: string
  deductorTan: string | null
  deductorPan: string | null
  fyStartYear: number
  fyLabel: string
  ayLabel: string
  quarter: 1 | 2 | 3 | 4
  quarterLabel: string
  from: string
  to: string
  /** When the certificate should have been issued by — rule 31(3). */
  dueDate: string
  deductions: Form16aDeduction[]
  /** Section-wise summary, which is the face of the certificate. */
  bySection: { sectionCode: string; amountPaid: number; tds: number; unverified: boolean }[]
  totalPaid: number
  totalTds: number
  /**
   * Everything that makes this copy not-yet-true, in the order it has to be fixed.
   *
   * Always non-empty in practice, because the first entry is always the TRACES point.
   */
  warnings: string[]
}

export interface Form16aInput {
  deducteeLedgerId: number
  deducteeName: string
  deducteePan: string | null
  deductorName: string
  deductorTan: string | null
  deductorPan: string | null
  fyStartYear: number
  quarter: 1 | 2 | 3 | 4
  from: string
  to: string
  dueDate: string
  deductions: Form16aDeduction[]
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/

/**
 * Assemble the certificate.
 *
 * Throws on no deductions rather than producing an empty certificate: a Form 16A for a quarter in
 * which nothing was deducted is not a nil certificate, it is a document that should not exist,
 * and issuing one tells a vendor to look for a credit that is not there.
 */
export function buildForm16a(input: Form16aInput): Form16a {
  if (input.deductions.length === 0) {
    throw new Error(`No TDS deducted from ${input.deducteeName} in this quarter — there is no certificate to issue`)
  }

  const bySection = new Map<string, { sectionCode: string; amountPaid: number; tds: number; unverified: boolean }>()
  for (const d of input.deductions) {
    const s = bySection.get(d.sectionCode) ?? { sectionCode: d.sectionCode, amountPaid: 0, tds: 0, unverified: false }
    s.amountPaid += d.amountPaid
    s.tds += d.tds
    s.unverified = s.unverified || d.sectionUnverified
    bySection.set(d.sectionCode, s)
  }

  const totalPaid = input.deductions.reduce((s, d) => s + d.amountPaid, 0)
  const totalTds = input.deductions.reduce((s, d) => s + d.tds, 0)

  const warnings: string[] = [
    'This is a working copy, not the certificate. Form 16A has to be downloaded from TRACES after the quarterly ' +
      'statement is filed — only that one carries a certificate number the vendor can verify.'
  ]
  if (!input.deductorTan) {
    warnings.push('The company has no TAN on record. A deduction certificate is issued against a TAN.')
  }
  if (!input.deducteePan || !PAN_RE.test(input.deducteePan)) {
    warnings.push(
      `No valid PAN on record for ${input.deducteeName}. Without it the deduction cannot reach their 26AS at all, ` +
        'and section 206AA has already forced the higher rate.'
    )
  }
  const unlinked = input.deductions.filter((d) => !d.challan).length
  if (unlinked > 0) {
    warnings.push(
      `${unlinked} of these deductions are not linked to a challan, so the certificate cannot show how the tax was ` +
        'paid. Record the challans before the quarterly statement.'
    )
  }
  if ([...bySection.values()].some((s) => s.unverified)) {
    warnings.push(
      'One or more section references are proposed Income-tax Act 2025 numbers that nobody has verified. Confirm ' +
        'them on the TDS section master before this goes to a vendor.'
    )
  }

  const quarterLabel = `Q${input.quarter}`
  return {
    deducteeLedgerId: input.deducteeLedgerId,
    deducteeName: input.deducteeName,
    deducteePan: input.deducteePan,
    deductorName: input.deductorName,
    deductorTan: input.deductorTan,
    deductorPan: input.deductorPan,
    fyStartYear: input.fyStartYear,
    fyLabel: `FY ${input.fyStartYear}-${String(input.fyStartYear + 1).slice(2)}`,
    ayLabel: `AY ${input.fyStartYear + 1}-${String(input.fyStartYear + 2).slice(2)}`,
    quarter: input.quarter,
    quarterLabel,
    from: input.from,
    to: input.to,
    dueDate: input.dueDate,
    deductions: [...input.deductions].sort((a, b) => a.paidOn.localeCompare(b.paidOn)),
    bySection: [...bySection.values()].sort((a, b) => a.sectionCode.localeCompare(b.sectionCode)),
    totalPaid,
    totalTds,
    warnings
  }
}
