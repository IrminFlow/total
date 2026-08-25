/**
 * The quick-pick periods offered by the working-period picker.
 *
 * Pure, and here rather than in the component, for the reason every date rule in this app is
 * here: "last month" and "this quarter" are year arithmetic, and year arithmetic done inline in
 * a component is year arithmetic nobody tests. A quarter is the *statutory* one (Q1 = Apr-Jun),
 * because that is what the rest of the app means by it — `periodBounds` owns that rule and this
 * defers to it rather than restating it.
 *
 * Each preset carries the single key that picks it in the dialog. The keys are unique and each
 * one occurs in its own label, so the dialog can underline it in place the way the sidebar does
 * — `periodPresets.test.ts` holds both properties.
 */

import { addDays, fyOf, fyFromStartYear } from './dates'
import { periodBounds, periodKey } from './period'

export interface PeriodPreset {
  /** Stable identity — the dialog's data-testid and what a test asserts against. */
  id: string
  /** Single uppercase letter that selects this preset. */
  key: string
  label: string
  from: string
  to: string
}

export function periodPresets(today: string): PeriodPreset[] {
  const month = periodBounds(periodKey(today, 'month'), 'month')
  // The day before this month started is, by definition, in last month — no month-and-year
  // decrement, so December has nothing special about it.
  const lastMonth = periodBounds(periodKey(addDays(month.from, -1), 'month'), 'month')
  const quarter = periodBounds(periodKey(today, 'quarter'), 'quarter')
  const fy = fyOf(today)
  const lastFy = fyFromStartYear(fy.startYear - 1)

  return [
    { id: 'this-month', key: 'M', label: 'This month', from: month.from, to: month.to },
    { id: 'last-month', key: 'L', label: 'Last month', from: lastMonth.from, to: lastMonth.to },
    { id: 'this-quarter', key: 'Q', label: 'This quarter', from: quarter.from, to: quarter.to },
    { id: 'this-fy', key: 'F', label: `This financial year — ${fy.label}`, from: fy.from, to: fy.to },
    {
      id: 'last-fy',
      key: 'P',
      label: `Previous financial year — ${lastFy.label}`,
      from: lastFy.from,
      to: lastFy.to
    },
    // Year to date ends TODAY, not at the end of the financial year: it is the one preset whose
    // point is that the books stop where the entries do.
    { id: 'ytd', key: 'Y', label: 'Year to date', from: fy.from, to: today }
  ]
}

/** The preset matching an exact range, if any — so the dialog can open with it highlighted. */
export function matchingPreset(presets: PeriodPreset[], from: string, to: string): PeriodPreset | undefined {
  return presets.find((p) => p.from === from && p.to === to)
}
