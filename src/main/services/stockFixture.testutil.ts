// Test-only: a deterministic, randomised inventory fixture seeded by raw INSERTs in one
// transaction. Shared by the legacy-valuation parity snapshot (stockValuation.dbtest.ts) and the
// valuation perf guard (stockValuation.perf.dbtest.ts). Not a test file — no describe/it here,
// and never imported by app code.
//
// It deliberately exercises every corner the valuation engine has: FIFO and weighted-average
// items, openings, purchases/sales/credit and debit notes, stock journals with mixed in/out lines
// (in-before-out line orders, same-item godown transfers, zero-amount inward lines, Dr/Cr ledger
// lines = additional cost), physical-stock absolute counts, overdraws (FIFO deficit backfill),
// many vouchers on the same date, tied line_order values, and soft-deleted / post-dated /
// optional vouchers that must stay out of the books.
import type { DB } from '../db/connection'

export interface StockFixtureOptions {
  vouchers: number
  items: number
  seed?: number
  /** Days the voucher dates spread over, starting 2025-04-01. */
  days?: number
}

export interface StockFixture {
  itemIds: number[]
  godownIds: number[]
  /** Stock-journal vouchers with both outward and inward lines (candidates for 'derived'). */
  mixedJournalIds: number[]
  inventoryLines: number
}

/** mulberry32 — tiny deterministic PRNG (the fixture must be identical on every run). */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedStockFixture(db: DB, opts: StockFixtureOptions): StockFixture {
  const rand = prng(opts.seed ?? 20261007)
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!
  const days = opts.days ?? 365
  const vt = (kind: string): number =>
    (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
  const g = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const unit =
    (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number } | undefined)?.id ??
    Number(db.prepare("INSERT INTO units (name, symbol, decimals) VALUES ('Numbers', 'nos', 0)").run().lastInsertRowid)
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id

  const itemIds: number[] = []
  const godownIds: number[] = []
  const mixedJournalIds: number[] = []
  let inventoryLines = 0
  db.transaction(() => {
    const freight = Number(
      db.prepare('INSERT INTO ledgers (name, group_id) VALUES (?, ?)').run('Fixture Freight Inward', g('Direct Expenses')).lastInsertRowid
    )
    const insGodown = db.prepare('INSERT INTO godowns (name) VALUES (?)')
    for (let i = 0; i < 3; i++) godownIds.push(Number(insGodown.run(`Fixture Godown ${i}`).lastInsertRowid))
    const insItem = db.prepare(
      'INSERT INTO stock_items (name, unit_id, opening_qty_milli, opening_value, valuation_method) VALUES (?, ?, ?, ?, ?)'
    )
    for (let i = 0; i < opts.items; i++) {
      const hasOpening = i % 3 !== 2
      const q = hasOpening ? int(1, 200) * 1000 : 0
      const v = hasOpening ? (q / 1000) * int(50, 900) * 100 + int(0, 99) : 0
      itemIds.push(Number(insItem.run(`Fixture Item ${i}`, unit, q, v, i % 3 === 0 ? 'fifo' : 'weighted_avg').lastInsertRowid))
    }

    const kinds = {
      purchase: vt('purchase'), sales: vt('sales'), credit_note: vt('credit_note'), debit_note: vt('debit_note'),
      stock_journal: vt('stock_journal'), physical_stock: vt('physical_stock')
    }
    const insV = db.prepare(
      'INSERT INTO vouchers (voucher_type_id, date, number, post_dated, is_optional, deleted_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const insL = db.prepare('INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)')
    const insI = db.prepare(
      `INSERT INTO inventory_lines (voucher_id, stock_item_id, godown_id, qty_milli, rate_paise, amount, direction, line_order, is_absolute)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const start = Date.UTC(2025, 3, 1)
    const qty = (): number => int(1, 40) * 1000 + (rand() < 0.2 ? int(1, 999) : 0)
    const amt = (q: number): number => Math.round((q * int(40, 1200)) / 10) + int(0, 99)
    const godown = (): number | null => (rand() < 0.25 ? null : pick(godownIds))
    type Line = [item: number, gd: number | null, q: number, amount: number, dir: 'in' | 'out', abs: number]

    for (let n = 0; n < opts.vouchers; n++) {
      const date = new Date(start + int(0, days - 1) * 86_400_000).toISOString().slice(0, 10)
      const r = rand()
      const kind: keyof typeof kinds =
        r < 0.3 ? 'purchase' : r < 0.62 ? 'sales' : r < 0.67 ? 'credit_note' : r < 0.72 ? 'debit_note' : r < 0.94 ? 'stock_journal' : 'physical_stock'
      const flag = rand()
      const deleted = flag < 0.03 ? '2026-01-01 00:00:00' : null
      const postDated = flag >= 0.03 && flag < 0.05 ? 1 : 0
      const optional = flag >= 0.05 && flag < 0.07 ? 1 : 0
      const vid = Number(insV.run(kinds[kind], date, `FX-${n}`, postDated, optional, deleted).lastInsertRowid)

      const lines: Line[] = []
      const count = int(1, 3)
      if (kind === 'purchase' || kind === 'credit_note') {
        for (let k = 0; k < count; k++) { const q = qty(); lines.push([pick(itemIds), godown(), q, amt(q), 'in', 0]) }
      } else if (kind === 'sales' || kind === 'debit_note') {
        for (let k = 0; k < count; k++) { const q = qty(); lines.push([pick(itemIds), godown(), q, amt(q), 'out', 0]) }
      } else if (kind === 'physical_stock') {
        const c = int(1, 2)
        for (let k = 0; k < c; k++) lines.push([pick(itemIds), godown(), rand() < 0.1 ? 0 : qty() * 2, 0, 'in', 1])
      } else {
        mixedJournalIds.push(vid)
        const outs = int(1, 3)
        for (let k = 0; k < outs; k++) { const q = qty(); lines.push([pick(itemIds), godown(), q, amt(q), 'out', 0]) }
        if (rand() < 0.15) {
          // Godown transfer of the same item (out of one godown, into another).
          const [it, , q] = lines[0]!
          lines.push([it, pick(godownIds), q, rand() < 0.5 ? 0 : amt(q), 'in', 0])
        } else {
          const ins = int(1, 2)
          for (let k = 0; k < ins; k++) { const q = qty(); lines.push([pick(itemIds), godown(), q, rand() < 0.15 ? 0 : amt(q), 'in', 0]) }
        }
        // Some journals list inward lines before outward ones.
        if (rand() < 0.3) lines.reverse()
        if (rand() < 0.4) {
          const extra = int(1, 50_000)
          insL.run(vid, freight, 'dr', extra, 0)
          insL.run(vid, cash, 'cr', extra, 1)
        }
      }
      const tiedOrder = rand() < 0.1 // every line_order 0 — the id tie-break decides
      lines.forEach(([item, gd, q, amount, dir, abs], i) => {
        insI.run(vid, item, gd, q, q > 0 ? Math.round((amount * 1000) / q) : 0, amount, dir, tiedOrder ? 0 : i, abs)
        inventoryLines++
      })
    }
  })()
  return { itemIds, godownIds, mixedJournalIds, inventoryLines }
}
