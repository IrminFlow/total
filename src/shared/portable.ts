/**
 * The books in a format that is not this app's (roadmap #254).
 *
 * Everything the app exports today answers somebody else's question: a CSV is a report, a Tally
 * XML is what Tally will swallow, a .totalbak is a SQLite file this build of this app can open.
 * None of them is "here are my books, in a form I can read in ten years without Total". A user
 * whose accounting software is the only thing that can read their accounting data does not own
 * their accounts, and the whole premise of an offline app is that they do.
 *
 * So: plain JSON, every reference by name rather than by row id, money still in integer paise,
 * and a documented shape (docs/export-format.md). The guarantee that makes it worth having is the
 * round trip — export, import into an empty company, export again, and the two documents are
 * identical. That is checked by a test, not asserted here.
 *
 * The format is deliberately the BOOKS: masters, opening balances, vouchers, and the stock lines
 * on them. Payroll runs, fixed assets, budgets, bank rules and the audit trail are not in it, and
 * `coverage` says so in every file it writes rather than leaving the reader to discover it.
 */

export const PORTABLE_FORMAT = 'total-books'
export const PORTABLE_VERSION = 1

/** What every file states about itself, so a reader in ten years knows what is missing. */
export const PORTABLE_COVERAGE = [
  'groups',
  'ledgers',
  'opening balances',
  'voucher types',
  'units',
  'stock groups',
  'stock items',
  'godowns',
  'vouchers',
  'voucher lines',
  'inventory lines'
] as const

export interface PortableCompany {
  name: string
  stateCode: string
  gstin: string | null
  pan: string | null
  address: string
  /** Financial year the books start in: 2025 means FY 2025-26. */
  booksFrom: number
}

export interface PortableGroup {
  name: string
  parent: string | null
  nature: 'asset' | 'liability' | 'income' | 'expense'
  affectsGrossProfit: boolean
}

export interface PortableLedger {
  name: string
  group: string
  /** Signed, dr-positive, integer paise. */
  openingBalance: number
  gstin: string | null
  stateCode: string | null
  address: string | null
  taxType: 'cgst' | 'sgst' | 'igst' | 'cess' | null
  gstRate: number | null
  hsn: string | null
}

export interface PortableVoucherType {
  name: string
  kind: string
  numbering: 'auto' | 'manual'
  prefix: string
}

export interface PortableUnit {
  name: string
  symbol: string
  decimals: number
  uqc: string
}

export interface PortableStockGroup {
  name: string
  parent: string | null
}

export interface PortableStockItem {
  name: string
  group: string | null
  unit: string
  hsn: string | null
  gstRate: number | null
  cessRate: number | null
  /** Integer thousandths. */
  openingQtyMilli: number
  /** Integer paise. */
  openingValue: number
}

export interface PortableLine {
  ledger: string
  drCr: 'dr' | 'cr'
  /** Integer paise, always positive; the side is `drCr`. */
  amount: number
}

export interface PortableInventoryLine {
  item: string
  godown: string | null
  qtyMilli: number
  ratePaise: number
  amount: number
  direction: 'in' | 'out'
}

export interface PortableVoucher {
  type: string
  number: string
  /** ISO YYYY-MM-DD. */
  date: string
  party: string | null
  narration: string | null
  reference: string | null
  lines: PortableLine[]
  inventory: PortableInventoryLine[]
}

export interface PortableDoc {
  format: typeof PORTABLE_FORMAT
  version: number
  /** ISO, informational only — excluded from round-trip comparison for obvious reasons. */
  exportedAt: string
  /** What this format carries, stated in the file itself. */
  coverage: readonly string[]
  company: PortableCompany
  groups: PortableGroup[]
  ledgers: PortableLedger[]
  voucherTypes: PortableVoucherType[]
  units: PortableUnit[]
  stockGroups: PortableStockGroup[]
  stockItems: PortableStockItem[]
  godowns: string[]
  vouchers: PortableVoucher[]
}

/**
 * Sort every list into an order that does not depend on row ids.
 *
 * The round-trip guarantee is only meaningful if both exports order things the same way, and the
 * second export's ids are necessarily different from the first's. Groups and stock groups are
 * additionally emitted parents-first so an importer can insert them in file order.
 */
