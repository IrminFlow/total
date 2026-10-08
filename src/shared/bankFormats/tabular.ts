/**
 * Tabular statements — CSV / TXT (any delimiter) and the XLSX grid — through one column-mapping
 * profile (WP 4.1). `detectProfile` guesses a mapping from the header row (skipping the account
 * preamble most Indian banks print above it); the user adjusts it in the mapping UI and the
 * result is remembered per bank ledger (bank_import_profiles). `gridToStatement` applies it:
 * rows without a date but with text are narration continuation lines (appended to the previous
 * line), opening/closing balance rows and totals are skipped, Dr/Cr flags and signed amounts are
 * resolved into deposit / withdrawal.
 */
import { parseBankAmount, parseBankDate } from './quirks'
import type { DateFormat, Delimiter, ImportProfile, ParsedStatement, StatementLine } from './types'
import { excelSerialToISO } from './xlsx'

/** Split delimited text into a grid, honouring RFC 4180 quoting (embedded delimiters, doubled
 *  quotes and line breaks inside quoted cells). */
export function parseDelimited(text: string, delimiter: Exclude<Delimiter, 'auto'>): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell.trim() === '') {
      cell = ''
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** The delimiter that splits the most early lines into a consistent, >1 cell count. */
export function sniffDelimiter(text: string): Exclude<Delimiter, 'auto'> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 40)
  let best: Exclude<Delimiter, 'auto'> = ','
  let bestScore = -1
  for (const d of [',', ';', '\t', '|'] as const) {
    const counts = lines.map((l) => parseDelimited(l, d)[0]?.length ?? 1)
    const multi = counts.filter((c) => c > 1)
    if (multi.length === 0) continue
    // Most common cell count among multi-cell lines × how many lines share it.
    const freq = new Map<number, number>()
    for (const c of multi) freq.set(c, (freq.get(c) ?? 0) + 1)
    const [mode, n] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!
    const score = n * 100 + mode
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

const norm = (h: string): string => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function findCol(header: string[], tests: ((h: string) => boolean)[], exclude: Set<number>): number | null {
  for (const test of tests) {
    const i = header.findIndex((h, idx) => !exclude.has(idx) && test(norm(h)))
    if (i >= 0) return i
  }
  return null
}

const FLAG_HEADER = /^(dr cr|cr dr|d c|c d|debit credit|credit debit|dr cr indicator|cr dr indicator)$/

const looksLikeHeader = (row: string[]): boolean => {
  const cells = row.map(norm)
  const hasDate = cells.some((c) => /\bdate\b|\bdt\b/.test(c))
  const hasMoney = cells.some((c) => /debit|credit|withdraw|deposit|amount|\bdr\b|\bcr\b/.test(c))
  return hasDate && hasMoney
}

/** Guess a mapping from the grid. Returns null when no header row with a date and an amount
 *  column can be found in the first 40 rows (the UI then asks for a manual mapping). */
export function detectProfile(grid: string[][], base: Partial<ImportProfile> = {}): ImportProfile | null {
  const headerIdx = grid.slice(0, 40).findIndex(looksLikeHeader)
  if (headerIdx < 0) return null
  const header = grid[headerIdx]!
  const used = new Set<number>()
  const take = (i: number | null): number | null => {
    if (i != null) used.add(i)
    return i
  }
  const valueDateCol = take(findCol(header, [(h) => /value/.test(h) && /date|dt/.test(h)], used))
  const dateCol = take(
    findCol(header, [(h) => /^(txn|tran|transaction|post|posting|book|booking)?\s*(date|dt)$/.test(h), (h) => /date/.test(h)], used)
  )
  if (dateCol == null) return null
  const isFlag = (h: string): boolean => FLAG_HEADER.test(h)
  const debitCol = take(findCol(header, [(h) => /withdraw/.test(h), (h) => !isFlag(h) && /\bdebit\b|\bdr\b|^debit|paid out/.test(h)], used))
  const creditCol = take(findCol(header, [(h) => /deposit/.test(h), (h) => !isFlag(h) && /\bcredit\b|\bcr\b|^credit|paid in/.test(h)], used))
  const balanceCol = take(findCol(header, [(h) => /balance|bal\b/.test(h)], used))
  const refCol = take(findCol(header, [(h) => /chq|cheque|check|ref|utr|instrument/.test(h)], used))
  const flagCol =
    debitCol == null || creditCol == null
      ? take(findCol(header, [isFlag, (h) => /^(dr|cr|type|txn type)$/.test(h)], used))
      : null
  const amountCol = debitCol == null && creditCol == null ? take(findCol(header, [(h) => /amount|amt/.test(h)], used)) : null
  const descCol = findCol(header, [(h) => /narration|description|particular|details|remark|desc/.test(h)], used)
  const descCols = descCol != null ? [descCol] : []
  let amountMode: ImportProfile['amountMode'] = 'split'
  if (debitCol == null || creditCol == null) amountMode = flagCol != null ? 'flag' : 'signed'
  return {
    delimiter: base.delimiter ?? 'auto',
    encoding: base.encoding ?? 'utf-8',
    headerRow: headerIdx + 1,
    dateFormat: base.dateFormat ?? 'auto',
    dateCol,
    valueDateCol,
    descCols,
    refCol,
    amountMode,
    debitCol: amountMode === 'split' ? debitCol : null,
    creditCol: amountMode === 'split' ? creditCol : null,
    amountCol: amountMode === 'split' ? null : (amountCol ?? debitCol ?? creditCol),
    flagCol: amountMode === 'flag' ? flagCol : null,
    balanceCol,
    signedNegativeIsDeposit: false
  }
}

/**
 * File-level day/month order for 'auto' dates written as numbers (15/08/2026 vs 08/15/2026): any
 * first part above 12 → day-first; any second part above 12 → month-first; both seen → the file
 * is inconsistent (day-first, with a warning); neither → ambiguous, read day-first (the Indian
 * convention) with a warning to pick the format in the mapping if the bank writes month first.
 */
export function inferDateOrder(cells: string[], warnings: string[]): DateFormat {
  let dayFirst = false
  let monthFirst = false
  let numeric = 0
  for (const c of cells) {
    const m = c.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/)
    if (!m) continue
    numeric++
    if (Number(m[1]) > 12) dayFirst = true
    if (Number(m[2]) > 12) monthFirst = true
  }
  if (numeric === 0) return 'auto'
  if (monthFirst && !dayFirst) return 'MM/DD/YYYY'
  if (dayFirst && monthFirst) warnings.push('Dates mix day-first and month-first — read day-first; check the date format in the mapping')
  else if (!dayFirst) warnings.push('Every date could be day-first or month-first (no day above 12) — read day-first; pick MM/DD/YYYY in the mapping if this bank writes the month first')
  return 'auto'
}

