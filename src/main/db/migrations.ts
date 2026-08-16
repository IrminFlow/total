/** Numbered schema migrations, applied in order inside a transaction on company open. */
export const MIGRATIONS: string[] = [
  // 001 — initial schema
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES groups(id),
    nature TEXT NOT NULL CHECK (nature IN ('asset','liability','income','expense')),
    affects_gross_profit INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE ledgers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    group_id INTEGER NOT NULL REFERENCES groups(id),
    opening_balance INTEGER NOT NULL DEFAULT 0,
    gstin TEXT,
    state_code TEXT,
    address TEXT,
    tax_type TEXT CHECK (tax_type IN ('cgst','sgst','igst','cess')),
    gst_rate REAL,
    hsn TEXT,
    is_system INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_ledgers_group ON ledgers(group_id);

  CREATE TABLE voucher_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN (
      'contra','payment','receipt','journal','sales',
      'purchase','credit_note','debit_note','stock_journal','physical_stock'
    )),
    numbering TEXT NOT NULL DEFAULT 'auto' CHECK (numbering IN ('auto','manual')),
    prefix TEXT NOT NULL DEFAULT '',
    is_system INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id),
    date TEXT NOT NULL,
    number TEXT NOT NULL,
    party_ledger_id INTEGER REFERENCES ledgers(id),
    narration TEXT,
    reference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_vouchers_date ON vouchers(date);
  CREATE INDEX idx_vouchers_type ON vouchers(voucher_type_id);

  CREATE TABLE voucher_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    dr_cr TEXT NOT NULL CHECK (dr_cr IN ('dr','cr')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    line_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_lines_voucher ON voucher_lines(voucher_id);
  CREATE INDEX idx_lines_ledger ON voucher_lines(ledger_id);

  CREATE TABLE stock_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES stock_groups(id)
  );

  CREATE TABLE units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 3),
    uqc TEXT NOT NULL DEFAULT 'NOS'
  );

  CREATE TABLE stock_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    group_id INTEGER REFERENCES stock_groups(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    hsn TEXT,
    gst_rate REAL,
    cess_rate REAL,
    opening_qty_milli INTEGER NOT NULL DEFAULT 0,
    opening_value INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE godowns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE inventory_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    godown_id INTEGER REFERENCES godowns(id),
    qty_milli INTEGER NOT NULL,
    rate_paise INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    line_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_inv_voucher ON inventory_lines(voucher_id);
  CREATE INDEX idx_inv_item ON inventory_lines(stock_item_id);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','update','delete')),
    at TEXT NOT NULL DEFAULT (datetime('now')),
    before_json TEXT,
    after_json TEXT
  );
  `,
  // 002 — banking (reconciliation + instruments) and dispatch details for e-way bills
  `
  ALTER TABLE voucher_lines ADD COLUMN bank_date TEXT;
  ALTER TABLE vouchers ADD COLUMN instrument_no TEXT;
  ALTER TABLE vouchers ADD COLUMN instrument_date TEXT;
  ALTER TABLE vouchers ADD COLUMN transporter_id TEXT;
  ALTER TABLE vouchers ADD COLUMN vehicle_no TEXT;
  ALTER TABLE vouchers ADD COLUMN transport_distance INTEGER;
  `,
  // 003 — multi-currency, manufacturing BOM, payroll, IRN/EWB numbers from live filing
  `
  CREATE TABLE currencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 2
  );
  ALTER TABLE vouchers ADD COLUMN currency_code TEXT;
  ALTER TABLE vouchers ADD COLUMN exchange_rate REAL;
  ALTER TABLE vouchers ADD COLUMN irn TEXT;
  ALTER TABLE vouchers ADD COLUMN irn_ack_no TEXT;
  ALTER TABLE vouchers ADD COLUMN irn_ack_date TEXT;
  ALTER TABLE vouchers ADD COLUMN ewb_no TEXT;
  ALTER TABLE vouchers ADD COLUMN ewb_valid_upto TEXT;

  CREATE TABLE bom_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    component_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli_per_unit INTEGER NOT NULL CHECK (qty_milli_per_unit > 0),
    UNIQUE (item_id, component_id)
  );

  CREATE TABLE employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT,
    designation TEXT,
    joined TEXT,
    pan TEXT,
    uan TEXT,
    esic_no TEXT,
    basic INTEGER NOT NULL DEFAULT 0,
    hra INTEGER NOT NULL DEFAULT 0,
    special INTEGER NOT NULL DEFAULT 0,
    pf_enabled INTEGER NOT NULL DEFAULT 1,
    esi_enabled INTEGER NOT NULL DEFAULT 1,
    pt_enabled INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE payroll_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL UNIQUE,
    voucher_id INTEGER REFERENCES vouchers(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE payroll_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    payable_days REAL NOT NULL,
    month_days REAL NOT NULL,
    basic INTEGER NOT NULL,
    hra INTEGER NOT NULL,
    special INTEGER NOT NULL,
    gross INTEGER NOT NULL,
    pf_emp INTEGER NOT NULL,
    pf_er INTEGER NOT NULL,
    esi_emp INTEGER NOT NULL,
    esi_er INTEGER NOT NULL,
    pt INTEGER NOT NULL,
    net INTEGER NOT NULL
  );
  `,
  // 004 — soft delete, full audit trail, local users/PIN/roles. This migration is now complete.
  `
  ALTER TABLE vouchers ADD COLUMN deleted_at TEXT;
  CREATE INDEX idx_vouchers_deleted ON vouchers(deleted_at) WHERE deleted_at IS NOT NULL;

  -- full audit trail (task 1.8): who made the change and which build wrote it
  ALTER TABLE audit_log ADD COLUMN user_name TEXT;
  ALTER TABLE audit_log ADD COLUMN app_version TEXT;
  CREATE INDEX idx_audit_at ON audit_log(at);
  CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

  -- local users + PIN + roles (task 1.9): a company with zero rows here is unlocked (no gate);
  -- the first user created is always forced to 'owner' regardless of requested role.
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','accountant','viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- perf hardening (task 1.11): covering indexes for the hot report queries, replacing the
  -- narrower single-column ledger index from 001 (idx_lines_ledger_voucher covers it too).
  CREATE INDEX idx_lines_ledger_voucher ON voucher_lines(ledger_id, voucher_id);
  CREATE INDEX idx_lines_voucher_drcr_amount ON voucher_lines(voucher_id, dr_cr, amount);
  CREATE INDEX idx_vouchers_type_date ON vouchers(voucher_type_id, date);
  CREATE INDEX idx_vouchers_party ON vouchers(party_ledger_id);
  DROP INDEX idx_lines_ledger;
  `,
  // 005 — TDS (Tax Deducted at Source): sections seeded with standard FY rates/thresholds
  // (paise), the ledger fields that flag a party for TDS, and the per-voucher deduction record
  // that feeds the quarterly summary + 26Q export (task 2.2).
  `
  CREATE TABLE tds_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    rate REAL NOT NULL,
    threshold_single INTEGER NOT NULL DEFAULT 0,
    threshold_annual INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO tds_sections (code, description, rate, threshold_single, threshold_annual) VALUES
    ('194C', 'Payments to contractors', 2, 3000000, 10000000),
    ('194J', 'Fees for professional or technical services', 10, 3000000, 3000000),
    ('194I', 'Rent', 10, 0, 24000000),
    ('194H', 'Commission or brokerage', 2, 0, 1500000),
    ('194A', 'Interest other than on securities', 10, 0, 500000);

  ALTER TABLE ledgers ADD COLUMN tds_section_id INTEGER REFERENCES tds_sections(id);
  ALTER TABLE ledgers ADD COLUMN pan TEXT;

  CREATE TABLE tds_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    section_id INTEGER NOT NULL REFERENCES tds_sections(id),
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    pan TEXT,
    base_amount INTEGER NOT NULL,
    tds_amount INTEGER NOT NULL
  );
  CREATE INDEX idx_tds_entries_voucher ON tds_entries(voucher_id);
  CREATE INDEX idx_tds_entries_party_section ON tds_entries(party_ledger_id, section_id);
  `,
  // 006 — cost centres (with per-voucher-line allocations), bill-by-bill references, ledger
  // credit terms, stock-item barcodes, and party export type for e-invoicing (DDL only here —
  // the live e-doc logic lands in task 2.8). Everything in this batch belongs to task 2.2.
  `
  CREATE TABLE cost_centres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES cost_centres(id),
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE voucher_line_cost_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_line_id INTEGER NOT NULL REFERENCES voucher_lines(id) ON DELETE CASCADE,
    cost_centre_id INTEGER NOT NULL REFERENCES cost_centres(id),
    amount INTEGER NOT NULL CHECK (amount > 0)
  );
  CREATE INDEX idx_vlca_cc ON voucher_line_cost_allocations(cost_centre_id);

  CREATE TABLE bill_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    kind TEXT NOT NULL CHECK (kind IN ('new', 'against')),
    name TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    due_date TEXT
  );
  CREATE INDEX idx_bill_refs_party ON bill_refs(party_ledger_id);

  ALTER TABLE ledgers ADD COLUMN credit_days INTEGER;

  ALTER TABLE stock_items ADD COLUMN barcode TEXT;
  CREATE UNIQUE INDEX idx_stock_items_barcode ON stock_items(barcode) WHERE barcode IS NOT NULL;

  ALTER TABLE ledgers ADD COLUMN export_type TEXT CHECK (export_type IN ('sez_wp', 'sez_wop', 'exp_wp', 'exp_wop'));
  `,
  // 007 — voucher-type numbering (suffix, pad, restart): task 2.12's F11/numbering config. Company
  // feature flags and invoice print settings ride on the existing `meta` table (JSON, no DDL) —
  // see src/main/services/config.ts.
  `
  ALTER TABLE voucher_types ADD COLUMN suffix TEXT NOT NULL DEFAULT '';
  ALTER TABLE voucher_types ADD COLUMN pad_width INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE voucher_types ADD COLUMN restart_fy INTEGER NOT NULL DEFAULT 1;
  `,
  // 008 — recurring templates: a saved voucher shape (exact VoucherInputParsed JSON) that
  // recurring:post re-validates and re-posts on a monthly/weekly cadence (task 2.3).
  `
  CREATE TABLE recurring_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    voucher_json TEXT NOT NULL,
    cadence TEXT NOT NULL CHECK (cadence IN ('monthly','weekly')),
    day_of_month INTEGER,
    weekday INTEGER,
    next_due TEXT NOT NULL,
    last_posted TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  `,
  // 009 — recurring_templates.voucher_type_id: denormalized FK (extracted from the stored
  // voucher_json at save time — see saveTemplate) so recurring:list/due can JOIN voucher_types
  // for its kind, letting "Open in voucher entry" pick the right entry form (kindHint) instead
  // of always falling through to Journal.
  `
  ALTER TABLE recurring_templates ADD COLUMN voucher_type_id INTEGER REFERENCES voucher_types(id);
  `,
  // 010 — bank rules: pattern-matched auto-categorization for statement import (task 2.5).
  // `pattern` is a case-insensitive substring matched against the statement description;
  // `kind` constrains a rule to deposits ('receipt') or withdrawals ('payment') so the same
  // description text can't misfire across direction; `hits` is incremented (recordRuleHit) each
  // time the user files a voucher from a suggestion built off this rule.
  `
  CREATE TABLE bank_rules (
    id INTEGER PRIMARY KEY,
    pattern TEXT NOT NULL,
    match_field TEXT NOT NULL DEFAULT 'description',
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    kind TEXT NOT NULL CHECK (kind IN ('payment','receipt')),
    active INTEGER NOT NULL DEFAULT 1,
    hits INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 011 — budgets (task 2.6): a named budget scoped to one financial year, with per-line targets
  // that are either a single ledger or a whole group (rolled up over its descendants at report
  // time — never denormalised). A line's `month` is either 'YYYY-MM' within the budget's FY (that
  // month only) or NULL (an annual figure, compared FY-to-date). The XOR CHECK keeps a line from
  // ever targeting both a ledger and a group, or neither.
  `
  CREATE TABLE budgets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    fy_start_year INTEGER NOT NULL,
    UNIQUE(name, fy_start_year)
  );

  CREATE TABLE budget_lines (
    id INTEGER PRIMARY KEY,
    budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    ledger_id INTEGER REFERENCES ledgers(id),
    group_id INTEGER REFERENCES groups(id),
    month TEXT,
    amount INTEGER NOT NULL,
    CHECK ((ledger_id IS NULL) <> (group_id IS NULL))
  );
  `,
  // 012 — perf hardening (v0.3 lane R): FK indexes for every child column that reports/services
  // join or filter on but had no index, one covering index for the stock-report hot path
  // (inventory_lines by item joined back to vouchers), and stock_items.reorder_level_milli
  // (integer thousandths; NULL = no reorder level set) feeding the stock ageing/reorder report.
  `
  CREATE INDEX idx_bill_refs_voucher ON bill_refs(voucher_id);
  CREATE INDEX idx_vlca_line ON voucher_line_cost_allocations(voucher_line_id);
  CREATE INDEX idx_budget_lines_budget ON budget_lines(budget_id);
  CREATE INDEX idx_payroll_lines_run ON payroll_lines(run_id);
  CREATE INDEX idx_payroll_lines_employee ON payroll_lines(employee_id);
  CREATE INDEX idx_bank_rules_ledger ON bank_rules(ledger_id);
  CREATE INDEX idx_bom_lines_component ON bom_lines(component_id);
  CREATE INDEX idx_inv_godown ON inventory_lines(godown_id);
  CREATE INDEX idx_groups_parent ON groups(parent_id);
  CREATE INDEX idx_stock_groups_parent ON stock_groups(parent_id);
  CREATE INDEX idx_stock_items_group ON stock_items(group_id);
  CREATE INDEX idx_stock_items_unit ON stock_items(unit_id);
  CREATE INDEX idx_ledgers_tds_section ON ledgers(tds_section_id);
  CREATE INDEX idx_recurring_templates_vt ON recurring_templates(voucher_type_id);
  CREATE INDEX idx_cost_centres_parent ON cost_centres(parent_id);
  CREATE INDEX idx_inv_item_voucher ON inventory_lines(stock_item_id, voucher_id);

  ALTER TABLE stock_items ADD COLUMN reorder_level_milli INTEGER;
  `,
  // 013 — GST rebuild (lane G, pre-assigned number 013 in the v0.3 migration ledger):
  // party-level reverse charge + ITC eligibility flags, a per-voucher place-of-supply
  // override, and the voucher_transport table (per-voucher transporter/vehicle/transport
  // doc + ship-to block) feeding e-way bill / e-invoice ExpDtls-ShipDtls generation.
  `
  ALTER TABLE ledgers ADD COLUMN rcm INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ledgers ADD COLUMN itc_eligibility TEXT CHECK(itc_eligibility IN ('eligible','blocked','capital_goods','input_services')) DEFAULT 'eligible';
  ALTER TABLE vouchers ADD COLUMN pos_override TEXT;

  CREATE TABLE voucher_transport (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    trans_mode TEXT,
    trans_distance INTEGER,
    transporter_id TEXT,
    transporter_name TEXT,
    trans_doc_no TEXT,
    trans_doc_date TEXT,
    vehicle_no TEXT,
    vehicle_type TEXT,
    ship_to_name TEXT,
    ship_to_gstin TEXT,
    ship_to_addr1 TEXT,
    ship_to_addr2 TEXT,
    ship_to_place TEXT,
    ship_to_pincode TEXT,
    ship_to_state TEXT
  );
  `,
  // 014 — inventory depth (lane I, v0.3): per-item valuation method (FIFO vs perpetual weighted
  // average, consumed by src/shared/valuation.ts), batches with mfg/expiry, physical-stock
  // absolute lines (is_absolute=1: qty_milli is the counted closing quantity), price levels with
  // date-effective per-item rates, party credit limits, godown addresses, and post-dated /
  // optional (memorandum) voucher flags. Number pre-assigned by the v0.3 migration ledger.
  `
  ALTER TABLE stock_items ADD COLUMN valuation_method TEXT NOT NULL DEFAULT 'weighted_avg'
    CHECK (valuation_method IN ('weighted_avg','fifo'));

  CREATE TABLE batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    name TEXT NOT NULL,
    mfg_date TEXT,
    expiry_date TEXT,
    UNIQUE (stock_item_id, name)
  );

  ALTER TABLE inventory_lines ADD COLUMN batch_id INTEGER REFERENCES batches(id);
  ALTER TABLE inventory_lines ADD COLUMN is_absolute INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_inv_batch ON inventory_lines(batch_id) WHERE batch_id IS NOT NULL;

  CREATE TABLE price_levels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE price_list_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    price_level_id INTEGER NOT NULL REFERENCES price_levels(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    rate INTEGER NOT NULL,
    effective_from TEXT NOT NULL,
    UNIQUE (price_level_id, stock_item_id, effective_from)
  );

  ALTER TABLE ledgers ADD COLUMN price_level_id INTEGER REFERENCES price_levels(id);
  ALTER TABLE ledgers ADD COLUMN credit_limit INTEGER;

  ALTER TABLE godowns ADD COLUMN address TEXT;

  ALTER TABLE vouchers ADD COLUMN post_dated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE vouchers ADD COLUMN is_optional INTEGER NOT NULL DEFAULT 0;
  `
]