export function canonicalisePortable(doc: PortableDoc): PortableDoc {
  const byName = <T extends { name: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => a.name.localeCompare(b.name))

  return {
    ...doc,
    coverage: [...PORTABLE_COVERAGE],
    groups: topological(byName(doc.groups)),
    ledgers: byName(doc.ledgers),
    voucherTypes: byName(doc.voucherTypes),
    units: byName(doc.units),
    stockGroups: topological(byName(doc.stockGroups)),
    stockItems: byName(doc.stockItems),
    godowns: [...doc.godowns].sort((a, b) => a.localeCompare(b)),
    vouchers: [...doc.vouchers].sort(
      (a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.number.localeCompare(b.number)
    )
  }
}

/** Parents before children, preserving the incoming (alphabetical) order within a level. */
function topological<T extends { name: string; parent: string | null }>(rows: T[]): T[] {
  const remaining = [...rows]
  const placed = new Set<string>()
  const out: T[] = []
  let progress = true
  while (remaining.length > 0 && progress) {
    progress = false
    for (let i = 0; i < remaining.length; ) {
      const row = remaining[i]!
      if (row.parent === null || placed.has(row.parent)) {
        out.push(row)
        placed.add(row.name)
        remaining.splice(i, 1)
        progress = true
      } else {
        i++
      }
    }
  }
  // A cycle or a dangling parent cannot be ordered; emit the rest as-is and let validation report
  // it, rather than silently dropping rows on the way out of somebody's books.
  return [...out, ...remaining]
}

/** Everything wrong with a document, in the order a person would want to fix it. */
export function validatePortable(input: unknown): string[] {
  const problems: string[] = []
  if (!input || typeof input !== 'object') return ['That file is not a Total books export.']
  const doc = input as Partial<PortableDoc>
  if (doc.format !== PORTABLE_FORMAT) return ['That file is not a Total books export.']
  if (doc.version !== PORTABLE_VERSION) {
    return [`This file is version ${String(doc.version)}; this build reads version ${PORTABLE_VERSION}.`]
  }
  if (!doc.company || typeof doc.company.name !== 'string' || !doc.company.name.trim()) {
    problems.push('The file does not say which company it is.')
  }

  const groups = new Set((doc.groups ?? []).map((g) => g.name))
  for (const group of doc.groups ?? []) {
    if (group.parent !== null && !groups.has(group.parent)) {
      problems.push(`Group "${group.name}" refers to a parent group "${group.parent}" that is not in the file.`)
    }
  }

  const ledgers = new Set((doc.ledgers ?? []).map((l) => l.name))
  for (const ledger of doc.ledgers ?? []) {
    if (!groups.has(ledger.group)) {
      problems.push(`Ledger "${ledger.name}" belongs to a group "${ledger.group}" that is not in the file.`)
    }
    if (!Number.isInteger(ledger.openingBalance)) {
      problems.push(`Ledger "${ledger.name}" has an opening balance that is not whole paise.`)
    }
  }

  const types = new Set((doc.voucherTypes ?? []).map((t) => t.name))
  const items = new Set((doc.stockItems ?? []).map((i) => i.name))
  for (const voucher of doc.vouchers ?? []) {
    const where = `${voucher.type} ${voucher.number} of ${voucher.date}`
    if (!types.has(voucher.type)) problems.push(`Voucher ${where} has a voucher type that is not in the file.`)
    if (voucher.party !== null && !ledgers.has(voucher.party)) {
      problems.push(`Voucher ${where} names a party "${voucher.party}" that is not in the file.`)
    }
    let dr = 0
    let cr = 0
    for (const line of voucher.lines) {
      if (!ledgers.has(line.ledger)) problems.push(`Voucher ${where} posts to a ledger "${line.ledger}" that is not in the file.`)
      if (!Number.isInteger(line.amount) || line.amount <= 0) {
        problems.push(`Voucher ${where} has a line amount that is not a positive whole number of paise.`)
      }
      if (line.drCr === 'dr') dr += line.amount
      else cr += line.amount
    }
    // The one check worth making twice: an import that accepted an unbalanced voucher would
    // produce books that do not foot, which is the failure this whole application exists to
    // prevent.
    if (dr !== cr) problems.push(`Voucher ${where} does not balance: debits ${dr} against credits ${cr}.`)
    for (const line of voucher.inventory) {
      if (!items.has(line.item)) problems.push(`Voucher ${where} moves an item "${line.item}" that is not in the file.`)
    }
  }
  return problems
}

/** Totals a reader can check the file against without importing it. */
export function portableTotals(doc: PortableDoc): { vouchers: number; debits: number; credits: number } {
  let debits = 0
  let credits = 0
  for (const voucher of doc.vouchers) {
    for (const line of voucher.lines) {
      if (line.drCr === 'dr') debits += line.amount
      else credits += line.amount
    }
  }
  return { vouchers: doc.vouchers.length, debits, credits }
}
