// Pure lint (plain-Node vitest — reads source text, never imports a service): every SQL string in
// src/main/services/*.ts and src/main/ai/**/*.ts (keyed 'ai/…') that mentions `inventory_lines` must filter stock movement with
// MOVES_STOCK / moves_stock (WP 2.5: an invoice line whose goods moved on its challan is NOT a
// second movement), or sit on the allowlist below with the reason it wants invoice ITEMS rather
// than stock movements. A new stock reader that forgets the filter double-counts stock — this
// test is what catches it.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const DIR = __dirname
/** WP 5.6: the AI code reads the books too (memory statistics, drafting) — scanned as 'ai/<path>'. */
const AI_DIR = join(__dirname, '..', 'ai')

/** `file` + a substring unique to the SQL string → why it may read every line. */
const ALLOW: { file: string; contains: string; reason: string }[] = [
  { file: 'tradeLinks.ts', contains: 'SELECT il.serials FROM line_links ll JOIN inventory_lines il ON il.line_uid', reason: 'serials already named by the linked (non-moving) target lines' },
  { file: 'tradeReports.ts', contains: "WHERE vt.kind = ? AND v.date <= ?", reason: 'pending challans / GRNs read the notes\' own lines (a stock note line always moves stock)' },
  { file: 'edocs.ts', contains: 'EXISTS(SELECT 1 FROM inventory_lines il JOIN stock_items si', reason: 'e-invoice eligibility / "has goods" read the invoice items' },
  { file: 'edocs.ts', contains: 'FROM inventory_lines il', reason: 'e-invoice / e-way item list = the invoice items' },
  { file: 'gst.ts', contains: 'FROM inventory_lines il\n', reason: 'GSTR-1 HSN / B2B items = the invoice items' },
  { file: 'gst.ts', contains: 'FROM inventory_lines il JOIN stock_items si', reason: 'RCM / inward HSN = the bill items' },
  { file: 'gst.ts', contains: 'SELECT il.amount FROM inventory_lines il WHERE il.voucher_id', reason: 'purchase-doc taxable value = the bill items' },
  { file: 'manufacture.ts', contains: 'FROM inventory_lines il', reason: 'suggestedSaleRate reads sale prices off invoice items' },
  { file: 'tradeLinks.ts', contains: 'SELECT 1 FROM inventory_lines WHERE line_uid = ?', reason: 'lineUidFree: is the uid used by any line at all (identity, not stock)' },
  { file: 'yearEnd.ts', contains: 'SELECT 1 FROM inventory_lines WHERE voucher_id = ?', reason: 'markImportedClose: a closing entry has no item lines at all (shape, not stock)' },
  { file: 'dataImport.ts', contains: 'SELECT 1 FROM inventory_lines WHERE batch_id', reason: 'undo: is the imported batch referenced by any line at all (existence, not stock)' },
  { file: 'masters.ts', contains: 'FROM inventory_lines WHERE stock_item_id', reason: 'usage count (delete guard) — any line uses the item' },
  { file: 'masters.ts', contains: 'FROM inventory_lines WHERE godown_id', reason: 'usage count (delete guard) — any line uses the godown' },
  { file: 'printTemplates.ts', contains: 'FROM inventory_lines WHERE voucher_id', reason: 'print: every item line of the invoice' },
  { file: 'reports.ts', contains: "vt.kind = 'sales'", reason: 'item profitability SALES value is the invoice items (COGS comes from the pass)' },
  { file: 'search.ts', contains: 'FROM inventory_lines WHERE stock_item_id', reason: 'search by item finds the invoice too' },
  { file: 'search.ts', contains: 'FROM inventory_lines il JOIN stock_items s', reason: 'search hit labels (item names on a voucher)' },
  { file: 'serials.ts', contains: 'UPDATE inventory_lines SET serials', reason: "stores the line's own serials (printed even when non-moving)" },
  { file: 'serials.ts', contains: 'JOIN inventory_lines il_in', reason: 'serial register lookup by the projection\'s line ids' },
  { file: 'serials.ts', contains: 'LEFT JOIN inventory_lines il ON il.id = sn.outward_line_id', reason: 'available-serials lookup by the projection\'s line ids' },
  { file: 'vouchers.ts', contains: 'SELECT * FROM inventory_lines WHERE voucher_id', reason: 'getVoucher loads every line of the voucher' },
  { file: 'vouchers.ts', contains: 'DELETE FROM inventory_lines WHERE voucher_id', reason: 'saveVoucher replaces the line set' },
  { file: 'vouchers.ts', contains: 'is_absolute, line_order)\n', reason: 'the pre-024 INSERT (data-migration fixtures only)' },
  { file: 'tradeLinks.ts', contains: 'PRAGMA table_info(inventory_lines)', reason: 'schema probe' },
  { file: 'tcsEvents.ts', contains: 'FROM inventory_lines WHERE voucher_id IN', reason: 'TCS goods category = the items sold on the invoice (TCS is on the sale, wherever the goods moved)' },
  { file: 'jobWork.ts', contains: 'FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id JOIN units u', reason: "ITC-04: a job-work challan's own lines (a stock journal — always stock-moving)" },
  { file: 'manufactureReports.ts', contains: 'FROM inventory_lines WHERE voucher_id IN', reason: "a manufacture's own lines (stock journals — always stock-moving)" },
  { file: 'stockAnalysis.ts', contains: 'JOIN inventory_lines il ON il.voucher_id = mo.voucher_id', reason: "maps a manufacture's by-product rows to its own line ids" },
  { file: 'gstAnnual.ts', contains: 'SELECT 1 FROM inventory_lines WHERE voucher_id', reason: 'GSTR-9 Table 6: does the bill carry goods (inputs) — the bill items' },
  { file: 'gstAnnual.ts', contains: 'FROM inventory_lines WHERE voucher_id = ?', reason: 'GSTR-9 Table 6: taxable value of the bill items' },
  { file: 'gstAnnual.ts', contains: "WHERE vt.kind = 'purchase' AND si.hsn IS NOT NULL", reason: 'GSTR-9 Table 18: inward HSN = the bill items' },
  { file: 'gstAnnual.ts', contains: "WHERE vt.kind = 'sales' AND g.kind = 'job_worker'", reason: "ITC-04 5C: the invoice's items supplied from a job worker's godown" },
  { file: 'tradeAnalysis.ts', contains: 'NULL AS tradeDocId, v.number, v.date', reason: 'three-way match compares bill / GRN line quantities and amounts (document facts, not movements)' },
  { file: 'tradeAnalysis.ts', contains: 'sv.id AS srcVoucherId', reason: 'returns register: the credit / debit note and rejection-note lines themselves' },
  { file: 'tradeAnalysis.ts', contains: 'v.party_ledger_id AS partyLedgerId, p.name AS partyName, il.stock_item_id AS stockItemId', reason: 'returns rate: quantity sold = the invoice items, wherever the goods moved' },
  { file: 'tradeAnalysis.ts', contains: 'SELECT COUNT(*) AS n FROM inventory_lines il WHERE il.voucher_id', reason: "a stock note's own line count (stock notes always move stock)" },
  { file: 'tradeChain.ts', contains: 'il.line_order AS lineOrder, il.stock_item_id AS stockItemId', reason: 'linked documents: every line of each document in the chain' },
  { file: 'tradeClosure.ts', contains: 'SELECT line_uid AS uid, qty_milli AS q FROM inventory_lines', reason: "closing a stock note reads its own lines' linked quantity" },
  { file: 'gstRcm.ts', contains: 'FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id JOIN units u', reason: 'self-invoice items = the bill items' },
  { file: 'pricing.ts', contains: 'FROM inventory_lines WHERE voucher_id = ? AND is_absolute = 0', reason: "remember last price: the sale's item rates" },
  { file: 'pricing.ts', contains: "vt.kind = 'purchase' AND il.direction = 'in'", reason: 'last purchase RATE of an item (a price, not a movement)' },
  { file: 'assistants.ts', contains: "WHERE vt.kind IN ('sales', 'purchase') AND v.date BETWEEN", reason: 'anomaly GST-rate check: the invoice items and their master rates (a document fact, wherever the goods moved)' },
  { file: 'ai/evals/runner.ts', contains: "'inventory_lines'", reason: 'WP 5.8 books digest: hashes every row of the book tables (unchanged-books check, not a stock reader)' },
  { file: 'ai/memory.ts', contains: 'SELECT il.stock_item_id AS id, si.name AS name, COUNT(DISTINCT il.voucher_id) AS n FROM inventory_lines il', reason: "a party's usual item = the items it was billed for (invoice items), wherever the goods moved" },
  { file: 'counter.ts', contains: 'FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id JOIN units u ON u.id = si.unit_id', reason: "day-end items = the counter invoices' items" }
]

