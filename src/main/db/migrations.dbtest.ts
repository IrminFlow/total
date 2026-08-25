import { describe, it, expect } from 'vitest'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations'
import { MIGRATION_HASHES } from './migrationHashes'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshDb, freshPartialDb } from './testdb'

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
  'voucher_transport',
  'batches',
  'price_levels',
  'price_list_rates',
  'pay_heads',
  'employee_pay_heads',
  'gst_filings',
  'asset_blocks',
  'attendance',
  'depreciation_lines',
  'depreciation_runs',
  'employee_loans',
  'fixed_assets',
  'report_views',
  'report_schedules',
  'loan_recoveries',
  'luts',
  'party_notes',
  'bank_import_profiles',
  'bank_narration_memory',
  'landed_costs',
  'counter_sessions',
  'counter_sales',
  'counter_tenders',
  'counter_movements',
  'discount_schemes',
  'sales_documents',
  'sales_document_lines',
  'loans',
  'loan_postings',
  'deposits',
  'cwip_projects',
  'cwip_costs',
  'prepaid_schedules',
  'prepaid_postings',
  'stock_statements',
  'commission_schemes',
  'voucher_drafts',
  'voucher_attachments',
  'bank_detail_requests',
  'cheque_bounces',
  'voucher_templates',
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

  it('adds block_negative as a nullable column, so existing items keep no opinion', () => {
    // NULL is a third state, not a missing false: it means "follow the company setting", which
    // is the only answer a migration can give for an item nobody has expressed a view on.
    const db = freshDb()
    const cols = db.prepare('PRAGMA table_info(stock_items)').all() as { name: string; notnull: number; dflt_value: unknown }[]
    const col = cols.find((c) => c.name === 'block_negative')
    expect(col).toBeDefined()
    expect(col!.notnull).toBe(0)
    expect(col!.dflt_value).toBeNull()
  })

  it('adds employee bank details as nullable, so cash-paid employees still save', () => {
    const db = freshDb()
    const cols = db.prepare('PRAGMA table_info(employees)').all() as { name: string; notnull: number }[]
    for (const name of ['bank_account', 'ifsc']) {
      const col = cols.find((c) => c.name === name)
      expect(col, name).toBeDefined()
      expect(col!.notnull, name).toBe(0)
    }
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

  it('012: creates the FK/covering perf indexes and stock_items.reorder_level_milli', () => {
    const db = freshDb()
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_bill_refs_voucher',
        'idx_vlca_line',
        'idx_budget_lines_budget',
        'idx_payroll_lines_run',
        'idx_payroll_lines_employee',
        'idx_bank_rules_ledger',
        'idx_bom_lines_component',
        'idx_inv_godown',
        'idx_groups_parent',
        'idx_stock_groups_parent',
        'idx_stock_items_group',
        'idx_stock_items_unit',
        'idx_ledgers_tds_section',
        'idx_recurring_templates_vt',
        'idx_cost_centres_parent',
        'idx_inv_item_voucher'
      ])
    )
    const itemColumns = (db.prepare('PRAGMA table_info(stock_items)').all() as { name: string }[]).map((c) => c.name)
    expect(itemColumns).toContain('reorder_level_milli')
    // Nullable with no default — NULL means "no reorder level configured".
    const unitId = db.prepare("INSERT INTO units (name, symbol, decimals, uqc) VALUES ('Pcs','Pcs',0,'NOS')").run()
      .lastInsertRowid
    const id = db.prepare('INSERT INTO stock_items (name, unit_id) VALUES (?, ?)').run('Reorder Item', unitId).lastInsertRowid
    const row = db.prepare('SELECT reorder_level_milli FROM stock_items WHERE id = ?').get(id) as {
      reorder_level_milli: number | null
    }
    expect(row.reorder_level_milli).toBeNull()
  })

  it('013: adds ledgers.rcm/itc_eligibility + vouchers.pos_override and creates voucher_transport (cascade on voucher delete)', () => {
    const db = freshDb()
    const ledgerColumns = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).map((c) => c.name)
    expect(ledgerColumns).toEqual(expect.arrayContaining(['rcm', 'itc_eligibility']))
    const voucherColumns = (db.prepare('PRAGMA table_info(vouchers)').all() as { name: string }[]).map((c) => c.name)
    expect(voucherColumns).toContain('pos_override')

    const groupId = Number(
      db.prepare("INSERT INTO groups (name, nature, is_system) VALUES ('G13', 'liability', 0)").run().lastInsertRowid
    )
    // rcm defaults 0, itc_eligibility defaults 'eligible'; the CHECK rejects unknown values.
    const lid = Number(db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('RCM Party', ?)").run(groupId).lastInsertRowid)
    const lrow = db.prepare('SELECT rcm, itc_eligibility FROM ledgers WHERE id = ?').get(lid) as { rcm: number; itc_eligibility: string }
    expect(lrow).toEqual({ rcm: 0, itc_eligibility: 'eligible' })
    expect(() =>
      db.prepare("INSERT INTO ledgers (name, group_id, itc_eligibility) VALUES ('Bad', ?, 'sometimes')").run(groupId)
    ).toThrow()

    const vtId = Number(db.prepare("INSERT INTO voucher_types (name, kind) VALUES ('Sales G13', 'sales')").run().lastInsertRowid)
    const vId = Number(
      db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-07-01', 'T-1')").run(vtId).lastInsertRowid
    )
    const tColumns = (db.prepare('PRAGMA table_info(voucher_transport)').all() as { name: string }[]).map((c) => c.name)
    expect(tColumns).toEqual(
      expect.arrayContaining([
        'voucher_id', 'trans_mode', 'trans_distance', 'transporter_id', 'transporter_name',
        'trans_doc_no', 'trans_doc_date', 'vehicle_no', 'vehicle_type',
        'ship_to_name', 'ship_to_gstin', 'ship_to_addr1', 'ship_to_addr2',
        'ship_to_place', 'ship_to_pincode', 'ship_to_state'
      ])
    )
    db.prepare("INSERT INTO voucher_transport (voucher_id, trans_mode, ship_to_place) VALUES (?, '1', 'Pune')").run(vId)
    db.prepare('DELETE FROM vouchers WHERE id = ?').run(vId)
    const left = db.prepare('SELECT COUNT(*) AS n FROM voucher_transport WHERE voucher_id = ?').get(vId) as { n: number }
    expect(left.n).toBe(0)
  })

  it('017: adds inventory_lines.discount_paise with a 0 default', () => {
    const db = freshDb()
    const columns = (db.prepare('PRAGMA table_info(inventory_lines)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toContain('discount_paise')

    const unitId = db.prepare("INSERT INTO units (name, symbol, decimals, uqc) VALUES ('Nos','Nos',0,'NOS')").run()
      .lastInsertRowid
    const itemId = db.prepare('INSERT INTO stock_items (name, unit_id) VALUES (?, ?)').run('Widget', unitId).lastInsertRowid
    const vtId = db.prepare("INSERT INTO voucher_types (name, kind) VALUES ('Sales (m17)', 'sales')").run().lastInsertRowid
    const vId = db
      .prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-04-01', '1')")
      .run(vtId).lastInsertRowid
    const ilId = db
      .prepare(
        "INSERT INTO inventory_lines (voucher_id, stock_item_id, qty_milli, rate_paise, amount, direction) VALUES (?, ?, 1000, 100, 100, 'out')"
      )
      .run(vId, itemId).lastInsertRowid
    const row = db.prepare('SELECT discount_paise FROM inventory_lines WHERE id = ?').get(ilId) as {
      discount_paise: number
    }
    expect(row.discount_paise).toBe(0)
  })

  it('017: audit_log accepts the expanded action set but still rejects unknown actions', () => {
    const db = freshDb()
    const insert = db.prepare('INSERT INTO audit_log (entity, entity_id, action) VALUES (?, ?, ?)')
    for (const action of ['create', 'update', 'delete', 'login', 'login_failed', 'logout', 'export', 'import']) {
      expect(() => insert.run('thing', 1, action)).not.toThrow()
    }
    expect(() => insert.run('thing', 1, 'superaction')).toThrow()

    // The rebuild preserved both indexes.
    const indexNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(indexNames).toEqual(expect.arrayContaining(['idx_audit_at', 'idx_audit_entity']))
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

  it('015: creates pay_heads/employee_pay_heads with CHECKs, seeds the three legacy heads, and adds pt_state + payroll_lines columns', () => {
    const db = freshDb()

    const headColumns = (db.prepare('PRAGMA table_info(pay_heads)').all() as { name: string }[]).map((c) => c.name)
    expect(headColumns).toEqual(expect.arrayContaining(['id', 'name', 'kind', 'calc', 'value', 'active']))
    expect(() =>
      db.prepare("INSERT INTO pay_heads (name, kind, calc) VALUES ('Bad', 'not_a_kind', 'flat')").run()
    ).toThrow()
    expect(() =>
      db.prepare("INSERT INTO pay_heads (name, kind, calc) VALUES ('Bad', 'earning', 'not_a_calc')").run()
    ).toThrow()

    const seeded = (db.prepare('SELECT name, kind, calc, value, active FROM pay_heads ORDER BY id').all() as {
      name: string; kind: string; calc: string; value: number; active: number
    }[])
    expect(seeded).toEqual([
      { name: 'Basic', kind: 'earning', calc: 'flat', value: 0, active: 1 },
      { name: 'HRA', kind: 'earning', calc: 'flat', value: 0, active: 1 },
      { name: 'Special Allowance', kind: 'earning', calc: 'flat', value: 0, active: 1 }
    ])

    const empColumns = (db.prepare('PRAGMA table_info(employees)').all() as { name: string; dflt_value: string | null }[])
    expect(empColumns.map((c) => c.name)).toContain('pt_state')
    const empId = Number(db.prepare("INSERT INTO employees (name) VALUES ('Asha')").run().lastInsertRowid)
    const row = db.prepare('SELECT pt_state FROM employees WHERE id = ?').get(empId) as { pt_state: string }
    expect(row.pt_state).toBe('MH')

    const lineColumns = (db.prepare('PRAGMA table_info(payroll_lines)').all() as { name: string }[]).map((c) => c.name)
    expect(lineColumns).toEqual(
      expect.arrayContaining(['other_earnings', 'other_deductions', 'eps_er', 'pf_admin', 'edli', 'heads_json'])
    )

    // (employee_id, pay_head_id) is unique
    const basicId = (db.prepare("SELECT id FROM pay_heads WHERE name = 'Basic'").get() as { id: number }).id
    db.prepare('INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value) VALUES (?, ?, 100)').run(empId, basicId)
    expect(() =>
      db.prepare('INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value) VALUES (?, ?, 200)').run(empId, basicId)
    ).toThrow()
  })

  it('015: migrates existing employees\' basic/hra/special into per-employee head overrides (data, not just schema)', () => {
    // Build a DB stopped just before the payroll-heads migration, insert a legacy employee,
    // then let migrate() finish — the migration must seed that employee's override rows.
    const payrollHeadsIdx = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE pay_heads'))
    expect(payrollHeadsIdx).toBeGreaterThan(0)

    const db = freshPartialDb(payrollHeadsIdx)
    db.prepare(
      "INSERT INTO employees (name, basic, hra, special) VALUES ('Asha', 2000000, 800000, 400000)"
    ).run()
    migrate(db)

    const rows = db
      .prepare(
        `SELECT ph.name, eph.override_value AS v
         FROM employee_pay_heads eph JOIN pay_heads ph ON ph.id = eph.pay_head_id
         JOIN employees e ON e.id = eph.employee_id WHERE e.name = 'Asha' ORDER BY ph.id`
      )
      .all() as { name: string; v: number }[]
    expect(rows).toEqual([
      { name: 'Basic', v: 2000000 },
      { name: 'HRA', v: 800000 },
      { name: 'Special Allowance', v: 400000 }
    ])
  })

  it('016: bank_rules gains min_amount/max_amount (NULL default) and auto_apply defaulting off', () => {
    const db = freshDb()
    const columns = (db.prepare('PRAGMA table_info(bank_rules)').all() as { name: string }[]).map((c) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['min_amount', 'max_amount', 'auto_apply']))

    const groupId = Number(
      db.prepare("INSERT INTO groups (name, nature, is_system) VALUES ('Test Group', 'liability', 0)").run().lastInsertRowid
    )
    const ledgerId = Number(
      db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Test Ledger', ?)").run(groupId).lastInsertRowid
    )
    const id = db
      .prepare("INSERT INTO bank_rules (pattern, ledger_id, kind) VALUES ('ACME', ?, 'payment')")
      .run(ledgerId).lastInsertRowid
    const row = db.prepare('SELECT min_amount, max_amount, auto_apply FROM bank_rules WHERE id = ?').get(id) as {
      min_amount: number | null; max_amount: number | null; auto_apply: number
    }
    expect(row).toEqual({ min_amount: null, max_amount: null, auto_apply: 0 })
  })
})

describe('migration 18 — party contact', () => {
  it('adds phone and email to an existing company without touching its data', () => {
    // Stage a company at the schema version before this migration, with a ledger in it, then
    // let migrate() finish. The point is that an existing install gains the columns and keeps
    // every row it had.
    const db = freshPartialDb(17)
    const group = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number } | undefined
    if (group) {
      db.prepare('INSERT INTO ledgers (name, group_id, opening_balance) VALUES (?, ?, ?)').run(
        'Pre-existing Party',
        group.id,
        12345
      )
    }

    migrate(db)

    const cols = (db.prepare('PRAGMA table_info(ledgers)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('phone')
    expect(cols).toContain('email')

    if (group) {
      const row = db.prepare("SELECT name, opening_balance, phone, email FROM ledgers WHERE name = 'Pre-existing Party'").get() as {
        opening_balance: number
        phone: string | null
        email: string | null
      }
      expect(row.opening_balance).toBe(12345)
      // Existing parties simply have no contact yet; nothing is invented for them.
      expect(row.phone).toBeNull()
      expect(row.email).toBeNull()
    }
    db.close()
  })
})


/**
 * The order is pinned, because nothing at runtime checks it.
 *
 * `migrate.ts` resumes from `MAX(id)` — an array index. Editing an applied migration, or slotting
 * a new one into the middle, is invisible to every other test in this repo, because every other
 * test builds a database from scratch where any order is self-consistent. It is only visible on a
 * machine that already ran the app, which is every machine that matters.
 *
 * This nearly happened: two agents working in parallel both took "31", and the second inserted
 * rather than appended. A database that had applied 31 migrations would have resumed at index 31,
 * run what was now migration 32, and failed on a table it already had — with the new migration
 * never applied at all.
 */
describe('migration order is append-only', () => {
  const hash = (sql: string): string => createHash('sha256').update(sql).digest('hex').slice(0, 16)
  const actual = MIGRATIONS.map(hash)

  // Appending a migration is the only change that keeps this green, and regenerating the pin is
  // then a deliberate one-liner rather than a hand-edit:
  //
  //   MIGRATION_HASHES_WRITE=1 npm run test:db -- migrations
  //
  // Written from the array itself so the pin can never disagree with what actually ships.
  if (process.env.MIGRATION_HASHES_WRITE) {
    const header = `/**
 * A fingerprint of every migration, in order. GENERATED — see migrations.dbtest.ts.
 *
 * Migrations here are applied by ARRAY POSITION: migrate.ts records MAX(id) and resumes from that
 * index. Nothing keys on a name or a checksum at runtime. Two consequences, both silent:
 *
 *   - EDITING an applied migration changes what a fresh database gets and leaves every existing
 *     one behind, with no error anywhere.
 *   - INSERTING one in the middle shifts every later migration up a position. A database that had
 *     applied N resumes at N, runs what used to be N+1, skips the new one entirely, and then
 *     fails on a CREATE TABLE for something it already has.
 *
 * Neither is visible to a test that builds from scratch, which is every other test in this repo.
 * So the order is pinned here.
 */
export const MIGRATION_HASHES: readonly string[] = [`
    const lines = actual.map((h, i) => {
      const first =
        (MIGRATIONS[i] ?? '')
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('--')) ?? ''
      return `  '${h}', // ${i + 1}: ${first.slice(0, 64)}`
    })
    writeFileSync(join(__dirname, 'migrationHashes.ts'), `${header}\n${lines.join('\n')}\n]\n`)
  }

  it('has a fingerprint for every migration', () => {
    expect(MIGRATION_HASHES).toHaveLength(MIGRATIONS.length)
  })

  it('has not edited or reordered an existing migration', () => {
    // Compared as whole arrays: a diff shows an insertion as one shifted block, where
    // index-by-index assertions would flag every later migration and bury the one that moved.
    expect(actual).toEqual([...MIGRATION_HASHES])
  })
})
