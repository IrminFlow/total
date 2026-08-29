/**
 * TDS lower-deduction certificates — section 197 / Rule 28AA (roadmap D-109).
 *
 * A payee who expects their final tax liability to be lower than the ordinary TDS on their
 * receipts applies to the Assessing Officer under **section 197**; the AO issues a certificate
 * (Form 13 application, certificate generated on TRACES) directing the *payer* to deduct at a
 * lower rate, or at nil. **Section 197A** (Forms 15G/15H) is the self-declaration route to the
 * same place for certain payees — modelled here as an ordinary certificate whose rate is 0.
 *
 * The part that is routinely got wrong: **Rule 28AA(4)** requires the certificate to name the
 * *amount* on which the lower rate applies, and the certificate is valid only up to that amount
 * ("the ceiling"). Once cumulative payments to that payee under that section cross it, the
 * certificate stops applying and the ordinary section rate resumes — including *within* the very
 * payment that crosses it. A single payment straddling the ceiling is therefore deducted at two
 * rates, and reported in the quarterly statement as two deductee rows.
 *
 * Rule 28AA(1) also fixes the certificate to a single section and a validity window
 * (Rule 28AA(5): a certificate is valid for the financial year named on it unless cancelled),
 * so both the section and the date have to agree before it applies at all.
 *
 * Checked against the Income-tax Act s.197/197A and Income-tax Rules 28AA/28AB as in force on
 * 2026-08-25. Rates and ceilings are per-certificate data issued by the AO, never constants
 * here — nothing in this file needs to change when the department changes a section rate.
 *
 * Pure: rounding and rate application go through `computeTds` in ../tds so there is exactly one
 * rounding convention in the TDS engine (nearest whole rupee, as filed).
 */
import { computeTds } from '../tds'

export interface LowerDeductionCertificate {
  /** The AO's certificate number, as printed (TRACES format). Reported in the 26Q/27Q line. */
  certificateNumber: string
  /** The payee's PAN. A certificate cannot exist without one — see Rule 28AA(2). */
  pan: string
  /**
   * The section the certificate covers, e.g. '194C', '194J'. A 194J certificate does nothing for
   * a 194C payment to the same payee.
   */
  sectionId: string
  /** The lower rate the AO has directed, whole or fractional percent. 0 = nil deduction. */
  ratePercent: number
  /** ISO 'YYYY-MM-DD', inclusive. */
  validFrom: string
  /** ISO 'YYYY-MM-DD', inclusive. */
  validTo: string
  /**
   * The amount (of payment/credit, NOT of tax) up to which the lower rate applies, in paise.
   *
   * `null` means uncapped — the AO named no amount — which is emphatically NOT the same as `0`.
   * A zero ceiling is an exhausted certificate: nothing may be deducted at the lower rate. If
   * these two collapse into each other, an uncapped nil certificate silently starts deducting at
   * the full rate, or a spent one silently stops.
   */
  ceilingPaise: number | null
}

/** Case/whitespace-insensitive comparison for PANs and section codes as typed by humans. */
function norm(s: string): string {
  return s.trim().toUpperCase()
}

/**
 * The certificate in force for this payee, section and date, or null.
 *
 * The ceiling is deliberately NOT consulted: this function cannot know cumulative payments, and
 * an exhausted certificate is still the certificate in force (it still supplies the certificate
 * number the quarterly statement has to quote for the part deducted under it). Exhaustion is
 * decided in `deductionWithCertificate`, which is given the cumulative figure.
 *
 * **Overlapping certificates.** In practice a payee gets a revised certificate mid-year and the
 * old one is not always cancelled, so windows overlap. The rule here, in order:
 *   1. the latest `validFrom` wins — a later certificate supersedes an earlier one;
 *   2. on a tie, the HIGHER rate wins. Under-deduction is the deductor's own liability under
 *      s.201(1) plus interest under s.201(1A), whereas over-deduction is merely refundable to
 *      the payee on their return. Faced with two equally-current certificates, the deductor is
 *      the one carrying the risk, so we resolve toward more tax, not less;
 *   3. on a further tie, the lexically-first certificate number, purely so the answer is
 *      deterministic rather than dependent on array order.
 */
export function applicableCertificate(
  certs: LowerDeductionCertificate[],
  query: { pan: string; sectionId: string; date: string }
): LowerDeductionCertificate | null {
  const pan = norm(query.pan)
  const sectionId = norm(query.sectionId)
  const inForce = certs.filter(
    (c) =>
      norm(c.pan) === pan &&
      norm(c.sectionId) === sectionId &&
      c.validFrom <= query.date &&
      query.date <= c.validTo
  )
  if (inForce.length === 0) return null
  return inForce.reduce((best, c) => {
    if (c.validFrom !== best.validFrom) return c.validFrom > best.validFrom ? c : best
    if (c.ratePercent !== best.ratePercent) return c.ratePercent > best.ratePercent ? c : best
    return c.certificateNumber < best.certificateNumber ? c : best
  })
}

