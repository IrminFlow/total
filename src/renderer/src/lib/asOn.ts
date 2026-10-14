import { todayISO } from '@shared/dates'

/** As-on date for an ageing view (stock ageing, slow movers): TODAY unless the working period
 *  ends earlier — never the FY end in the future, where stock bought today would read as 90+
 *  days old (Outstandings clamps the same way). An explicit earlier period end is kept. */
export function ageingAsOn(periodTo: string, today: string = todayISO()): string {
  return periodTo > today ? today : periodTo
}
