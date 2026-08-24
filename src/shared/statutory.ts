/**
 * Statutory rates, with the dates they changed on.
 *
 * The rates were constants, which is fine right up to the first month they are not. When EPFO
 * dropped the admin charge from 0.65% to 0.5%, every previously computed run in the books would
 * have silently changed if it were ever recomputed — and a payroll that answers differently the
 * second time you ask is a payroll nobody can reconcile against a filed return.
 *
 * So: a run is computed with the rates in force on its own pay date, and the history is data
 * rather than a code change. The entries below are the real changes, cited by the notification
 * that made them; a company with a special dispensation can add its own effective-dated override
 * without touching this file.
 *
 * The list is ascending by date. `ratesOn` picks the last entry that has taken effect, so a date
 * before the first entry gets the first entry — the alternative is refusing to compute a 2009
 * payroll, which helps nobody and is not what a user importing old books wants.
 */

export interface StatutoryRates {
  /** ISO date this set took effect. */
  effectiveFrom: string
  /** Monthly PF wage ceiling, paise. Basic above this does not attract PF. */
  pfWageCeiling: number
  /** Employee and employer PF, whole percent. */
  pfRate: number
  /** Employer's share diverted to the pension fund, percent. */
  epsRate: number
  /** EPFO administrative charge on the capped wage, percent. */
  pfAdminRate: number
  /** EDLI (insurance) contribution on the capped wage, percent. */
  edliRate: number
  /** Monthly gross at or below which ESI applies, paise. */
  esiGrossLimit: number
  esiEmpRate: number
  esiErRate: number
  /** Why this set exists — shown in the UI so a rate can be checked against its source. */
  note: string
}

export const STATUTORY_HISTORY: StatutoryRates[] = [
  {
    effectiveFrom: '2011-01-01',
    pfWageCeiling: 6_500_00,
    pfRate: 12,
    epsRate: 8.33,
    pfAdminRate: 1.1,
    edliRate: 0.5,
    esiGrossLimit: 15_000_00,
    esiEmpRate: 1.75,
    esiErRate: 4.75,
    note: 'Pre-2014 baseline: PF ceiling ₹6,500, ESI limit ₹15,000, admin charge 1.10%.'
  },
  {
    effectiveFrom: '2014-09-01',
    pfWageCeiling: 15_000_00,
    pfRate: 12,
    epsRate: 8.33,
    pfAdminRate: 1.1,
    edliRate: 0.5,
    esiGrossLimit: 15_000_00,
    esiEmpRate: 1.75,
    esiErRate: 4.75,
    note: 'PF wage ceiling raised to ₹15,000 (EPFO notification, September 2014).'
  },
  {
    effectiveFrom: '2015-01-01',
    pfWageCeiling: 15_000_00,
    pfRate: 12,
    epsRate: 8.33,
    pfAdminRate: 0.85,
    edliRate: 0.5,
    esiGrossLimit: 15_000_00,
    esiEmpRate: 1.75,
    esiErRate: 4.75,
    note: 'EPFO administrative charge reduced from 1.10% to 0.85%.'
  },
  {
    effectiveFrom: '2017-01-01',
    pfWageCeiling: 15_000_00,
    pfRate: 12,
    epsRate: 8.33,
    pfAdminRate: 0.65,
    edliRate: 0.5,
    esiGrossLimit: 21_000_00,
    esiEmpRate: 1.75,
    esiErRate: 4.75,
    note: 'ESI wage limit raised to ₹21,000; EPFO admin charge reduced to 0.65%.'
  },
  {
    effectiveFrom: '2018-06-01',
    pfWageCeiling: 15_000_00,
    pfRate: 12,
    epsRate: 8.33,
    pfAdminRate: 0.5,
    edliRate: 0.5,
    esiGrossLimit: 21_000_00,
    esiEmpRate: 1.75,
    esiErRate: 4.75,
    note: 'EPFO administrative charge reduced to 0.50%.'
  },
  {
    effectiveFrom: '2019-07-01',
    pfWageCeiling: 15_000_00,
    pfRate: 12,
    epsRate: 8.33,
    pfAdminRate: 0.5,
    edliRate: 0.5,
    esiGrossLimit: 21_000_00,
    esiEmpRate: 0.75,
    esiErRate: 3.25,
    note: 'ESI contribution reduced to 0.75% employee / 3.25% employer.'
  }
]

/** The set in force on `date`. Dates before the first entry get the first entry. */
export function ratesOn(date: string, history: StatutoryRates[] = STATUTORY_HISTORY): StatutoryRates {
  let current = history[0] as StatutoryRates
  for (const r of history) {
    if (r.effectiveFrom <= date) current = r
    else break
  }
  return current
}

/** The set in force for a 'YYYY-MM' pay month — read on the last day, which is when pay accrues. */
export function ratesForMonth(month: string, history: StatutoryRates[] = STATUTORY_HISTORY): StatutoryRates {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return ratesOn(`${month}-${String(lastDay).padStart(2, '0')}`, history)
}

/** True when two consecutive months would be computed on different rates — worth telling the user. */
export function ratesChangedBetween(fromMonth: string, toMonth: string, history: StatutoryRates[] = STATUTORY_HISTORY): boolean {
  return ratesForMonth(fromMonth, history).effectiveFrom !== ratesForMonth(toMonth, history).effectiveFrom
}
