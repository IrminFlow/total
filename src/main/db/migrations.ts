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
  `,
  // 015 — payroll depth (lane Y, task Y1): custom pay heads (flat | percent-of-basic, earning |
  // deduction) with per-employee overrides, the PT state an employee is taxed in, and the extra
  // per-line statutory figures (EPS split, PF admin, EDLI, custom-head totals + JSON breakdown).
  // Backward compatibility is DATA, not just schema: the legacy basic/hra/special columns are
  // seeded as three pay heads with one override row per existing employee, so a migrated employee
  // computes byte-identical pay through the head list (regression-tested in payroll.test.ts).
  `
  CREATE TABLE pay_heads (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('earning','deduction')),
    calc TEXT NOT NULL CHECK (calc IN ('flat','percent_of_basic')),
    value INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE employee_pay_heads (
    id INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_head_id INTEGER NOT NULL REFERENCES pay_heads(id) ON DELETE CASCADE,
    override_value INTEGER,
    UNIQUE (employee_id, pay_head_id)
  );
  CREATE INDEX idx_eph_head ON employee_pay_heads(pay_head_id);

  ALTER TABLE employees ADD COLUMN pt_state TEXT NOT NULL DEFAULT 'MH';

  ALTER TABLE payroll_lines ADD COLUMN other_earnings INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN other_deductions INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN eps_er INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN pf_admin INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN edli INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN heads_json TEXT;

  INSERT INTO pay_heads (name, kind, calc, value) VALUES
    ('Basic', 'earning', 'flat', 0),
    ('HRA', 'earning', 'flat', 0),
    ('Special Allowance', 'earning', 'flat', 0);

  INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value)
    SELECT e.id, (SELECT id FROM pay_heads WHERE name = 'Basic'), e.basic FROM employees e;
  INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value)
    SELECT e.id, (SELECT id FROM pay_heads WHERE name = 'HRA'), e.hra FROM employees e;
  INSERT INTO employee_pay_heads (employee_id, pay_head_id, override_value)
    SELECT e.id, (SELECT id FROM pay_heads WHERE name = 'Special Allowance'), e.special FROM employees e;
  `,
  // 016 — banking depth (lane Y, task Y2): bank rules gain an amount window (paise; NULL = no
  // bound) and an audited opt-in auto-apply flag (auto-create the voucher on statement import
  // when the rule matches exactly — off by default). match_field ('description' | 'reference')
  // existed since 010 and is honored by the matcher from this version on.
  `
  ALTER TABLE bank_rules ADD COLUMN min_amount INTEGER;
  ALTER TABLE bank_rules ADD COLUMN max_amount INTEGER;
  ALTER TABLE bank_rules ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 0;
  `,
  // 017 (lane Q) — invoice discount + audit action set expansion.
  // - inventory_lines.discount_paise: per-line trade discount. Display + gross computation only:
  //   `amount` stays the post-discount taxable value, so GST (always computed off `amount`) is
  //   unaffected by construction.
  // - audit_log's action CHECK gains 'login'/'login_failed'/'logout'/'export'/'import' (audit
  //   completeness, task Q1). SQLite cannot ALTER a CHECK constraint, so the table is rebuilt in
  //   place, preserving rows, ids, and both indexes.
  `
  ALTER TABLE inventory_lines ADD COLUMN discount_paise INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE audit_log_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'create','update','delete','login','login_failed','logout','export','import'
    )),
    at TEXT NOT NULL DEFAULT (datetime('now')),
    before_json TEXT,
    after_json TEXT,
    user_name TEXT,
    app_version TEXT
  );
  INSERT INTO audit_log_new (id, entity, entity_id, action, at, before_json, after_json, user_name, app_version)
    SELECT id, entity, entity_id, action, at, before_json, after_json, user_name, app_version FROM audit_log;
  DROP TABLE audit_log;
  ALTER TABLE audit_log_new RENAME TO audit_log;
  CREATE INDEX idx_audit_at ON audit_log(at);
  CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
  `,
  // 018 - GST return preparation state. A frozen snapshot records the exact JSON reviewed or
  // exported for a period; later book edits can be detected without mutating the frozen copy.
  // Filing acknowledgement fields retain the portal ARN and submitted payload alongside it.
  `
  CREATE TABLE gst_return_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_type TEXT NOT NULL CHECK (return_type IN ('gstr1','gstr3b')),
    period TEXT NOT NULL CHECK (length(period) = 6),
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    frozen_at TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','filed')),
    filed_at TEXT,
    arn TEXT,
    submitted_json TEXT,
    UNIQUE (return_type, period)
  );
  CREATE INDEX idx_gst_return_status ON gst_return_periods(status, period);
  `,
  // 019 — tamper-evident audit chain. Existing rows are cryptographically backfilled by the
  // migration hook in migrate.ts inside this migration's transaction.
  `
  ALTER TABLE audit_log ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '';
  ALTER TABLE audit_log ADD COLUMN row_hash TEXT NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX idx_audit_row_hash ON audit_log(row_hash) WHERE row_hash <> '';
  `,
  // 020 — durable import identity and reconciliation evidence. A content hash prevents an
  // identical source from being committed twice; summary_json retains the reviewed outcome.
  `
  CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    source_bytes INTEGER NOT NULL,
    source_rows INTEGER NOT NULL,
    accepted_rows INTEGER NOT NULL,
    rejected_rows INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, source_hash)
  );
  CREATE INDEX idx_import_batches_applied ON import_batches(applied_at DESC);
  `,
  // 021 — maker-checker. Approval requests are deliberately separate from vouchers: pending
  // work never appears in voucher_lines or any report and is posted only by a different user.
  `
  CREATE TABLE approval_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'voucher' CHECK (kind = 'voucher'),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    maker_user_id INTEGER NOT NULL REFERENCES users(id),
    maker_name TEXT NOT NULL,
    checker_user_id INTEGER REFERENCES users(id),
    checker_name TEXT,
    target_voucher_id INTEGER REFERENCES vouchers(id),
    posted_voucher_id INTEGER REFERENCES vouchers(id),
    summary TEXT NOT NULL,
    amount INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    decision_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );
  CREATE INDEX idx_approval_status_created ON approval_requests(status, created_at DESC);
  `,
  // 022 — collections operations. Promises are workflow metadata linked to a debtor ledger;
  // they never create or modify accounting entries.
  `
  CREATE TABLE collection_promises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    promised_date TEXT NOT NULL CHECK (length(promised_date) = 10),
    owner TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','kept','broken','cancelled')),
    outcome_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX idx_collection_promises_party_status ON collection_promises(ledger_id, status, promised_date);
  CREATE UNIQUE INDEX idx_collection_one_pending ON collection_promises(ledger_id) WHERE status = 'pending';
  `,
  // 023 — non-destructive voucher workflow. Reversals are ordinary double-entry vouchers with
  // an immutable one-to-one link to their source; tags and review state are operational metadata
  // and never participate in balances or statutory reports.
  `
  ALTER TABLE vouchers ADD COLUMN reversal_of_id INTEGER REFERENCES vouchers(id);
  ALTER TABLE vouchers ADD COLUMN reversal_reason TEXT;
  ALTER TABLE vouchers ADD COLUMN reversal_author TEXT;
  CREATE UNIQUE INDEX idx_voucher_one_reversal ON vouchers(reversal_of_id) WHERE reversal_of_id IS NOT NULL;

  CREATE TABLE voucher_tags (
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    tag TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(tag)) BETWEEN 1 AND 30),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT NOT NULL,
    PRIMARY KEY (voucher_id, tag)
  );
  CREATE INDEX idx_voucher_tags_tag ON voucher_tags(tag, voucher_id);

  CREATE TABLE voucher_reviews (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by TEXT NOT NULL
  );
  `,
  // 024 — supplier payment runs. Drafts live outside the books until an explicit reviewed post;
  // every item retains its exact bill allocation and resulting payment-voucher link.
  `
  CREATE TABLE payment_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL CHECK (length(date) = 10),
    bank_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
    total_amount INTEGER NOT NULL CHECK (total_amount > 0),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    posted_by TEXT,
    posted_at TEXT,
    cancelled_by TEXT,
    cancelled_at TEXT
  );
  CREATE INDEX idx_payment_runs_status_date ON payment_runs(status, date DESC, id DESC);

  CREATE TABLE payment_run_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES payment_runs(id) ON DELETE CASCADE,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    bill_refs_json TEXT NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id),
    UNIQUE (run_id, party_ledger_id)
  );
  CREATE INDEX idx_payment_run_items_party ON payment_run_items(party_ledger_id, run_id);
  `,
  // 025 — personal follow-up tasks. Links are intentionally typed and opaque: tasks can point
  // at accounting records and workspaces without becoming part of the accounting model.
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
    note TEXT,
    due_date TEXT CHECK (due_date IS NULL OR length(due_date) = 10),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
    assigned_to TEXT,
    link_type TEXT NOT NULL DEFAULT 'none' CHECK (link_type IN ('none','voucher','ledger','screen','gst_return')),
    link_key TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_by TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((link_type = 'none' AND link_key IS NULL) OR (link_type <> 'none' AND link_key IS NOT NULL AND length(trim(link_key)) > 0))
  );
  CREATE INDEX idx_tasks_status_due ON tasks(status, due_date, priority, id);
  CREATE INDEX idx_tasks_link ON tasks(link_type, link_key);
  `,
  // 026 - operational voucher comments. Comments are append-only review context, kept outside
  // accounting narration and voucher lines so they can never affect reports or document output.
  `
  CREATE TABLE voucher_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_voucher_comments_voucher ON voucher_comments(voucher_id, created_at, id);
  `,
  // 027 - incomplete voucher work lives outside posted books. The versioned JSON payload keeps
  // raw form values (including half-filled rows); only normal voucher:save can post it later.
  `
  CREATE TABLE voucher_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id),
    mode TEXT NOT NULL CHECK (mode IN ('accounting','invoice','manufacture','physical_stock')),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
    payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
    payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 262144),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_voucher_drafts_updated ON voucher_drafts(updated_at DESC, id DESC);
  `,
  // 028 - reusable one-off entry patterns. Applying a template creates a normal editable draft;
  // the template itself never posts, schedules work or participates in accounting reports.
  `
  CREATE TABLE voucher_entry_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 120),
    voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id),
    mode TEXT NOT NULL CHECK (mode IN ('accounting','invoice','manufacture','physical_stock')),
    payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
    payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 262144),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_voucher_entry_templates_type ON voucher_entry_templates(voucher_type_id, name);
  `,
  // 029 - procurement document chain. Requisitions and orders are non-posting; a posted GRN
  // links to an inventory-only stock journal so physical availability updates before invoicing.
  `
  CREATE TABLE purchase_requisitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL CHECK (length(date) = 10),
    needed_by TEXT CHECK (needed_by IS NULL OR length(needed_by) = 10),
    department TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','converted','cancelled')),
    requested_by TEXT NOT NULL,
    approved_by TEXT,
    approval_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE purchase_requisition_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requisition_id INTEGER NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    note TEXT,
    UNIQUE (requisition_id, stock_item_id)
  );
  CREATE INDEX idx_purchase_requisitions_status ON purchase_requisitions(status, date DESC);

  CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL CHECK (length(date) = 10),
    expected_date TEXT CHECK (expected_date IS NULL OR length(expected_date) = 10),
    supplier_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    requisition_id INTEGER REFERENCES purchase_requisitions(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','part_received','received','closed','cancelled')),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE purchase_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_ordered_milli INTEGER NOT NULL CHECK (qty_ordered_milli > 0),
    rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
    gst_rate REAL NOT NULL CHECK (gst_rate >= 0 AND gst_rate <= 100),
    UNIQUE (purchase_order_id, stock_item_id)
  );
  CREATE INDEX idx_purchase_orders_supplier_status ON purchase_orders(supplier_ledger_id, status, date DESC);

  CREATE TABLE goods_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL UNIQUE,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    date TEXT NOT NULL CHECK (length(date) = 10),
    status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','cancelled')),
    note TEXT,
    inventory_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id),
    received_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE goods_receipt_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goods_receipt_id INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
    purchase_order_line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
    qty_received_milli INTEGER NOT NULL CHECK (qty_received_milli > 0),
    qty_accepted_milli INTEGER NOT NULL CHECK (qty_accepted_milli >= 0),
    qty_rejected_milli INTEGER NOT NULL CHECK (qty_rejected_milli >= 0),
    CHECK (qty_accepted_milli + qty_rejected_milli = qty_received_milli),
    UNIQUE (goods_receipt_id, purchase_order_line_id)
  );
  CREATE INDEX idx_goods_receipts_po ON goods_receipts(purchase_order_id, date, id);
  `,
  // 030 - immutable three-way match evidence. Invoice item snapshots live here because a
  // matched purchase voucher is financial-only: the GRN already posted the physical stock.
  `
  CREATE TABLE purchase_invoice_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id),
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    goods_receipt_id INTEGER NOT NULL UNIQUE REFERENCES goods_receipts(id),
    status TEXT NOT NULL CHECK (status IN ('exact','variance')),
    quantity_variance_count INTEGER NOT NULL DEFAULT 0 CHECK (quantity_variance_count >= 0),
    rate_variance_count INTEGER NOT NULL DEFAULT 0 CHECK (rate_variance_count >= 0),
    matched_by TEXT NOT NULL,
    matched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE purchase_invoice_match_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES purchase_invoice_matches(id) ON DELETE CASCADE,
    purchase_order_line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    ordered_qty_milli INTEGER NOT NULL CHECK (ordered_qty_milli > 0),
    accepted_qty_milli INTEGER NOT NULL CHECK (accepted_qty_milli >= 0),
    invoiced_qty_milli INTEGER NOT NULL CHECK (invoiced_qty_milli > 0),
    po_rate_paise INTEGER NOT NULL CHECK (po_rate_paise >= 0),
    invoice_rate_paise INTEGER NOT NULL CHECK (invoice_rate_paise >= 0),
    invoice_amount INTEGER NOT NULL CHECK (invoice_amount >= 0),
    gst_rate REAL NOT NULL CHECK (gst_rate >= 0 AND gst_rate <= 100),
    UNIQUE (match_id, purchase_order_line_id),
    UNIQUE (match_id, stock_item_id)
  );
  CREATE INDEX idx_purchase_invoice_matches_po ON purchase_invoice_matches(purchase_order_id, matched_at DESC);
  `,
  // 031 - one posted debit note per durable procurement exception source.
  `
  CREATE TABLE procurement_debit_note_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id),
    source_key TEXT NOT NULL UNIQUE,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
    goods_receipt_id INTEGER REFERENCES goods_receipts(id),
    invoice_match_id INTEGER REFERENCES purchase_invoice_matches(id),
    reason TEXT NOT NULL CHECK (reason IN ('shortage','rejection','rate_difference')),
    claimed_amount INTEGER NOT NULL CHECK (claimed_amount > 0),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_procurement_debit_notes_po ON procurement_debit_note_links(purchase_order_id, created_at DESC);
  `,
  // 032 - supplier onboarding details and verification state, kept separate from accounting master data.
  `
  CREATE TABLE vendor_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL UNIQUE REFERENCES ledgers(id) ON DELETE CASCADE,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    bank_name TEXT,
    bank_account TEXT,
    ifsc TEXT,
    udyam_number TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified','blocked')),
    review_note TEXT,
    verified_by TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_vendor_profiles_status ON vendor_profiles(status, updated_at DESC);
  CREATE INDEX idx_vendor_profiles_bank_account ON vendor_profiles(bank_account) WHERE bank_account IS NOT NULL;
  `,
  // 033 - durable bank-statement workspace. Imports remain available after reconciliation so
  // users can account for every statement and book line, explain opening differences, and
  // explicitly classify timing/ignored items. Rule-review metadata turns manually approved
  // description mappings into reversible, confidence-scored suggestions.
  `
  ALTER TABLE bank_rules ADD COLUMN confidence_bp INTEGER NOT NULL DEFAULT 5000 CHECK (confidence_bp BETWEEN 0 AND 10000);
  ALTER TABLE bank_rules ADD COLUMN reviewed_hits INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_hits >= 0);
  ALTER TABLE bank_rules ADD COLUMN rejected_hits INTEGER NOT NULL DEFAULT 0 CHECK (rejected_hits >= 0);
  ALTER TABLE bank_rules ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','learned'));
  ALTER TABLE bank_rules ADD COLUMN rolled_back_at TEXT;
  ALTER TABLE bank_rules ADD COLUMN bank_ledger_id INTEGER REFERENCES ledgers(id);
  ALTER TABLE bank_rules ADD COLUMN date_from TEXT CHECK (date_from IS NULL OR length(date_from) = 10);
  ALTER TABLE bank_rules ADD COLUMN date_to TEXT CHECK (date_to IS NULL OR length(date_to) = 10);
  ALTER TABLE bank_rules ADD COLUMN narration_template TEXT;

  CREATE TABLE bank_statement_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','xlsx','ofx','qif','mt940')),
    file_name TEXT,
    period_from TEXT NOT NULL CHECK (length(period_from) = 10),
    period_to TEXT NOT NULL CHECK (length(period_to) = 10),
    opening_balance INTEGER,
    closing_balance INTEGER,
    source_hash TEXT NOT NULL,
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    imported_by TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ledger_id, source_hash)
  );
  CREATE INDEX idx_bank_statement_imports_ledger ON bank_statement_imports(ledger_id, imported_at DESC, id DESC);

  CREATE TABLE bank_statement_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
    row_no INTEGER NOT NULL CHECK (row_no > 0),
    date TEXT NOT NULL CHECK (length(date) = 10),
    description TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL CHECK (direction IN ('deposit','withdrawal')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    running_balance INTEGER,
    status TEXT NOT NULL CHECK (status IN ('bank_only','matched','ignored','timing_difference')),
    matched_line_id INTEGER REFERENCES voucher_lines(id),
    created_voucher_id INTEGER REFERENCES vouchers(id),
    note TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    UNIQUE (import_id, row_no)
  );
  CREATE INDEX idx_bank_statement_rows_status ON bank_statement_rows(import_id, status, date, id);
  CREATE INDEX idx_bank_statement_rows_match ON bank_statement_rows(matched_line_id) WHERE matched_line_id IS NOT NULL;
  `,
  // 034 - reviewed statement-to-statement transfer pairs. Posting a suggested pair creates one
  // ordinary Contra voucher and links both retained bank rows to its exact bank lines.
  `
  CREATE TABLE bank_transfer_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    withdrawal_row_id INTEGER NOT NULL UNIQUE REFERENCES bank_statement_rows(id),
    deposit_row_id INTEGER NOT NULL UNIQUE REFERENCES bank_statement_rows(id),
    voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id),
    linked_by TEXT NOT NULL,
    linked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_bank_transfer_matches_linked ON bank_transfer_matches(linked_at DESC, id DESC);
  `,
  // 035 - reviewed net-settlement fee/tax extraction. The original gross receipt stays intact;
  // a linked payment voucher books the bank deduction and the statement row retains both links.
  `
  CREATE TABLE bank_charge_extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_row_id INTEGER NOT NULL UNIQUE REFERENCES bank_statement_rows(id),
    settlement_line_id INTEGER NOT NULL REFERENCES voucher_lines(id),
    charge_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id),
    fee_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    tax_ledger_id INTEGER REFERENCES ledgers(id),
    fee_amount INTEGER NOT NULL CHECK (fee_amount > 0),
    tax_amount INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_bank_charge_extractions_settlement ON bank_charge_extractions(settlement_line_id, created_at DESC);
  `,
  // 036 - cheque lifecycle overlay. Accounting vouchers remain the source of truth; this table
  // stores operational state changes and notes for their instrument number.
  `
  CREATE TABLE cheque_lifecycle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('issued','deposited','cleared','bounced','cancelled')),
    status_date TEXT NOT NULL CHECK (length(status_date) = 10),
    note TEXT,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_cheque_lifecycle_status ON cheque_lifecycle(status, status_date, voucher_id);
  `,
  // 037 - denomination-level physical cash counts. The captured book balance and count are
  // immutable evidence once an owner posts the explicit adjustment voucher.
  `
  CREATE TABLE cash_count_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL CHECK (length(date) = 10),
    cash_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    denominations_json TEXT NOT NULL,
    physical_total INTEGER NOT NULL CHECK (physical_total >= 0),
    book_balance INTEGER NOT NULL,
    difference INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
    note TEXT,
    counted_by TEXT NOT NULL,
    counted_at TEXT NOT NULL DEFAULT (datetime('now')),
    posted_by TEXT,
    posted_at TEXT,
    adjustment_voucher_id INTEGER UNIQUE REFERENCES vouchers(id)
  );
  CREATE INDEX idx_cash_count_sessions_date ON cash_count_sessions(date DESC, id DESC);
  `,
  // 038 - named, non-posting liquidity scenarios. Assumptions remain isolated from accounting
  // and feed the same deterministic 13-week treasury forecast as the base case.
  `
  CREATE TABLE liquidity_scenarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 80),
    assumptions_json TEXT NOT NULL CHECK (length(assumptions_json) BETWEEN 2 AND 65536),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 039 - optional, read-only bank-feed connections. Secrets are never stored here: only
  // consent metadata and sync state live in SQLite; tokens are OS-encrypted in meta envelopes.
  `
  CREATE TABLE bank_feed_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    provider TEXT NOT NULL CHECK (provider IN ('custom_open_banking')),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
    endpoint TEXT NOT NULL,
    consent_scope TEXT NOT NULL DEFAULT 'statements.read' CHECK (consent_scope = 'statements.read'),
    consent_expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','paused','revoked')),
    last_sync_at TEXT,
    last_error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_bank_feed_connections_ledger ON bank_feed_connections(bank_ledger_id, status, id);
  `,
  // 040 - compliance operations. Portal imports, credit follow-up, statutory payments,
  // registration scope, e-document history and versioned rule guidance are durable evidence;
  // deterministic tax calculations continue to live in the shared engine.
  `
  CREATE TABLE gst2b_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL CHECK (length(period) = 6),
    source_hash TEXT NOT NULL UNIQUE CHECK (length(source_hash) = 64),
    file_name TEXT,
    source_json TEXT NOT NULL,
    tolerance_value INTEGER NOT NULL DEFAULT 100 CHECK (tolerance_value >= 0),
    tolerance_tax INTEGER NOT NULL DEFAULT 100 CHECK (tolerance_tax >= 0),
    summary_json TEXT NOT NULL,
    imported_by TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_gst2b_imports_period ON gst2b_imports(period, imported_at DESC, id DESC);

  CREATE TABLE itc_action_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES gst2b_imports(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    bucket TEXT NOT NULL CHECK (bucket IN ('amountMismatch','taxMismatch','missingInBooks','missingInPortal')),
    classification TEXT NOT NULL CHECK (classification IN ('missing','mismatched','blocked','reversed','follow_up')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting_supplier','resolved','dismissed')),
    owner TEXT,
    due_date TEXT CHECK (due_date IS NULL OR length(due_date) = 10),
    note TEXT,
    voucher_id INTEGER REFERENCES vouchers(id),
    portal_json TEXT,
    book_json TEXT,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (import_id, source_key)
  );
  CREATE INDEX idx_itc_action_status ON itc_action_items(status, due_date, import_id);

  CREATE TABLE edoc_lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('einvoice','eway')),
    status TEXT NOT NULL CHECK (status IN ('pending','generated','failed','cancelled','extended','vehicle_updated','expired')),
    request_key TEXT,
    document_no TEXT,
    valid_until TEXT,
    vehicle_no TEXT,
    reason TEXT,
    response_json TEXT,
    actor TEXT NOT NULL,
    occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, request_key)
  );
  CREATE INDEX idx_edoc_lifecycle_voucher ON edoc_lifecycle_events(voucher_id, kind, occurred_at DESC, id DESC);

  CREATE TABLE tds_challans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fy_start_year INTEGER NOT NULL,
    quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    bsr_code TEXT NOT NULL,
    challan_serial TEXT NOT NULL,
    deposit_date TEXT NOT NULL CHECK (length(deposit_date) = 10),
    amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (bsr_code, challan_serial, deposit_date)
  );
  CREATE INDEX idx_tds_challans_period ON tds_challans(fy_start_year, quarter, deposit_date);

  CREATE TABLE tds_return_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fy_start_year INTEGER NOT NULL,
    quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','prepared','filed','revised')),
    token TEXT,
    filed_at TEXT,
    note TEXT,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (fy_start_year, quarter)
  );

  CREATE TABLE compliance_obligations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stable_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('gst','tds','pf','esi','advance-tax','state','custom')),
    title TEXT NOT NULL,
    due_date TEXT NOT NULL CHECK (length(due_date) = 10),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','filed','paid','not_applicable')),
    owner TEXT,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'statutory' CHECK (source IN ('statutory','custom')),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_compliance_obligations_due ON compliance_obligations(status, due_date, kind);

  CREATE TABLE gst_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gstin TEXT NOT NULL UNIQUE,
    legal_name TEXT NOT NULL,
    state_code TEXT NOT NULL CHECK (length(state_code) = 2),
    address TEXT NOT NULL,
    registration_type TEXT NOT NULL CHECK (registration_type IN ('regular','composition')),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    invoice_prefix TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_gst_registrations_primary ON gst_registrations(is_primary) WHERE is_primary = 1;

  CREATE TABLE tax_content_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_key TEXT NOT NULL,
    version TEXT NOT NULL,
    effective_from TEXT NOT NULL CHECK (length(effective_from) = 10),
    effective_to TEXT CHECK (effective_to IS NULL OR length(effective_to) = 10),
    title TEXT NOT NULL,
    content_json TEXT NOT NULL,
    source_url TEXT,
    installed_by TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    UNIQUE (pack_key, version)
  );
  CREATE INDEX idx_tax_content_effective ON tax_content_packs(pack_key, active, effective_from DESC);
  `,
  // 041 - operational multi-GSTIN scope and LUT evidence. Vouchers, number series and godowns
  // can belong to a registration; return snapshots are unique per registration and period.
  `
  ALTER TABLE vouchers ADD COLUMN gst_registration_id INTEGER REFERENCES gst_registrations(id);
  ALTER TABLE voucher_types ADD COLUMN gst_registration_id INTEGER REFERENCES gst_registrations(id);
  ALTER TABLE godowns ADD COLUMN gst_registration_id INTEGER REFERENCES gst_registrations(id);
  CREATE INDEX idx_vouchers_gst_registration ON vouchers(gst_registration_id, date, id);
  CREATE INDEX idx_godowns_gst_registration ON godowns(gst_registration_id, name);

  CREATE TABLE gst_return_periods_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER REFERENCES gst_registrations(id),
    return_type TEXT NOT NULL CHECK (return_type IN ('gstr1','gstr3b')),
    period TEXT NOT NULL CHECK (length(period) = 6),
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    frozen_at TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot_hash TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','filed')),
    filed_at TEXT,
    arn TEXT,
    submitted_json TEXT
  );
  INSERT INTO gst_return_periods_new
    (id, registration_id, return_type, period, from_date, to_date, frozen_at, snapshot_hash, snapshot_json, status, filed_at, arn, submitted_json)
    SELECT id, NULL, return_type, period, from_date, to_date, frozen_at, snapshot_hash, snapshot_json, status, filed_at, arn, submitted_json
    FROM gst_return_periods;
  DROP TABLE gst_return_periods;
  ALTER TABLE gst_return_periods_new RENAME TO gst_return_periods;
  CREATE UNIQUE INDEX idx_gst_return_registration_period ON gst_return_periods(COALESCE(registration_id, 0), return_type, period);
  CREATE INDEX idx_gst_return_status ON gst_return_periods(status, period);

  CREATE TABLE gst_registration_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL REFERENCES gst_registrations(id) ON DELETE CASCADE,
    voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    pad_width INTEGER NOT NULL DEFAULT 0 CHECK (pad_width BETWEEN 0 AND 8),
    restart_fy INTEGER NOT NULL DEFAULT 1 CHECK (restart_fy IN (0,1)),
    UNIQUE (registration_id, voucher_type_id)
  );

  CREATE TABLE lut_authorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL REFERENCES gst_registrations(id) ON DELETE CASCADE,
    fy_start_year INTEGER NOT NULL,
    arn TEXT NOT NULL,
    filed_date TEXT NOT NULL CHECK (length(filed_date) = 10),
    valid_from TEXT NOT NULL CHECK (length(valid_from) = 10),
    valid_to TEXT NOT NULL CHECK (length(valid_to) = 10),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (registration_id, fy_start_year)
  );
  CREATE INDEX idx_lut_authorizations_validity ON lut_authorizations(registration_id, valid_from, valid_to);
  `,
  // 042 - management insight workspaces. Scenarios and annotations are explicitly non-posting;
  // Schedule III mappings are presentation metadata over deterministic voucher-line reports.
  `
  CREATE TABLE management_scenarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    sales_growth_pct REAL NOT NULL DEFAULT 0,
    gross_margin_pct REAL,
    expense_change_pct REAL NOT NULL DEFAULT 0,
    collection_days_change INTEGER NOT NULL DEFAULT 0,
    payment_days_change INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_management_scenarios_updated ON management_scenarios(updated_at DESC);

  CREATE TABLE report_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_key TEXT NOT NULL,
    row_key TEXT NOT NULL DEFAULT '',
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    note TEXT NOT NULL,
    include_in_export INTEGER NOT NULL DEFAULT 1 CHECK (include_in_export IN (0,1)),
    author TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (report_key, row_key, from_date, to_date)
  );
  CREATE INDEX idx_report_annotations_period ON report_annotations(report_key, from_date, to_date);

  CREATE TABLE schedule_iii_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK (side IN ('equity_liability','asset','income','expense')),
    section TEXT NOT NULL,
    note_code TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_schedule_iii_order ON schedule_iii_mappings(side, sort_order, section);
  `,
  // 043 - budgets can target an operational cost-centre tree (department/project/branch)
  // as well as an account ledger/group, without storing any derived actuals.
  `
  CREATE TABLE budget_lines_new (
    id INTEGER PRIMARY KEY,
    budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    ledger_id INTEGER REFERENCES ledgers(id),
    group_id INTEGER REFERENCES groups(id),
    cost_centre_id INTEGER REFERENCES cost_centres(id),
    month TEXT,
    amount INTEGER NOT NULL,
    CHECK ((ledger_id IS NOT NULL) + (group_id IS NOT NULL) + (cost_centre_id IS NOT NULL) = 1)
  );
  INSERT INTO budget_lines_new(id,budget_id,ledger_id,group_id,cost_centre_id,month,amount)
    SELECT id,budget_id,ledger_id,group_id,NULL,month,amount FROM budget_lines;
  DROP TABLE budget_lines;
  ALTER TABLE budget_lines_new RENAME TO budget_lines;
  CREATE INDEX idx_budget_lines_budget ON budget_lines(budget_id);
  CREATE INDEX idx_budget_lines_cost_centre ON budget_lines(cost_centre_id);
  `,
  // 044 - inventory operations control plane. These tables store workflow, identity and
  // planning evidence only; quantities and values in the books continue to derive from
  // inventory_lines/voucher_lines. Integer thousandths and paise are preserved throughout.
  `
  CREATE TABLE item_planning (
    stock_item_id INTEGER PRIMARY KEY REFERENCES stock_items(id) ON DELETE CASCADE,
    lead_time_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
    safety_stock_milli INTEGER NOT NULL DEFAULT 0 CHECK (safety_stock_milli >= 0),
    reorder_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (reorder_qty_milli >= 0),
    preferred_supplier_ledger_id INTEGER REFERENCES ledgers(id),
    forecast_method TEXT NOT NULL DEFAULT 'velocity' CHECK (forecast_method IN ('velocity','manual','seasonal')),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE demand_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    month TEXT NOT NULL CHECK (length(month) = 7),
    qty_milli INTEGER NOT NULL CHECK (qty_milli >= 0),
    reason TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (stock_item_id, month)
  );
  CREATE INDEX idx_demand_overrides_month ON demand_overrides(month, stock_item_id);

  CREATE TABLE inventory_action_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('reorder','discount','transfer','return','dispose','review')),
    due_date TEXT,
    owner TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX idx_inventory_actions_status ON inventory_action_items(status, due_date);

  CREATE TABLE stock_reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    godown_id INTEGER REFERENCES godowns(id),
    batch_id INTEGER REFERENCES batches(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    required_date TEXT NOT NULL,
    reference TEXT NOT NULL,
    customer_ledger_id INTEGER REFERENCES ledgers(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','fulfilled','released','expired')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX idx_stock_reservations_available ON stock_reservations(stock_item_id, godown_id, status, required_date);

  CREATE TABLE stock_count_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    count_date TEXT NOT NULL,
    godown_id INTEGER NOT NULL REFERENCES godowns(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','counting','review','posted','cancelled')),
    blind_count INTEGER NOT NULL DEFAULT 1 CHECK (blind_count IN (0,1)),
    posted_voucher_id INTEGER REFERENCES vouchers(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_count_sessions_status ON stock_count_sessions(status, count_date DESC);

  CREATE TABLE stock_count_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES stock_count_sessions(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    batch_id INTEGER REFERENCES batches(id),
    expected_qty_milli INTEGER NOT NULL,
    counted_qty_milli INTEGER,
    note TEXT,
    counted_by TEXT,
    counted_at TEXT,
    UNIQUE (session_id, stock_item_id, batch_id)
  );
  CREATE INDEX idx_count_lines_session ON stock_count_lines(session_id);

  CREATE TABLE stock_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    transfer_date TEXT NOT NULL,
    from_godown_id INTEGER NOT NULL REFERENCES godowns(id),
    to_godown_id INTEGER NOT NULL REFERENCES godowns(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','dispatched','received','cancelled')),
    dispatch_voucher_id INTEGER REFERENCES vouchers(id),
    receipt_voucher_id INTEGER REFERENCES vouchers(id),
    expected_arrival TEXT,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (from_godown_id <> to_godown_id)
  );
  CREATE TABLE stock_transfer_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    batch_id INTEGER REFERENCES batches(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    received_qty_milli INTEGER CHECK (received_qty_milli IS NULL OR received_qty_milli >= 0),
    unit_cost_paise INTEGER CHECK (unit_cost_paise IS NULL OR unit_cost_paise >= 0),
    UNIQUE (transfer_id, stock_item_id, batch_id)
  );
  CREATE INDEX idx_stock_transfers_status ON stock_transfers(status, transfer_date);

  CREATE TABLE inventory_serials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    serial_no TEXT NOT NULL COLLATE NOCASE,
    batch_id INTEGER REFERENCES batches(id),
    warranty_until TEXT,
    note TEXT,
    UNIQUE (stock_item_id, serial_no)
  );
  CREATE TABLE inventory_serial_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_id INTEGER NOT NULL REFERENCES inventory_serials(id) ON DELETE CASCADE,
    inventory_line_id INTEGER NOT NULL REFERENCES inventory_lines(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    UNIQUE (serial_id, inventory_line_id)
  );
  CREATE INDEX idx_serial_movements_line ON inventory_serial_movements(inventory_line_id);

  CREATE TABLE manufacturing_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    planned_qty_milli INTEGER NOT NULL CHECK (planned_qty_milli > 0),
    due_date TEXT NOT NULL,
    godown_id INTEGER REFERENCES godowns(id),
    bom_version_id INTEGER REFERENCES bom_versions(id),
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','released','in_progress','completed','cancelled')),
    completed_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (completed_qty_milli >= 0),
    production_voucher_id INTEGER REFERENCES vouchers(id),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_manufacturing_orders_status ON manufacturing_orders(status, due_date);

  CREATE TABLE bom_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (item_id, version),
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
  );
  CREATE TABLE bom_version_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_version_id INTEGER NOT NULL REFERENCES bom_versions(id) ON DELETE CASCADE,
    component_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli_per_unit INTEGER NOT NULL CHECK (qty_milli_per_unit > 0),
    scrap_pct REAL NOT NULL DEFAULT 0 CHECK (scrap_pct >= 0 AND scrap_pct <= 100),
    UNIQUE (bom_version_id, component_id)
  );
  CREATE INDEX idx_bom_versions_active ON bom_versions(item_id, status, effective_from);

  CREATE TABLE landed_cost_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
    inventory_line_id INTEGER NOT NULL REFERENCES inventory_lines(id),
    cost_ledger_id INTEGER REFERENCES ledgers(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('value','quantity','weight','manual')),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (source_voucher_id, inventory_line_id, cost_ledger_id)
  );
  CREATE INDEX idx_landed_cost_line ON landed_cost_allocations(inventory_line_id);
  `,
  // 045 - payroll and workforce operations. The posted payroll voucher remains the accounting
  // source of truth; these tables retain reviewed HR inputs, approvals and statutory evidence.
  `
  ALTER TABLE employees ADD COLUMN bank_account TEXT;
  ALTER TABLE employees ADD COLUMN bank_ifsc TEXT;
  ALTER TABLE employees ADD COLUMN department TEXT;
  ALTER TABLE employees ADD COLUMN exit_date TEXT;
  ALTER TABLE payroll_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'regular' CHECK (run_kind IN ('regular','supplementary','reversal','final_settlement'));
  ALTER TABLE payroll_runs ADD COLUMN parent_run_id INTEGER REFERENCES payroll_runs(id);
  ALTER TABLE payroll_runs ADD COLUMN locked_at TEXT;
  ALTER TABLE payroll_runs ADD COLUMN locked_by TEXT;
  ALTER TABLE payroll_lines ADD COLUMN overtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0);
  ALTER TABLE payroll_lines ADD COLUMN overtime_amount INTEGER NOT NULL DEFAULT 0 CHECK (overtime_amount >= 0);
  ALTER TABLE payroll_lines ADD COLUMN department TEXT;

  CREATE TABLE attendance_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','applied','rejected')),
    row_count INTEGER NOT NULL DEFAULT 0,
    exception_count INTEGER NOT NULL DEFAULT 0,
    imported_by TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER REFERENCES attendance_imports(id) ON DELETE SET NULL,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    month TEXT NOT NULL,
    payable_days REAL NOT NULL CHECK (payable_days >= 0),
    present_days REAL NOT NULL DEFAULT 0 CHECK (present_days >= 0),
    leave_days REAL NOT NULL DEFAULT 0 CHECK (leave_days >= 0),
    unpaid_days REAL NOT NULL DEFAULT 0 CHECK (unpaid_days >= 0),
    overtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
    status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','approved','exception')),
    note TEXT,
    approved_by TEXT,
    approved_at TEXT,
    UNIQUE (employee_id, month)
  );
  CREATE INDEX idx_attendance_month_status ON attendance_records(month,status);

  CREATE TABLE leave_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    annual_accrual_milli INTEGER NOT NULL DEFAULT 0 CHECK (annual_accrual_milli >= 0),
    carry_forward_limit_milli INTEGER CHECK (carry_forward_limit_milli IS NULL OR carry_forward_limit_milli >= 0),
    encashable INTEGER NOT NULL DEFAULT 0 CHECK (encashable IN (0,1)),
    paid INTEGER NOT NULL DEFAULT 1 CHECK (paid IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
  );
  CREATE TABLE leave_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
    date TEXT NOT NULL,
    qty_milli INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('accrual','taken','carry_forward','encashment','adjustment')),
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('requested','approved','rejected')),
    note TEXT,
    approved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_leave_employee_date ON leave_transactions(employee_id,date);

  CREATE TABLE salary_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    effective_from TEXT NOT NULL,
    heads_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved','superseded')),
    approved_by TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (employee_id,effective_from)
  );

  CREATE TABLE employee_loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    disbursed_date TEXT NOT NULL,
    principal INTEGER NOT NULL CHECK (principal > 0),
    annual_interest_bps INTEGER NOT NULL DEFAULT 0 CHECK (annual_interest_bps >= 0),
    installment_amount INTEGER NOT NULL CHECK (installment_amount > 0),
    first_deduction_month TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','settled','written_off')),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE employee_loan_installments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id INTEGER NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    principal INTEGER NOT NULL DEFAULT 0 CHECK (principal >= 0),
    interest INTEGER NOT NULL DEFAULT 0 CHECK (interest >= 0),
    payroll_run_id INTEGER REFERENCES payroll_runs(id),
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','deducted','paused','waived')),
    UNIQUE (loan_id,month)
  );

  CREATE TABLE employee_reimbursements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    claim_date TEXT NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    taxable INTEGER NOT NULL DEFAULT 0 CHECK (taxable IN (0,1)),
    description TEXT NOT NULL,
    attachment_path TEXT,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','paid')),
    approved_by TEXT,
    payment_voucher_id INTEGER REFERENCES vouchers(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_reimbursements_status ON employee_reimbursements(status,claim_date);

  CREATE TABLE contractors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pan TEXT,
    bank_account TEXT,
    bank_ifsc TEXT,
    tds_section_id INTEGER REFERENCES tds_sections(id),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    UNIQUE (name,pan)
  );
  CREATE TABLE contractor_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contractor_id INTEGER NOT NULL REFERENCES contractors(id),
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    gross INTEGER NOT NULL CHECK (gross > 0),
    tds INTEGER NOT NULL DEFAULT 0 CHECK (tds >= 0),
    voucher_id INTEGER REFERENCES vouchers(id),
    certificate_no TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','posted','cancelled')),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE final_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    last_working_date TEXT NOT NULL,
    salary_due INTEGER NOT NULL DEFAULT 0,
    notice_pay INTEGER NOT NULL DEFAULT 0,
    leave_encashment INTEGER NOT NULL DEFAULT 0,
    gratuity INTEGER NOT NULL DEFAULT 0,
    recovery INTEGER NOT NULL DEFAULT 0,
    advance_recovery INTEGER NOT NULL DEFAULT 0,
    net_amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','posted','cancelled')),
    voucher_id INTEGER REFERENCES vouchers(id),
    note TEXT,
    approved_by TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE payroll_statutory_challans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pf','esi','pt','tds')),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    paid_date TEXT,
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','filed')),
    filed_reference TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (month,kind)
  );

  CREATE TABLE shift_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    work_minutes INTEGER NOT NULL CHECK (work_minutes > 0),
    weekly_off_day INTEGER NOT NULL DEFAULT 0 CHECK (weekly_off_day BETWEEN 0 AND 6),
    overtime_after_minutes INTEGER NOT NULL CHECK (overtime_after_minutes >= 0),
    overtime_rate_bps INTEGER NOT NULL DEFAULT 10000 CHECK (overtime_rate_bps >= 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
  );
  CREATE TABLE employee_shift_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    shift_rule_id INTEGER NOT NULL REFERENCES shift_rules(id),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    UNIQUE (employee_id,effective_from)
  );
  CREATE TABLE workforce_holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    UNIQUE (date,department)
  );

  CREATE TABLE workforce_import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('joiners','leavers','attendance')),
    source_name TEXT NOT NULL,
    source_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','applied','rejected')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE workforce_import_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES workforce_import_batches(id) ON DELETE CASCADE,
    source_row INTEGER NOT NULL,
    employee_code TEXT,
    data_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('valid','warning','error','applied')),
    message TEXT,
    UNIQUE (batch_id,source_row)
  );
  `,
  // 046 - non-posting sales documents and immutable numbering/conversion evidence.
  `
  CREATE TABLE sales_document_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('quotation','order','challan','proforma')),
    name TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    pad_width INTEGER NOT NULL DEFAULT 4 CHECK (pad_width BETWEEN 0 AND 12),
    restart_fy INTEGER NOT NULL DEFAULT 1 CHECK (restart_fy IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    UNIQUE (kind,name)
  );
  INSERT INTO sales_document_series(kind,name,prefix) VALUES
    ('quotation','Default','QUO/'),('order','Default','SO/'),('challan','Default','DC/'),('proforma','Default','PI/');

  CREATE TABLE sales_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('quotation','order','challan','proforma')),
    series_id INTEGER NOT NULL REFERENCES sales_document_series(id),
    number TEXT NOT NULL,
    revision_no INTEGER NOT NULL DEFAULT 1 CHECK (revision_no > 0),
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    date TEXT NOT NULL,
    valid_until TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','confirmed','part_fulfilled','fulfilled','cancelled','approved','returned','converted','expired')),
    parent_document_id INTEGER REFERENCES sales_documents(id),
    purpose TEXT,
    gst_registration_id INTEGER REFERENCES gst_registrations(id),
    terms_json TEXT NOT NULL DEFAULT '[]',
    custom_fields_json TEXT NOT NULL DEFAULT '{}',
    invoice_draft_id INTEGER REFERENCES voucher_drafts(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (series_id,number)
  );
  CREATE INDEX idx_sales_documents_party_date ON sales_documents(party_ledger_id,date);
  CREATE INDEX idx_sales_documents_kind_status ON sales_documents(kind,status,date);

  CREATE TABLE sales_document_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES sales_documents(id) ON DELETE CASCADE,
    line_order INTEGER NOT NULL,
    stock_item_id INTEGER REFERENCES stock_items(id),
    description TEXT NOT NULL,
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    rate INTEGER NOT NULL CHECK (rate >= 0),
    discount_bps INTEGER NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
    gst_rate REAL NOT NULL DEFAULT 0 CHECK (gst_rate >= 0),
    optional INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1)),
    cancelled_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_qty_milli >= 0),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (document_id,line_order)
  );

  CREATE TABLE sales_document_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES sales_documents(id) ON DELETE CASCADE,
    revision_no INTEGER NOT NULL CHECK (revision_no > 0),
    snapshot_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (document_id,revision_no)
  );

  CREATE TABLE sales_document_line_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_line_id INTEGER NOT NULL REFERENCES sales_document_lines(id),
    to_line_id INTEGER REFERENCES sales_document_lines(id),
    invoice_draft_id INTEGER REFERENCES voucher_drafts(id),
    kind TEXT NOT NULL CHECK (kind IN ('allocation','delivery','invoice','return')),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((to_line_id IS NOT NULL) != (invoice_draft_id IS NOT NULL)),
    UNIQUE (from_line_id,to_line_id,invoice_draft_id,kind)
  );
  CREATE INDEX idx_sales_line_links_from ON sales_document_line_links(from_line_id,kind);

  CREATE TABLE sales_document_conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_document_id INTEGER NOT NULL REFERENCES sales_documents(id),
    to_document_id INTEGER REFERENCES sales_documents(id),
    invoice_draft_id INTEGER REFERENCES voucher_drafts(id),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((to_document_id IS NOT NULL) != (invoice_draft_id IS NOT NULL)),
    UNIQUE (from_document_id,to_document_id,invoice_draft_id)
  );

  CREATE TABLE sales_document_number_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES sales_document_series(id),
    fy_start_year INTEGER NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    number TEXT NOT NULL,
    document_id INTEGER REFERENCES sales_documents(id),
    allocated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (series_id,fy_start_year,sequence),
    UNIQUE (series_id,number),
    UNIQUE (document_id)
  );
  `,
  // 047 - recurring sales drafts and server-enforced discount authority.
  `
  CREATE TABLE sales_recurring_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id),
    cadence TEXT NOT NULL CHECK (cadence IN ('monthly','quarterly','yearly')),
    next_due TEXT NOT NULL,
    end_date TEXT,
    due_days INTEGER NOT NULL DEFAULT 0 CHECK (due_days BETWEEN 0 AND 365),
    lines_json TEXT NOT NULL,
    narration TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    last_generated TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sales_recurring_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    as_on TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sales_recurring_batch_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES sales_recurring_batches(id) ON DELETE CASCADE,
    schedule_id INTEGER NOT NULL REFERENCES sales_recurring_schedules(id),
    due_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('exception','generated','skipped')),
    message TEXT,
    voucher_draft_id INTEGER REFERENCES voucher_drafts(id),
    UNIQUE (batch_id,schedule_id,due_date)
  );

  CREATE TABLE sales_discount_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','role','item','customer')),
    role TEXT CHECK (role IN ('owner','accountant','viewer')),
    stock_item_id INTEGER REFERENCES stock_items(id),
    customer_ledger_id INTEGER REFERENCES ledgers(id),
    max_discount_bps INTEGER NOT NULL CHECK (max_discount_bps BETWEEN 0 AND 10000),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
      (scope_kind='global' AND role IS NULL AND stock_item_id IS NULL AND customer_ledger_id IS NULL) OR
      (scope_kind='role' AND role IS NOT NULL AND stock_item_id IS NULL AND customer_ledger_id IS NULL) OR
      (scope_kind='item' AND role IS NULL AND stock_item_id IS NOT NULL AND customer_ledger_id IS NULL) OR
      (scope_kind='customer' AND role IS NULL AND stock_item_id IS NULL AND customer_ledger_id IS NOT NULL)
    )
  );
  CREATE TABLE sales_discount_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_kind TEXT NOT NULL CHECK (context_kind IN ('sales_document','sales_invoice')),
    customer_ledger_id INTEGER REFERENCES ledgers(id),
    stock_item_id INTEGER REFERENCES stock_items(id),
    requested_discount_bps INTEGER NOT NULL,
    allowed_discount_bps INTEGER NOT NULL,
    actor_role TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('allowed','blocked')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 048 - customer operations: returns, warranty, document fields, territories and subscriptions.
  `
  CREATE TABLE sales_return_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
    return_inventory_line_id INTEGER NOT NULL REFERENCES inventory_lines(id),
    invoice_voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
    invoice_inventory_line_id INTEGER NOT NULL REFERENCES inventory_lines(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    value INTEGER NOT NULL CHECK (value >= 0),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (return_inventory_line_id),
    UNIQUE (return_voucher_id,invoice_inventory_line_id)
  );

  CREATE TABLE sales_warranty_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_id INTEGER NOT NULL REFERENCES inventory_serials(id),
    invoice_voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
    opened_date TEXT NOT NULL,
    issue TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_service','resolved','rejected')),
    outcome TEXT,
    service_cost INTEGER NOT NULL DEFAULT 0 CHECK (service_cost >= 0),
    resolved_date TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sales_custom_field_definitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
    label TEXT NOT NULL,
    document_kind TEXT CHECK (document_kind IN ('quotation','order','challan','proforma')),
    data_type TEXT NOT NULL CHECK (data_type IN ('text','number','date','choice')),
    required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
    options_json TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sales_territories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES sales_territories(id),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
  );
  CREATE TABLE sales_customer_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    territory_id INTEGER NOT NULL REFERENCES sales_territories(id),
    salesperson TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    UNIQUE (customer_ledger_id,effective_from)
  );

  CREATE TABLE sales_subscription_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recurring_schedule_id INTEGER NOT NULL REFERENCES sales_recurring_schedules(id),
    plan_name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    escalation_bps INTEGER NOT NULL DEFAULT 0 CHECK (escalation_bps BETWEEN 0 AND 10000),
    next_escalation_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','renewal_due','ended','cancelled')),
    renewed_from_id INTEGER REFERENCES sales_subscription_contracts(id),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE customer_portal_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    folder_token TEXT NOT NULL UNIQUE,
    manifest_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 049 - collaboration and internal-control workspace. These records are operational evidence;
  // accounting amounts still come exclusively from voucher_lines.
  `
  CREATE TABLE review_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
    question TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 3 AND 2000),
    assigned_to_user_id INTEGER REFERENCES users(id),
    due_date TEXT CHECK (due_date IS NULL OR length(due_date) = 10),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','resolved','cancelled')),
    answer TEXT,
    created_by TEXT NOT NULL,
    answered_by TEXT,
    resolved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT,
    resolved_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_review_questions_status_due ON review_questions(status,due_date,priority,id);
  CREATE INDEX idx_review_questions_voucher ON review_questions(voucher_id,id);

  CREATE TABLE period_signoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','prepared','reviewed','reopened')),
    outstanding_issues_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    prepared_by TEXT,
    prepared_at TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_note TEXT,
    reopened_by TEXT,
    reopened_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period_from,period_to),
    CHECK (period_from <= period_to)
  );

  CREATE TABLE export_permissions (
    role TEXT NOT NULL CHECK (role IN ('owner','accountant','viewer')),
    format TEXT NOT NULL CHECK (format IN ('pdf','spreadsheet','json_mirror','full_data')),
    allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
    PRIMARY KEY(role,format)
  );
  INSERT INTO export_permissions(role,format,allowed) VALUES
    ('owner','pdf',1),('owner','spreadsheet',1),('owner','json_mirror',1),('owner','full_data',1),
    ('accountant','pdf',1),('accountant','spreadsheet',1),('accountant','json_mirror',0),('accountant','full_data',0),
    ('viewer','pdf',0),('viewer','spreadsheet',0),('viewer','json_mirror',0),('viewer','full_data',0);

  ALTER TABLE users ADD COLUMN access_expires_at TEXT;
  CREATE TABLE user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    signed_in_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    signed_out_at TEXT,
    lock_state TEXT NOT NULL DEFAULT 'active' CHECK (lock_state IN ('active','locked','signed_out','expired'))
  );
  CREATE INDEX idx_user_sessions_state_activity ON user_sessions(lock_state,last_activity_at DESC);

  CREATE TABLE policy_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_kind TEXT NOT NULL CHECK (policy_kind IN ('period_lock','credit_limit','validation_warning','negative_stock','other')),
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','used','cancelled')),
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by TEXT,
    decided_at TEXT,
    decision_note TEXT,
    used_at TEXT
  );
  CREATE INDEX idx_policy_exceptions_status ON policy_exceptions(status,requested_at DESC);

  CREATE TABLE review_bundle_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    path TEXT NOT NULL,
    question_count INTEGER NOT NULL,
    evidence_count INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE department_boundaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('accountant','viewer')),
    dimension_kind TEXT NOT NULL CHECK (dimension_kind IN ('cost_centre','godown','voucher_type')),
    dimension_id INTEGER NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 1 CHECK (allowed IN (0,1)),
    UNIQUE(role,dimension_kind,dimension_id)
  );

  CREATE TABLE evidence_retention_policies (
    evidence_kind TEXT PRIMARY KEY CHECK (evidence_kind IN ('attachments','review_questions','signoffs','review_bundles','audit')),
    keep_days INTEGER CHECK (keep_days IS NULL OR keep_days BETWEEN 30 AND 36500),
    warn_days INTEGER NOT NULL DEFAULT 30 CHECK (warn_days BETWEEN 1 AND 365),
    purge_requires_approval INTEGER NOT NULL DEFAULT 1 CHECK (purge_requires_approval IN (0,1)),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO evidence_retention_policies(evidence_kind,keep_days,warn_days,purge_requires_approval,updated_by) VALUES
    ('attachments',NULL,30,1,'system'),('review_questions',NULL,30,1,'system'),
    ('signoffs',NULL,30,1,'system'),('review_bundles',NULL,30,1,'system'),('audit',NULL,30,1,'system');
  `,
  // 050 - source mapping profiles, imported attachment lineage and portable exit-package receipts.
  `
  CREATE TABLE import_mapping_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('generic','busy','zoho_books','marg')),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('ledgers','items','openings','generic_journal')),
    field_mappings_json TEXT NOT NULL DEFAULT '{}',
    value_mappings_json TEXT NOT NULL DEFAULT '{}',
    date_format TEXT NOT NULL DEFAULT 'auto',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO import_mapping_profiles(name,source_kind,target_kind,field_mappings_json,value_mappings_json,date_format,created_by) VALUES
    ('Busy voucher export','busy','generic_journal','{"Voucher Group":"Vch No","Date":"Date","Voucher Type":"Vch Type","Ledger":"Account","Debit":"Dr","Credit":"Cr","Narration":"Narration"}','{}','auto','system'),
    ('Busy ledger masters','busy','ledgers','{"Name":"Account Name","Group":"Group Name","Opening Balance":"Opening Balance","GSTIN":"GST No","State":"State","PAN":"PAN","Credit Days":"Credit Days"}','{}','auto','system'),
    ('Busy item masters','busy','items','{"Name":"Item Name","Group":"Item Group","Unit":"Unit","HSN":"HSN Code","GST Rate":"Tax Rate","Opening Qty":"Opening Qty","Opening Value":"Opening Value"}','{}','auto','system'),
    ('Zoho Books journals','zoho_books','generic_journal','{"Voucher Group":"Journal Number","Date":"Journal Date","Voucher Type":"Transaction Type","Ledger":"Account","Debit":"Debit","Credit":"Credit","Narration":"Description","Reference":"Reference Number"}','{"Voucher Type":{"Manual Journal":"Journal","Invoice":"Sales","Bill":"Purchase","Customer Payment":"Receipt","Vendor Payment":"Payment"}}','auto','system'),
    ('Zoho Books contacts','zoho_books','ledgers','{"Name":"Contact Name","Group":"Contact Type","Opening Balance":"Opening Balance","GSTIN":"GSTIN","State":"Place of Supply","PAN":"PAN","Credit Days":"Payment Terms Days"}','{"Group":{"customer":"Sundry Debtors","vendor":"Sundry Creditors"}}','auto','system'),
    ('Zoho Books items','zoho_books','items','{"Name":"Item Name","Group":"Item Type","Unit":"Unit","HSN":"HSN/SAC","GST Rate":"Tax Percentage","Opening Qty":"Opening Stock","Opening Value":"Opening Stock Value"}','{}','auto','system'),
    ('Zoho Books opening balances','zoho_books','openings','{"Ledger":"Account","Opening Balance":"Opening Balance"}','{}','auto','system'),
    ('Marg transaction export','marg','generic_journal','{"Voucher Group":"Bill No","Date":"Date","Voucher Type":"Voucher Type","Ledger":"Ledger","Debit":"Debit","Credit":"Credit","Narration":"Narration"}','{}','auto','system'),
    ('Marg ledger masters','marg','ledgers','{"Name":"Ledger Name","Group":"Group","Opening Balance":"Opening","GSTIN":"GST No","State":"State","PAN":"PAN No"}','{}','auto','system'),
    ('Marg item masters','marg','items','{"Name":"Product Name","Group":"Company","Unit":"Packing","HSN":"HSN","GST Rate":"GST %","Opening Qty":"Opening Stock","Opening Value":"Opening Value"}','{}','auto','system');

  CREATE TABLE import_voucher_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_batch_id INTEGER NOT NULL REFERENCES import_batches(id),
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id),
    source_filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256)=64),
    linked_by TEXT NOT NULL,
    linked_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(import_batch_id,source_filename),
    UNIQUE(voucher_id,stored_path)
  );

  CREATE TABLE portable_export_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    path TEXT NOT NULL,
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash)=64),
    counts_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 051 - review-only document extraction, task routing and local suggestion feedback.
  `
  CREATE TABLE ai_document_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_kind TEXT NOT NULL CHECK (document_kind IN ('supplier_invoice','receipt')),
    source_path TEXT NOT NULL,
    source_hash TEXT NOT NULL CHECK (length(source_hash)=64),
    status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('extracting','review','approved','dismissed','duplicate','failed')),
    extracted_json TEXT NOT NULL,
    duplicate_of_id INTEGER REFERENCES ai_document_inbox(id),
    voucher_draft_id INTEGER REFERENCES voucher_drafts(id),
    error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_by TEXT,
    reviewed_at TEXT
  );
  CREATE INDEX idx_ai_document_inbox_status ON ai_document_inbox(status,created_at DESC);

  CREATE TABLE ai_task_routes (
    task_kind TEXT PRIMARY KEY CHECK (task_kind IN ('ocr','classification','analysis','writing')),
    provider TEXT NOT NULL CHECK (provider IN ('default','openai','compatible')),
    model TEXT,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO ai_task_routes(task_kind,provider,updated_by) VALUES
    ('ocr','default','system'),('classification','default','system'),('analysis','default','system'),('writing','default','system');

  CREATE TABLE ai_ledger_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_kind TEXT NOT NULL,
    context_key TEXT NOT NULL,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_ai_ledger_feedback_context ON ai_ledger_feedback(context_kind,context_key,created_at DESC);

  CREATE TABLE ai_evaluation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fixture_set TEXT NOT NULL,
    extraction_accuracy_bps INTEGER NOT NULL CHECK (extraction_accuracy_bps BETWEEN 0 AND 10000),
    citation_validity_bps INTEGER NOT NULL CHECK (citation_validity_bps BETWEEN 0 AND 10000),
    draft_validity_bps INTEGER NOT NULL CHECK (draft_validity_bps BETWEEN 0 AND 10000),
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 052 - declarative partner extensions, signed webhook outbox and visible local automation.
  // Plugins never execute inside the accounting process; manifests can only select allow-listed
  // import/report primitives. All accounting figures remain derived from voucher_lines.
  `
  CREATE TABLE integration_plugins (
    id TEXT PRIMARY KEY,
    manifest_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
    compatible INTEGER NOT NULL CHECK (compatible IN (0,1)),
    installed_by TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE integration_import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id TEXT NOT NULL REFERENCES integration_plugins(id),
    importer_id TEXT NOT NULL,
    source_hash TEXT NOT NULL CHECK (length(source_hash)=64),
    source_rows INTEGER NOT NULL CHECK (source_rows >= 0),
    accepted_rows INTEGER NOT NULL CHECK (accepted_rows >= 0),
    rejected_rows INTEGER NOT NULL CHECK (rejected_rows >= 0),
    status TEXT NOT NULL CHECK (status IN ('previewed','applied','rejected')),
    result_json TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_integration_import_runs_plugin ON integration_import_runs(plugin_id,created_at DESC);

  CREATE TABLE settlement_adapter_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (provider IN ('generic','razorpay','stripe')),
    payout_reference TEXT NOT NULL,
    review_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('balanced','provider_mismatch','bank_mismatch')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider,payout_reference)
  );

  CREATE TABLE ecommerce_adapter_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('generic','shopify','woocommerce')),
    order_id TEXT NOT NULL,
    review_json TEXT NOT NULL,
    ready INTEGER NOT NULL CHECK (ready IN (0,1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source,order_id)
  );

  CREATE TABLE logistics_adapter_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    format TEXT NOT NULL CHECK (format IN ('generic','delhivery','shiprocket')),
    path TEXT NOT NULL,
    shipment_count INTEGER NOT NULL CHECK (shipment_count > 0),
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash)=64),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE webhook_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    event_types_json TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    last_error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE webhook_outbox (
    id TEXT PRIMARY KEY,
    endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints(id),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','retry','dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  );
  CREATE INDEX idx_webhook_outbox_delivery ON webhook_outbox(state,next_attempt_at,endpoint_id);

  CREATE TABLE automation_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    task_kind TEXT NOT NULL CHECK (task_kind IN ('backup','mirror','report_pack')),
    cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
    local_time TEXT NOT NULL CHECK (length(local_time)=5),
    day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
    day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 28),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    config_json TEXT NOT NULL DEFAULT '{}',
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_automation_schedules_due ON automation_schedules(enabled,next_run_at);

  CREATE TABLE automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES automation_schedules(id),
    task_kind TEXT NOT NULL CHECK (task_kind IN ('backup','mirror','report_pack')),
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    output_json TEXT,
    error TEXT
  );
  CREATE INDEX idx_automation_runs_schedule ON automation_runs(schedule_id,started_at DESC);
  `,
  // 053 - user-selected backup destinations, recovery-drill evidence and rotation policy.
  `
  CREATE TABLE backup_destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    last_success_at TEXT,
    last_error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE backup_recovery_drills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backup_file TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('company','destination')),
    source_path TEXT NOT NULL,
    integrity TEXT NOT NULL CHECK (integrity IN ('ok','failed')),
    detail TEXT NOT NULL,
    company_name TEXT,
    schema_version INTEGER,
    voucher_count INTEGER,
    verified_by TEXT NOT NULL,
    verified_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_backup_recovery_drills_at ON backup_recovery_drills(verified_at DESC);

  CREATE TABLE backup_rotation_policy (
    id INTEGER PRIMARY KEY CHECK (id=1),
    daily_count INTEGER NOT NULL DEFAULT 14 CHECK (daily_count BETWEEN 1 AND 365),
    weekly_count INTEGER NOT NULL DEFAULT 8 CHECK (weekly_count BETWEEN 0 AND 104),
    monthly_count INTEGER NOT NULL DEFAULT 12 CHECK (monthly_count BETWEEN 0 AND 120),
    year_end_count INTEGER NOT NULL DEFAULT 7 CHECK (year_end_count BETWEEN 0 AND 25),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO backup_rotation_policy(id,updated_by) VALUES(1,'system');
  `,
  // 054 - managed evidence associated with posted vouchers. Files live in the company
  // attachment vault; this table stores only durable identity, kind and audit metadata.
  `
  CREATE TABLE voucher_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('invoice','receipt','email','delivery','other')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_voucher_attachments_voucher ON voucher_attachments(voucher_id,created_at,id);
  `,
  // 055 - customer collection operations remain separate from posted accounting evidence.
  `
  CREATE TABLE collection_customer_settings (
    ledger_id INTEGER PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
    owner TEXT NOT NULL DEFAULT '',
    reminder_days TEXT NOT NULL DEFAULT '7,14,30',
    early_discount_bps INTEGER NOT NULL DEFAULT 0 CHECK (early_discount_bps BETWEEN 0 AND 5000),
    early_days INTEGER NOT NULL DEFAULT 0 CHECK (early_days BETWEEN 0 AND 365),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE collection_disputes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    owner TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX idx_collection_disputes_ledger ON collection_disputes(ledger_id,status,created_at);
  CREATE UNIQUE INDEX idx_collection_disputes_open_voucher ON collection_disputes(voucher_id) WHERE status='open';
  CREATE TABLE collection_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','phone')),
    status TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','sent','skipped')),
    body TEXT NOT NULL,
    due_date TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX idx_collection_reminders_ledger ON collection_reminders(ledger_id,due_date,status);
  CREATE TABLE collection_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_collection_notes_ledger ON collection_notes(ledger_id,created_at,id);
  `,
  // 056 - optional party contact channels. These remain local master data and are used only
  // when a user explicitly opens a reviewed email/WhatsApp reminder draft.
  `
  ALTER TABLE ledgers ADD COLUMN email TEXT;
  ALTER TABLE ledgers ADD COLUMN phone TEXT;
  `,
  // 057 - durable idempotency ledger for human-reviewed agent proposals. The accounting or
  // maker-checker result and this row commit together; filesystem archival can then be retried
  // without ever posting the same proposal twice.
  `
  CREATE TABLE agent_proposal_results (
    proposal_id TEXT PRIMARY KEY,
    proposal_sha256 TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    result_kind TEXT NOT NULL CHECK (result_kind IN ('voucher','approval_request')),
    result_id INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 058 - ties a recurring occurrence to maker-checker so the schedule advances only when
  // the voucher is actually approved. Rejection leaves the occurrence due for correction/retry.
  `
  CREATE TABLE recurring_approval_links (
    approval_request_id INTEGER PRIMARY KEY REFERENCES approval_requests(id) ON DELETE CASCADE,
    recurring_template_id INTEGER NOT NULL REFERENCES recurring_templates(id) ON DELETE CASCADE,
    occurrence_date TEXT NOT NULL,
    next_due TEXT NOT NULL,
    UNIQUE(recurring_template_id, occurrence_date)
  );
  CREATE INDEX idx_recurring_approval_links_template
    ON recurring_approval_links(recurring_template_id, occurrence_date);
  `,
  // 059 - local customer/supplier communications. Drafts require an explicit review before
  // queueing; SMTP acceptance is recorded honestly and never presented as recipient delivery.
  // Credentials are device-bound safeStorage ciphertext. Message events are append-only evidence.
  `
  CREATE TABLE party_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    email TEXT,
    phone TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (email IS NOT NULL OR phone IS NOT NULL)
  );
  CREATE INDEX idx_party_contacts_ledger ON party_contacts(ledger_id,active DESC,name,id);
  CREATE UNIQUE INDEX idx_party_contacts_email
    ON party_contacts(ledger_id,lower(email)) WHERE email IS NOT NULL;
  CREATE UNIQUE INDEX idx_party_contacts_primary
    ON party_contacts(ledger_id) WHERE is_primary=1 AND active=1;

  CREATE TABLE smtp_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    security TEXT NOT NULL CHECK (security IN ('tls','starttls')),
    username TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    from_email TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    last_tested_at TEXT,
    last_error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_smtp_profiles_active ON smtp_profiles(active DESC,name,id);

  CREATE TABLE outbound_messages (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    contact_id INTEGER REFERENCES party_contacts(id) ON DELETE SET NULL,
    channel TEXT NOT NULL DEFAULT 'email' CHECK (channel='email'),
    to_json TEXT NOT NULL CHECK (json_valid(to_json) AND json_type(to_json)='array'),
    cc_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cc_json) AND json_type(cc_json)='array'),
    bcc_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bcc_json) AND json_type(bcc_json)='array'),
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
    sender_json TEXT CHECK (sender_json IS NULL OR json_valid(sender_json)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
      'draft','reviewed','queued','sending','accepted_by_smtp','acceptance_unknown','failed','cancelled','exported'
    )),
    smtp_profile_id INTEGER REFERENCES smtp_profiles(id) ON DELETE SET NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    reviewed_by TEXT,
    reviewed_at TEXT,
    queued_at TEXT,
    accepted_at TEXT,
    exported_at TEXT,
    last_error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_outbound_messages_status ON outbound_messages(status,updated_at DESC,id);
  CREATE INDEX idx_outbound_messages_ledger ON outbound_messages(ledger_id,created_at DESC,id);
  CREATE TRIGGER outbound_messages_content_locked
    BEFORE UPDATE OF ledger_id,contact_id,to_json,cc_json,bcc_json,subject,body_text,content_sha256
    ON outbound_messages WHEN OLD.status<>'draft'
    BEGIN SELECT RAISE(ABORT,'reviewed message content is immutable'); END;

  CREATE TABLE outbound_message_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES outbound_messages(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'created','edited','reviewed','queued','delivery_started','accepted_by_smtp',
      'acceptance_unknown','failed','cancelled','eml_exported'
    )),
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json)='object'),
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_outbound_message_events_message
    ON outbound_message_events(message_id,id);
  CREATE TRIGGER outbound_message_events_no_update
    BEFORE UPDATE ON outbound_message_events
    BEGIN SELECT RAISE(ABORT,'outbound message events are append-only'); END;
  CREATE TRIGGER outbound_message_events_no_delete
    BEFORE DELETE ON outbound_message_events
    BEGIN SELECT RAISE(ABORT,'outbound message events are append-only'); END;
  `,
  // 060 - crash-safe SMTP delivery leases. Kept separate because migration 059
  // shipped as the communications foundation and may already exist locally.
  `
  ALTER TABLE outbound_messages ADD COLUMN delivery_attempt_id TEXT;
  ALTER TABLE outbound_messages ADD COLUMN delivery_lease_expires_at TEXT;
  CREATE INDEX idx_outbound_messages_delivery_lease
    ON outbound_messages(status,delivery_lease_expires_at);
  `,
  // 061 - bounded, maker-checker approval batches for local outbound drafts. Batch rows
  // snapshot the exact reviewed revision, recipients and paise totals; events are immutable
  // evidence of approval, enqueue failures and retries. SMTP submission remains a separate step.
  `
  CREATE TABLE communication_batches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'pending_approval','approved','partially_queued','queued','rejected','cancelled'
    )),
    maker_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    maker_name TEXT NOT NULL,
    checker_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    checker_name TEXT,
    decision_note TEXT,
    selected_count INTEGER NOT NULL CHECK (selected_count BETWEEN 1 AND 100),
    included_count INTEGER NOT NULL CHECK (included_count BETWEEN 0 AND 100),
    excluded_count INTEGER NOT NULL CHECK (excluded_count BETWEEN 0 AND 100),
    recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 0 AND 5000),
    total_amount_paise INTEGER NOT NULL CHECK (total_amount_paise >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (included_count + excluded_count = selected_count)
  );
  CREATE INDEX idx_communication_batches_status
    ON communication_batches(status,updated_at DESC,id);

  CREATE TABLE communication_batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES communication_batches(id) ON DELETE RESTRICT,
    message_id TEXT NOT NULL REFERENCES outbound_messages(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 99),
    status TEXT NOT NULL CHECK (status IN ('ready','excluded','queued','failed')),
    document_kind TEXT NOT NULL CHECK (document_kind IN ('invoice','statement','reminder','other')),
    document_label TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
    message_revision INTEGER NOT NULL CHECK (message_revision > 0),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
    ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    contact_id INTEGER REFERENCES party_contacts(id) ON DELETE SET NULL,
    to_json TEXT NOT NULL CHECK (json_valid(to_json) AND json_type(to_json)='array'),
    cc_json TEXT NOT NULL CHECK (json_valid(cc_json) AND json_type(cc_json)='array'),
    bcc_json TEXT NOT NULL CHECK (json_valid(bcc_json) AND json_type(bcc_json)='array'),
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    exclusion_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    queued_at TEXT,
    UNIQUE(batch_id,message_id),
    UNIQUE(batch_id,position),
    CHECK ((status='excluded') = (exclusion_reason IS NOT NULL))
  );
  CREATE INDEX idx_communication_batch_items_batch
    ON communication_batch_items(batch_id,position,id);

  CREATE TABLE communication_batch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES communication_batches(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'created','approved','rejected','enqueue_started','item_queued','item_failed',
      'retry_started','enqueue_completed','cancelled'
    )),
    detail_json TEXT NOT NULL DEFAULT '{}' CHECK (
      json_valid(detail_json) AND json_type(detail_json)='object'
    ),
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_communication_batch_events_batch
    ON communication_batch_events(batch_id,id);
  CREATE TRIGGER communication_batch_events_no_update
    BEFORE UPDATE ON communication_batch_events
    BEGIN SELECT RAISE(ABORT,'communication batch events are append-only'); END;
  CREATE TRIGGER communication_batch_events_no_delete
    BEFORE DELETE ON communication_batch_events
    BEGIN SELECT RAISE(ABORT,'communication batch events are append-only'); END;
  `,
  // 062 - local AI conversation history and immutable draft-action evidence. Provider keys
  // remain device-only in safeStorage and are never written to these company tables.
  `
  CREATE TABLE ai_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_ai_conversations_updated ON ai_conversations(updated_at DESC,id);

  CREATE TABLE ai_conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    request_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
    citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json) AND json_type(citations_json)='array'),
    provider TEXT,
    model TEXT,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled','failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_ai_conversation_messages_conversation
    ON ai_conversation_messages(conversation_id,id);
  CREATE UNIQUE INDEX idx_ai_conversation_messages_request_role
    ON ai_conversation_messages(request_id,role) WHERE request_id IS NOT NULL;

  CREATE TABLE ai_draft_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT REFERENCES ai_conversations(id) ON DELETE SET NULL,
    proposal_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('voucher','master_change')),
    source_prompt TEXT NOT NULL CHECK (length(source_prompt) BETWEEN 1 AND 4000),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','discarded')),
    explanation TEXT NOT NULL DEFAULT '',
    warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json) AND json_type(warnings_json)='array'),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_ai_draft_actions_status ON ai_draft_actions(status,updated_at DESC,id);
  CREATE UNIQUE INDEX idx_ai_draft_actions_proposal ON ai_draft_actions(proposal_id);
  `,
  // 063 - optional end-to-end encrypted collaboration transport. Only proposals, drafts,
  // comments and tasks enter this lane; posted books and the live SQLite file never do.
  // Envelopes/events are append-only evidence while sync_records is a rebuildable CRDT view.
  `
  CREATE TABLE sync_records (
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('proposal','draft','comment','task')),
    entity_id TEXT NOT NULL,
    document_json TEXT NOT NULL CHECK (json_valid(document_json) AND json_type(document_json)='object'),
    document_hash TEXT NOT NULL CHECK (length(document_hash)=64),
    updated_at TEXT NOT NULL,
    updated_by_device TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
    PRIMARY KEY(entity_kind,entity_id)
  );
  CREATE INDEX idx_sync_records_updated ON sync_records(updated_at DESC,entity_kind,entity_id);

  CREATE TABLE sync_envelopes (
    envelope_id TEXT PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('outgoing','incoming')),
    device_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    entity_kind TEXT NOT NULL CHECK (entity_kind IN ('proposal','draft','comment','task')),
    entity_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json) AND json_type(envelope_json)='object'),
    content_hash TEXT NOT NULL CHECK (length(content_hash)=64),
    state TEXT NOT NULL CHECK (state IN ('pending','acknowledged','applied','rejected')),
    error TEXT,
    created_at TEXT NOT NULL,
    processed_at TEXT,
    UNIQUE(device_id,sequence)
  );
  CREATE INDEX idx_sync_envelopes_outbox ON sync_envelopes(direction,state,sequence);
  CREATE TRIGGER sync_envelopes_no_update_payload
    BEFORE UPDATE OF envelope_id,direction,device_id,sequence,entity_kind,entity_id,envelope_json,content_hash,created_at
    ON sync_envelopes BEGIN SELECT RAISE(ABORT,'sync envelope payloads are append-only'); END;
  CREATE TRIGGER sync_envelopes_no_delete
    BEFORE DELETE ON sync_envelopes BEGIN SELECT RAISE(ABORT,'sync envelopes are append-only'); END;

  CREATE TABLE sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envelope_id TEXT NOT NULL REFERENCES sync_envelopes(envelope_id) ON DELETE RESTRICT,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    kept_device_id TEXT NOT NULL,
    other_device_id TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX idx_sync_conflicts_unresolved ON sync_conflicts(resolved,created_at DESC,id);

  CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 064 - preserve source voucher identity in the seeded accounting migration profiles.
  `
  UPDATE import_mapping_profiles
  SET field_mappings_json = '{"Voucher Group":"Vch No","Date":"Date","Voucher Type":"Vch Type","Number":"Vch No","Ledger":"Account","Debit":"Dr","Credit":"Cr","Narration":"Narration","Reference":"Ref No"}',
      updated_at = datetime('now')
  WHERE name = 'Busy voucher export' AND created_by = 'system';

  UPDATE import_mapping_profiles
  SET field_mappings_json = '{"Voucher Group":"Journal Number","Date":"Journal Date","Voucher Type":"Transaction Type","Number":"Journal Number","Ledger":"Account","Debit":"Debit","Credit":"Credit","Narration":"Description","Reference":"Reference Number"}',
      updated_at = datetime('now')
  WHERE name = 'Zoho Books journals' AND created_by = 'system';

  UPDATE import_mapping_profiles
  SET field_mappings_json = '{"Voucher Group":"Bill No","Date":"Date","Voucher Type":"Voucher Type","Number":"Bill No","Ledger":"Ledger","Debit":"Debit","Credit":"Credit","Narration":"Narration","Reference":"Reference"}',
      updated_at = datetime('now')
  WHERE name = 'Marg transaction export' AND created_by = 'system';
  `,
  // 065 - semantic replay identity for structured imports such as Tally XML.
  `
  ALTER TABLE import_batches ADD COLUMN semantic_hash TEXT CHECK (semantic_hash IS NULL OR length(semantic_hash)=64);
  CREATE UNIQUE INDEX idx_import_batches_kind_semantic
    ON import_batches(kind,semantic_hash) WHERE semantic_hash IS NOT NULL;
  `,
];
