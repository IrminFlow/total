/**
 * Pasting a table of lines from a spreadsheet into a voucher grid.
 *
 * Half the data entry in a small business already exists in a spreadsheet — the accountant's
 * working, the supplier's emailed statement, the salesman's own sheet. Retyping it into the
 * voucher grid is where both the time and the transcription errors come from, and every one of
 * those errors is a number in the books that nobody typed twice.
 *
 * This module is only the reading: text in, candidate lines out. It resolves nothing — no ledger
 * ids, no stock items, no rounding decisions. The screen does that, because only the screen knows
 * which ledgers exist. Keeping the parse pure is what lets the awkward cases (a header row, a
 * total row, "1,234.00 Dr", a blank column the spreadsheet exported) be tested exhaustively.
 *
 * Nothing here throws. A line that cannot be read comes back in `skipped` with the reason, and
 * the screen reports it — a paste that silently drops three of twelve rows is worse than one
 * that refuses, because the operator only finds out at the trial balance.
 */

import { parseRupees } from './money'
import { parseCsvLine } from './csv'

/** A row the parser could not use, kept so the screen can say which ones and why. */
export interface SkippedRow {
  /** 1-based row number within the pasted block, so "row 4" means the fourth line pasted. */
  row: number
  text: string
  reason: string
}

/**
 * Split pasted clipboard text into a grid of cells.
 *
 * Tabs win when the text has any, because that is what every spreadsheet puts on the clipboard
 * and a tab can never appear inside a cell's own text. Only when there is no tab anywhere do we
 * fall back to RFC-4180 comma parsing, which is what a pasted CSV file looks like.
 *
 * Carriage returns are stripped rather than treated as separators: Excel on Windows ends rows
 * with CRLF, and a stray \r on the end of the last cell would defeat every number parse.
 */
export function parsePastedGrid(text: string): string[][] {
  const normalised = text.replace(/\r\n?/g, '\n')
  const lines = normalised.split('\n')
  const tabbed = normalised.includes('\t')
  return lines
    .map((line) => (tabbed ? line.split('\t') : parseCsvLine(line)).map((c) => c.trim()))
    .filter((cells) => cells.some((c) => c !== ''))
}

/**
 * Read an amount cell.
 *
 * Spreadsheets export money in more shapes than the app's own amount field ever sees: a currency
 * symbol, a trailing "Dr"/"Cr", brackets for negative (the accountant's convention), and Indian
 * digit grouping. All of them mean a number, so all of them are read.
 *
 * Returns the paise and, when the cell said so itself, which side it is — `(1,200)` and
 * `1,200 Cr` both mean a credit, and losing that would put the line on the wrong side.
 */
export function parseAmountCell(cell: string): { paise: number; side: 'dr' | 'cr' | null } | null {
  let text = cell.trim()
  if (text === '') return null

  let side: 'dr' | 'cr' | null = null
  let negative = false

  // Accountant's brackets. Checked before the Dr/Cr suffix so "(1,200) Cr" is not read twice.
  const bracketed = text.match(/^\((.*)\)$/)
  if (bracketed) {
    negative = true
    text = bracketed[1]!.trim()
  }

  const suffix = text.match(/\b(dr|cr|debit|credit)\.?$/i)
  if (suffix) {
    side = suffix[1]!.toLowerCase().startsWith('d') ? 'dr' : 'cr'
    text = text.slice(0, suffix.index).trim()
  }

  const cleaned = text.replace(/[₹$\s]/g, '')
  if (cleaned === '') return null
  const paise = parseRupees(cleaned)
  if (paise === null) return null

  const signed = negative ? -Math.abs(paise) : paise
  return { paise: signed, side }
}

