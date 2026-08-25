import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { todayISO } from '@shared/dates'
import { openCompanyDb } from '../db/connection'
import { companyDbPath } from '../paths'
import { trialBalance, stockSummary } from './reports'
import { getFeatures } from './config'
import { getBom, itemsWithBom } from './extras'
import { createDemoCompany } from './demo'
import { DEMO_TRADES, demoProfile } from '@shared/demo'

// createDemoCompany() derives every path from paths.ts#dataRoot(), which honours
// TOTAL_DATA_DIR — point the whole storage tree at a throwaway temp dir per test so
// nothing here touches a real ~/Documents/total.
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'total-demo-'))
  process.env.TOTAL_DATA_DIR = dataDir
})

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

describe('createDemoCompany', () => {
  it('creates a company whose database exists and is registered under a slugified name', () => {
    const { slug } = createDemoCompany()
    expect(slug).toBe('demo-traders')
    expect(existsSync(companyDbPath(slug))).toBe(true)
  })

  it('produces a trial balance that balances', () => {
    const { slug } = createDemoCompany()
    const db = openCompanyDb(slug)
    const tb = trialBalance(db, todayISO())
    expect(tb.totalDebit).toBe(tb.totalCredit)
    expect(tb.totalDebit).toBeGreaterThan(0)
    db.close()
  })

  it('posts around 40 vouchers (14 sales, 8 purchase, 8 receipt, 6 payment, 2 contra, 2 journal)', () => {
    const { slug } = createDemoCompany()
    const db = openCompanyDb(slug)
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL').get() as { n: number }
    expect(n).toBe(40)
    const kinds = db
      .prepare(
        `SELECT vt.kind AS kind, COUNT(*) AS n FROM vouchers v
         JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE v.deleted_at IS NULL GROUP BY vt.kind`
      )
      .all() as { kind: string; n: number }[]
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]))
    expect(byKind.sales).toBe(14)
    expect(byKind.purchase).toBe(8)
    expect(byKind.receipt).toBe(8)
    expect(byKind.payment).toBe(6)
    expect(byKind.contra).toBe(2)
    expect(byKind.journal).toBe(2)
    db.close()
  })

  it('dedupes the slug when a demo company already exists', () => {
    const first = createDemoCompany()
    const second = createDemoCompany()
    expect(first.slug).toBe('demo-traders')
    expect(second.slug).toBe('demo-traders-2')
  })

  it('still builds Demo Traders when no trade is asked for', () => {
    // Backward compatibility, stated as a test: every existing caller passes nothing.
    expect(createDemoCompany().slug).toBe('demo-traders')
    expect(createDemoCompany('trading').slug).toBe('demo-traders-2')
  })
})

// ---------- one sample per trade (roadmap #293) ----------

/** Vouchers whose lines do not sum dr === cr. Must always be empty, in every sample. */
function unbalancedVouchers(db: ReturnType<typeof openCompanyDb>): { id: number; dr: number; cr: number }[] {
  return db
    .prepare(
      `SELECT v.id AS id,
              COALESCE(SUM(CASE WHEN l.dr_cr = 'dr' THEN l.amount ELSE 0 END), 0) AS dr,
              COALESCE(SUM(CASE WHEN l.dr_cr = 'cr' THEN l.amount ELSE 0 END), 0) AS cr
       FROM vouchers v LEFT JOIN voucher_lines l ON l.voucher_id = v.id
       WHERE v.deleted_at IS NULL
       GROUP BY v.id HAVING dr <> cr`
    )
    .all() as { id: number; dr: number; cr: number }[]
}