/** Every string / template literal in a TS source (comments skipped; a template's nested
 *  templates are part of it). */
export function sqlStrings(src: string): string[] {
  const out: string[] = []
  let i = 0
  const readTemplate = (): string => {
    const start = i
    i++ // opening backtick
    while (i < src.length) {
      const c = src[i]!
      if (c === '\\') i += 2
      else if (c === '`') {
        i++
        return src.slice(start, i)
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2
        let depth = 1
        while (i < src.length && depth > 0) {
          const d = src[i]!
          if (d === '`') readTemplate()
          else if (d === "'" || d === '"') readQuoted()
          else {
            if (d === '{') depth++
            else if (d === '}') depth--
            i++
          }
        }
      } else i++
    }
    return src.slice(start)
  }
  const readQuoted = (): string => {
    const q = src[i]!
    const start = i
    i++
    while (i < src.length && src[i] !== q && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1
    i++
    return src.slice(start, i)
  }
  while (i < src.length) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
    } else if (c === '`') out.push(readTemplate())
    else if (c === "'" || c === '"') out.push(readQuoted())
    else i++
  }
  return out
}

const isSource = (f: string): boolean => f.endsWith('.ts') && !/\.(test|dbtest|testutil|perf\.dbtest)\.ts$/.test(f) && !f.endsWith('.testutil.ts')
const aiFiles = (readdirSync(AI_DIR, { recursive: true }) as string[]).filter(isSource).map((f) => `ai/${f.split('\\').join('/')}`)
const files = [...readdirSync(DIR).filter(isSource), ...aiFiles]
const pathOf = (f: string): string => (f.startsWith('ai/') ? join(AI_DIR, f.slice(3)) : join(DIR, f))

