/**
 * Pure merge for multi-company consolidated reports (trial balance / P&L).
 * Each company supplies a flat list of {group, name, dr, cr} rows (paise); this merges
 * them into one matrix keyed by ledger/line name, case-insensitive and trim-normalised,
 * with a null cell wherever a company has no row for that name.
 */

export interface ConsolidateInputRow {
  group: string
  name: string
  /** Signed paise, debit side. */
  dr: number
  /** Signed paise, credit side. */
  cr: number
}

export interface ConsolidateCompanyInput {
  company: string
  rows: ConsolidateInputRow[]
}

export interface ConsolidatedRow {
  name: string
  group: string
  /** One cell per input company, in the same order; null where that company has no row for this name. */
  perCompany: (number | null)[]
  /** Row-wise sum of the non-null cells. */
  total: number
}

/** Shape returned by the `consol:run` IPC channel and the main-process consolidated() service. */
export interface ConsolidatedResult {
  /** Company display names, in the same order as the requested slugs. */
  columns: string[]
  rows: ConsolidatedRow[]
  warnings: string[]
  translationRates?: Record<string,number>
  eliminationCount?: number
}

export interface ConsolidationOptions { translationRates:Record<string,number>;eliminations:{name:string;group:string;amount:number;reason:string}[] }

const normalize = (s: string): string => s.trim().toLowerCase()

/**
 * Merge per-company rows into a name-keyed matrix. Each row's per-company value is
 * `dr - cr` (dr-positive, matching the app's signed-balance convention). Duplicate
 * names within a single company's row list are summed before merging. Row order is
 * alphabetical by display name.
 */
export function mergeByName(perCompany: ConsolidateCompanyInput[]): ConsolidatedRow[] {
  interface Acc {
    name: string
    group: string
    values: (number | null)[]
  }
  const byKey = new Map<string, Acc>()

  perCompany.forEach((company, colIndex) => {
    const perNameValue = new Map<string, { name: string; group: string; value: number }>()
    for (const row of company.rows) {
      const key = normalize(row.name)
      const value = row.dr - row.cr
      const existing = perNameValue.get(key)
      if (existing) existing.value += value
      else perNameValue.set(key, { name: row.name, group: row.group, value })
    }

    for (const [key, entry] of perNameValue) {
      let acc = byKey.get(key)
      if (!acc) {
        acc = { name: entry.name, group: entry.group, values: perCompany.map(() => null) }
        byKey.set(key, acc)
      }
      acc.values[colIndex] = entry.value
    }
  })

  return Array.from(byKey.values())
    .map((acc) => ({
      name: acc.name,
      group: acc.group,
      perCompany: acc.values,
      total: acc.values.reduce((s: number, v) => s + (v ?? 0), 0)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