/** Cell text that means "this is a heading, not data" in the first column. */
const HEADER_WORDS =
  /^(particulars?|account|ledger|a\/c|name|description|item|narration|dr\/cr|drcr|side|sr\.?\s*no\.?|s\.?\s*no\.?|#)$/i

/**
 * Cell text that means "this is the sheet's own total", which the grid computes for itself.
 *
 * Anchored at BOTH ends: "Balance with SBI" is a real bank ledger, and a prefix match would
 * refuse to paste it while claiming it was a total row.
 */
const TOTAL_WORDS = /^(grand\s+total|sub[-\s]?total|total|balance)\s*:?$/i

function isDrCrCell(cell: string): 'dr' | 'cr' | null {
  const t = cell.trim().toLowerCase().replace(/\.$/, '')
  if (t === 'dr' || t === 'debit') return 'dr'
  if (t === 'cr' || t === 'credit') return 'cr'
  return null
}

// ---------- accounting grid (Dr/Cr · Particulars · Amount) ----------

export interface PastedAcctLine {
  /** The ledger NAME as pasted. Resolution to an id is the screen's job. */
  name: string
  /** null when the sheet did not say — the screen falls back to its own default side. */
  drCr: 'dr' | 'cr' | null
  /** Always positive paise. A negative or bracketed cell has already flipped `drCr` instead. */
  amount: number
}

export interface AcctPasteResult {
  lines: PastedAcctLine[]
  skipped: SkippedRow[]
}

/**
 * Read a pasted block as accounting lines.
 *
 * Three layouts are recognised, because these are the three a bookkeeper's sheet actually uses:
 *
 *   Name, Amount                 one column of money; the side comes from the cell or the caller
 *   Name, Dr/Cr, Amount          the side spelled out in its own column
 *   Name, Debit, Credit          the classic two-money-column journal; whichever is filled wins
 *
 * The layout is detected per row rather than once for the block, so a sheet that has a stray
 * empty cell in one row does not throw off the other eleven.
 */
export function parseAcctPaste(text: string): AcctPasteResult {
  const grid = parsePastedGrid(text)
  const lines: PastedAcctLine[] = []
  const skipped: SkippedRow[] = []

  grid.forEach((cells, i) => {
    const row = i + 1
    const raw = cells.join(' · ')
    const name = (cells[0] ?? '').trim()
    if (name === '') return void skipped.push({ row, text: raw, reason: 'no account name' })

    // A header row is only a header when its money columns are not money either — a real ledger
    // called "Balance with SBI" must not be dropped because it starts with "Balance".
    const moneyCells = cells.slice(1).filter((c) => parseAmountCell(c) !== null)
    if (moneyCells.length === 0 && (HEADER_WORDS.test(name) || isDrCrCell(name) !== null)) return
    if (moneyCells.length > 0 && TOTAL_WORDS.test(name)) {
      return void skipped.push({ row, text: raw, reason: 'looks like the sheet’s own total' })
    }
    if (moneyCells.length === 0) return void skipped.push({ row, text: raw, reason: 'no amount' })

    // Layout 2: an explicit Dr/Cr column somewhere after the name.
    const sideIdx = cells.findIndex((c, j) => j > 0 && isDrCrCell(c) !== null)
    if (sideIdx > 0) {
      const side = isDrCrCell(cells[sideIdx]!)!
      const amountCell = cells.slice(sideIdx + 1).find((c) => parseAmountCell(c) !== null)
      const parsed = amountCell ? parseAmountCell(amountCell) : null
      if (!parsed || parsed.paise === 0) return void skipped.push({ row, text: raw, reason: 'no amount' })
      lines.push(sideAndAmount(name, parsed.paise < 0 ? flip(side) : side, parsed.paise))
      return
    }

    // Layout 3: two money columns = debit then credit. Both filled on one row is ambiguous
    // rather than clever — "500 Dr and 200 Cr" is not one line in any reading of it.
    const money = cells.slice(1).map((c) => ({ cell: c, parsed: parseAmountCell(c) }))
    const filled = money.filter((m) => m.parsed !== null && m.parsed.paise !== 0)
    if (filled.length >= 2) {
      return void skipped.push({ row, text: raw, reason: 'more than one amount on the row' })
    }
    const only = filled[0]
    if (!only || !only.parsed) return void skipped.push({ row, text: raw, reason: 'no amount' })

    /**
     * Layout 1 vs 3: with a debit column AND a credit column the position IS the side, unless
     * the cell said otherwise itself. With one money column the side is left to the caller.
     *
     * "Two columns" means two cells that could hold money — empty or numeric. A trailing
     * narration column must not make an amount in the first slot read as a debit, so a cell
     * carrying text is not counted.
     */
    const moneyColumns = money.filter((m) => m.cell === '' || m.parsed !== null)
    const moneyIdx = money.indexOf(only)
    const positional: 'dr' | 'cr' | null = moneyColumns.length >= 2 ? (moneyIdx === 0 ? 'dr' : 'cr') : null
    const side = only.parsed.side ?? positional
    const resolved = only.parsed.paise < 0 && side ? flip(side) : side
    lines.push(sideAndAmount(name, resolved, only.parsed.paise))
  })

  return { lines, skipped }
}

function flip(side: 'dr' | 'cr'): 'dr' | 'cr' {
  return side === 'dr' ? 'cr' : 'dr'
}

function sideAndAmount(name: string, drCr: 'dr' | 'cr' | null, paise: number): PastedAcctLine {
  return { name, drCr, amount: Math.abs(paise) }
}

// ---------- invoice grid (Item · Qty · Rate · Discount) ----------

export interface PastedItemLine {
  name: string
  /** Kept as text: the grid's own quantity field is text (it accepts expressions). */
  qtyText: string
  /** Paise, or null when the sheet did not carry a rate — the item's own rate then applies. */
  rate: number | null
  discount: number | null
}

export interface ItemPasteResult {
  lines: PastedItemLine[]
  skipped: SkippedRow[]
}

/** Cell text that is a bare quantity: digits with an optional decimal, nothing else. */
const QTY_CELL = /^-?\d[\d,]*(\.\d+)?$/

/**
 * Read a pasted block as invoice item lines: `Item, Qty, Rate[, Discount]`.
 *
 * Rate and discount are optional because the commonest paste is a picking list — item and
 * quantity only — and the price then comes from the item master or the party's price level,
 * which is exactly where it should come from.
 */
export function parseItemPaste(text: string): ItemPasteResult {
  const grid = parsePastedGrid(text)
  const lines: PastedItemLine[] = []
  const skipped: SkippedRow[] = []

  grid.forEach((cells, i) => {
    const row = i + 1
    const raw = cells.join(' · ')
    const name = (cells[0] ?? '').trim()
    if (name === '') return void skipped.push({ row, text: raw, reason: 'no item name' })

    // Positional, so empty cells are KEPT: a sheet exporting `Widget, , 250` means "no
    // quantity", and squeezing the blank out would silently read the rate as the quantity.
    const rest = cells.slice(1)
    const looksNumeric = rest.some((c) => c !== '' && (QTY_CELL.test(c) || parseAmountCell(c) !== null))
    if (!looksNumeric && (HEADER_WORDS.test(name) || /^qty|quantity$/i.test(rest[0] ?? ''))) return
    if (looksNumeric && TOTAL_WORDS.test(name)) {
      return void skipped.push({ row, text: raw, reason: 'looks like the sheet’s own total' })
    }

    const qtyCell = rest[0] ?? ''
    if (!QTY_CELL.test(qtyCell)) return void skipped.push({ row, text: raw, reason: 'no quantity' })
    const qtyText = qtyCell.replace(/,/g, '')
    if (Number(qtyText) <= 0) return void skipped.push({ row, text: raw, reason: 'quantity is not positive' })

    const rate = rest[1] ? (parseAmountCell(rest[1])?.paise ?? null) : null
    const discount = rest[2] ? (parseAmountCell(rest[2])?.paise ?? null) : null
    lines.push({
      name,
      qtyText,
      rate: rate != null ? Math.abs(rate) : null,
      discount: discount != null ? Math.abs(discount) : null
    })
  })

  return { lines, skipped }
}

/**
 * Match a pasted name against the master list.
 *
 * Case- and space-insensitive exact match only. Deliberately NOT fuzzy: a near-match that picks
 * the wrong ledger posts real money to the wrong account, and the operator has no way to notice
 * because the name shown afterwards is the one they meant to see. An unmatched name comes back
 * unresolved and the screen leaves the picker empty for a human to fill.
 */
export function matchByName<T extends { id: number; name: string }>(
  name: string,
  candidates: readonly T[]
): T | null {
  const key = normaliseName(name)
  if (key === '') return null
  const hits = candidates.filter((c) => normaliseName(c.name) === key)
  // Two masters with the same normalised name is a real (if rare) state — an ambiguous match is
  // no match, for the same reason a fuzzy one is not offered.
  return hits.length === 1 ? hits[0]! : null
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}
