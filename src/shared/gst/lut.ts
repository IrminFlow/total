/**
 * Letter of Undertaking tracking.
 *
 * An exporter supplies without paying IGST only while a valid LUT is on file. The undertaking is
 * annual and expires on 31 March regardless of when it was filed, and an expired one silently
 * converts a zero-rated export into a taxable supply — the exporter finds out from a notice,
 * often a year later, by which time the tax plus interest is theirs to pay.
 *
 * A date and a reminder, then. Worth far more than the effort.
 */

export interface Lut {
  /** ARN of the LUT filed on the portal. */
  arn: string
  /** Financial year it covers, as the start year: 2026 means FY 2026-27. */
  fyStartYear: number
  filedOn: string
}

/** An LUT covers a financial year and dies with it, whenever in that year it was filed. */
export function lutValidFrom(fyStartYear: number): string {
  return `${fyStartYear}-04-01`
}

export function lutValidTo(fyStartYear: number): string {
  return `${fyStartYear + 1}-03-31`
}

export type LutState = 'valid' | 'expiring' | 'expired' | 'missing'

export interface LutStatus {
  state: LutState
  lut: Lut | null
  validFrom: string | null
  validTo: string | null
  /** Days until it expires; negative once it has. Null when there is none. */
  daysLeft: number | null
  message: string
}

/** Inside this many days of expiry, start saying so — the renewal is a portal filing, not instant. */
export const LUT_WARN_DAYS = 45

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Where the exporter stands today.
 *
 * "Missing" is the loudest state and the default. An exporter with no LUT on file is not an
 * exporter who does not need one; every zero-rated invoice they raise is exposed, and silence
 * here would be the app agreeing with them.
 */
export function lutStatus(luts: Lut[], today: string): LutStatus {
  const current = luts
    .filter((l) => lutValidFrom(l.fyStartYear) <= today)
    .sort((a, b) => b.fyStartYear - a.fyStartYear)[0]

  if (!current) {
    return {
      state: 'missing',
      lut: null,
      validFrom: null,
      validTo: null,
      daysLeft: null,
      message: 'No LUT on file. Exports without one are taxable, whatever the invoice says.'
    }
  }

  const validTo = lutValidTo(current.fyStartYear)
  const daysLeft = daysBetween(today, validTo)

  if (daysLeft < 0) {
    return {
      state: 'expired',
      lut: current,
      validFrom: lutValidFrom(current.fyStartYear),
      validTo,
      daysLeft,
      message: `The LUT expired on ${validTo}. Exports raised since then are taxable until a new one is filed.`
    }
  }
  if (daysLeft <= LUT_WARN_DAYS) {
    return {
      state: 'expiring',
      lut: current,
      validFrom: lutValidFrom(current.fyStartYear),
      validTo,
      daysLeft,
      message: `The LUT expires in ${daysLeft} days, on ${validTo}. File the next one before 1 April.`
    }
  }
  return {
    state: 'valid',
    lut: current,
    validFrom: lutValidFrom(current.fyStartYear),
    validTo,
    daysLeft,
    message: `Valid to ${validTo}.`
  }
}