describe.each([...DEMO_TRADES])('the %s sample', (trade) => {
  it('balances — trial balance and every single voucher', () => {
    const { slug } = createDemoCompany(trade)
    const db = openCompanyDb(slug)
    try {
      const tb = trialBalance(db, todayISO())
      expect(tb.totalDebit).toBe(tb.totalCredit)
      expect(tb.totalDebit).toBeGreaterThan(0)
      // A stock journal has no ledger lines at all, so it is 0 === 0 — still balanced.
      expect(unbalancedVouchers(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('creates exactly the masters its profile describes, and posts every one of its vouchers', () => {
    const profile = demoProfile(trade)
    const { slug } = createDemoCompany(trade)
    const db = openCompanyDb(slug)
    try {
      const items = db.prepare('SELECT name FROM stock_items ORDER BY name').all() as { name: string }[]
      expect(items.map((i) => i.name).sort()).toEqual(profile.items.map((i) => i.name).sort())
      for (const p of profile.parties) {
        expect(db.prepare('SELECT COUNT(*) AS n FROM ledgers WHERE name = ?').get(p.name)).toEqual({ n: 1 })
      }
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL').get() as { n: number }
      expect(n).toBe(profile.vouchers(todayISO()).length)
    } finally {
      db.close()
    }
  })
})

describe('the services sample', () => {
  it('has no stock items and no inventory feature — a practice does not keep a shelf', () => {
    const { slug } = createDemoCompany('services')
    const db = openCompanyDb(slug)
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM stock_items').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM inventory_lines').get()).toEqual({ n: 0 })
      expect(getFeatures(db).inventory).toBe(false)
      // Only inventory is switched off — the rest of the F11 defaults are untouched.
      expect(getFeatures(db).billWise).toBe(true)
      expect(stockSummary(db, todayISO())).toEqual([])
    } finally {
      db.close()
    }
  })

  it('registers under its own name, so it can sit beside the trading sample', () => {
    expect(createDemoCompany('services').slug).toBe('demo-consulting')
    expect(createDemoCompany('trading').slug).toBe('demo-traders')
  })
})

describe('the manufacturing sample', () => {
  it('keeps inventory on and carries a work-in-progress item', () => {
    const { slug } = createDemoCompany('manufacturing')
    const db = openCompanyDb(slug)
    try {
      expect(getFeatures(db).inventory).toBe(true)
      const wip = db.prepare('SELECT id FROM stock_items WHERE name = ?').get('Pulley Housing (WIP)')
      expect(wip).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('closes with stock of both the work in progress and the finished goods', () => {
    const { slug } = createDemoCompany('manufacturing')
    const db = openCompanyDb(slug)
    try {
      const rows = stockSummary(db, todayISO())
      const qty = (name: string): number => rows.find((r) => r.name === name)!.closingQtyMilli
      // Made and not yet consumed, made and not yet sold: the WIP stage is visible on the stock
      // summary rather than being an idea in a comment.
      expect(qty('Pulley Housing (WIP)')).toBeGreaterThan(0)
      expect(qty('Idler Pulley Assembly')).toBeGreaterThan(0)
      expect(qty('Conveyor Roller 600mm')).toBeGreaterThan(0)
      for (const r of rows) expect(r.closingQtyMilli, r.name).toBeGreaterThanOrEqual(0)
      // A produced item is worth what went into it, so it carries value as well as quantity.
      expect(rows.find((r) => r.name === 'Pulley Housing (WIP)')!.closingValue).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('writes a real bill of materials into bom_lines, not a demo-only copy of one', () => {
    const profile = demoProfile('manufacturing')
    const { slug } = createDemoCompany('manufacturing')
    const db = openCompanyDb(slug)
    try {
      // itemsWithBom() is what the Manufacture voucher's picker reads — if the sample is not in
      // there, the screen the sample exists to demonstrate comes up empty.
      const withBom = itemsWithBom(db)
      expect(withBom.map((i) => i.name).sort()).toEqual(profile.bom.map((b) => b.itemName).sort())

      for (const b of profile.bom) {
        const { id } = db.prepare('SELECT id FROM stock_items WHERE name = ?').get(b.itemName) as { id: number }
        const lines = getBom(db, id)
        expect(lines.map((l) => l.componentName).sort()).toEqual(b.components.map((c) => c.itemName).sort())
        for (const c of b.components) {
          expect(lines.find((l) => l.componentName === c.itemName)!.qtyMilliPerUnit).toBe(c.qtyMilliPerUnit)
        }
      }
    } finally {
      db.close()
    }
  })
})