describe('MOVES_STOCK lint', () => {
  it('the scanner sees nested templates and skips comments', () => {
    const s = sqlStrings('// FROM inventory_lines\nconst a = `SELECT ${x ? `AND ${MOVES_STOCK}` : \'\'} FROM inventory_lines il`; /* inventory_lines */')
    expect(s).toEqual(['`SELECT ${x ? `AND ${MOVES_STOCK}` : \'\'} FROM inventory_lines il`'])
  })

  it('every inventory_lines query in services filters MOVES_STOCK or is allowlisted with a reason', () => {
    const offenders: string[] = []
    const used = new Set<number>()
    for (const f of files) {
      const src = readFileSync(pathOf(f), 'utf8')
      for (const s of sqlStrings(src)) {
        if (!s.includes('inventory_lines')) continue
        if (s.includes('MOVES_STOCK') || s.includes('moves_stock')) continue
        const k = ALLOW.findIndex((a) => a.file === f && s.includes(a.contains))
        if (k === -1) offenders.push(`${f}: ${s.slice(0, 160).replace(/\s+/g, ' ')}`)
        else used.add(k)
      }
    }
    expect(offenders, 'a stock reader without MOVES_STOCK — add the filter, or allowlist it with a reason').toEqual([])
    // Stale allowlist entries hide nothing but mislead: each must still match something.
    expect(ALLOW.filter((_a, k) => !used.has(k)).map((a) => `${a.file}: ${a.contains}`)).toEqual([])
  })

  it('the readers the design names do filter it', () => {
    const must: [string, string][] = [
      ['stockAnalysis.ts', 'function loadMovements'],
      ['stockAnalysis.ts', 'export function batchStock'],
      ['stockAnalysis.ts', 'export function itemMovements'],
      ['stockAnalysis.ts', 'export function stockMovements'],
      ['stockAnalysis.ts', 'export function voucherCosting'],
      ['vouchers.ts', 'export function checkStock'],
      ['serials.ts', 'export function rebuildItemSerials'],
      ['reports.ts', 'export function stockAgeing']
    ]
    for (const [f, fn] of must) {
      const src = readFileSync(join(DIR, f), 'utf8')
      const start = src.indexOf(fn)
      expect(start, `${f} ${fn}`).toBeGreaterThan(-1)
      const next = src.indexOf('\nexport function', start + fn.length)
      const body = src.slice(start, next === -1 ? undefined : next)
      expect(body.includes('MOVES_STOCK'), `${f} ${fn} must filter MOVES_STOCK`).toBe(true)
    }
  })
})
