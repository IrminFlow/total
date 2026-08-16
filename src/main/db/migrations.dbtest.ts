import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshDb } from './testdb'

const EXPECTED_TABLES = [
  'meta',
  'groups',
  'ledgers',
  'voucher_types',
  'vouchers',
  'voucher_lines',
  'stock_groups',
  'units',
  'stock_items',
  'godowns',
  'inventory_lines',
  'audit_log',
  'currencies',
  'bom_lines',
  'employees',
  'payroll_runs',
  'payroll_lines',
  'users',
  'tds_sections',
  'tds_entries',
  'cost_centres',
  'voucher_line_cost_allocations',
  'bill_refs',
  'recurring_templates',
  'bank_rules',
  'budgets',
  'budget_lines',
  'batches',
  'price_levels',
  'price_list_rates',
  'migrations'
]

describe('migrate', () => {
  it('applies every migration exactly once and records them all', () => {
    const db = freshDb()
    const row = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
    expect(row.n).toBe(MIGRATIONS.length)
  })

  it('running migrate again is a no-op', () => {
    const db = freshDb()
    migrate(db)
    const row = db.prepare('SELECT COUNT(*) AS n FROM migrations').get() as { n: number }
    expect(row.n).toBe(MIGRATIONS.length)
  })

  it('creates exactly the expected tables', () => {
    const db = freshDb()
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual([...EXPECTED_TABLES].sort())
  })

  it('creates the partial index backing the bin (deleted_at lookups)', () => {
    const db = freshDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_vouchers_deleted'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('idx_vouchers_deleted')
  })

  it('creates the audit_log indexes and the user_name/app_version columns', () => {
    const db = freshDb()
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(indexNames).toEqual(expect.arrayContaining(['idx_audit_at', 'idx_audit_entity']))

    const columns = (db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'entity', 'entity_id', 'action', 'at', 'before_json', 'after_json', 'user_name', 'app_version'])
    )
  })

  it('creates the users table with the expected columns and role CHECK constraint', () => {
    const db = freshDb()
    const columns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'name', 'pin_hash', 'role', 'active', 'created_at'])
    )

    db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Owner', 'x', 'owner')").run()
    expect(() =>
      db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Bad', 'x', 'superuser')").run()
    ).toThrow()
  })

  it('users.name is unique case-insensitively', () => {
    const db = freshDb()
    db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Alice', 'x', 'owner')").run()
    expect(() =>
      db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('alice', 'x', 'accountant')").run()
    ).toThrow()
  })

  it('creates the covering perf indexes and drops the superseded single-column ledger index', () => {
    const db = freshDb()
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_lines_ledger_voucher',
        'idx_lines_voucher_drcr_amount',
        'idx_vouchers_type_date',
        'idx_vouchers_party'
      ])
    )
    expect(indexNames).not.toContain('idx_lines_ledger')
  })

  it('seeds the five standard tds_sections with the plan\'s rates/thresholds (paise)', () => {
    const db = freshDb()
    const rows = (
      db.prepare('SELECT code, description, rate, threshold_single, threshold_annual FROM tds_sections ORDER BY code').all() as {
        code: string; description: string; rate: number; threshold_single: number; threshold_annual: number
      }[]
    )
    expect(rows.map((r) => r.code)).toEqual(['194A', '194C', '194H', '194I', '194J'])
    const byCode = new Map(rows.map((r) => [r.code, r]))
    expect(byCode.get('194C')).toMatchObject({ rate: 2, threshold_single: 3000000, threshold_annual: 10000000 })
    expect(byCode.get('194J')).toMatchObject({ rate: 10, threshold_single: 3000000, threshold_annual: 3000000 })
    expect(byCode.get('194I')).toMatchObject({ rate: 10, threshold_single: 0, threshold_annual: 24000000 })
    expect(byCode.get('194H')).toMatchObject({ rate: 2, threshold_single: 0, threshold_annual: 1500000 })
    expect(byCode.get('194A')).toMatchObject({ rate: 10, threshold_single: 0, threshold_annual: 500000 })
  })

  it('adds tds_section_id/pan/credit_days/export_type to ledgers and barcode to stock_items', () => {
    const db = freshDb()
    const ledgerColumns = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).map((c) => c.name)
    expect(ledgerColumns).toEqual(
      expect.arrayContaining(['tds_section_id', 'pan', 'credit_days', 'export_type'])
    )
    const itemColumns = (db.prepare('PRAGMA table_info(stock_items)').all() as { name: string }[]).map((c) => c.name)
    expect(itemColumns).toContain('barcode')
  })

  it('creates the cost-centre / bill-ref indexes and the partial unique barcode index', () => {
    const db = freshDb()
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_vlca_cc',
        'idx_bill_refs_party',
        'idx_stock_items_barcode',
        'idx_tds_entries_voucher',
        'idx_tds_entries_party_section'
      ])
    )
  })

  it('barcode uniqueness only applies to non-null values', () => {
    const db = freshDb()
    const unitId = db.prepare("INSERT INTO units (name, symbol, decimals, uqc) VALUES ('Nos','Nos',0,'NOS')").run()
      .lastInsertRowid
    db.prepare('INSERT INTO stock_items (name, unit_id, barcode) VALUES (?, ?, NULL)').run('Item A', unitId)
    db.prepare('INSERT INTO stock_items (name, unit_id, barcode) VALUES (?, ?, NULL)').run('Item B', unitId)
    db.prepare('INSERT INTO stock_items (name, unit_id, barcode) VALUES (?, ?, ?)').run('Item C', unitId, '12345')
    expect(() =>
      db.prepare('INSERT INTO stock_items (name, unit_id, barcode) VALUES (?, ?, ?)').run('Item D', unitId, '12345')
    ).toThrow()
  })

  it('adds suffix/pad_width/restart_fy to voucher_types with the documented defaults', () => {
    const db = freshDb()
    const columns = (db.prepare('PRAGMA table_info(voucher_types)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['suffix', 'pad_width', 'restart_fy']))

    const id = db.prepare("INSERT INTO voucher_types (name, kind) VALUES ('Sales (test)', 'sales')").run().lastInsertRowid
    const row = db
      .prepare('SELECT suffix, pad_width, restart_fy FROM voucher_types WHERE id = ?')
      .get(id) as { suffix: string; pad_width: number; restart_fy: number }
    expect(row).toEqual({ suffix: '', pad_width: 0, restart_fy: 1 })
  })

  it('export_type is constrained to the four SEZ/export codes', () => {
    const db = freshDb() // no seed data — groups is empty until a company is seeded, so insert one
    const groupId = Number(
      db.prepare("INSERT INTO groups (name, nature, is_system) VALUES ('Test Group', 'liability', 0)").run().lastInsertRowid
    )
    expect(() =>
      db
        .prepare("INSERT INTO ledgers (name, group_id, export_type) VALUES ('Bad Party', ?, 'not_a_type')")
        .run(groupId)
    ).toThrow()
    expect(() =>
      db
        .prepare("INSERT INTO ledgers (name, group_id, export_type) VALUES ('SEZ Party', ?, 'sez_wp')")
        .run(groupId)
    ).not.toThrow()
  })

  it('adds voucher_type_id to recurring_templates, nullable and FK-referencing voucher_types', () => {
    const db = freshDb()
    const columns = (db.prepare('PRAGMA table_info(recurring_templates)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toContain('voucher_type_id')

    const vtId = db.prepare("INSERT INTO voucher_types (name, kind) VALUES ('Journal (test)', 'journal')").run().lastInsertRowid
    db.prepare(
      `INSERT INTO recurring_templates (name, voucher_json, cadence, day_of_month, next_due, voucher_type_id)
       VALUES ('Rent', '{}', 'monthly', 5, '2026-09-05', ?)`
    ).run(vtId)
    const row = db.prepare('SELECT voucher_type_id FROM recurring_templates WHERE name = ?').get('Rent') as {
      voucher_type_id: number
    }
    expect(row.voucher_type_id).toBe(Number(vtId))
  })

  it('creates bank_rules with the documented defaults and a kind CHECK constraint', () => {
    const db = freshDb()
    const columns = (db.prepare('PRAGMA table_info(bank_rules)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining(['id', 'pattern', 'match_field', 'ledger_id', 'kind', 'active', 'hits'])
    )

    const groupId = Number(
      db.prepare("INSERT INTO groups (name, nature, is_system) VALUES ('Test Group', 'liability', 0)").run().lastInsertRowid
    )
    const ledgerId = Number(
      db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Test Ledger', ?)").run(groupId).lastInsertRowid
    )
    const id = db
      .prepare("INSERT INTO bank_rules (pattern, ledger_id, kind) VALUES ('ACME', ?, 'payment')")
      .run(ledgerId).lastInsertRowid
    const row = db.prepare('SELECT match_field, active, hits FROM bank_rules WHERE id = ?').get(id) as {
      match_field: string; active: number; hits: number
    }
    expect(row).toEqual({ match_field: 'description', active: 1, hits: 0 })

    expect(() =>
      db.prepare("INSERT INTO bank_rules (pattern, ledger_id, kind) VALUES ('X', ?, 'not_a_kind')").run(ledgerId)
    ).toThrow()
  })

  it('creates budgets/budget_lines, enforces the name+FY uniqueness and the ledger-XOR-group CHECK, and cascades line deletes', () => {
    const db = freshDb()
    const groupId = Number(
      db.prepare("INSERT INTO groups (name, nature, is_system) VALUES ('Test Group', 'expense', 0)").run().lastInsertRowid
    )
    const ledgerId = Number(
      db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Test Ledger', ?)").run(groupId).lastInsertRowid
    )
    const budgetId = Number(
      db.prepare("INSERT INTO budgets (name, fy_start_year) VALUES ('FY26 Budget', 2025)").run().lastInsertRowid
    )

    expect(() =>
      db.prepare("INSERT INTO budgets (name, fy_start_year) VALUES ('FY26 Budget', 2025)").run()
    ).toThrow()

    expect(() =>
      db.prepare('INSERT INTO budget_lines (budget_id, ledger_id, group_id, amount) VALUES (?, NULL, NULL, 1000)').run(budgetId)
    ).toThrow()
    expect(() =>
      db.prepare('INSERT INTO budget_lines (budget_id, ledger_id, group_id, amount) VALUES (?, ?, ?, 1000)').run(budgetId, ledgerId, groupId)
    ).toThrow()

    const lineId = db
      .prepare('INSERT INTO budget_lines (budget_id, ledger_id, month, amount) VALUES (?, ?, ?, ?)')
      .run(budgetId, ledgerId, '2025-04', 500000).lastInsertRowid

    db.prepare('DELETE FROM budgets WHERE id = ?').run(budgetId)
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM budget_lines WHERE id = ?').get(lineId) as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('014: inventory-depth columns, batches uniqueness, and price-level cascade', () => {
    const db = freshDb()

    // New columns exist with the expected defaults.
    const stockCols = (db.prepare('PRAGMA table_info(stock_items)').all() as { name: string }[]).map((c) => c.name)
    expect(stockCols).toContain('valuation_method')
    const invCols = (db.prepare('PRAGMA table_info(inventory_lines)').all() as { name: string }[]).map((c) => c.name)
    expect(invCols).toEqual(expect.arrayContaining(['batch_id', 'is_absolute']))
    const ledgerCols = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).map((c) => c.name)
    expect(ledgerCols).toEqual(expect.arrayContaining(['price_level_id', 'credit_limit']))
    const voucherCols = (db.prepare('PRAGMA table_info(vouchers)').all() as { name: string }[]).map((c) => c.name)
    expect(voucherCols).toEqual(expect.arrayContaining(['post_dated', 'is_optional']))
    const godownCols = (db.prepare('PRAGMA table_info(godowns)').all() as { name: string }[]).map((c) => c.name)
    expect(godownCols).toContain('address')

    // valuation_method CHECK constraint.
    db.prepare("INSERT INTO units (name, symbol) VALUES ('Nos', 'nos')").run()
    const unitId = Number(db.prepare("SELECT id FROM units WHERE name = 'Nos'").get()!['id' as never])
    db.prepare("INSERT INTO stock_items (name, unit_id, valuation_method) VALUES ('Widget', ?, 'fifo')").run(unitId)
    expect(() =>
      db.prepare("INSERT INTO stock_items (name, unit_id, valuation_method) VALUES ('Bad', ?, 'lifo')").run(unitId)
    ).toThrow()
    const itemId = Number(db.prepare("SELECT id FROM stock_items WHERE name = 'Widget'").get()!['id' as never])

    // Batch names are unique per item, not globally.
    db.prepare("INSERT INTO batches (stock_item_id, name) VALUES (?, 'B-1')").run(itemId)
    expect(() => db.prepare("INSERT INTO batches (stock_item_id, name) VALUES (?, 'B-1')").run(itemId)).toThrow()
    db.prepare("INSERT INTO stock_items (name, unit_id) VALUES ('Gadget', ?)").run(unitId)
    const otherId = Number(db.prepare("SELECT id FROM stock_items WHERE name = 'Gadget'").get()!['id' as never])
    db.prepare("INSERT INTO batches (stock_item_id, name) VALUES (?, 'B-1')").run(otherId)

    // Deleting a price level cascades its rates.
    const levelId = Number(db.prepare("INSERT INTO price_levels (name) VALUES ('Wholesale')").run().lastInsertRowid)
    db.prepare('INSERT INTO price_list_rates (price_level_id, stock_item_id, rate, effective_from) VALUES (?, ?, 10000, ?)')
      .run(levelId, itemId, '2025-04-01')
    db.prepare('DELETE FROM price_levels WHERE id = ?').run(levelId)
    const rates = db.prepare('SELECT COUNT(*) AS n FROM price_list_rates').get() as { n: number }
    expect(rates.n).toBe(0)
  })
})