const SKIP_DESC = /^(opening|closing|brought forward|carried forward|b\/f|c\/f|total|grand total|statement summary)\b/i

/** Apply a mapping to a grid. Pure; reports skipped rows as warnings. */
export function gridToStatement(grid: string[][], profile: ImportProfile, format: 'csv' | 'xlsx'): ParsedStatement {
  const lines: StatementLine[] = []
  const warnings: string[] = []
  const cell = (row: string[], i: number | null): string => (i == null ? '' : (row[i] ?? '').trim())
  let skipped = 0
  let continuation = 0
  const rejected: string[] = []
  const start = profile.headerRow > 0 ? profile.headerRow : 0
  const dateFormat = profile.dateFormat === 'auto' ? inferDateOrder(grid.slice(start).map((row) => cell(row, profile.dateCol)), warnings) : profile.dateFormat
  const dateOf = (raw: string): string | null => {
    // Excel cells without a date style arrive as serial numbers; in the date column they are dates.
    if (format === 'xlsx' && /^\d{5}(\.\d+)?$/.test(raw) && Number(raw) > 20000 && Number(raw) < 80000) return excelSerialToISO(Number(raw))
    return parseBankDate(raw, dateFormat)
  }
  for (let r = start; r < grid.length; r++) {
    const row = grid[r]!
    if (row.every((c) => c.trim() === '')) continue
    const date = dateOf(cell(row, profile.dateCol))
    const desc = profile.descCols.map((i) => cell(row, i)).filter(Boolean).join(' ')
    if (!date) {
      // Narration continuation: no date, no amounts, some text — belongs to the line above.
      const hasMoney = [profile.debitCol, profile.creditCol, profile.amountCol].some((i) => parseBankAmount(cell(row, i))?.paise)
      const extra = desc || row.filter((c) => c.trim()).join(' ').trim()
      if (!hasMoney && extra && lines.length > 0 && !SKIP_DESC.test(extra) && cell(row, profile.dateCol) === '') {
        const prev = lines[lines.length - 1]!
        prev.description = `${prev.description} ${extra}`.trim()
        continuation++
      } else if (r > start && extra) skipped++
      continue
    }
    if (SKIP_DESC.test(desc)) continue
    let deposit = 0
    let withdrawal = 0
    if (profile.amountMode === 'split') {
      const dr = parseBankAmount(cell(row, profile.debitCol))?.paise ?? 0
      const cr = parseBankAmount(cell(row, profile.creditCol))?.paise ?? 0
      if (dr !== 0 && cr !== 0) {
        // Both columns filled: no bank format we know does this, so it is not netted — the row is
        // left out and named, never allowed to fail the whole import.
        rejected.push(`row ${r + 1} (${cell(row, profile.dateCol)} ${desc.slice(0, 40)}): both a withdrawal and a deposit`)
        continue
      }
      // Signs are symmetric: a negative withdrawal is money in, a negative deposit money out
      // (some exports book reversals that way).
      const net = cr - dr
      deposit = net > 0 ? net : 0
      withdrawal = net < 0 ? -net : 0
    } else {
      const amt = parseBankAmount(cell(row, profile.amountCol))
      if (amt) {
        let flag = amt.flag
        if (profile.amountMode === 'flag') {
          const f = cell(row, profile.flagCol).toLowerCase()
          flag = /^(c|cr|credit|dep|deposit)/.test(f) ? 'cr' : /^(d|dr|debit|wd|withdraw)/.test(f) ? 'dr' : flag
        }
        if (flag === 'cr') deposit = Math.abs(amt.paise)
        else if (flag === 'dr') withdrawal = Math.abs(amt.paise)
        else {
          const positiveIsDeposit = !profile.signedNegativeIsDeposit
          if ((amt.paise >= 0) === positiveIsDeposit) deposit = Math.abs(amt.paise)
          else withdrawal = Math.abs(amt.paise)
        }
      }
    }
    if (deposit === 0 && withdrawal === 0) {
      skipped++
      continue
    }
    const bal = parseBankAmount(cell(row, profile.balanceCol))
    lines.push({
      date,
      valueDate: profile.valueDateCol == null ? null : dateOf(cell(row, profile.valueDateCol)),
      description: desc,
      reference: cell(row, profile.refCol),
      deposit,
      withdrawal,
      balance: bal ? (bal.flag === 'dr' ? -Math.abs(bal.paise) : bal.paise) : null
    })
  }
  if (continuation) warnings.push(`${continuation} narration continuation ${continuation === 1 ? 'line was' : 'lines were'} joined to the line above`)
  if (rejected.length) {
    warnings.push(`${rejected.length} ${rejected.length === 1 ? 'row was' : 'rows were'} left out — ${rejected.slice(0, 5).join('; ')}${rejected.length > 5 ? '; …' : ''}`)
  }
  if (skipped) warnings.push(`${skipped} ${skipped === 1 ? 'row' : 'rows'} without a date or an amount skipped`)
  return { format, lines, warnings, account: null, currency: null, openingBalance: null, closingBalance: null }
}