/** One rate actually applied to part of the payment — a deductee row in the quarterly statement. */
export interface AppliedRate {
  ratePercent: number
  /** Portion of the payment this rate was applied to, paise. */
  basePaise: number
  /** Tax on that portion, paise, rounded to the rupee. */
  tdsPaise: number
  /** True for the portion covered by the section 197 certificate. */
  underCertificate: boolean
}

export interface DeductionWithCertificateInput {
  /** The payment/credit being made now, in paise. */
  amountPaise: number
  /** The ordinary section rate that would apply with no certificate, percent. */
  normalRatePercent: number
  /** The certificate in force (from `applicableCertificate`), or null. Validity is NOT rechecked. */
  certificate: LowerDeductionCertificate | null
  /**
   * Cumulative payments already made to this payee under THIS certificate, in paise, excluding
   * the payment being computed. Payments, not tax: the Rule 28AA ceiling is an amount of income.
   */
  alreadyPaidUnderCertificatePaise: number
  /**
   * Whether the payee's PAN is on file, for the portion deducted at the ordinary rate — section
   * 206AA forces 20% without one. It does not gate the certificate portion: Rule 28AA(2) forbids
   * issuing a certificate without a PAN, so a certificate's existence proves the PAN.
   */
  panAvailable?: boolean
}

export interface DeductionWithCertificateResult {
  /** Tax on the portion covered by the certificate, paise. */
  atCertificateRatePaise: number
  /** Tax on the portion beyond the ceiling (or all of it, with no certificate), paise. */
  atNormalRatePaise: number
  /** The two added together — what is actually deducted from this payment. */
  tdsPaise: number
  /**
   * True when the certificate's ceiling is spent as at the end of this payment (including a
   * ceiling that was already spent before it). Always false when there is no certificate, and
   * always false for an uncapped one — there is nothing to exhaust.
   */
  certificateExhausted: boolean
  /** The rate(s) applied, in the order they bite. Two entries for a payment that straddles. */
  ratesApplied: AppliedRate[]
}

/**
 * Deduct on one payment, honouring a section 197 certificate and its Rule 28AA ceiling.
 *
 * Each leg is rounded to the nearest rupee independently (via `computeTds`) rather than rounding
 * the total, because each leg is filed as its own deductee row at its own rate; rounding the
 * total would leave the two filed rows not adding up to the challan. `tdsPaise` is defined as the
 * sum of the legs so the books and the return can never disagree.
 */
export function deductionWithCertificate(
  input: DeductionWithCertificateInput
): DeductionWithCertificateResult {
  const { amountPaise, normalRatePercent, certificate, alreadyPaidUnderCertificatePaise } = input
  const panAvailable = input.panAvailable ?? true

  const normalOnly = (): DeductionWithCertificateResult => {
    const tds = computeTds(normalRatePercent, amountPaise, panAvailable)
    return {
      atCertificateRatePaise: 0,
      atNormalRatePaise: tds,
      tdsPaise: tds,
      certificateExhausted: certificate !== null && certificate.ceilingPaise !== null,
      ratesApplied:
        amountPaise === 0
          ? []
          : [{ ratePercent: normalRatePercent, basePaise: amountPaise, tdsPaise: tds, underCertificate: false }]
    }
  }

  if (!certificate) {
    const out = normalOnly()
    out.certificateExhausted = false
    return out
  }

  const ceiling = certificate.ceilingPaise
  // Uncapped: the whole payment rides the certificate, and nothing can exhaust it.
  const headroom = ceiling === null ? amountPaise : Math.max(0, ceiling - alreadyPaidUnderCertificatePaise)
  const certBase = Math.min(amountPaise, headroom)
  const normalBase = amountPaise - certBase

  if (certBase <= 0) return normalOnly()

  const atCertificateRatePaise = computeTds(certificate.ratePercent, certBase, true)
  const atNormalRatePaise = normalBase > 0 ? computeTds(normalRatePercent, normalBase, panAvailable) : 0

  const ratesApplied: AppliedRate[] = [
    {
      ratePercent: certificate.ratePercent,
      basePaise: certBase,
      tdsPaise: atCertificateRatePaise,
      underCertificate: true
    }
  ]
  if (normalBase > 0) {
    ratesApplied.push({
      ratePercent: normalRatePercent,
      basePaise: normalBase,
      tdsPaise: atNormalRatePaise,
      underCertificate: false
    })
  }

  return {
    atCertificateRatePaise,
    atNormalRatePaise,
    tdsPaise: atCertificateRatePaise + atNormalRatePaise,
    certificateExhausted: ceiling !== null && alreadyPaidUnderCertificatePaise + certBase >= ceiling,
    ratesApplied
  }
}
