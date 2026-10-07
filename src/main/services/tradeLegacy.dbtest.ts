// WP 2.5a legacy proof (design §3.4): books with no trade links (Demo Traders) produce
// byte-identical stock, trial balance, P&L and GSTR-1 figures after the trade-cycle schema
// (migrations 024–025) and the new code paths. The file snapshot was generated on origin/main
// BEFORE any WP 2.5a change; never regenerate it (`-u`) — a diff here is a legacy regression.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import type { DB } from '../db/connection'
import { openCompanyDb } from '../db/connection'
import { migrate } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations'
import { readCompanyInfo } from '../db/seed'
import { createDemoCompany } from './demo'
import * as reports from './reports'
import * as stockAnalysis from './stockAnalysis'
import { gstr1 } from './gst'
import { fyOf } from '@shared/dates'

const TODAY = '2026-08-15'

function figures(db: DB): unknown {
  const fy = fyOf(TODAY)
  const company = readCompanyInfo(db)
  const items = (db.prepare('SELECT id FROM stock_items ORDER BY id').all() as { id: number }[]).map((r) => r.id)
  return {
    stockSummary: stockAnalysis.stockSummary(db, TODAY),
    stockByGodown: stockAnalysis.stockByGodown(db, TODAY),
    stockValuesAt: [...stockAnalysis.stockValuesAt(db, ['2026-05-31', '2026-06-30', TODAY]).entries()],
    movements: items.map((id) => stockAnalysis.stockMovements(db, id, fy.from, TODAY)),
    negativeStock: stockAnalysis.negativeStock(db, TODAY),
    stockAgeing: reports.stockAgeing(db, TODAY),
    itemProfitability: reports.itemProfitability(db, fy.from, TODAY),
    trialBalance: reports.trialBalance(db, TODAY),
    profitAndLoss: reports.profitAndLoss(db, fy.from, TODAY),
    gstr1: gstr1(db, company, '2026-07-01', '2026-07-31', '072026')
  }
}

/** First migration of WP 2.5a (the voucher-kinds rebuild); everything before it is "legacy". */
const firstTradeMigration = (): number => {
  const i = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE voucher_kinds'))
  return i === -1 ? MIGRATIONS.length : i
}

/** Copy `src` (latest schema) into a DB holding only the legacy migrations, column by column. */
function legacyCopy(src: DB): DB {
  const n = firstTradeMigration()
  const db = new Database(':memory:')
  db.exec('CREATE TABLE migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  for (let i = 0; i < n; i++) {
    db.exec(MIGRATIONS[i]!)
    db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(i + 1, 'legacy')
  }
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('migrations', 'sqlite_sequence')").all() as { name: string }[]
  ).map((t) => t.name)
  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run()
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
      const srcCols = new Set((src.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name))
      const common = cols.filter((c) => srcCols.has(c))
      // The stock-note voucher types are what migration 024 itself adds — a legacy book has none.
      const where = t === 'voucher_types' ? " WHERE kind NOT IN ('delivery_note', 'receipt_note')" : ''
      const rows = src.prepare(`SELECT ${common.join(', ')} FROM ${t}${where}`).all() as Record<string, unknown>[]
      const ins = db.prepare(`INSERT INTO ${t} (${common.join(', ')}) VALUES (${common.map((c) => '@' + c).join(', ')})`)
      for (const r of rows) ins.run(r)
    }
    db.prepare('DELETE FROM sqlite_sequence').run()
    for (const r of src.prepare('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]) {
      if (tables.includes(r.name)) db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(r.name, r.seq)
    }
  })()
  db.pragma('foreign_keys = ON')
  return db
}

let dataDir: string
let demo: DB

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${TODAY}T10:00:00`))
  dataDir = mkdtempSync(join(tmpdir(), 'total-legacy-'))
  process.env.TOTAL_DATA_DIR = dataDir
  const { slug } = createDemoCompany()
  demo = openCompanyDb(slug)
})

afterAll(() => {
  demo.close()
  vi.useRealTimers()
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

describe('legacy books are unchanged by WP 2.5a', () => {
  it('Demo Traders figures equal the pre-WP 2.5a snapshot', async () => {
    await expect(JSON.stringify(figures(demo), null, 1)).toMatchFileSnapshot('./__snapshots__/tradeLegacy.demo.json')
  })

  it('a legacy copy of Demo Traders, migrated forward, reports the same figures', async () => {
    const legacy = legacyCopy(demo)
    expect(legacy.prepare("SELECT COUNT(*) AS n FROM voucher_types WHERE name IN ('Delivery Note', 'Receipt Note')").get()).toEqual({ n: 0 })
    migrate(legacy)
    // The migration really ran on the copy: new kinds seeded, every line given a uid.
    expect(legacy.prepare("SELECT COUNT(*) AS n FROM voucher_types WHERE kind IN ('delivery_note', 'receipt_note')").get()).toEqual({ n: 2 })
    expect(legacy.prepare('SELECT COUNT(*) AS n FROM inventory_lines WHERE line_uid IS NULL OR moves_stock <> 1').get()).toEqual({ n: 0 })
    await expect(JSON.stringify(figures(legacy), null, 1)).toMatchFileSnapshot('./__snapshots__/tradeLegacy.demo.json')
    legacy.close()
  })
})
