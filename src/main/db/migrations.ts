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
  // 018 (WP 1.3) — year-end closing journals get an explicit flag; group natures are repaired.
  // - vouchers.is_year_end_close: 1 on the journal postClose posts. Profit reports (P&L, cash flow,
  //   close preview, ...) exclude flagged vouchers so a closed year still shows its real profit;
  //   trial balance / ledger statements keep them (they are real postings). Flagged vouchers are
  //   immutable (saveVoucher refuses edits). No CHECK constraint, matching the other 0/1 voucher
  //   flags (post_dated, is_optional).
  // - (1) Backfill FIRST, on group natures as they are before the repair — the natures postClose
  //   itself used when it built those journals. Conservative: a false positive would hide real
  //   income/expense from the P&L. Soft-deleted vouchers are included, so a binned close
  //   restored later is still flagged.
  //   (a) vouchers referenced by a year_end 'create' audit row (postClose writes {voucherId});
  //       rows whose JSON doesn't parse or whose voucher no longer exists are skipped.
  //   (b) pre-audit (v0.2.0) closes: a journal dated 31 March <y+1> whose narration contains the
  //       exact marker '[year-end close FY<y>]', with at least one income/expense line and ALL
  //       other lines on one single ledger — the transfer ledger, whatever it is now called
  //       (postClose finds-or-creates 'Retained Earnings' by name, so a renamed one must match).
  // - (2) Group repair: a non-system group's nature/affects_gross_profit always follow its
  //   parent's, but updateGroup used to re-derive them for the moved group only. Values are
  //   copied top-down from the nearest system (seeded) ancestor, or a top-level group; system
  //   groups are never changed (in the seed every child already matches its parent).
  // - (3) Trace: one audit_log row (entity 'migration', entity_id 18, no user) recording the
  //   voucher ids flagged via audit and via narration and every repaired group (old -> new).
  `
  ALTER TABLE vouchers ADD COLUMN is_year_end_close INTEGER NOT NULL DEFAULT 0;

  CREATE TEMP TABLE m018_via_audit AS
    SELECT v.id FROM vouchers v
     WHERE v.id IN (
       SELECT CAST(json_extract(a.after_json, '$.voucherId') AS INTEGER)
         FROM audit_log a
        WHERE a.entity = 'year_end' AND a.action = 'create'
          AND a.after_json IS NOT NULL AND json_valid(a.after_json)
          AND json_type(a.after_json, '$.voucherId') = 'integer'
     );

  CREATE TEMP TABLE m018_via_narration AS
    SELECT v.id FROM vouchers v
      JOIN voucher_types vt ON vt.id = v.voucher_type_id
     WHERE vt.kind = 'journal'
       AND v.id NOT IN (SELECT id FROM m018_via_audit)
       AND substr(v.date, 6, 5) = '03-31'
       AND v.narration IS NOT NULL
       AND instr(v.narration,
                 '[year-end close FY' || (CAST(substr(v.date, 1, 4) AS INTEGER) - 1) || ']') > 0
       AND EXISTS (
         SELECT 1 FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
           JOIN groups g ON g.id = l.group_id
          WHERE vl.voucher_id = v.id AND g.nature IN ('income', 'expense')
       )
       AND (
         SELECT COUNT(DISTINCT vl.ledger_id) FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
           JOIN groups g ON g.id = l.group_id
          WHERE vl.voucher_id = v.id AND g.nature NOT IN ('income', 'expense')
       ) <= 1;

  UPDATE vouchers SET is_year_end_close = 1
   WHERE id IN (SELECT id FROM m018_via_audit UNION SELECT id FROM m018_via_narration);

  CREATE TEMP TABLE m018_groups AS
    WITH RECURSIVE truth(id, nature, gp) AS (
      SELECT id, nature, affects_gross_profit FROM groups WHERE is_system = 1 OR parent_id IS NULL
      UNION ALL
      SELECT g.id, t.nature, t.gp FROM groups g JOIN truth t ON g.parent_id = t.id WHERE g.is_system = 0
    )
    SELECT g.id, g.name, g.nature AS old_nature, t.nature AS new_nature,
           g.affects_gross_profit AS old_gp, t.gp AS new_gp
      FROM groups g JOIN truth t ON t.id = g.id
     WHERE g.is_system = 0 AND (g.nature <> t.nature OR g.affects_gross_profit <> t.gp);

  UPDATE groups
     SET nature = (SELECT m.new_nature FROM m018_groups m WHERE m.id = groups.id),
         affects_gross_profit = (SELECT m.new_gp FROM m018_groups m WHERE m.id = groups.id)
   WHERE id IN (SELECT id FROM m018_groups);

  INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
  VALUES ('migration', 18, 'update', NULL, json_object(
    'migration', 18,
    'flaggedViaAudit', json((SELECT json_group_array(id) FROM (SELECT id FROM m018_via_audit ORDER BY id))),
    'flaggedViaNarration', json((SELECT json_group_array(id) FROM (SELECT id FROM m018_via_narration ORDER BY id))),
    'groupsRepaired', json((SELECT json_group_array(json_object(
        'id', id, 'name', name,
        'nature', json_object('from', old_nature, 'to', new_nature),
        'affectsGrossProfit', json_object('from', old_gp, 'to', new_gp)))
      FROM (SELECT * FROM m018_groups ORDER BY id)))
  ), NULL, NULL);

  DROP TABLE m018_via_audit;
  DROP TABLE m018_via_narration;
  DROP TABLE m018_groups;
  `,
  // 019 (WP 2.2) — manufacture voucher entry facts. One row per stock_journal saved by the
  // Manufacture screen: the finished item and quantity, the sale rate/amount and profit typed on
  // the screen (margin reporting only — they never post), and the labour figure that the
  // valuation engine loads into the finished goods (stockAnalysis' derived-costing source reads
  // this table). labour_posted = 1 when labour was journalled on the voucher itself (Dr
  // labour_expense_ledger_id / Cr labour_credit_ledger_id); 0 = "already booked" elsewhere,
  // capitalised without ledger lines. These are entry facts, not balances. A legacy stock
  // journal has no row and keeps its stored costing. Soft delete leaves the row in place (the
  // voucher row survives in the bin); only a purge cascades it away.
  `
  CREATE TABLE manufacture_details (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    finished_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    sale_rate_paise INTEGER NOT NULL DEFAULT 0 CHECK (sale_rate_paise >= 0),
    sale_amount INTEGER NOT NULL DEFAULT 0 CHECK (sale_amount >= 0),
    labour_paise INTEGER NOT NULL DEFAULT 0 CHECK (labour_paise >= 0),
    labour_posted INTEGER NOT NULL DEFAULT 0 CHECK (labour_posted IN (0, 1)),
    labour_expense_ledger_id INTEGER REFERENCES ledgers(id),
    labour_credit_ledger_id INTEGER REFERENCES ledgers(id),
    profit_paise INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_manufacture_details_item ON manufacture_details(finished_item_id);
  `,
  // 020 (WP 3.1) — TDS core. Number assigned by the orchestrator; appended after 019 (WP 2.2),
  // whose content it does not depend on.
  // - ledgers.tds_payable_section_id tags a ledger as a section's TDS payable ledger (the mirror
  //   of tax_type); ledgers.deductee_type (null = derive from the PAN's 4th character);
  //   ledgers.tds_default_section_id flags expense ledgers as TDS-applicable.
  // - tds_sections gains nature / act / legacy_code (Income-tax Act 1961) / new_reference
  //   (Income-tax Act 2025). The old rate/threshold columns stay and are kept as a mirror of the
  //   current 'any' rate row (services/tds.ts syncLegacyColumns) so older readers keep working.
  // - tds_section_rates: effective-dated rate/threshold rows per section x deductee type, rates
  //   in basis points. Every seeded number carries a citation (below, and in `source`).
  // - tds_certificates (s.197 lower/nil deduction), tds_challans + tds_entry_challans (one
  //   challan per entry), and tds_entries' basis columns (deductee type, rate, certificate,
  //   manual flag). Entries recorded before 020 were never server-validated: is_manual = 1.
  // - Backfill: payable ledgers are tagged (a) by the name the app always created them with,
  //   "TDS Payable <code>", and (b) for hand-named ledgers, when a pre-020 entry's voucher
  //   credits exactly one untagged Duties & Taxes ledger by exactly the TDS amount and that
  //   ledger is never matched to two sections. One audit_log row (entity 'migration',
  //   entity_id 20) records what was tagged.
  //
  // SOURCES (all accessed 2026-10-07):
  //  [ACT25]   Income-tax Act, 2025 (No. 30 of 2025, assent 21 Aug 2025), Gazette —
  //            https://egazette.gov.in/WriteReadData/2025/265620.pdf ; s.1(3): "it shall come
  //            into force on the 1st April, 2026". TDS: s.392 (salary), s.393(1) Table
  //            (residents), s.393(3) (any person), s.397(2)(b)(i) (no PAN), s.516 (rounding).
  //  [ACT25-FA26] Income-tax Act, 2025 as amended by Finance Act 2026 (CBDT compilation) —
  //            https://www.incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf
  //  [FA25]    Finance Act, 2025 — https://egazette.gov.in/WriteReadData/2025/262125.pdf
  //            (s.63 194H 15,000->20,000; s.64 194-I "50,000 for a month or part of a month";
  //            s.65 194J 30,000->50,000; s.58 194A thresholds; s.71 omits 206AB)
  //  [FA26]    Finance Act, 2026 (No. 4 of 2026) — https://egazette.gov.in/WriteReadData/2026/271439.pdf
  //  [FAQ]     e-filing portal, TDS compliance FAQs (Q1 transition test; Q3 "TDS rates and
  //            monetary thresholds ... retained as they are under the Income Tax Act, 1961") —
  //            https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/tds-compliance
  //  [RATES]   Income Tax Department, TDS rates (AY 2026-27) — https://www.incometaxindia.gov.in/w/tds-rates-1
  //  [194C]    https://www.incometaxindia.gov.in/w/section-194c
  //  [194A]    https://www.incometaxindia.gov.in/w/section-194a
  //  [194Q]    https://www.incometaxindia.gov.in/w/section-194q
  //  [206AA]   https://www.incometaxindia.gov.in/w/higher-deduction-of-tax-at-source-in-certain-cases-section-206aa-and-section-206ab-
  //  [F26Q]    Protean 26Q file format v7.8 (old-Act section codes, deductee code 01/02) —
  //            https://tinpan.proteantech.in/downloads/e-tds/File_Format_26Q_Regular_Q1_to_Q4_Version_7.8_27052025_201011.xls
  //  [F140]    Protean Form No. 140 (26Q under the 2025 Act) file format v1.1 (payment codes) —
  //            https://tinpan.proteantech.in/downloads/e-tds/Form%20Number%20140%20-%2026Q%20-%20Q1%20to%20Q4_22072026.xlsx
  //  [PAN]     PAN 4th character = holder status — https://www.incometaxindia.gov.in/w/how-pan-is-formed-and-how-it-gets-its-unique-identity-
  // FY 2025-26 rows: 1961 Act as amended by [FA25] (ss.2-91 in force 1 Apr 2025).
  // From 1 Apr 2026: [ACT25-FA26]; per [FAQ] Q3 rates/thresholds are unchanged, and [FA26]
  // changes none of the seeded figures. No-PAN: higher of the section rate and 20% (5% for
  // 194Q) — 1961 s.206AA [206AA], 2025 s.397(2)(b)(i) [ACT25-FA26].
  `
  ALTER TABLE ledgers ADD COLUMN tds_payable_section_id INTEGER REFERENCES tds_sections(id);
  ALTER TABLE ledgers ADD COLUMN deductee_type TEXT CHECK (deductee_type IN ('individual_huf', 'company', 'firm', 'other'));
  ALTER TABLE ledgers ADD COLUMN tds_default_section_id INTEGER REFERENCES tds_sections(id);
  CREATE INDEX idx_ledgers_tds_payable ON ledgers(tds_payable_section_id) WHERE tds_payable_section_id IS NOT NULL;

  ALTER TABLE tds_sections ADD COLUMN nature TEXT;
  ALTER TABLE tds_sections ADD COLUMN act TEXT NOT NULL DEFAULT 'it_act_1961' CHECK (act IN ('it_act_1961', 'it_act_2025'));
  ALTER TABLE tds_sections ADD COLUMN legacy_code TEXT;
  ALTER TABLE tds_sections ADD COLUMN new_reference TEXT;

  CREATE TABLE tds_section_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES tds_sections(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    deductee_type TEXT NOT NULL CHECK (deductee_type IN ('individual_huf', 'company', 'firm', 'other', 'any')),
    rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
    threshold_single_paise INTEGER NOT NULL DEFAULT 0 CHECK (threshold_single_paise >= 0),
    threshold_annual_paise INTEGER NOT NULL DEFAULT 0 CHECK (threshold_annual_paise >= 0),
    threshold_basis TEXT NOT NULL DEFAULT 'fy' CHECK (threshold_basis IN ('fy', 'month')),
    threshold_excess_only INTEGER NOT NULL DEFAULT 0,
    no_pan_rate_bp INTEGER NOT NULL DEFAULT 2000 CHECK (no_pan_rate_bp BETWEEN 0 AND 10000),
    return_code TEXT,
    source TEXT,
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
  );
  CREATE INDEX idx_tds_section_rates_section ON tds_section_rates(section_id, effective_from);

  CREATE TABLE tds_certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    section_id INTEGER REFERENCES tds_sections(id) ON DELETE CASCADE,
    certificate_no TEXT NOT NULL,
    rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
    valid_from TEXT NOT NULL,
    valid_to TEXT NOT NULL,
    cap_paise INTEGER CHECK (cap_paise IS NULL OR cap_paise >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (valid_to >= valid_from)
  );
  CREATE INDEX idx_tds_certificates_ledger ON tds_certificates(ledger_id);

  CREATE TABLE tds_challans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    bsr_code TEXT NOT NULL,
    challan_no TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    payment_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    quarter INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    fy_start_year INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_tds_challans_period ON tds_challans(fy_start_year, quarter);

  CREATE TABLE tds_entry_challans (
    entry_id INTEGER PRIMARY KEY REFERENCES tds_entries(id) ON DELETE CASCADE,
    challan_id INTEGER NOT NULL REFERENCES tds_challans(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_tds_entry_challans_challan ON tds_entry_challans(challan_id);

  ALTER TABLE tds_entries ADD COLUMN deductee_type_at TEXT;
  ALTER TABLE tds_entries ADD COLUMN rate_bp_at INTEGER;
  ALTER TABLE tds_entries ADD COLUMN certificate_id INTEGER REFERENCES tds_certificates(id) ON DELETE SET NULL;
  ALTER TABLE tds_entries ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0;
  UPDATE tds_entries SET is_manual = 1;

  -- Sections carried from 005 keep their code; seeded ones get nature + both Act references
  -- (matched by code, so a section the user renamed is left alone). New-Act references are the
  -- s.393(1) Table serials in [ACT25-FA26].
  UPDATE tds_sections SET legacy_code = code;
  UPDATE tds_sections SET nature = 'Payment to contractors / sub-contractors (work)', new_reference = '393(1) Sl. 6(i)' WHERE code = '194C';
  UPDATE tds_sections SET nature = 'Fees for professional services and other 194J(b) sums', legacy_code = '194J(b)', new_reference = '393(1) Sl. 6(iii) D(b)' WHERE code = '194J';
  UPDATE tds_sections SET nature = 'Rent of land, building, furniture or fittings', legacy_code = '194-I(b)', new_reference = '393(1) Sl. 2(ii) D(b)' WHERE code = '194I';
  UPDATE tds_sections SET nature = 'Commission or brokerage', new_reference = '393(1) Sl. 1(ii)' WHERE code = '194H';
  UPDATE tds_sections SET nature = 'Interest other than on securities (payer other than a bank / co-op bank / post office)', new_reference = '393(1) Sl. 5(iii)' WHERE code = '194A';

  INSERT OR IGNORE INTO tds_sections (code, description, rate, threshold_single, threshold_annual, nature, act, legacy_code, new_reference) VALUES
    ('194J(A)', 'Fees for technical services, film royalty, call centre', 2, 0, 5000000,
     'Fees for technical services (not professional), royalty for sale/distribution/exhibition of films, call centre', 'it_act_1961', '194J(a)', '393(1) Sl. 6(iii) D(a)'),
    ('194I(A)', 'Rent of plant, machinery or equipment', 2, 0, 5000000,
     'Rent of plant, machinery or equipment', 'it_act_1961', '194-I(a)', '393(1) Sl. 2(ii) D(a)'),
    ('194Q', 'Purchase of goods', 0.1, 0, 500000000,
     'Purchase of goods above Rs 50 lakh a year from a resident seller (buyer turnover above Rs 10 crore in the preceding year)', 'it_act_1961', '194Q', '393(1) Sl. 8(ii)');

  -- (1) Carry every pre-020 section master figure as a rate row, so nothing computed before this
  --     migration changes: for the five 005 codes it covers dates up to 31 Mar 2025 (the cited
  --     rows below take over from FY 2025-26); a user-added section keeps it open-ended. These
  --     figures were NOT re-verified (source says so).
  INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp,
      threshold_single_paise, threshold_annual_paise, threshold_basis, no_pan_rate_bp, source)
    SELECT id, '1961-04-01',
           CASE WHEN code IN ('194C', '194J', '194I', '194H', '194A') THEN '2025-03-31' ELSE NULL END,
           'any', CAST(ROUND(rate * 100) AS INTEGER), threshold_single, threshold_annual, 'fy', 2000,
           'Carried over from the section master as it stood before migration 020 (not re-verified)'
      FROM tds_sections WHERE code NOT IN ('194J(A)', '194I(A)', '194Q');

  -- (2) Cited rows. Paise: Rs 30,000 = 3000000; Rs 1,00,000 = 10000000; Rs 50,000 = 5000000;
  --     Rs 20,000 = 2000000; Rs 10,000 = 1000000; Rs 50 lakh = 500000000.
  CREATE TEMP TABLE m020_seed (code TEXT, eff_from TEXT, eff_to TEXT, deductee TEXT, rate_bp INTEGER,
    single INTEGER, annual INTEGER, basis TEXT, excess INTEGER, no_pan INTEGER, return_code TEXT, source TEXT);
  INSERT INTO m020_seed VALUES
    -- 194C: 1% individual/HUF, 2% others; single > Rs 30,000 or aggregate > Rs 1,00,000.
    -- FY25-26: [194C] s.194C(1),(5) "does not exceed thirty thousand rupees ... aggregate ... exceeds one lakh rupees"; 26Q code 94C [F26Q].
    ('194C', '2025-04-01', '2026-03-31', 'individual_huf', 100, 3000000, 10000000, 'fy', 0, 2000, '94C',
     '1961 s.194C(1),(5) [https://www.incometaxindia.gov.in/w/section-194c]; no PAN s.206AA; accessed 2026-10-07'),
    ('194C', '2025-04-01', '2026-03-31', 'any', 200, 3000000, 10000000, 'fy', 0, 2000, '94C',
     '1961 s.194C(1),(5) [https://www.incometaxindia.gov.in/w/section-194c]; no PAN s.206AA; accessed 2026-10-07'),
    -- From 1 Apr 2026: 2025 Act s.393(1) Sl. 6(i) D(a)/(b) [ACT25-FA26]; Form 140 codes 1023/1024 [F140].
    ('194C', '2026-04-01', NULL, 'individual_huf', 100, 3000000, 10000000, 'fy', 0, 2000, '1023',
     '2025 Act s.393(1) Table Sl. 6(i) D(a) [ACT25 as amended by FA 2026, incometaxindia.gov.in]; no PAN s.397(2)(b)(i); accessed 2026-10-07'),
    ('194C', '2026-04-01', NULL, 'any', 200, 3000000, 10000000, 'fy', 0, 2000, '1024',
     '2025 Act s.393(1) Table Sl. 6(i) D(b) [ACT25 as amended by FA 2026, incometaxindia.gov.in]; no PAN s.397(2)(b)(i); accessed 2026-10-07'),
    -- 194J(b) professional fees: 10%, aggregate > Rs 50,000 a year. FY25-26: [RATES] 10%; [FA25] s.65 "fifty thousand rupees"; 26Q 4JB [F26Q].
    ('194J', '2025-04-01', '2026-03-31', 'any', 1000, 0, 5000000, 'fy', 0, 2000, '4JB',
     '1961 s.194J(1)(b) as amended by Finance Act 2025 s.65 [https://egazette.gov.in/WriteReadData/2025/262125.pdf]; rate per https://www.incometaxindia.gov.in/w/tds-rates-1; accessed 2026-10-07'),
    ('194J', '2026-04-01', NULL, 'any', 1000, 0, 5000000, 'fy', 0, 2000, '1027',
     '2025 Act s.393(1) Table Sl. 6(iii) D(b), threshold Rs 50,000 [ACT25 as amended by FA 2026]; accessed 2026-10-07'),
    -- 194J(a) technical fees / film royalty / call centre: 2%, aggregate > Rs 50,000. 26Q 4JA [F26Q]; Form 140 1026 [F140].
    ('194J(A)', '2025-04-01', '2026-03-31', 'any', 200, 0, 5000000, 'fy', 0, 2000, '4JA',
     '1961 s.194J(1)(a) as amended by Finance Act 2025 s.65; rate per https://www.incometaxindia.gov.in/w/tds-rates-1; accessed 2026-10-07'),
    ('194J(A)', '2026-04-01', NULL, 'any', 200, 0, 5000000, 'fy', 0, 2000, '1026',
     '2025 Act s.393(1) Table Sl. 6(iii) D(a), threshold Rs 50,000 [ACT25 as amended by FA 2026]; accessed 2026-10-07'),
    -- 194-I(b) land/building/furniture: 10%; 194-I(a) plant/machinery: 2%; "fifty thousand rupees for a month or part of a month" [FA25] s.64.
    ('194I', '2025-04-01', '2026-03-31', 'any', 1000, 0, 5000000, 'month', 0, 2000, '4IB',
     '1961 s.194-I(b) as amended by Finance Act 2025 s.64 (Rs 50,000 per month or part of a month); rate per https://www.incometaxindia.gov.in/w/tds-rates-1; accessed 2026-10-07'),
    ('194I', '2026-04-01', NULL, 'any', 1000, 0, 5000000, 'month', 0, 2000, '1009',
     '2025 Act s.393(1) Table Sl. 2(ii) D(b) [ACT25 as amended by FA 2026]; accessed 2026-10-07'),
    ('194I(A)', '2025-04-01', '2026-03-31', 'any', 200, 0, 5000000, 'month', 0, 2000, '4IA',
     '1961 s.194-I(a) as amended by Finance Act 2025 s.64; rate per https://www.incometaxindia.gov.in/w/tds-rates-1; accessed 2026-10-07'),
    ('194I(A)', '2026-04-01', NULL, 'any', 200, 0, 5000000, 'month', 0, 2000, '1008',
     '2025 Act s.393(1) Table Sl. 2(ii) D(a) [ACT25 as amended by FA 2026]; accessed 2026-10-07'),
    -- 194H: 2%, aggregate > Rs 20,000. [RATES] 2%; [FA25] s.63 "twenty thousand rupees"; 26Q 94H; Form 140 1006.
    ('194H', '2025-04-01', '2026-03-31', 'any', 200, 0, 2000000, 'fy', 0, 2000, '94H',
     '1961 s.194H as amended by Finance Act 2025 s.63; rate per https://www.incometaxindia.gov.in/w/tds-rates-1; accessed 2026-10-07'),
    ('194H', '2026-04-01', NULL, 'any', 200, 0, 2000000, 'fy', 0, 2000, '1006',
     '2025 Act s.393(1) Table Sl. 1(ii), rate 2%, threshold Rs 20,000 [ACT25 as amended by FA 2026]; accessed 2026-10-07'),
    -- 194A (payer not a bank/co-op bank/post office): 10%, aggregate > Rs 10,000. [194A]; [FA25] s.58; 26Q 94A; Form 140 1022.
    ('194A', '2025-04-01', '2026-03-31', 'any', 1000, 0, 1000000, 'fy', 0, 2000, '94A',
     '1961 s.194A(3)(i) as amended by Finance Act 2025 s.58 [https://www.incometaxindia.gov.in/w/section-194a]; accessed 2026-10-07'),
    ('194A', '2026-04-01', NULL, 'any', 1000, 0, 1000000, 'fy', 0, 2000, '1022',
     '2025 Act s.393(1) Table Sl. 5(iii); rate in force 10% per Finance Act 2026 First Schedule Part II [https://egazette.gov.in/WriteReadData/2026/271439.pdf]; accessed 2026-10-07'),
    -- 194Q: 0.1% of the amount EXCEEDING Rs 50 lakh in the year; no PAN 5% (s.206AA(1A) / s.397(2)(b)(i)(C)). [194Q]; 26Q 94Q; Form 140 1031.
    ('194Q', '2025-04-01', '2026-03-31', 'any', 10, 0, 500000000, 'fy', 1, 500, '94Q',
     '1961 s.194Q(1) [https://www.incometaxindia.gov.in/w/section-194q]; no PAN 5% per s.206AA [https://www.incometaxindia.gov.in/w/higher-deduction-of-tax-at-source-in-certain-cases-section-206aa-and-section-206ab-]; accessed 2026-10-07'),
    ('194Q', '2026-04-01', NULL, 'any', 10, 0, 500000000, 'fy', 1, 500, '1031',
     '2025 Act s.393(1) Table Sl. 8(ii); no PAN 5% s.397(2)(b)(i)(C) [ACT25 as amended by FA 2026]; accessed 2026-10-07');

  INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp,
      threshold_single_paise, threshold_annual_paise, threshold_basis, threshold_excess_only, no_pan_rate_bp, return_code, source)
    SELECT s.id, m.eff_from, m.eff_to, m.deductee, m.rate_bp, m.single, m.annual, m.basis, m.excess, m.no_pan, m.return_code, m.source
      FROM m020_seed m JOIN tds_sections s ON s.code = m.code;
  DROP TABLE m020_seed;

  -- Legacy mirror columns: the open-ended 'any' row (what an unknown deductee pays today).
  UPDATE tds_sections SET
    rate = COALESCE((SELECT r.rate_bp / 100.0 FROM tds_section_rates r WHERE r.section_id = tds_sections.id
                      AND r.deductee_type = 'any' AND r.effective_to IS NULL ORDER BY r.effective_from DESC LIMIT 1), rate),
    threshold_single = COALESCE((SELECT r.threshold_single_paise FROM tds_section_rates r WHERE r.section_id = tds_sections.id
                      AND r.deductee_type = 'any' AND r.effective_to IS NULL ORDER BY r.effective_from DESC LIMIT 1), threshold_single),
    threshold_annual = COALESCE((SELECT r.threshold_annual_paise FROM tds_section_rates r WHERE r.section_id = tds_sections.id
                      AND r.deductee_type = 'any' AND r.effective_to IS NULL ORDER BY r.effective_from DESC LIMIT 1), threshold_annual);

  -- Backfill (a): ledgers the app created by name.
  CREATE TEMP TABLE m020_by_name AS
    SELECT l.id AS ledger_id, s.id AS section_id FROM ledgers l
      JOIN tds_sections s ON l.name = 'TDS Payable ' || s.code COLLATE NOCASE
     WHERE l.tds_payable_section_id IS NULL;
  UPDATE ledgers SET tds_payable_section_id = (SELECT section_id FROM m020_by_name WHERE ledger_id = ledgers.id)
   WHERE id IN (SELECT ledger_id FROM m020_by_name);

  -- Backfill (b): hand-named payable ledgers, inferred from pre-020 entries (unambiguous only).
  CREATE TEMP TABLE m020_by_entry AS
    WITH RECURSIVE dt(id) AS (
      SELECT id FROM groups WHERE name = 'Duties & Taxes'
      UNION ALL SELECT g.id FROM groups g JOIN dt ON g.parent_id = dt.id
    ),
    cand AS (
      SELECT te.id AS entry_id, te.section_id, vl.ledger_id
        FROM tds_entries te
        JOIN voucher_lines vl ON vl.voucher_id = te.voucher_id AND vl.dr_cr = 'cr' AND vl.amount = te.tds_amount
        JOIN ledgers l ON l.id = vl.ledger_id
       WHERE l.id <> te.party_ledger_id AND l.tax_type IS NULL AND l.tds_payable_section_id IS NULL
         AND l.group_id IN (SELECT id FROM dt)
    ),
    single_per_entry AS (SELECT entry_id FROM cand GROUP BY entry_id HAVING COUNT(DISTINCT ledger_id) = 1)
    SELECT c.ledger_id, MIN(c.section_id) AS section_id FROM cand c
     WHERE c.entry_id IN (SELECT entry_id FROM single_per_entry)
     GROUP BY c.ledger_id HAVING COUNT(DISTINCT c.section_id) = 1;
  UPDATE ledgers SET tds_payable_section_id = (SELECT section_id FROM m020_by_entry WHERE ledger_id = ledgers.id)
   WHERE id IN (SELECT ledger_id FROM m020_by_entry) AND tds_payable_section_id IS NULL;

  INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
  VALUES ('migration', 20, 'update', NULL, json_object(
    'migration', 20,
    'payableTaggedByName', json((SELECT json_group_array(json_object('ledgerId', ledger_id, 'sectionId', section_id))
                                  FROM (SELECT * FROM m020_by_name ORDER BY ledger_id))),
    'payableTaggedByEntry', json((SELECT json_group_array(json_object('ledgerId', ledger_id, 'sectionId', section_id))
                                  FROM (SELECT * FROM m020_by_entry ORDER BY ledger_id))),
    'legacyEntriesMarkedManual', (SELECT COUNT(*) FROM tds_entries)
  ), NULL, NULL);

  DROP TABLE m020_by_name;
  DROP TABLE m020_by_entry;
  `,

  // 021 (WP 2.3) — serial numbers. Appended after 019 (WP 2.2) and 020 (WP 3.1); self-contained.
  // - stock_items.track_serials: 1 = every non-count inventory line of the item names one serial
  //   per whole unit (src/shared/serials.ts has the rules).
  // - inventory_lines.serials: the line's serials as a JSON array (NULL = none) — the source of
  //   truth, carried through the bin with its voucher.
  // - serial_numbers: a projection of the live line serials (one row per item + serial, its
  //   current status, the line that brought it in and the one that took it out), rebuilt per item
  //   by services/serials.ts whenever a voucher touching the item is saved, binned or restored.
  //   Line ids are re-issued when a voucher is altered, so both line FKs let go on delete
  //   (CASCADE / SET NULL) and the rebuild in the same transaction re-points them.
  `
  ALTER TABLE stock_items ADD COLUMN track_serials INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inventory_lines ADD COLUMN serials TEXT;

  CREATE TABLE serial_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    serial TEXT NOT NULL,
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    godown_id INTEGER REFERENCES godowns(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('in_stock', 'sold', 'consumed', 'returned')),
    inward_line_id INTEGER NOT NULL REFERENCES inventory_lines(id) ON DELETE CASCADE,
    outward_line_id INTEGER REFERENCES inventory_lines(id) ON DELETE SET NULL,
    UNIQUE (stock_item_id, serial)
  );
  CREATE INDEX idx_serial_numbers_status ON serial_numbers(stock_item_id, status);
  `,
  // 022 (WP 3.2) — TDS "Not applicable" marks. Number assigned by the orchestrator; appended after
  // 021 (WP 2.3, serial numbers), whose content it does not depend on — only on vouchers (001).
  // One row per voucher the user has said carries no TDS (not a sum of that nature, a payee
  // declaration, below-threshold by agreement …): the Eligible tab skips it and the aggregate
  // threshold walk leaves it out. Deleting the voucher (purge) cascades.
  `
  CREATE TABLE IF NOT EXISTS tds_exemptions (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 023 (WP 2.4) — deeper manufacturing. Number assigned by the orchestrator; appended after 022
  // (WP 3.2, TDS exemptions), whose content it does not depend on.
  // - BOM versions: bom_versions (named, effective-dated, one default per item) own
  //   bom_version_lines (per-unit quantity + optional scrap allowance in basis points). Every
  //   existing item BOM is backfilled as a default version "v1" in force from the beginning.
  //   bom_lines (003) is REPLACED BY A VIEW of the default versions' lines, same columns
  //   (id, item_id, component_id, qty_milli_per_unit), so anything still reading it keeps
  //   working for one release; it is read-only — writes go through services/bom.ts.
  // - godowns.kind ('own' | 'job_worker') + party_ledger_id (the job worker's party ledger).
  // - manufacture_details.bom_version_id / bom_exploded: the version the rows came from (the
  //   material-variance standard) and whether they were the exploded leaves.
  // - manufacture_outputs: by-product / scrap rows of a manufacture, keyed to their inward
  //   line by (voucher_id, line_order). The engine books them at value_paise and gives the
  //   remainder of the conserved cost to the finished item.
  // - job_work_challans (one per job-work voucher: send / receive / return) + job_work_losses
  //   (receive: loss per raw line) hold what ITC-04 needs: challan no/date, job worker,
  //   nature of processing, goods type, the original challan; quantities and values are the
  //   voucher's own inventory lines.
  // - stock_transfers: stock journals saved as same-item godown transfers, costed by the
  //   engine's 'transfer' rule (inward leg = the outward leg's engine cost at valuation time).
  //   Marked at save time only — no backfill, so no pre-existing journal re-prices on upgrade.
  `
  CREATE TABLE bom_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    effective_from TEXT,
    effective_to TEXT,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    UNIQUE (item_id, name),
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from)
  );
  CREATE UNIQUE INDEX idx_bom_versions_one_default ON bom_versions(item_id) WHERE is_default = 1;
  CREATE TABLE bom_version_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL REFERENCES bom_versions(id) ON DELETE CASCADE,
    component_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli_per_unit INTEGER NOT NULL CHECK (qty_milli_per_unit > 0),
    scrap_pct_bp INTEGER CHECK (scrap_pct_bp IS NULL OR scrap_pct_bp >= 0),
    line_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (version_id, component_id)
  );
  CREATE INDEX idx_bom_version_lines_component ON bom_version_lines(component_id);

  INSERT INTO bom_versions (item_id, name, effective_from, effective_to, is_default)
    SELECT DISTINCT item_id, 'v1', NULL, NULL, 1 FROM bom_lines ORDER BY item_id;
  INSERT INTO bom_version_lines (version_id, component_id, qty_milli_per_unit, scrap_pct_bp, line_order)
    SELECT bv.id, b.component_id, b.qty_milli_per_unit, NULL,
           (SELECT COUNT(*) FROM bom_lines b2 WHERE b2.item_id = b.item_id AND b2.id < b.id)
      FROM bom_lines b JOIN bom_versions bv ON bv.item_id = b.item_id
     ORDER BY b.item_id, b.id;
  DROP TABLE bom_lines;
  CREATE VIEW bom_lines AS
    SELECT l.id AS id, v.item_id AS item_id, l.component_id AS component_id, l.qty_milli_per_unit AS qty_milli_per_unit
      FROM bom_version_lines l JOIN bom_versions v ON v.id = l.version_id
     WHERE v.is_default = 1;

  ALTER TABLE godowns ADD COLUMN kind TEXT NOT NULL DEFAULT 'own' CHECK (kind IN ('own', 'job_worker'));
  ALTER TABLE godowns ADD COLUMN party_ledger_id INTEGER REFERENCES ledgers(id);

  ALTER TABLE manufacture_details ADD COLUMN bom_version_id INTEGER REFERENCES bom_versions(id) ON DELETE SET NULL;
  ALTER TABLE manufacture_details ADD COLUMN bom_exploded INTEGER NOT NULL DEFAULT 0 CHECK (bom_exploded IN (0, 1));

  CREATE TABLE manufacture_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES manufacture_details(voucher_id) ON DELETE CASCADE,
    line_order INTEGER NOT NULL,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    value_paise INTEGER NOT NULL CHECK (value_paise >= 0),
    kind TEXT NOT NULL DEFAULT 'by_product' CHECK (kind IN ('by_product', 'scrap')),
    UNIQUE (voucher_id, line_order)
  );
  CREATE INDEX idx_manufacture_outputs_item ON manufacture_outputs(stock_item_id);

  CREATE TABLE job_work_challans (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('send', 'receive', 'return')),
    godown_id INTEGER NOT NULL REFERENCES godowns(id),
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    challan_no TEXT,
    challan_date TEXT,
    nature_of_processing TEXT,
    goods_type TEXT NOT NULL DEFAULT 'inputs' CHECK (goods_type IN ('inputs', 'capital_goods')),
    original_challan_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_job_work_challans_godown ON job_work_challans(godown_id);
  CREATE INDEX idx_job_work_challans_party ON job_work_challans(party_ledger_id);
  CREATE TABLE job_work_losses (
    voucher_id INTEGER NOT NULL REFERENCES job_work_challans(voucher_id) ON DELETE CASCADE,
    line_order INTEGER NOT NULL,
    loss_qty_milli INTEGER NOT NULL CHECK (loss_qty_milli > 0),
    PRIMARY KEY (voucher_id, line_order)
  );

  CREATE TABLE stock_transfers (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE
  );
  `,

  // 024 (WP 2.5a) — trade cycle, part 1: voucher kinds, stable line ids, the non-moving flag.
  // Appended after 022 (WP 3.2) and 023 (WP 2.4); self-contained. Design:
  // docs/superpowers/specs/2026-10-07-wp2.5-trade-cycle-design.md §2.2–2.3, §9 Q7.
  // - voucher_kinds replaces the CHECK list on voucher_types.kind (SQLite can't alter a CHECK):
  //   the table is rebuilt with ids, column order and the AUTOINCREMENT high-water mark preserved,
  //   so every later kind is one INSERT. Runs with foreign keys OFF (the marker on the first
  //   line; see migrate.ts) — DROP TABLE would otherwise trip vouchers/recurring_templates FKs.
  // - System types for the new stock-only kinds: the first free name wins (a Tally import may
  //   already have created a "Delivery Note" type — as a journal — which is left untouched).
  //   Not in DEFAULT_VOUCHER_TYPES: a fresh company gets them here, before seedCompany runs.
  // - inventory_lines.line_uid: a stable line identity (saveVoucher re-inserts lines on every
  //   edit, so ids change); trade links key on it. Backfilled for every existing line.
  // - inventory_lines.moves_stock: 0 = an invoice/bill line whose goods moved on a challan/GRN
  //   (server-derived from its link; every stock reader filters MOVES_STOCK). Legacy lines = 1.
  // - serial_numbers.status gains 'delivered' (out on a delivery challan, not yet invoiced) —
  //   another CHECK rebuild of the small WP 2.3 projection table.
  `-- @foreign-keys-off
  CREATE TABLE voucher_kinds (
    kind TEXT PRIMARY KEY,
    stock_only INTEGER NOT NULL CHECK (stock_only IN (0, 1))
  ) WITHOUT ROWID;
  INSERT INTO voucher_kinds (kind, stock_only) VALUES
    ('contra', 0), ('payment', 0), ('receipt', 0), ('journal', 0), ('sales', 0), ('purchase', 0),
    ('credit_note', 0), ('debit_note', 0), ('stock_journal', 1), ('physical_stock', 1),
    ('delivery_note', 1), ('receipt_note', 1);

  CREATE TEMP TABLE m024_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'voucher_types';

  CREATE TABLE voucher_types_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL REFERENCES voucher_kinds(kind),
    numbering TEXT NOT NULL DEFAULT 'auto' CHECK (numbering IN ('auto','manual')),
    prefix TEXT NOT NULL DEFAULT '',
    is_system INTEGER NOT NULL DEFAULT 0,
    suffix TEXT NOT NULL DEFAULT '',
    pad_width INTEGER NOT NULL DEFAULT 0,
    restart_fy INTEGER NOT NULL DEFAULT 1
  );
  INSERT INTO voucher_types_new (id, name, kind, numbering, prefix, is_system, suffix, pad_width, restart_fy)
    SELECT id, name, kind, numbering, prefix, is_system, suffix, pad_width, restart_fy FROM voucher_types ORDER BY id;
  DROP TABLE voucher_types;
  ALTER TABLE voucher_types_new RENAME TO voucher_types;
  -- Keep the AUTOINCREMENT high-water mark: a deleted type's id is never reissued (audit rows name it).
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'voucher_types', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'voucher_types');
  UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM m024_seq), 0)) WHERE name = 'voucher_types';
  DROP TABLE m024_seq;

  WITH c(o, n) AS (VALUES (1, 'Delivery Note'), (2, 'Delivery Challan'), (3, 'Outward Delivery Note'))
  INSERT INTO voucher_types (name, kind, numbering, prefix, is_system)
    SELECT n, 'delivery_note', 'auto', '', 1 FROM c
     WHERE NOT EXISTS (SELECT 1 FROM voucher_types WHERE name = c.n COLLATE NOCASE) ORDER BY o LIMIT 1;
  WITH c(o, n) AS (VALUES (1, 'Receipt Note'), (2, 'Goods Receipt Note'), (3, 'Inward Receipt Note'))
  INSERT INTO voucher_types (name, kind, numbering, prefix, is_system)
    SELECT n, 'receipt_note', 'auto', '', 1 FROM c
     WHERE NOT EXISTS (SELECT 1 FROM voucher_types WHERE name = c.n COLLATE NOCASE) ORDER BY o LIMIT 1;

  ALTER TABLE inventory_lines ADD COLUMN line_uid TEXT;
  UPDATE inventory_lines SET line_uid = lower(hex(randomblob(16)));
  CREATE UNIQUE INDEX idx_inv_line_uid ON inventory_lines(line_uid);
  ALTER TABLE inventory_lines ADD COLUMN moves_stock INTEGER NOT NULL DEFAULT 1 CHECK (moves_stock IN (0, 1));
  CREATE INDEX idx_inv_nonmoving ON inventory_lines(voucher_id) WHERE moves_stock = 0;

  CREATE TABLE serial_numbers_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    serial TEXT NOT NULL,
    batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
    godown_id INTEGER REFERENCES godowns(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('in_stock', 'sold', 'consumed', 'returned', 'delivered')),
    inward_line_id INTEGER NOT NULL REFERENCES inventory_lines(id) ON DELETE CASCADE,
    outward_line_id INTEGER REFERENCES inventory_lines(id) ON DELETE SET NULL,
    UNIQUE (stock_item_id, serial)
  );
  INSERT INTO serial_numbers_new (id, stock_item_id, serial, batch_id, godown_id, status, inward_line_id, outward_line_id)
    SELECT id, stock_item_id, serial, batch_id, godown_id, status, inward_line_id, outward_line_id FROM serial_numbers ORDER BY id;
  DROP TABLE serial_numbers;
  ALTER TABLE serial_numbers_new RENAME TO serial_numbers;
  CREATE INDEX idx_serial_numbers_status ON serial_numbers(stock_item_id, status);

  INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
  VALUES ('migration', 24, 'update', NULL, json_object(
    'migration', 24,
    'voucherKinds', (SELECT COUNT(*) FROM voucher_kinds),
    'voucherTypesCreated', json((SELECT json_group_array(json_object('id', id, 'name', name, 'kind', kind))
                                  FROM (SELECT * FROM voucher_types WHERE kind IN ('delivery_note', 'receipt_note') ORDER BY id))),
    'lineUidsBackfilled', (SELECT COUNT(*) FROM inventory_lines),
    'serialsCarried', (SELECT COUNT(*) FROM serial_numbers)
  ), NULL, NULL);
  `,

  // 025 (WP 2.5a) — trade cycle, part 2: orders/quotations (tables only; screens in WP 2.5c),
  // challan/GRN facts, and line links. Design §2.4 and §2.7. line_links lives here (not in 024)
  // because it references trade_docs: SQLite refuses DML and foreign_key_check against a child
  // table whose parent table doesn't exist yet.
  // - trade_doc_types: own numbering series per order/quotation kind (same knobs as voucher types).
  // - trade_docs / trade_doc_lines: non-posting documents; trade_doc_lines.line_uid is the link key.
  //   The stored status is only the MANUAL state (closed / cancelled); the shown status is derived.
  // - trade_voucher_details: facts about a challan / GRN that aren't voucher columns (purpose,
  //   short-close) — like manufacture_details.
  // - line_links: one row per target line (to_line_uid UNIQUE → one source each), written by the
  //   TARGET's save (services/tradeLinks.ts). Purging a target cascades its links away; purging a
  //   source is blocked (NO ACTION) while any link — live or binned — still points at it.
  `
  CREATE TABLE trade_doc_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('quotation', 'sales_order', 'purchase_order')),
    numbering TEXT NOT NULL DEFAULT 'auto' CHECK (numbering IN ('auto','manual')),
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    pad_width INTEGER NOT NULL DEFAULT 0,
    restart_fy INTEGER NOT NULL DEFAULT 1,
    is_system INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO trade_doc_types (name, kind, prefix, is_system) VALUES
    ('Quotation', 'quotation', 'QT-', 1), ('Sales Order', 'sales_order', 'SO-', 1),
    ('Purchase Order', 'purchase_order', 'PO-', 1);

  CREATE TABLE trade_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_type_id INTEGER NOT NULL REFERENCES trade_doc_types(id),
    number TEXT NOT NULL,
    date TEXT NOT NULL,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    valid_until TEXT,
    due_date TEXT,
    reference TEXT,
    terms TEXT,
    narration TEXT,
    pos_override TEXT,
    currency_code TEXT,
    exchange_rate REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
    closed_at TEXT,
    close_reason TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_trade_docs_type_date ON trade_docs(doc_type_id, date);
  CREATE INDEX idx_trade_docs_party ON trade_docs(party_ledger_id);

  CREATE TABLE trade_doc_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES trade_docs(id) ON DELETE CASCADE,
    line_uid TEXT NOT NULL UNIQUE,
    line_order INTEGER NOT NULL DEFAULT 0,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    description TEXT,
    godown_id INTEGER REFERENCES godowns(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
    discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
    amount INTEGER NOT NULL CHECK (amount >= 0),
    gst_rate REAL,
    cess_rate REAL,
    due_date TEXT
  );
  CREATE INDEX idx_trade_doc_lines_doc ON trade_doc_lines(doc_id);
  CREATE INDEX idx_trade_doc_lines_item ON trade_doc_lines(stock_item_id);

  CREATE TABLE trade_voucher_details (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL DEFAULT 'supply'
      CHECK (purpose IN ('supply', 'job_work', 'approval', 'liquid_gas', 'non_supply', 'purchase', 'return')),
    closed_at TEXT,
    close_reason TEXT
  );

  CREATE TABLE line_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_type TEXT NOT NULL CHECK (link_type IN ('fulfil', 'return')),
    from_trade_doc_id INTEGER REFERENCES trade_docs(id),
    from_voucher_id INTEGER REFERENCES vouchers(id),
    from_line_uid TEXT NOT NULL,
    to_trade_doc_id INTEGER REFERENCES trade_docs(id) ON DELETE CASCADE,
    to_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
    to_line_uid TEXT NOT NULL UNIQUE,
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    reprices INTEGER NOT NULL DEFAULT 0 CHECK (reprices IN (0, 1)),
    CHECK ((from_trade_doc_id IS NULL) <> (from_voucher_id IS NULL)),
    CHECK ((to_trade_doc_id IS NULL) <> (to_voucher_id IS NULL)),
    CHECK (from_line_uid <> to_line_uid)
  );
  CREATE INDEX idx_line_links_from_uid ON line_links(from_line_uid);
  CREATE INDEX idx_line_links_from_voucher ON line_links(from_voucher_id) WHERE from_voucher_id IS NOT NULL;
  CREATE INDEX idx_line_links_from_doc ON line_links(from_trade_doc_id) WHERE from_trade_doc_id IS NOT NULL;
  CREATE INDEX idx_line_links_to_voucher ON line_links(to_voucher_id) WHERE to_voucher_id IS NOT NULL;
  CREATE INDEX idx_line_links_to_doc ON line_links(to_trade_doc_id) WHERE to_trade_doc_id IS NOT NULL;

  INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
  VALUES ('migration', 25, 'update', NULL, json_object(
    'migration', 25,
    'tradeDocTypesSeeded', (SELECT COUNT(*) FROM trade_doc_types)
  ), NULL, NULL);
  `,

  // 026 (WP 3.6) — fixed-asset register and depreciation under the Companies Act, 2013 and the
  // Income-tax Acts. Number assigned by the orchestrator; appended after 022–025 (WP 3.2, 2.4,
  // 2.5a) and self-contained (creates its own tables, alters nothing older).
  //
  // Tables
  // - ca_asset_classes: Schedule II Part C useful lives (effective-dated, editable, cited).
  // - it_blocks / it_block_rates: income-tax blocks of assets with effective-dated rates per Act.
  // - it_block_openings: the user's opening WDV of a block for a tax year (later years carry the
  //   computed closing WDV forward unless an opening is entered).
  // - fixed_asset_groups: Companies-Act class + IT block + the ledgers a depreciation run posts to.
  // - fixed_assets, fixed_asset_additions: the register (cost layers).
  // - depreciation_runs / depreciation_lines: a posted run (one journal) or a disposal's catch-up
  //   (asset_id set). A run counts only while its voucher is live (not binned, not purged).
  // Voucher FKs SET NULL so the bin's auto-purge is never blocked; a NULL voucher = void.
  //
  // Sources (all accessed 2026-10-07). mca.gov.in, incometaxindia.gov.in and indiacode.nic.in
  // refused automated access that day, so the text was read from these faithful copies:
  //  [SCH2]  Companies Act, 2013, Schedule II as amended (MCA e-book text, "Source: mca.gov.in"):
  //          Part A https://oss-data-in.vaquill.ai/legislation/REG_MCA_mcaacts28231scheduleiiusefullivestocompu/act.pdf
  //          Part C https://oss-data-in.vaquill.ai/legislation/REG_MCA_mcaacts28232scheduleiiusefullivestocompu/act.pdf
  //          official: https://www.mca.gov.in/content/mca/global/en/acts-rules/ebooks/acts.html
  //          Part A para 3(i): residual value "shall not be more than five per cent. of the original
  //          cost"; Note 2: pro rata from the date of addition / up to the date of sale, discard,
  //          demolition or destruction; Note 4: component accounting mandatory from FY 2015-16;
  //          Note 6: extra-shift depreciation (not implemented); Note 7: transition — carrying
  //          amount over the remaining life. Schedule II names no method (Note 3(i) only requires
  //          the methods used to be disclosed); SLM / WDV are the methods offered here.
  //  [GN35]  ICAI Guidance Note GN(A) 35 on Accounting for Depreciation in Companies in the
  //          context of Schedule II (Feb 2016) — https://cdn.taxguru.in/wp-content/uploads/2016/02/41241research31047.pdf
  //          ¶38 WDV rate R = 1 − (s/c)^(1/n) with a worked example (unit-tested); ¶56-58: the old
  //          Schedule XIV "cost ≤ Rs 5,000 written off" rule is NOT in Schedule II — a company may
  //          adopt a materiality threshold as policy. So no ≤ Rs 5,000 rule is seeded.
  //  [IT61]  Income-tax Act, 1961 s.32(1)(ii) (WDV at the Rule 5 / New Appendix I rates), second
  //          proviso (half rate if put to use < 180 days), s.32(1)(iia) additional depreciation
  //          20%, s.43(6) WDV, s.2(11) block, s.50 STCG — read in ICAI BoS Final Paper 4 (DT),
  //          Module 1 Ch.3 (AY 2026-27) https://resource.cdn.icai.org/88213bos-aps2299-m1-ch3.pdf
  //          and Ch.4 https://resource.cdn.icai.org/88214bos-aps2299-m1-ch4.pdf
  //  [IT25]  Income-tax Act, 2025 (in force 1 Apr 2026): s.33 depreciation — s.33(3)(a) block WDV
  //          at the prescribed percentage, s.33(4) half rate < 180 days, s.33(8)-(9) additional
  //          20% (10% + 10% next year); s.2(17) block of assets; s.41(1)(c) WDV; s.74(2)-(3) STCG.
  //          Read in Income-tax (No.2) Bill 2025 as passed by Lok Sabha 11.08.2025 —
  //          https://prsindia.org/files/bills_acts/bills_parliament/2025/Bill_as_passed_by_LS_Income_Tax_(No.2)_Bill.pdf
  //  [R2026] Income-tax Rules, 2026, G.S.R. 198(E) of 20 Mar 2026, Rule 25 + Appendix I (rates) —
  //          Gazette scan via https://simpliance.in/download/file/dXBsb2Fkcy9nb3Z0bm90aWZpY2F0aW9uL1RoZSBJbmNvbWUtdGF4IFJ1bGVzLCAyMDI2LnBkZg==
  //
  // UNVERIFIED (kept editable; also listed in the WP 3.6 report):
  //  - Hotel / school furniture life: 8 years per [GN35] appendix and ca2013.com; the MCA e-book
  //    copy says 10. Seeded 8.
  //  - All Schedule II text from copies, not mca.gov.in itself; the 2025 Act read in the Bill as
  //    passed by Lok Sabha, not the enacted Act 30 of 2025.
  //  - Finance Act 2026 changing nothing in s.33 / s.41 / s.74 / Appendix I — not confirmed.
  //  - 1961-Act rows are seeded from FY 2017-18 (the 40% ceiling era); only FY 2025-26 rates were
  //    read ([IT61], AY 2026-27). Earlier years, and the 23.8.2019–31.3.2020 30%/45% motor-vehicle
  //    windows, are not seeded.
  //  - Sale proceeds reduce the full-rate base before the half-rate additions — the reading in
  //    ICAI Illustration 4 [IT61]; not stated in the Act's text.
  //  - Default IT-block mapping of the seeded groups (e.g. electrical installations → furniture
  //    and fittings incl. electrical fittings, [R2026] Appendix I Note 5) is a convenience default.
  `
  CREATE TABLE ca_asset_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    life_months INTEGER NOT NULL CHECK (life_months > 0),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    source TEXT NOT NULL DEFAULT '',
    is_seeded INTEGER NOT NULL DEFAULT 0,
    UNIQUE (code, effective_from)
  );

  CREATE TABLE it_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    is_seeded INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE it_block_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL REFERENCES it_blocks(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
    additional_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (additional_rate_bp BETWEEN 0 AND 10000),
    act TEXT NOT NULL CHECK (act IN ('1961', '2025')),
    section_ref TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    is_seeded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_it_block_rates_block ON it_block_rates(block_id, effective_from);

  CREATE TABLE it_block_openings (
    block_id INTEGER NOT NULL REFERENCES it_blocks(id) ON DELETE CASCADE,
    fy_start_year INTEGER NOT NULL,
    opening_wdv_paise INTEGER NOT NULL DEFAULT 0,
    additional_bf_paise INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (block_id, fy_start_year)
  );

  CREATE TABLE fixed_asset_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    ca_class_id INTEGER REFERENCES ca_asset_classes(id) ON DELETE SET NULL,
    life_months INTEGER NOT NULL CHECK (life_months > 0),
    residual_bp INTEGER NOT NULL DEFAULT 500 CHECK (residual_bp BETWEEN 0 AND 10000),
    method TEXT NOT NULL DEFAULT 'slm' CHECK (method IN ('slm', 'wdv')),
    it_block_id INTEGER REFERENCES it_blocks(id) ON DELETE SET NULL,
    asset_ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    acc_dep_ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    dep_expense_ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    post_per_asset INTEGER NOT NULL DEFAULT 0,
    is_seeded INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE fixed_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    asset_group_id INTEGER NOT NULL REFERENCES fixed_asset_groups(id),
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    purchase_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    purchase_date TEXT NOT NULL,
    put_to_use_date TEXT NOT NULL,
    cost_paise INTEGER NOT NULL CHECK (cost_paise > 0),
    residual_pct_bp INTEGER NOT NULL CHECK (residual_pct_bp BETWEEN 0 AND 10000),
    useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
    method TEXT NOT NULL CHECK (method IN ('slm', 'wdv')),
    -- Date the current method / life / residual took effect (prospective change of estimate).
    basis_date TEXT NOT NULL,
    it_block_id INTEGER REFERENCES it_blocks(id) ON DELETE SET NULL,
    it_additional_eligible INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    identifier TEXT,
    acc_dep_ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    opening_acc_dep_paise INTEGER NOT NULL DEFAULT 0,
    opening_acc_dep_as_of TEXT,
    disposal_date TEXT,
    disposal_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    disposal_kind TEXT CHECK (disposal_kind IN ('sale', 'scrap')),
    disposal_proceeds_paise INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_fixed_assets_group ON fixed_assets(asset_group_id);
  CREATE INDEX idx_fixed_assets_purchase ON fixed_assets(purchase_voucher_id);

  CREATE TABLE fixed_asset_additions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    kind TEXT NOT NULL CHECK (kind IN ('addition', 'improvement')),
    note TEXT
  );
  CREATE INDEX idx_fixed_asset_additions_asset ON fixed_asset_additions(asset_id);

  CREATE TABLE depreciation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fy_start_year INTEGER NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    basis TEXT NOT NULL CHECK (basis IN ('companies_act', 'income_tax')),
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    -- Set for a disposal's catch-up depreciation (posted inside the disposal voucher).
    asset_id INTEGER REFERENCES fixed_assets(id) ON DELETE CASCADE,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_depreciation_runs_voucher ON depreciation_runs(voucher_id);
  CREATE INDEX idx_depreciation_runs_period ON depreciation_runs(period_from, period_to);

  CREATE TABLE depreciation_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES depreciation_runs(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
    opening_wdv INTEGER NOT NULL,
    depreciation INTEGER NOT NULL CHECK (depreciation >= 0),
    closing_wdv INTEGER NOT NULL,
    days_used INTEGER NOT NULL
  );
  CREATE INDEX idx_depreciation_lines_asset ON depreciation_lines(asset_id);
  CREATE INDEX idx_depreciation_lines_run ON depreciation_lines(run_id);

  -- Schedule II Part C useful lives [SCH2] (cross-checked with the [GN35] appendix), in force for
  -- financial years from 1 Apr 2014. Continuous process plant: 25 years as substituted by the
  -- notification of 31 Mar 2014 [SCH2].
  INSERT INTO ca_asset_classes (code, name, life_months, effective_from, source, is_seeded) VALUES
    ('I(a)', 'Buildings (other than factory buildings), RCC frame structure', 720, '2014-04-01', 'Sch. II Part C I(a) [SCH2]; accessed 2026-10-07', 1),
    ('I(b)', 'Buildings (other than factory buildings), other than RCC frame structure', 360, '2014-04-01', 'Sch. II Part C I(b) [SCH2]; accessed 2026-10-07', 1),
    ('I(c)', 'Factory buildings', 360, '2014-04-01', 'Sch. II Part C I(c) ("-do-" = 30 years) [SCH2]; accessed 2026-10-07', 1),
    ('I(d)', 'Fences, wells, tube wells', 60, '2014-04-01', 'Sch. II Part C I(d) [SCH2]; accessed 2026-10-07', 1),
    ('I(e)', 'Other buildings, including temporary structures', 36, '2014-04-01', 'Sch. II Part C I(e) [SCH2]; accessed 2026-10-07', 1),
    ('II', 'Bridges, culverts, bunders', 360, '2014-04-01', 'Sch. II Part C II [SCH2]; accessed 2026-10-07', 1),
    ('III(a)(i)', 'Roads — carpeted, RCC', 120, '2014-04-01', 'Sch. II Part C III(a)(i) [SCH2]; accessed 2026-10-07', 1),
    ('III(a)(ii)', 'Roads — carpeted, other than RCC', 60, '2014-04-01', 'Sch. II Part C III(a)(ii) [SCH2]; accessed 2026-10-07', 1),
    ('III(b)', 'Roads — non-carpeted', 36, '2014-04-01', 'Sch. II Part C III(b) [SCH2]; accessed 2026-10-07', 1),
    ('IV(a)', 'Plant and machinery (general, not continuous process)', 180, '2014-04-01', 'Sch. II Part C IV(i)(a) [SCH2]; accessed 2026-10-07', 1),
    ('IV(b)', 'Continuous process plant (no special rate)', 300, '2014-04-01', 'Sch. II Part C IV(i)(b), 25 years as substituted 31 Mar 2014 [SCH2]; accessed 2026-10-07', 1),
    ('V(i)', 'Furniture and fittings (general)', 120, '2014-04-01', 'Sch. II Part C V(i) [SCH2]; accessed 2026-10-07', 1),
    ('V(ii)', 'Furniture and fittings in hotels, schools, hire use, etc.', 96, '2014-04-01', 'Sch. II Part C V(ii) — 8 years per [GN35] appendix and ca2013.com; MCA e-book copy reads 10 (UNVERIFIED); accessed 2026-10-07', 1),
    ('VI(1)', 'Motor cycles, scooters and other mopeds', 120, '2014-04-01', 'Sch. II Part C VI(1) [SCH2]; accessed 2026-10-07', 1),
    ('VI(2)', 'Motor buses, lorries, cars and taxis used in a business of running them on hire', 72, '2014-04-01', 'Sch. II Part C VI(2) [SCH2]; accessed 2026-10-07', 1),
    ('VI(3)', 'Motor buses, lorries and cars (other)', 96, '2014-04-01', 'Sch. II Part C VI(3) [SCH2]; accessed 2026-10-07', 1),
    ('VI(4)', 'Motor tractors, harvesting combines and heavy vehicles', 96, '2014-04-01', 'Sch. II Part C VI(4) ("-do-" = 8 years) [SCH2]; accessed 2026-10-07', 1),
    ('VI(5)', 'Electrically operated vehicles', 96, '2014-04-01', 'Sch. II Part C VI(5) [SCH2]; accessed 2026-10-07', 1),
    ('VIII', 'Aircraft or helicopters', 240, '2014-04-01', 'Sch. II Part C VIII [SCH2]; accessed 2026-10-07', 1),
    ('IX', 'Railway sidings, locomotives, rolling stocks, tramways and railways used by concerns', 180, '2014-04-01', 'Sch. II Part C IX [SCH2]; accessed 2026-10-07', 1),
    ('X', 'Ropeway structures', 180, '2014-04-01', 'Sch. II Part C X [SCH2]; accessed 2026-10-07', 1),
    ('XI', 'Office equipment', 60, '2014-04-01', 'Sch. II Part C XI [SCH2]; accessed 2026-10-07', 1),
    ('XII(i)', 'Computers — servers and networks', 72, '2014-04-01', 'Sch. II Part C XII(i) [SCH2]; accessed 2026-10-07', 1),
    ('XII(ii)', 'Computers — end user devices (desktops, laptops, etc.)', 36, '2014-04-01', 'Sch. II Part C XII(ii) [SCH2]; accessed 2026-10-07', 1),
    ('XIII(i)', 'Laboratory equipment (general)', 120, '2014-04-01', 'Sch. II Part C XIII(i) [SCH2]; accessed 2026-10-07', 1),
    ('XIII(ii)', 'Laboratory equipment used in educational institutions', 60, '2014-04-01', 'Sch. II Part C XIII(ii) [SCH2]; accessed 2026-10-07', 1),
    ('XIV', 'Electrical installations and equipment', 120, '2014-04-01', 'Sch. II Part C XIV [SCH2]; accessed 2026-10-07', 1),
    ('XV', 'Hydraulic works, pipelines and sluices', 180, '2014-04-01', 'Sch. II Part C XV [SCH2]; accessed 2026-10-07', 1);

  -- Income-tax blocks. A block is a class of assets with the same prescribed rate (1961 s.2(11);
  -- 2025 s.2(17)), so each rate class is its own block.
  INSERT INTO it_blocks (code, name, is_seeded) VALUES
    ('BLD5', 'Buildings used mainly for residential purposes (except hotels and boarding houses)', 1),
    ('BLD10', 'Buildings (other)', 1),
    ('BLD40', 'Purely temporary erections', 1),
    ('FUR10', 'Furniture and fittings, including electrical fittings', 1),
    ('PM15', 'Machinery and plant (general), incl. motor cars not used on hire', 1),
    ('PM30', 'Machinery and plant @30% (motor buses, lorries, taxis used on hire; moulds)', 1),
    ('PM40', 'Machinery and plant @40% (computers incl. software, pollution-control equipment)', 1),
    ('INT25', 'Intangible assets (know-how, patents, copyrights, trademarks, licences, franchises)', 1);

  CREATE TEMP TABLE m026_rates (code TEXT, eff_from TEXT, eff_to TEXT, rate INTEGER, addl INTEGER, act TEXT, sec TEXT, src TEXT);
  INSERT INTO m026_rates VALUES
    ('BLD5',  '2017-04-01', '2026-03-31',  500,    0, '1961', 's.32(1)(ii); Rule 5(1), New Appendix I Part A I(1)', 'Appendix I rates as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('BLD10', '2017-04-01', '2026-03-31', 1000,    0, '1961', 's.32(1)(ii); Rule 5(1), New Appendix I Part A I(2)', 'Appendix I rates as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('BLD40', '2017-04-01', '2026-03-31', 4000,    0, '1961', 's.32(1)(ii); Rule 5(1), New Appendix I Part A I(4)', 'Appendix I rates as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('FUR10', '2017-04-01', '2026-03-31', 1000,    0, '1961', 's.32(1)(ii); Rule 5(1), New Appendix I Part A II', 'Appendix I rates as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('PM15',  '2017-04-01', '2026-03-31', 1500, 2000, '1961', 's.32(1)(ii), (iia) additional 20%; New Appendix I Part A III(1), III(2)(i)', 'Appendix I rates and s.32(1)(iia) as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('PM30',  '2017-04-01', '2026-03-31', 3000, 2000, '1961', 's.32(1)(ii), (iia); New Appendix I Part A III(3)(ii), (v)', 'Appendix I rates as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('PM40',  '2017-04-01', '2026-03-31', 4000, 2000, '1961', 's.32(1)(ii), (iia); New Appendix I Part A III(5) computers incl. software, III(3)(vi)-(viii)', 'Appendix I rates as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('INT25', '2017-04-01', '2026-03-31', 2500,    0, '1961', 's.32(1)(ii); New Appendix I Part B (goodwill excluded, s.2(11))', 'Appendix I rates as read in ICAI BoS Final DT M1 Ch.3, AY 2026-27 [IT61]; start date UNVERIFIED; accessed 2026-10-07'),
    ('BLD5',  '2026-04-01', NULL,  500,    0, '2025', 's.33(3)(a); Income-tax Rules 2026 r.25(1), Appendix I Part A I(1)', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.33 [IT25]; accessed 2026-10-07'),
    ('BLD10', '2026-04-01', NULL, 1000,    0, '2025', 's.33(3)(a); Income-tax Rules 2026 r.25(1), Appendix I Part A I(2)', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.33 [IT25]; accessed 2026-10-07'),
    ('BLD40', '2026-04-01', NULL, 4000,    0, '2025', 's.33(3)(a); Income-tax Rules 2026 r.25(1), Appendix I Part A I(4)', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.33 [IT25]; accessed 2026-10-07'),
    ('FUR10', '2026-04-01', NULL, 1000,    0, '2025', 's.33(3)(a); Income-tax Rules 2026 r.25(1), Appendix I Part A II (Note 5 electrical fittings)', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.33 [IT25]; accessed 2026-10-07'),
    ('PM15',  '2026-04-01', NULL, 1500, 2000, '2025', 's.33(3)(a), s.33(8)-(9) additional 20%; Rules 2026 Appendix I Part A III(1), III(2)(i)', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.33(8) [IT25]; accessed 2026-10-07'),
    ('PM30',  '2026-04-01', NULL, 3000, 2000, '2025', 's.33(3)(a), s.33(8)-(9); Rules 2026 Appendix I Part A III(3)(ii), (v)', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.33(8) [IT25]; accessed 2026-10-07'),
    ('PM40',  '2026-04-01', NULL, 4000, 2000, '2025', 's.33(3)(a), s.33(8)-(9); Rules 2026 Appendix I Part A III computers incl. software, III(3)(vi)-(viii)', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.33(8) [IT25]; accessed 2026-10-07'),
    ('INT25', '2026-04-01', NULL, 2500,    0, '2025', 's.33(3)(a); Rules 2026 Appendix I Part B (goodwill excluded, s.2(17))', 'Income-tax Rules 2026 (G.S.R. 198(E), 20 Mar 2026) Appendix I [R2026]; Act s.2(17) [IT25]; accessed 2026-10-07');
  INSERT INTO it_block_rates (block_id, effective_from, effective_to, rate_bp, additional_rate_bp, act, section_ref, source, is_seeded)
    SELECT b.id, m.eff_from, m.eff_to, m.rate, m.addl, m.act, m.sec, m.src, 1 FROM m026_rates m JOIN it_blocks b ON b.code = m.code;
  DROP TABLE m026_rates;

  -- Default asset groups (editable; ledgers are created at the first posting). Residual 5% — the
  -- Schedule II ceiling [SCH2] Part A 3(i); method SLM.
  CREATE TEMP TABLE m026_groups (name TEXT, class TEXT, block TEXT);
  INSERT INTO m026_groups VALUES
    ('Buildings', 'I(a)', 'BLD10'),
    ('Factory buildings', 'I(c)', 'BLD10'),
    ('Plant and machinery', 'IV(a)', 'PM15'),
    ('Furniture and fittings', 'V(i)', 'FUR10'),
    ('Motor vehicles', 'VI(3)', 'PM15'),
    ('Office equipment', 'XI', 'PM15'),
    ('Computers', 'XII(ii)', 'PM40'),
    ('Servers and networks', 'XII(i)', 'PM40'),
    ('Electrical installations', 'XIV', 'FUR10');
  INSERT INTO fixed_asset_groups (name, ca_class_id, life_months, residual_bp, method, it_block_id, is_seeded)
    SELECT g.name, c.id, c.life_months, 500, 'slm', b.id, 1
      FROM m026_groups g JOIN ca_asset_classes c ON c.code = g.class JOIN it_blocks b ON b.code = g.block;
  DROP TABLE m026_groups;
  `,
  // 027 (WP 3.3) — TCS (tax collected at source) on sales. Number assigned by the orchestrator;
  // appended after 023 (manufacturing depth), 024/025 (trade cycle) and 026 (fixed assets), none of
  // which it depends on — only on 005/020/022 (the TDS tables) and 001.
  //
  // DATA MODEL — TCS shares the TDS tables, tagged by kind, rather than a parallel tcs_* set:
  // sections, effective-dated rates, lower-rate certificates, challans + allocation and the
  // "not applicable" marks are the same shapes under both chapters of the Act, and every service
  // over them (src/main/services/tds.ts, tdsWorkbench.ts) now takes a kind instead of being
  // copied. So:
  // - tds_sections.kind ('tds' | 'tcs'); rate rows and entries take their kind from the section.
  // - tds_section_rates.base_includes_gst: TCS is computed on "the amount payable by the buyer"
  //   (GST included — see the GST note below); TDS rows stay 0 (GST excluded, Circular 23/2017).
  // - tds_certificates.kind (s.206C(9) lower-collection certificates are TCS ones; a certificate
  //   with no section must not leak across kinds) and tds_challans.kind (a TCS deposit is its own
  //   challan; allocation refuses entries of the other kind).
  // - tds_exemptions is rebuilt with PRIMARY KEY (voucher_id, kind) — existing marks become 'tds'.
  // - tds_entries.gst_in_base: the basis recorded on a TCS entry (1 = the base included GST).
  // - Ledger / goods tags, separate columns so the TDS tags keep their exact meaning:
  //   ledgers.tcs_section_id (buyer flagged as collectee), ledgers.tcs_payable_section_id (the
  //   section's TCS payable ledger under Duties & Taxes, the mirror of tds_payable_section_id),
  //   ledgers.tcs_default_section_id (a sales ledger: e.g. "Scrap Sales"), stock_items.tcs_section_id
  //   (goods category: scrap, timber, minerals, a motor vehicle …).
  //
  // SOURCES (all accessed 2026-10-07):
  //  [FA25]   Finance Act, 2025 — https://egazette.gov.in/WriteReadData/2025/262125.pdf
  //           s.72(a): s.206C(1) Table — timber 2.5% -> 2% (Sl.(iii),(iv)), Sl.(v) "any other
  //           forest produce" omitted; s.72(b): s.206C(1G) threshold Rs 7 lakh -> Rs 10 lakh;
  //           s.72(c): proviso to s.206C(1H) "nothing contained in the provisions of this
  //           sub-section shall apply from the 1st day of April, 2025"; s.73: s.206CCA omitted.
  //  [206C]   CBDT, s.206C as in force — https://www.incometaxindia.gov.in/w/section-206c-36
  //           (Table of s.206C(1); (1A)/(1B) Form 27C declaration; (1F) motor vehicle / notified
  //           goods of value exceeding Rs 10 lakh, "at the time of receipt"; (1G); (7) interest
  //           1% per month or part (collectible -> collected) + 1.5% (collected -> paid), as
  //           substituted by Act 15 of 2024 w.e.f. 1-4-2025; time of collection for (1): "at the
  //           time of debiting ... or at the time of receipt ..., whichever is earlier").
  //  [206CC]  https://www.incometaxindia.gov.in/w/section-206cc-8 — no PAN: the higher of twice
  //           the rate and 5%, proviso "shall not exceed twenty per cent"; (1H) capped at 1%.
  //  [N36]    Notification No. 36/2025, S.O. 1825(E), 22-4-2025 (s.206C(1F) goods of value above
  //           Rs 10 lakh: wrist watch, art piece, collectibles, yacht/boat/helicopter, sunglasses,
  //           handbag/purse, shoes, sportswear/equipment, home theatre, race/polo horse) —
  //           https://egazette.gov.in/WriteReadData/2025/262610.pdf
  //  [C17]    CBDT Circular 17/2020 (29-9-2020) para 4.6.1 (s.206C(1H)): "no adjustment on account
  //           of sale return or discount or indirect taxes including GST is required" —
  //           https://www.incometaxindia.gov.in/w/circular-no.-17/2020-guidelines-under-section-194-o-4-and-section-206c-1-i-of-the-income-tax-act-1961
  //  [37CA]   Income-tax Rules 1962 rule 37CA(2) — deposit within one week from the last day of
  //           the month of collection (March included: 7 April) — https://www.incometaxindia.gov.in/w/rule-37ca
  //  [31AA]   rule 31AA — Form 27EQ due 15 Jul / 15 Oct / 15 Jan / 15 May; [37D] rule 37D — Form
  //           27D within 15 days of that due date — https://www.incometaxindia.gov.in/w/rule-31aa ,
  //           https://www.incometaxindia.gov.in/w/rule-37d
  //  [F27EQ]  Protean Form 27EQ file format v6.9 (27-05-2025), Annexure 2 section codes (A liquor,
  //           B timber forest lease, C timber other mode, E scrap, I tendu, J minerals, L motor
  //           vehicle, MA-MJ notified goods in notification order, O overseas tour package, R 1H),
  //           Annexure 8 collectee codes, Annexure 6 remarks (A s.206C(9), B s.206C(1A), C s.206CC) —
  //           https://tinpan.proteantech.in/downloads/e-tds/File_Format_27EQ_Regular_Q1_to_Q4_Version_6.9_%2027052025_201011.xls
  //  [ACT25]  Income-tax Act, 2025 — https://egazette.gov.in/WriteReadData/2025/265620.pdf — TCS is
  //           s.394(1) Table (Sl. 1 liquor, 2 tendu, 3 timber / forest produce, 4 scrap, 5 coal /
  //           lignite / iron ore, 6 D(a) motor vehicle / D(b) notified goods above Rs 10 lakh,
  //           7 LRS, 8 overseas tour package, 9 parking / toll / mine); s.394(1)(c) debit or
  //           receipt whichever earlier for every row; s.395(3) certificate; s.397(2)(b)(ii) no
  //           PAN (twice or 5%, max 20%); s.398(3)(a) interest (1% / 1.5%); notification 36/2025
  //           continues under the savings clause s.536(2)(j).
  //  [FA26]   Finance Act, 2026 — https://egazette.gov.in/WriteReadData/2026/271439.pdf — s.85
  //           amends the s.394(1) Table from 1-4-2026: Sl. 1 liquor 1% -> 2%, Sl. 2 tendu
  //           5% -> 2%, Sl. 4 scrap 1% -> 2%, Sl. 5 minerals 1% -> 2%, Sl. 8 tour package flat 2%;
  //           Sl. 3 timber 2% and Sl. 6 1% unchanged.
  //  [R26]    Income-tax Rules 2026 — https://wm.incometaxindia.gov.in/documents/d/guest/income-tax-document-income-tax-rules-2026_2026-04-18_10-56-56_45638f_en
  //           rule 218(2) deposit within 7 days of month-end, March by 30 April; rule 219(1) Sl.4
  //           the TCS statement is Form 143 (replaces 27EQ), rule 219(4) due 31 Jul / 31 Oct /
  //           31 Jan / 31 May; rule 215 Sl.4 certificate Form 133 (replaces 27D), within 15 days.
  //  [F143]   Protean Form 143 file format v1.1 (tax year 2026-27 on), Annexure 2 collection codes
  //           (1068 liquor, 1069 tendu, 1070 timber forest lease, 1071 timber other, 1073 scrap,
  //           1074 minerals, 1075 motor vehicle, 1076-1085 notified goods, 1088 tour package) —
  //           https://tinpan.proteantech.in/downloads/e-tds/Form%20Number%20143-27EQ%20-%20Q1%20to%20Q4_22072026.xlsx
  //
  // GST AND THE BASE: [C17] (s.206C(1H)) says TCS is on the consideration with no deduction for
  // GST. For s.206C(1) / (1F) and s.394 no circular was found — the statute says "such amount" /
  // "consideration" payable by the buyer — so every seeded TCS row has base_includes_gst = 1 (the
  // conservative reading: collecting on the larger figure is recoverable by the buyer, short
  // collection is a default) — UNVERIFIED, editable per rate row.
  // NOT MODELLED (UNVERIFIED list in the WP 3.3 report): the 20% slab of s.206C(1G) tour packages
  // above Rs 10 lakh (seeded at 5%; collect the slab manually), s.206C(1C) (parking / toll /
  // mining leases) and LRS (authorised dealers only), and FY 2024-25 rates other than 1H.
  `
  ALTER TABLE tds_sections ADD COLUMN kind TEXT NOT NULL DEFAULT 'tds' CHECK (kind IN ('tds', 'tcs'));
  CREATE INDEX idx_tds_sections_kind ON tds_sections(kind);
  ALTER TABLE tds_section_rates ADD COLUMN base_includes_gst INTEGER NOT NULL DEFAULT 0 CHECK (base_includes_gst IN (0, 1));
  ALTER TABLE tds_certificates ADD COLUMN kind TEXT NOT NULL DEFAULT 'tds' CHECK (kind IN ('tds', 'tcs'));
  ALTER TABLE tds_challans ADD COLUMN kind TEXT NOT NULL DEFAULT 'tds' CHECK (kind IN ('tds', 'tcs'));
  CREATE INDEX idx_tds_challans_kind ON tds_challans(kind, fy_start_year, quarter);
  ALTER TABLE tds_entries ADD COLUMN gst_in_base INTEGER CHECK (gst_in_base IS NULL OR gst_in_base IN (0, 1));

  CREATE TABLE tds_exemptions_027 (
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'tds' CHECK (kind IN ('tds', 'tcs')),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (voucher_id, kind)
  );
  INSERT INTO tds_exemptions_027 (voucher_id, kind, reason, created_at)
    SELECT voucher_id, 'tds', reason, created_at FROM tds_exemptions;
  DROP TABLE tds_exemptions;
  ALTER TABLE tds_exemptions_027 RENAME TO tds_exemptions;

  ALTER TABLE ledgers ADD COLUMN tcs_section_id INTEGER REFERENCES tds_sections(id);
  ALTER TABLE ledgers ADD COLUMN tcs_payable_section_id INTEGER REFERENCES tds_sections(id);
  ALTER TABLE ledgers ADD COLUMN tcs_default_section_id INTEGER REFERENCES tds_sections(id);
  CREATE INDEX idx_ledgers_tcs_payable ON ledgers(tcs_payable_section_id) WHERE tcs_payable_section_id IS NOT NULL;
  CREATE INDEX idx_ledgers_tcs_section ON ledgers(tcs_section_id) WHERE tcs_section_id IS NOT NULL;
  ALTER TABLE stock_items ADD COLUMN tcs_section_id INTEGER REFERENCES tds_sections(id);

  -- TCS sections. Codes are unique across the shared master; legacy_code = the 1961 sub-section,
  -- new_reference = the s.394(1) Table serial [ACT25]. Rates live in the rate rows below.
  INSERT OR IGNORE INTO tds_sections (code, description, rate, threshold_single, threshold_annual, nature, act, legacy_code, new_reference, kind) VALUES
    ('206C(1) LIQUOR', 'Sale of alcoholic liquor for human consumption', 2, 0, 0,
     'Alcoholic liquor for human consumption', 'it_act_1961', '206C(1)', '394(1) Sl. 1', 'tcs'),
    ('206C(1) TENDU', 'Sale of tendu leaves', 2, 0, 0,
     'Tendu leaves', 'it_act_1961', '206C(1)', '394(1) Sl. 2', 'tcs'),
    ('206C(1) TIMBER-FL', 'Sale of timber / forest produce obtained under a forest lease', 2, 0, 0,
     'Timber or any other forest produce (not tendu leaves) obtained under a forest lease', 'it_act_1961', '206C(1)', '394(1) Sl. 3', 'tcs'),
    ('206C(1) TIMBER', 'Sale of timber obtained by any other mode', 2, 0, 0,
     'Timber obtained by any mode other than under a forest lease', 'it_act_1961', '206C(1)', '394(1) Sl. 3', 'tcs'),
    ('206C(1) SCRAP', 'Sale of scrap', 2, 0, 0,
     'Scrap', 'it_act_1961', '206C(1)', '394(1) Sl. 4', 'tcs'),
    ('206C(1) MINERALS', 'Sale of coal, lignite or iron ore', 2, 0, 0,
     'Minerals, being coal or lignite or iron ore', 'it_act_1961', '206C(1)', '394(1) Sl. 5', 'tcs'),
    ('206C(1F) VEHICLE', 'Sale of a motor vehicle above Rs 10 lakh', 1, 100000000, 0,
     'Motor vehicle of value exceeding Rs 10 lakh', 'it_act_1961', '206C(1F)', '394(1) Sl. 6 D(a)', 'tcs'),
    ('206C(1F) LUXURY', 'Sale of notified goods above Rs 10 lakh', 1, 100000000, 0,
     'Notified goods of value exceeding Rs 10 lakh (Notification 36/2025: wrist watch, art piece, collectibles, yacht / helicopter, sunglasses, handbag, shoes, sportswear, home theatre, race / polo horse)',
     'it_act_1961', '206C(1F)', '394(1) Sl. 6 D(b)', 'tcs'),
    ('206C(1G) TOUR', 'Sale of an overseas tour programme package', 2, 0, 0,
     'Overseas tour programme package', 'it_act_1961', '206C(1G)', '394(1) Sl. 8', 'tcs'),
    ('206C(1H)', 'Sale of goods above Rs 50 lakh (not applicable from 1 Apr 2025)', 0.1, 0, 500000000,
     'Sale of goods: consideration above Rs 50 lakh a year from a buyer (seller turnover above Rs 10 crore) — switched off from 1 Apr 2025 by FA 2025 s.72(c)',
     'it_act_1961', '206C(1H)', NULL, 'tcs');

  -- Rate rows. Paise: Rs 10 lakh = 100000000; Rs 50 lakh = 500000000. No-PAN 5% floor in
  -- no_pan_rate_bp; the engine takes the higher of that and twice the rate, capped at 20% [206CC].
  CREATE TEMP TABLE m027_seed (code TEXT, eff_from TEXT, eff_to TEXT, rate_bp INTEGER, single INTEGER, annual INTEGER,
    excess INTEGER, no_pan INTEGER, return_code TEXT, source TEXT);
  INSERT INTO m027_seed VALUES
    -- FY 2025-26: 1961 Act s.206C as amended by [FA25]; 27EQ section codes [F27EQ].
    ('206C(1) LIQUOR', '2025-04-01', '2026-03-31', 100, 0, 0, 0, 500, 'A',
     '1961 s.206C(1) Table Sl.(i) 1% [https://www.incometaxindia.gov.in/w/section-206c-36]; no PAN s.206CC; 27EQ code A; base incl. GST UNVERIFIED; accessed 2026-10-07'),
    ('206C(1) TENDU', '2025-04-01', '2026-03-31', 500, 0, 0, 0, 500, 'I',
     '1961 s.206C(1) Table Sl.(ii) 5% [https://www.incometaxindia.gov.in/w/section-206c-36]; no PAN s.206CC (twice = 10%); 27EQ code I; accessed 2026-10-07'),
    ('206C(1) TIMBER-FL', '2025-04-01', '2026-03-31', 200, 0, 0, 0, 500, 'B',
     '1961 s.206C(1) Table Sl.(iii) 2.5% -> 2% by Finance Act 2025 s.72(a) [https://egazette.gov.in/WriteReadData/2025/262125.pdf]; 27EQ code B; accessed 2026-10-07'),
    ('206C(1) TIMBER', '2025-04-01', '2026-03-31', 200, 0, 0, 0, 500, 'C',
     '1961 s.206C(1) Table Sl.(iv) 2.5% -> 2% by Finance Act 2025 s.72(a) [https://egazette.gov.in/WriteReadData/2025/262125.pdf]; 27EQ code C; accessed 2026-10-07'),
    ('206C(1) SCRAP', '2025-04-01', '2026-03-31', 100, 0, 0, 0, 500, 'E',
     '1961 s.206C(1) Table Sl.(vi) 1% [https://www.incometaxindia.gov.in/w/section-206c-36]; no PAN s.206CC; 27EQ code E; accessed 2026-10-07'),
    ('206C(1) MINERALS', '2025-04-01', '2026-03-31', 100, 0, 0, 0, 500, 'J',
     '1961 s.206C(1) Table Sl.(vii) 1% [https://www.incometaxindia.gov.in/w/section-206c-36]; 27EQ code J; accessed 2026-10-07'),
    ('206C(1F) VEHICLE', '2025-04-01', '2026-03-31', 100, 100000000, 0, 0, 500, 'L',
     '1961 s.206C(1F)(a) 1% of the consideration, value exceeding Rs 10 lakh, at receipt [https://www.incometaxindia.gov.in/w/section-206c-36]; 27EQ code L; accessed 2026-10-07'),
    ('206C(1F) LUXURY', '2025-04-22', '2026-03-31', 100, 100000000, 0, 0, 500, NULL,
     '1961 s.206C(1F)(b) + Notification 36/2025 (22-4-2025) [https://egazette.gov.in/WriteReadData/2025/262610.pdf]; 27EQ code MA-MJ by the good (set it per good); accessed 2026-10-07'),
    ('206C(1G) TOUR', '2025-04-01', '2026-03-31', 500, 0, 0, 0, 500, 'O',
     '1961 s.206C(1G)(b) 5% up to Rs 10 lakh a year [Finance Act 2025 s.72(b)]; the 20% on the excess over Rs 10 lakh is NOT modelled — collect it manually; 27EQ code O; accessed 2026-10-07'),
    -- 1H: inserted by Finance Act 2020 from 1-10-2020; 0.1% of consideration above Rs 50 lakh a
    -- year; no PAN capped at 1% (s.206CC proviso); GST included [C17]; switched off from
    -- 1-4-2025 by [FA25] s.72(c) — the row ends 31-3-2025 so older vouchers keep their figure.
    ('206C(1H)', '2020-10-01', '2025-03-31', 10, 0, 500000000, 1, 100, 'R',
     '1961 s.206C(1H) (0.1% above Rs 50 lakh); GST included per CBDT Circular 17/2020 para 4.6.1; not applicable from 1-4-2025 per Finance Act 2025 s.72(c) [https://egazette.gov.in/WriteReadData/2025/262125.pdf]; accessed 2026-10-07'),
    -- From 1 Apr 2026: Income-tax Act 2025 s.394(1) Table as amended by [FA26] s.85; Form 143 codes [F143].
    ('206C(1) LIQUOR', '2026-04-01', NULL, 200, 0, 0, 0, 500, '1068',
     '2025 Act s.394(1) Table Sl. 1, 1% -> 2% by Finance Act 2026 s.85 [https://egazette.gov.in/WriteReadData/2026/271439.pdf]; no PAN s.397(2)(b)(ii); Form 143 code 1068; accessed 2026-10-07'),
    ('206C(1) TENDU', '2026-04-01', NULL, 200, 0, 0, 0, 500, '1069',
     '2025 Act s.394(1) Table Sl. 2, 5% -> 2% by Finance Act 2026 s.85; Form 143 code 1069; accessed 2026-10-07'),
    ('206C(1) TIMBER-FL', '2026-04-01', NULL, 200, 0, 0, 0, 500, '1070',
     '2025 Act s.394(1) Table Sl. 3, 2% [https://egazette.gov.in/WriteReadData/2025/265620.pdf]; Form 143 code 1070; accessed 2026-10-07'),
    ('206C(1) TIMBER', '2026-04-01', NULL, 200, 0, 0, 0, 500, '1071',
     '2025 Act s.394(1) Table Sl. 3, 2% [https://egazette.gov.in/WriteReadData/2025/265620.pdf]; Form 143 code 1071; accessed 2026-10-07'),
    ('206C(1) SCRAP', '2026-04-01', NULL, 200, 0, 0, 0, 500, '1073',
     '2025 Act s.394(1) Table Sl. 4, 1% -> 2% by Finance Act 2026 s.85; Form 143 code 1073; accessed 2026-10-07'),
    ('206C(1) MINERALS', '2026-04-01', NULL, 200, 0, 0, 0, 500, '1074',
     '2025 Act s.394(1) Table Sl. 5, 1% -> 2% by Finance Act 2026 s.85; Form 143 code 1074; accessed 2026-10-07'),
    ('206C(1F) VEHICLE', '2026-04-01', NULL, 100, 100000000, 0, 0, 500, '1075',
     '2025 Act s.394(1) Table Sl. 6 D(a), 1% of consideration above Rs 10 lakh; debit or receipt whichever earlier s.394(1)(c); Form 143 code 1075; accessed 2026-10-07'),
    ('206C(1F) LUXURY', '2026-04-01', NULL, 100, 100000000, 0, 0, 500, NULL,
     '2025 Act s.394(1) Table Sl. 6 D(b) + Notification 36/2025 (saved by s.536(2)(j)); Form 143 codes 1076-1085 by the good; accessed 2026-10-07'),
    ('206C(1G) TOUR', '2026-04-01', NULL, 200, 0, 0, 0, 500, '1088',
     '2025 Act s.394(1) Table Sl. 8, flat 2% by Finance Act 2026 s.85; Form 143 code 1088; accessed 2026-10-07');

  INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp,
      threshold_single_paise, threshold_annual_paise, threshold_basis, threshold_excess_only, no_pan_rate_bp,
      return_code, base_includes_gst, source)
    SELECT s.id, m.eff_from, m.eff_to, 'any', m.rate_bp, m.single, m.annual, 'fy', m.excess, m.no_pan, m.return_code, 1, m.source
      FROM m027_seed m JOIN tds_sections s ON s.code = m.code AND s.kind = 'tcs';
  DROP TABLE m027_seed;
  `,
  // 028 (WP 3.4) — GST expansion. Number assigned by the orchestrator; appended after 026 (WP 3.6,
  // fixed assets) and 027 (WP 3.3, TCS), whose content it does not depend on — it only references
  // vouchers (001).
  // - gst_ims_actions: the Invoice Management System action the user decided for one GSTR-2B /
  //   IMS record (accept / reject / pending), keyed by return period + supplier GSTIN + document
  //   type + number. record_json keeps the portal figures the decision was taken on (for the
  //   export); voucher_id the matched purchase, when there was one. Nothing posts from here.
  // - gst_self_invoices: the self-invoice (s.31(3)(f) CGST Act, rule 47A) raised for an RCM
  //   purchase from an unregistered supplier — one per purchase voucher, numbered in its own
  //   consecutive series per financial year (rule 46(b)). Binned purchases keep their row: the
  //   number was used, the list shows it cancelled.
  `
  CREATE TABLE gst_ims_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL CHECK (length(period) = 6),
    supplier_gstin TEXT NOT NULL,
    doc_type TEXT NOT NULL DEFAULT 'INV' CHECK (doc_type IN ('INV', 'CN', 'DN')),
    doc_no TEXT NOT NULL,
    doc_date TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'pending')),
    note TEXT,
    record_json TEXT,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (period, supplier_gstin, doc_type, doc_no)
  );
  CREATE INDEX idx_gst_ims_actions_period ON gst_ims_actions(period);

  CREATE TABLE gst_self_invoices (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    number TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL,
    fy_start_year INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (fy_start_year, seq)
  );
  `,
  // 029 (WP 3.7) — payroll statutory. Number assigned by the orchestrator; appended after 027
  // (WP 3.3 TCS) and 028 (WP 3.4 GST expansion, which it does not touch), and self-contained — it depends only on 003/005/015/020/027 (tds_sections
  // gained `kind` in 027; section 192 is a 'tds' section, the column default).
  //
  // DATA MODEL
  // - statutory_rates: effective-dated, user-editable rate rows. kind 'epf' / 'eps' / 'edli' /
  //   'epf_admin' / 'esi_emp' / 'esi_er' carry rate_bp + ceiling (PF wage ceiling) / threshold (ESI
  //   coverage ceiling) / min (EPF admin minimum per establishment; ESI: the average daily wage at
  //   or below which the employee share is nil); variant 'disabled' = the ESI ceiling for persons
  //   with disability. kind 'pt' rows are slabs per state (slab_to inclusive, NULL = no ceiling),
  //   on a basis ('month' | 'half_year' | 'year'), optionally restricted to a gender (Maharashtra's
  //   women's slab), with a special month (Maharashtra / Karnataka February ₹300). kind 'ss_wages'
  //   switches the Code on Social Security 2020 s.2(88) wage definition on (rate_bp = the 50%
  //   exclusion cap). `source` cites every seeded row; verified = 1 when read from the official
  //   text. The engine (src/shared/payrollStatutory.ts) reads them through statutoryRatesOn.
  // - employees: the statutory profile (PF member id, gender, date of birth, regime, VPF, PF on
  //   full wages, EPS membership, disability, metro rent, TDS on). PAN / UAN / ESIC number and the
  //   PT state already existed (003 / 015).
  // - employee_tax_declarations: investment / income declarations per employee x FY x section.
  // - pay_heads.in_wages: 1 = the head is "wages" under CoSS s.2(88) (basic, DA, retaining
  //   allowance and every allowance not excluded); 0 = excluded (HRA, conveyance, overtime,
  //   commission, bonus …). Seeded: Basic 1, HRA 0, Special Allowance 1.
  // - payroll_lines: VPF, EPF/EPS/EDLI wages as remitted, ESI coverage flag (contribution-period
  //   stickiness), salary TDS, the PT state and regime at posting, and the TDS projection JSON.
  //   payroll_runs.pf_admin_topup: the EPFO minimum admin charge top-up posted on the run.
  // - ledgers.statutory_kind ('pf' | 'esi' | 'pt' | 'salary') tags the payable ledgers the pay run
  //   credits (mirrors tds_payable_section_id). Salary TDS is credited to the section-192 TDS
  //   payable ledger (tds_payable_section_id, seeded section below) — the TDS screen's tag.
  // - tds_entries.employee_id: a salary TDS entry (party_ledger_id = the Salaries Payable ledger
  //   the journal credits, PAN = the employee's). Form 26Q/16A skip these; Form 24Q reads them.
  // - statutory_payments: a month's PF / ESI / PT (per state) / salary TDS deposit, with the
  //   Payment voucher that booked it.
  //
  // SOURCES (all accessed 2026-10-07; "VERIFIED" = read in the official text):
  //  [EPFS52]  EPF Scheme 1952 (archived official PDF) — para 26A(2) ₹15,000 ceiling from 1-9-2014,
  //            para 29 rates + rounding, para 38(1) due date — VERIFIED —
  //            https://web.archive.org/web/2024id_/https://www.epfindia.gov.in/site_docs/PDFs/Downloads_PDFs/EPFScheme.pdf
  //  [EPFS26]  EPF Scheme 2026, G.S.R. 525(E) 29-6-2026 (supersedes the 1952 Scheme): para 18(2)
  //            12% of wages, 18(3) ceiling, 18(5) rupee rounding (50 paise up), 19 VPF (employer not
  //            bound to match), 9(4) joint option above the ceiling, 20(1)/28(3) within 15 days of
  //            the close of the month, 29(1) admin charges — VERIFIED —
  //            https://egazette.gov.in/WriteReadData/2026/273957.pdf
  //  [EPS26]   EPS 2026, G.S.R. 527(E) 29-6-2026: para 4(1) 8.33% of wages up to the ceiling, 4(3)
  //            rounding, 7(1) membership — VERIFIED — https://egazette.gov.in/WriteReadData/2026/273951.pdf ;
  //            G.S.R. 847(E) para 7(1)(iii) — https://egazette.gov.in/WriteReadData/2026/276595.pdf
  //  [SO3582]  S.O. 3582(E) 1-7-2026: 12% under CoSS s.16(1)(a) proviso, deemed from 21-11-2025 —
  //            VERIFIED — https://egazette.gov.in/WriteReadData/2026/274112.pdf
  //  [SO5109]  S.O. 5109(E) 17-9-2026: wage ceiling ₹25,000 for Chapter III from 17-9-2026,
  //            superseding S.O. 2702(E) (₹15,000) — VERIFIED — https://egazette.gov.in/WriteReadData/2026/276299.pdf ;
  //            press note https://www.labour.gov.in/static/uploads/2026/09/4f607a88c5342aeb980c6b999997caab.pdf
  //  [EPFRATE] EPFO "Present Rates of Contribution": EDLI 0.5% (EDLI admin nil from 1-4-2017),
  //            admin 0.50% from 1-6-2018, minimum ₹500 a month (₹75 with no contributing member) —
  //            VERIFIED — https://web.archive.org/web/2024id_/https://www.epfindia.gov.in/site_docs/PDFs/MiscPDFs/ContributionRate.pdf
  //  [ECR]     EPFO "Introduction – ECR Version II" field order — VERIFIED —
  //            https://web.archive.org/web/2024id_/https://www.epfindia.gov.in/site_docs/PDFs/EPFOUnifiedPortal/Introduction_ECR2.0.pdf
  //  [COSS]    Code on Social Security 2020 — s.2(88) wages (50% rule), s.2(89) wage ceiling,
  //            s.16(1), s.164(2) — VERIFIED — https://prsindia.org/files/bills_acts/acts_parliament/2020/Code%20On%20Social%20Security,%202020.pdf ;
  //            in force 21-11-2025 by S.O. 5319(E) (recited in ESIC draft regulations, VERIFIED)
  //  [ESIC-W]  ESIC circular P-11/12/MinistryMol&E/2024-RevII 11-12-2025: s.2(88) wages apply to
  //            ESI from 21-11-2025 — VERIFIED — https://esic.gov.in/attachments/circularfile/New_wage_definition_u_s_2_88_of_The_Code_on_Social_Security_2020_1765902209.pdf
  //  [SSR26]   Social Security (Central) Rules 2026, G.S.R. 344(E) 8-5-2026, rule 19(1): employer
  //            3.25%, employee 0.75%, "rounded to the next higher rupee" — VERIFIED —
  //            https://egazette.gov.in/WriteReadData/2026/272366.pdf
  //  [ESIC-C]  ESIC contribution page: 0.75% / 3.25% from 1-7-2019; daily wage ≤ ₹176 no employee
  //            share; contribution periods Apr–Sep / Oct–Mar; due within 15 days — VERIFIED (that
  //            ESIC says so) — https://esic.gov.in/contribution
  //  [PT-MH]   Maharashtra Profession Tax Act 1975 Schedule I entry 1 (from 1-4-2023) — VERIFIED —
  //            https://www.mahagst.gov.in/public/uploads/mvatservices/1761635767Rate%20Schedules%20under%20the%20Professions%20Tax%20Act,%201975%201.pdf
  //  [PT-KA]   Karnataka Tax on Professions (Amendment) Act No. 33 of 2025 (from 1-4-2025), gazette
  //            scan — VERIFIED (scan hosted at https://taxguru.in/wp-content/uploads/2025/04/Karnataka-PT-Amendment-Act-2025_compressed-1-4.pdf)
  //  [PT-WB]   West Bengal: schedule w.e.f. 1-4-2014 (https://comtax.wb.gov.in/Ptax-Schedule-New_(w.e.f._1-4-2014).pdf,
  //            UNVERIFIED); from 1-10-2026 Notification 1407-F.T. 18-8-2026 (draft, VERIFIED) —
  //            https://comtax.wb.gov.in/pdf/SAR-470_Finance%20Dept(Rev)_1407-FT.pdf — final 1607-F.T.
  //            16-9-2026 UNVERIFIED
  //  [PT-TN]   Greater Chennai Corporation half-yearly PT from 1-10-2024 (TN Urban Local Bodies Act
  //            1998) — UNVERIFIED (secondary: https://akriviahcm.com/resources/wp-content/uploads/2025/02/Revision-of-Chennai-Corporation-Professional-Tax-1.pdf);
  //            rates differ by local body
  //  [PT-GJ]   Gujarat Notification GHN-35-PFT-2022-S.3(2)(10)-Th 8-4-2022 — VERIFIED —
  //            https://commercialtax.gujarat.gov.in/vatwebsite/download/cir_noti/NOTI/Profession_Tax_NOTI_08042022.pdf
  //  [PT-TS]   Telangana Tax on Professions Act 1987, First Schedule entry 1 — VERIFIED —
  //            https://www.tgct.gov.in/tgportal/AllActs/APPT/APPTSchedule.aspx
  //  [PT-AP]   Andhra Pradesh Act 22 of 1987 as amended by Act 12 of 2013 — UNVERIFIED (secondary:
  //            https://www.legitquest.com/act/andhra-pradesh-tax-on-professions-trades-callings-and-employments-amendment-act-2013/5529)
  //  [PT-MP]   MP Vritti Kar (Sanshodhan) Adhiniyam 2018 (Act 20 of 2018) — UNVERIFIED (Act text on
  //            https://www.legitquest.com/act/madhya-pradesh-vritti-kar-sanshodhan-adhiniyam-2018/103BD)
  //  [A276]    Constitution Article 276(2): PT ≤ ₹2,500 a year — VERIFIED —
  //            https://www.constitutionofindia.net/articles/article-276-taxes-on-professions-trades-callings-and-employments/
  //  [IT61]    Income-tax Act 1961 s.192 (salary TDS at the average rate) — https://www.incometaxindia.gov.in
  //  [ACT25]   Income-tax Act 2025 s.392 (salary) — https://egazette.gov.in/WriteReadData/2025/265620.pdf
  //  [F24Q]    Protean Form 24Q Regular Q4 file format v7.5 (27-05-2025), Annexure 2 section codes
  //            92A Govt (non-Union) / 92B non-Govt / 92C Union Govt — VERIFIED —
  //            https://tinpan.proteantech.in/downloads/e-tds/File_Format_24Q_Regular_Q4_Version_7.5_27052025_201112.xls
  //  [R26]     Income-tax Rules 2026, G.S.R. 198(E) 20-3-2026: rule 219(1) Sl.1 Form 138 replaces 24Q,
  //            Annexure I note 1 codes 1001 Govt (non-Union) / 1002 non-Govt / 1003 Union Govt; rule
  //            219(4) due 31 Jul / 31 Oct / 31 Jan / 31 May; rule 218 deposit by the 7th, March by
  //            30 April; rule 215(1) Sl.1 Form 130 replaces Form 16 — VERIFIED —
  //            https://egazette.gov.in/WriteReadData/2026/271092.pdf
  // NOT MODELLED: the September-2026 split month is handled by day-weighting the ceiling (EPFO
  // FAQ, UNVERIFIED source); the ESI employer-share waiver for persons with disability (SSR26
  // r.19(2)); the 10% EPF rate for notified establishments (edit the epf row).
  `
  CREATE TABLE statutory_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('epf', 'eps', 'edli', 'epf_admin', 'esi_emp', 'esi_er', 'pt', 'ss_wages')),
    state TEXT,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    rate_bp INTEGER CHECK (rate_bp IS NULL OR rate_bp BETWEEN 0 AND 10000),
    ceiling_paise INTEGER CHECK (ceiling_paise IS NULL OR ceiling_paise >= 0),
    threshold_paise INTEGER CHECK (threshold_paise IS NULL OR threshold_paise >= 0),
    min_paise INTEGER CHECK (min_paise IS NULL OR min_paise >= 0),
    slab_from_paise INTEGER CHECK (slab_from_paise IS NULL OR slab_from_paise >= 0),
    slab_to_paise INTEGER CHECK (slab_to_paise IS NULL OR slab_to_paise >= 0),
    amount_paise INTEGER CHECK (amount_paise IS NULL OR amount_paise >= 0),
    basis TEXT NOT NULL DEFAULT 'month' CHECK (basis IN ('month', 'half_year', 'year')),
    gender TEXT NOT NULL DEFAULT 'any' CHECK (gender IN ('any', 'male', 'female')),
    variant TEXT NOT NULL DEFAULT 'standard' CHECK (variant IN ('standard', 'disabled')),
    special_month INTEGER CHECK (special_month IS NULL OR special_month BETWEEN 1 AND 12),
    special_amount_paise INTEGER CHECK (special_amount_paise IS NULL OR special_amount_paise >= 0),
    source TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    is_seeded INTEGER NOT NULL DEFAULT 0,
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CHECK (kind <> 'pt' OR state IS NOT NULL)
  );
  CREATE INDEX idx_statutory_rates_kind ON statutory_rates(kind, state, effective_from);

  -- EPF / EPS / EDLI: ₹15,000 ceiling to 16-9-2026, ₹25,000 from 17-9-2026 [SO5109].
  INSERT INTO statutory_rates (kind, effective_from, effective_to, rate_bp, ceiling_paise, min_paise, source, verified, is_seeded) VALUES
    ('epf', '2014-09-01', '2026-09-16', 1200, 1500000, NULL,
     'EPF Act s.6; EPF Scheme 1952 para 26A(2) ceiling Rs 15,000 from 1-9-2014 [EPFS52]; 12% continued under CoSS s.16(1)(a) by S.O. 3582(E) [SO3582], EPF Scheme 2026 para 18 [EPFS26]; accessed 2026-10-07', 1, 1),
    ('epf', '2026-09-17', NULL, 1200, 2500000, NULL,
     'EPF Scheme 2026 para 18(2)-(3) [EPFS26]; 12% per S.O. 3582(E) [SO3582]; ceiling Rs 25,000 from 17-9-2026 per S.O. 5109(E) [SO5109]; accessed 2026-10-07', 1, 1),
    ('eps', '2014-09-01', '2026-09-16', 833, 1500000, NULL,
     'EPS 1995 para 3(2) / EPS 2026 para 4(1): 8.33% of pay up to the ceiling [EPS26]; accessed 2026-10-07', 1, 1),
    ('eps', '2026-09-17', NULL, 833, 2500000, NULL,
     'EPS 2026 para 4(1) proviso, ceiling Rs 25,000 per S.O. 5109(E) [EPS26][SO5109]; accessed 2026-10-07', 1, 1),
    ('edli', '2014-09-01', '2026-09-16', 50, 1500000, NULL,
     'EPFO Present Rates of Contribution: EDLI 0.5% of wages up to the ceiling, EDLI admin nil from 1-4-2017 [EPFRATE]; accessed 2026-10-07', 1, 1),
    ('edli', '2026-09-17', NULL, 50, 2500000, NULL,
     'EDLI 0.5% [EPFRATE] on the Rs 25,000 ceiling [SO5109]; EDLI Scheme 2026 (G.S.R. 526(E)) rate notification not read — UNVERIFIED; accessed 2026-10-07', 0, 1),
    ('epf_admin', '2018-06-01', NULL, 50, NULL, 50000,
     'EPFO admin charges 0.50% of EPF wages from 1-6-2018, minimum Rs 500 a month per establishment [EPFRATE]; EPF Scheme 2026 para 29(1) [EPFS26]; notification no. (S.O. 2011(E) 21-5-2018) UNVERIFIED; accessed 2026-10-07', 1, 1);

  -- ESI: rates from 1-7-2019 [ESIC-C], restated by SS (Central) Rules 2026 r.19(1) [SSR26].
  -- threshold = coverage ceiling (Rs 21,000; Rs 25,000 with disability); min = daily wage Rs 176.
  INSERT INTO statutory_rates (kind, variant, effective_from, effective_to, rate_bp, threshold_paise, min_paise, source, verified, is_seeded) VALUES
    ('esi_emp', 'standard', '2019-07-01', '2026-05-07', 75, 2100000, 17600,
     'ESI employee 0.75% from 1-7-2019; ceiling Rs 21,000; no employee share at average daily wage <= Rs 176 [ESIC-C https://esic.gov.in/contribution]; G.S.R. 423(E) 2019 UNVERIFIED; accessed 2026-10-07', 1, 1),
    ('esi_emp', 'standard', '2026-05-08', NULL, 75, 2100000, 17600,
     'Social Security (Central) Rules 2026 r.19(1)(b) 0.75%, rounded to the next higher rupee [SSR26]; Rs 21,000 ceiling and Rs 176 exemption per ESIC practice [ESIC-C] — legal basis under the Code UNVERIFIED; accessed 2026-10-07', 0, 1),
    ('esi_emp', 'disabled', '2017-01-01', NULL, 75, 2500000, 17600,
     'ESI coverage ceiling Rs 25,000 for persons with disability [ESIC-C]; start date and basis under the Code UNVERIFIED; accessed 2026-10-07', 0, 1),
    ('esi_er', 'standard', '2019-07-01', '2026-05-07', 325, NULL, NULL,
     'ESI employer 3.25% from 1-7-2019 [ESIC-C https://esic.gov.in/contribution]; accessed 2026-10-07', 1, 1),
    ('esi_er', 'standard', '2026-05-08', NULL, 325, NULL, NULL,
     'Social Security (Central) Rules 2026 r.19(1)(a) 3.25%, rounded to the next higher rupee [SSR26]; accessed 2026-10-07', 1, 1);

  -- Code on Social Security wages (s.2(88), 50% rule) for EPF and ESI from 21-11-2025 [COSS][ESIC-W].
  INSERT INTO statutory_rates (kind, effective_from, rate_bp, source, verified, is_seeded) VALUES
    ('ss_wages', '2025-11-21', 5000,
     'Code on Social Security 2020 s.2(88) wages (basic + DA + retaining allowance + allowances not excluded; excluded items above 50% of remuneration added back) in force 21-11-2025 (S.O. 5319(E)) [COSS]; applies to ESI per ESIC circular 11-12-2025 [ESIC-W] and to EPF per EPF Scheme 2026 para 18(2) [EPFS26]; accessed 2026-10-07', 1, 1);

  -- Professional tax slabs. Paise; slab_to inclusive (NULL = no ceiling); slab_from = display only.
  CREATE TEMP TABLE m029_pt (state TEXT, eff_from TEXT, eff_to TEXT, gender TEXT, basis TEXT, s_from INTEGER, s_to INTEGER,
    amount INTEGER, sp_month INTEGER, sp_amount INTEGER, src TEXT, verified INTEGER);
  INSERT INTO m029_pt VALUES
    -- Maharashtra, monthly, Schedule I entry 1 from 1-4-2023 [PT-MH]: men <= 7,500 nil; 7,501-10,000 Rs 175; > 10,000 Rs 200 (Feb Rs 300); women <= 25,000 nil, > 25,000 Rs 200 (Feb Rs 300).
    ('MH', '2023-04-01', NULL, 'any', 'month', 0, 750000, 0, NULL, NULL, 'MH PT Act 1975 Sch. I entry 1 [PT-MH]; accessed 2026-10-07', 1),
    ('MH', '2023-04-01', NULL, 'any', 'month', 750100, 1000000, 17500, NULL, NULL, 'MH PT Act 1975 Sch. I entry 1 [PT-MH]; accessed 2026-10-07', 1),
    ('MH', '2023-04-01', NULL, 'any', 'month', 1000100, NULL, 20000, 2, 30000, 'MH PT Act 1975 Sch. I entry 1, Rs 300 in February (Rs 2,500 a year) [PT-MH]; accessed 2026-10-07', 1),
    ('MH', '2023-04-01', NULL, 'female', 'month', 0, 2500000, 0, NULL, NULL, 'MH PT Act 1975 Sch. I entry 1, women up to Rs 25,000 nil [PT-MH]; accessed 2026-10-07', 1),
    ('MH', '2023-04-01', NULL, 'female', 'month', 2500100, NULL, 20000, 2, 30000, 'MH PT Act 1975 Sch. I entry 1, women above Rs 25,000 [PT-MH]; accessed 2026-10-07', 1),
    -- Karnataka, monthly, from 1-4-2025 (Act 33 of 2025) [PT-KA]: below 25,000 nil; 25,000 and above Rs 200 (Feb Rs 300).
    ('KA', '2025-04-01', NULL, 'any', 'month', 0, 2499999, 0, NULL, NULL, 'Karnataka Tax on Professions Act 1976 Sch. as amended by Act 33 of 2025 [PT-KA]; accessed 2026-10-07', 1),
    ('KA', '2025-04-01', NULL, 'any', 'month', 2500000, NULL, 20000, 2, 30000, 'Karnataka Tax on Professions Act 1976 Sch. as amended by Act 33 of 2025: Rs 200 a month, Rs 300 in February [PT-KA]; accessed 2026-10-07', 1),
    -- West Bengal, monthly, schedule w.e.f. 1-4-2014 to 30-9-2026 [PT-WB] (UNVERIFIED).
    ('WB', '2014-04-01', '2026-09-30', 'any', 'month', 0, 850000, 0, NULL, NULL, 'WB State Tax on Professions Act 1979 schedule w.e.f. 1-4-2014 [PT-WB] — UNVERIFIED; accessed 2026-10-07', 0),
    ('WB', '2014-04-01', '2026-09-30', 'any', 'month', 850100, 1000000, 9000, NULL, NULL, 'WB schedule w.e.f. 1-4-2014 [PT-WB] — UNVERIFIED; accessed 2026-10-07', 0),
    ('WB', '2014-04-01', '2026-09-30', 'any', 'month', 1000100, 1500000, 11000, NULL, NULL, 'WB schedule w.e.f. 1-4-2014 [PT-WB] — UNVERIFIED; accessed 2026-10-07', 0),
    ('WB', '2014-04-01', '2026-09-30', 'any', 'month', 1500100, 2500000, 13000, NULL, NULL, 'WB schedule w.e.f. 1-4-2014 [PT-WB] — UNVERIFIED; accessed 2026-10-07', 0),
    ('WB', '2014-04-01', '2026-09-30', 'any', 'month', 2500100, 4000000, 15000, NULL, NULL, 'WB schedule w.e.f. 1-4-2014 [PT-WB] — UNVERIFIED; accessed 2026-10-07', 0),
    ('WB', '2014-04-01', '2026-09-30', 'any', 'month', 4000100, NULL, 20000, NULL, NULL, 'WB schedule w.e.f. 1-4-2014 [PT-WB] — UNVERIFIED; accessed 2026-10-07', 0),
    -- West Bengal from 1-10-2026 (Notification 1407-F.T. draft, VERIFIED; final 1607-F.T. UNVERIFIED).
    ('WB', '2026-10-01', NULL, 'any', 'month', 0, 2000000, 0, NULL, NULL, 'WB Notification 1407-F.T. 18-8-2026 (draft; final 1607-F.T. 16-9-2026 UNVERIFIED) [PT-WB]; accessed 2026-10-07', 0),
    ('WB', '2026-10-01', NULL, 'any', 'month', 2000100, 3000000, 10000, NULL, NULL, 'WB Notification 1407-F.T. [PT-WB]; accessed 2026-10-07', 0),
    ('WB', '2026-10-01', NULL, 'any', 'month', 3000100, 5000000, 14000, NULL, NULL, 'WB Notification 1407-F.T. [PT-WB]; accessed 2026-10-07', 0),
    ('WB', '2026-10-01', NULL, 'any', 'month', 5000100, 10000000, 17000, NULL, NULL, 'WB Notification 1407-F.T. [PT-WB]; accessed 2026-10-07', 0),
    ('WB', '2026-10-01', NULL, 'any', 'month', 10000100, NULL, 20800, NULL, NULL, 'WB Notification 1407-F.T. [PT-WB]; accessed 2026-10-07', 0),
    -- Tamil Nadu (Greater Chennai Corporation), HALF-YEARLY income, from 1-10-2024 [PT-TN] (UNVERIFIED).
    ('TN', '2024-10-01', NULL, 'any', 'half_year', 0, 2100000, 0, NULL, NULL, 'Chennai Corporation PT half-yearly from 1-10-2024 [PT-TN] — UNVERIFIED; accessed 2026-10-07', 0),
    ('TN', '2024-10-01', NULL, 'any', 'half_year', 2100100, 3000000, 18000, NULL, NULL, 'Chennai Corporation PT [PT-TN] — UNVERIFIED; accessed 2026-10-07', 0),
    ('TN', '2024-10-01', NULL, 'any', 'half_year', 3000100, 4500000, 42500, NULL, NULL, 'Chennai Corporation PT [PT-TN] — UNVERIFIED; accessed 2026-10-07', 0),
    ('TN', '2024-10-01', NULL, 'any', 'half_year', 4500100, 6000000, 93000, NULL, NULL, 'Chennai Corporation PT [PT-TN] — UNVERIFIED; accessed 2026-10-07', 0),
    ('TN', '2024-10-01', NULL, 'any', 'half_year', 6000100, 7500000, 102500, NULL, NULL, 'Chennai Corporation PT [PT-TN] — UNVERIFIED; accessed 2026-10-07', 0),
    ('TN', '2024-10-01', NULL, 'any', 'half_year', 7500100, NULL, 125000, NULL, NULL, 'Chennai Corporation PT [PT-TN] — UNVERIFIED; accessed 2026-10-07', 0),
    -- Gujarat, monthly, from 1-4-2022 [PT-GJ]: up to 12,000 nil; more than 12,000 Rs 200.
    ('GJ', '2022-04-01', NULL, 'any', 'month', 0, 1200000, 0, NULL, NULL, 'Gujarat Notification GHN-35-PFT-2022 8-4-2022 [PT-GJ]; accessed 2026-10-07', 1),
    ('GJ', '2022-04-01', NULL, 'any', 'month', 1200001, NULL, 20000, NULL, NULL, 'Gujarat Notification GHN-35-PFT-2022 8-4-2022: more than Rs 12,000 [PT-GJ]; accessed 2026-10-07', 1),
    -- Telangana, monthly [PT-TS] (VERIFIED; effective date = state formation, UNVERIFIED).
    ('TS', '2014-06-02', NULL, 'any', 'month', 0, 1500000, 0, NULL, NULL, 'Telangana Tax on Professions Act 1987 First Sch. entry 1 [PT-TS]; effective date UNVERIFIED; accessed 2026-10-07', 1),
    ('TS', '2014-06-02', NULL, 'any', 'month', 1500100, 2000000, 15000, NULL, NULL, 'Telangana PT Act 1987 First Sch. entry 1 [PT-TS]; accessed 2026-10-07', 1),
    ('TS', '2014-06-02', NULL, 'any', 'month', 2000100, NULL, 20000, NULL, NULL, 'Telangana PT Act 1987 First Sch. entry 1 [PT-TS]; accessed 2026-10-07', 1),
    -- Andhra Pradesh, monthly, Act 12 of 2013 [PT-AP] (UNVERIFIED).
    ('AP', '2013-02-06', NULL, 'any', 'month', 0, 1500000, 0, NULL, NULL, 'AP Tax on Professions Act 1987 as amended by Act 12 of 2013 [PT-AP] — UNVERIFIED; accessed 2026-10-07', 0),
    ('AP', '2013-02-06', NULL, 'any', 'month', 1500100, 2000000, 15000, NULL, NULL, 'AP PT Act 1987 [PT-AP] — UNVERIFIED; accessed 2026-10-07', 0),
    ('AP', '2013-02-06', NULL, 'any', 'month', 2000100, NULL, 20000, NULL, NULL, 'AP PT Act 1987 [PT-AP] — UNVERIFIED; accessed 2026-10-07', 0),
    -- Madhya Pradesh, ANNUAL salary, deducted monthly (last-month remainder), from 1-4-2018 [PT-MP] (UNVERIFIED).
    ('MP', '2018-04-01', NULL, 'any', 'year', 0, 22500000, 0, NULL, NULL, 'MP Vritti Kar Adhiniyam 1995 as amended by Act 20 of 2018 [PT-MP] — UNVERIFIED; accessed 2026-10-07', 0),
    ('MP', '2018-04-01', NULL, 'any', 'year', 22500100, 30000000, 150000, NULL, NULL, 'MP Vritti Kar Act 20 of 2018: Rs 1,500 a year (Rs 125 x 12) [PT-MP] — UNVERIFIED; accessed 2026-10-07', 0),
    ('MP', '2018-04-01', NULL, 'any', 'year', 30000100, 40000000, 200000, NULL, NULL, 'MP Vritti Kar Act 20 of 2018: Rs 2,000 a year (Rs 166 x 11 + Rs 174) [PT-MP] — UNVERIFIED; accessed 2026-10-07', 0),
    ('MP', '2018-04-01', NULL, 'any', 'year', 40000100, NULL, 250000, NULL, NULL, 'MP Vritti Kar Act 20 of 2018: Rs 2,500 a year (Rs 208 x 11 + Rs 212) [PT-MP] — UNVERIFIED; accessed 2026-10-07', 0);
  INSERT INTO statutory_rates (kind, state, effective_from, effective_to, gender, basis, slab_from_paise, slab_to_paise, amount_paise,
      special_month, special_amount_paise, source, verified, is_seeded)
    SELECT 'pt', state, eff_from, eff_to, gender, basis, s_from, s_to, amount, sp_month, sp_amount, src, verified, 1 FROM m029_pt;
  DROP TABLE m029_pt;

  -- Employee statutory profile.
  ALTER TABLE employees ADD COLUMN pf_number TEXT;
  ALTER TABLE employees ADD COLUMN gender TEXT CHECK (gender IS NULL OR gender IN ('male', 'female', 'other'));
  ALTER TABLE employees ADD COLUMN dob TEXT;
  ALTER TABLE employees ADD COLUMN tax_regime TEXT NOT NULL DEFAULT 'new' CHECK (tax_regime IN ('new', 'old'));
  ALTER TABLE employees ADD COLUMN vpf_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (vpf_rate_bp >= 0);
  ALTER TABLE employees ADD COLUMN pf_full_wage INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE employees ADD COLUMN eps_eligible INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE employees ADD COLUMN is_disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE employees ADD COLUMN metro INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE employees ADD COLUMN tds_enabled INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE employee_tax_declarations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    fy_start_year INTEGER NOT NULL,
    section TEXT NOT NULL CHECK (section IN ('80C', '80CCD1B', '80D', '80D_PARENTS', '24B', 'RENT', 'OTHER_INCOME', 'PREV_SALARY', 'PREV_TDS', 'PREV_PT')),
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
    proof_received INTEGER NOT NULL DEFAULT 0 CHECK (proof_received IN (0, 1)),
    UNIQUE (employee_id, fy_start_year, section)
  );

  ALTER TABLE pay_heads ADD COLUMN in_wages INTEGER NOT NULL DEFAULT 1 CHECK (in_wages IN (0, 1));
  UPDATE pay_heads SET in_wages = 0 WHERE name = 'HRA' COLLATE NOCASE;

  ALTER TABLE payroll_runs ADD COLUMN pf_admin_topup INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN vpf INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN epf_wage INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN eps_wage INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN edli_wage INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN esi_covered INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN esi_wage INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN tds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE payroll_lines ADD COLUMN pt_state TEXT;
  ALTER TABLE payroll_lines ADD COLUMN tax_regime TEXT CHECK (tax_regime IS NULL OR tax_regime IN ('new', 'old'));
  ALTER TABLE payroll_lines ADD COLUMN tds_workings_json TEXT;
  -- Pre-029 lines: wages as the old engine remitted them (basic capped at Rs 15,000), coverage from the contributions.
  UPDATE payroll_lines SET
    epf_wage = CASE WHEN pf_emp > 0 THEN MIN(basic, 1500000) ELSE 0 END,
    eps_wage = CASE WHEN eps_er > 0 THEN MIN(basic, 1500000) ELSE 0 END,
    edli_wage = CASE WHEN edli > 0 THEN MIN(basic, 1500000) ELSE 0 END,
    esi_covered = CASE WHEN esi_emp > 0 OR esi_er > 0 THEN 1 ELSE 0 END,
    esi_wage = CASE WHEN esi_emp > 0 OR esi_er > 0 THEN gross ELSE 0 END,
    pt_state = (SELECT e.pt_state FROM employees e WHERE e.id = payroll_lines.employee_id);

  -- Tagged statutory payable ledgers; backfill the names the pay run always created.
  ALTER TABLE ledgers ADD COLUMN statutory_kind TEXT CHECK (statutory_kind IS NULL OR statutory_kind IN ('pf', 'esi', 'pt', 'salary'));
  UPDATE ledgers SET statutory_kind = 'pf' WHERE name = 'PF Payable' COLLATE NOCASE;
  UPDATE ledgers SET statutory_kind = 'esi' WHERE name = 'ESI Payable' COLLATE NOCASE;
  UPDATE ledgers SET statutory_kind = 'pt' WHERE name = 'Professional Tax Payable' COLLATE NOCASE;
  UPDATE ledgers SET statutory_kind = 'salary' WHERE name = 'Salaries Payable' COLLATE NOCASE;
  CREATE INDEX idx_ledgers_statutory_kind ON ledgers(statutory_kind) WHERE statutory_kind IS NOT NULL;

  -- Salary TDS: section 192 (1961) / 392 (2025 Act) [IT61][ACT25]. No flat rate — the payroll engine
  -- deducts at the average rate on estimated salary; the rate rows carry the return codes only.
  INSERT OR IGNORE INTO tds_sections (code, description, rate, threshold_single, threshold_annual, nature, act, legacy_code, new_reference) VALUES
    ('192', 'Salary', 0, 0, 0, 'Salary (deducted by payroll at the average rate of income-tax on estimated salary)', 'it_act_1961', '192', '392');
  INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp, threshold_single_paise, threshold_annual_paise,
      threshold_basis, no_pan_rate_bp, return_code, source)
    SELECT id, '2025-04-01', '2026-03-31', 'any', 0, 0, 0, 'fy', 2000, '92B',
      'Income-tax Act 1961 s.192(1) average rate on estimated salary (computed by payroll, not a flat rate); 24Q section code 92B [F24Q]; no PAN s.206AA(1) — 20% or the average rate if higher; accessed 2026-10-07'
      FROM tds_sections WHERE code = '192';
  INSERT INTO tds_section_rates (section_id, effective_from, effective_to, deductee_type, rate_bp, threshold_single_paise, threshold_annual_paise,
      threshold_basis, no_pan_rate_bp, return_code, source)
    SELECT id, '2026-04-01', NULL, 'any', 0, 0, 0, 'fy', 2000, '1002',
      'Income-tax Act 2025 s.392(1) salary TDS at the average rate [ACT25]; Form 138 code 1002 (non-Government) per Income-tax Rules 2026 Annexure I note 1 [R26]; accessed 2026-10-07'
      FROM tds_sections WHERE code = '192';

  ALTER TABLE tds_entries ADD COLUMN employee_id INTEGER REFERENCES employees(id);
  CREATE INDEX idx_tds_entries_employee ON tds_entries(employee_id) WHERE employee_id IS NOT NULL;

  CREATE TABLE statutory_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('pf', 'esi', 'pt', 'tds')),
    period TEXT NOT NULL,
    state TEXT,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    payment_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    reference TEXT,
    paid_on TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (kind = 'pt' OR state IS NULL)
  );
  CREATE INDEX idx_statutory_payments_period ON statutory_payments(kind, period);
  CREATE INDEX idx_statutory_payments_voucher ON statutory_payments(payment_voucher_id);
  `,
  // 030 — pricing and counter billing (WP 2.6). Extends migration 014's price lists:
  // - price_levels.inclusive_of_tax: the level's rates are GST-inclusive (the resolver backs the
  //   taxable rate out — src/shared/pricing.ts); price_levels.is_default: the company's default
  //   level (at most one, partial unique index). ledgers.price_level_id (014) stays the party's.
  // - price_list_rates is rebuilt (its UNIQUE grows): effective_to (inclusive, NULL = open),
  //   min_qty_milli (quantity slab: the row applies from this quantity up), discount_bp (the
  //   slab's discount), currency (rates in a foreign invoice currency). Existing rows keep their
  //   ids and become open-ended INR base slabs (min 0, no discount). Nothing references the
  //   table, so a plain create-copy-drop-rename is safe with foreign keys on.
  // - stock_items.mrp_paise / standard_cost_paise: the printed MRP (GST-inclusive by definition,
  //   Legal Metrology (Packaged Commodities) Rules 2011 r.2(m) "inclusive of all taxes") and a
  //   standard cost — both master facts, never posted.
  // - party_item_rates: negotiated party-wise rates (source 'manual', date-effective) and the
  //   remembered last selling price (source 'last_sale', one row per party + item).
  // - discount_schemes + discount_scheme_slabs: qty / value slabs, buy-x-get-y, flat; item,
  //   stock group or everything; date range; priority (higher wins).
  // - counter_sales: entry facts of a counter-billing sale (the invoice + its receipt, cash
  //   tendered / change). Reports still read voucher_lines; this row only links the pair.
  `
  ALTER TABLE price_levels ADD COLUMN inclusive_of_tax INTEGER NOT NULL DEFAULT 0 CHECK (inclusive_of_tax IN (0, 1));
  ALTER TABLE price_levels ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
  CREATE UNIQUE INDEX idx_price_levels_default ON price_levels(is_default) WHERE is_default = 1;

  CREATE TABLE price_list_rates_030 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    price_level_id INTEGER NOT NULL REFERENCES price_levels(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    rate INTEGER NOT NULL CHECK (rate >= 0),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    min_qty_milli INTEGER NOT NULL DEFAULT 0 CHECK (min_qty_milli >= 0),
    discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
    currency TEXT NOT NULL DEFAULT 'INR',
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
    UNIQUE (price_level_id, stock_item_id, currency, min_qty_milli, effective_from)
  );
  INSERT INTO price_list_rates_030 (id, price_level_id, stock_item_id, rate, effective_from)
    SELECT id, price_level_id, stock_item_id, rate, effective_from FROM price_list_rates;
  DROP TABLE price_list_rates;
  ALTER TABLE price_list_rates_030 RENAME TO price_list_rates;
  CREATE INDEX idx_price_list_rates_item ON price_list_rates(stock_item_id, price_level_id);

  ALTER TABLE stock_items ADD COLUMN mrp_paise INTEGER CHECK (mrp_paise IS NULL OR mrp_paise >= 0);
  ALTER TABLE stock_items ADD COLUMN standard_cost_paise INTEGER CHECK (standard_cost_paise IS NULL OR standard_cost_paise >= 0);

  CREATE TABLE party_item_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    rate_paise INTEGER NOT NULL CHECK (rate_paise >= 0),
    discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000),
    effective_from TEXT,
    effective_to TEXT,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'last_sale')),
    last_sold_at TEXT,
    last_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
  );
  CREATE INDEX idx_party_item_rates_pair ON party_item_rates(ledger_id, stock_item_id);
  CREATE UNIQUE INDEX idx_party_item_rates_last ON party_item_rates(ledger_id, stock_item_id) WHERE source = 'last_sale';

  CREATE TABLE discount_schemes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('qty_slab', 'value_slab', 'buy_x_get_y', 'flat')),
    applies_to TEXT NOT NULL CHECK (applies_to IN ('item', 'group', 'all')),
    target_id INTEGER,
    from_date TEXT,
    to_date TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    CHECK ((applies_to = 'all') = (target_id IS NULL)),
    CHECK (to_date IS NULL OR from_date IS NULL OR to_date >= from_date)
  );
  CREATE TABLE discount_scheme_slabs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scheme_id INTEGER NOT NULL REFERENCES discount_schemes(id) ON DELETE CASCADE,
    min_qty_milli INTEGER CHECK (min_qty_milli IS NULL OR min_qty_milli >= 0),
    min_value_paise INTEGER CHECK (min_value_paise IS NULL OR min_value_paise >= 0),
    discount_bp INTEGER CHECK (discount_bp IS NULL OR discount_bp BETWEEN 0 AND 10000),
    free_qty_milli INTEGER CHECK (free_qty_milli IS NULL OR free_qty_milli > 0),
    CHECK ((min_qty_milli IS NULL) <> (min_value_paise IS NULL)),
    CHECK ((discount_bp IS NULL) <> (free_qty_milli IS NULL))
  );
  CREATE INDEX idx_discount_scheme_slabs_scheme ON discount_scheme_slabs(scheme_id);

  CREATE TABLE counter_sales (
    invoice_voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    receipt_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    tendered_paise INTEGER NOT NULL DEFAULT 0 CHECK (tendered_paise >= 0),
    change_paise INTEGER NOT NULL DEFAULT 0 CHECK (change_paise >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_counter_sales_receipt ON counter_sales(receipt_voucher_id);
  `,
  // 031 (WP 3.8) — audit trail for the MCA edit-log requirement (Companies (Accounts) Rules 2014
  // r.3(1) proviso; sources in src/main/services/audit.ts). Number assigned by the orchestrator;
  // appended after 030 (WP 2.6, pricing and counter billing). dbtests locate it by content.
  // - audit_log is rebuilt (SQLite can't ALTER a CHECK) preserving every row and id:
  //   * action CHECK gains 'restore' (bin restore / backup restore), 'purge' (permanent delete
  //     from the bin), 'backup' and 'prune' (the retention job);
  //   * user_id (the signed-in user's id; names can change), at_iso (local ISO 8601 with offset
  //     and milliseconds — `at` stays UTC seconds for compatibility), clock_skew_note (set when
  //     the system clock reads earlier than the previous row), prev_hash / row_hash (SHA-256
  //     hash chain, see src/shared/auditChain.ts);
  //   * rows written by earlier migrations (entity 'migration', no user) are attributed to
  //     'system' before hashing.
  // - The hashes are NOT computed here: SQLite has no SHA-256. The migration runner seals every
  //   unhashed row in id order right after this SQL, inside the same transaction (migrate.ts
  //   → sealAuditChain), which is the backfill. Rows inserted by raw SQL in any later migration
  //   are sealed the same way.
  // - Database-level protection (ICAI Implementation Guide on rule 11(g), para 20: the trail
  //   should also be enabled "at the database level"): sealed rows can never be UPDATEd; rows
  //   can only be DELETEd by the retention job, which opens a guard in meta inside its own
  //   transaction — and never 'migration' or 'prune' rows. This stops accidental or app-code
  //   edits; anyone with the file and a SQLite tool can still drop the triggers, which is what
  //   the hash chain exists to reveal.
  // - A future migration that rebuilds audit_log again must recreate both triggers.
  // - Trace: one 'migration' row (entity_id 31, user 'system') with the row count backfilled
  //   and the highest id SQLite had issued (ids below it that no longer exist were removed
  //   before the chain existed, e.g. by the old retention setting).
  `
  CREATE TEMP TABLE m031_before AS
    SELECT (SELECT COUNT(*) FROM audit_log) AS n,
           (SELECT MAX(id) FROM audit_log) AS max_id,
           (SELECT seq FROM sqlite_sequence WHERE name = 'audit_log') AS seq;

  CREATE TABLE audit_log_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'create','update','delete','restore','purge','login','login_failed','logout','export','import','backup','prune'
    )),
    at TEXT NOT NULL DEFAULT (datetime('now')),
    before_json TEXT,
    after_json TEXT,
    user_name TEXT,
    app_version TEXT,
    user_id INTEGER,
    at_iso TEXT,
    clock_skew_note TEXT,
    prev_hash TEXT,
    row_hash TEXT
  );
  INSERT INTO audit_log_new (id, entity, entity_id, action, at, before_json, after_json, user_name, app_version)
    SELECT id, entity, entity_id, action, at, before_json, after_json,
           CASE WHEN entity = 'migration' AND user_name IS NULL THEN 'system' ELSE user_name END,
           app_version
      FROM audit_log ORDER BY id;
  DROP TABLE audit_log;
  ALTER TABLE audit_log_new RENAME TO audit_log;
  CREATE INDEX idx_audit_at ON audit_log(at);
  CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
  CREATE INDEX idx_audit_user ON audit_log(user_name);

  CREATE TRIGGER audit_log_append_only BEFORE UPDATE ON audit_log
    WHEN OLD.row_hash IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: a sealed audit entry cannot be changed');
  END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    WHEN OLD.entity = 'migration' OR OLD.action = 'prune'
      OR (SELECT value FROM meta WHERE key = 'audit.pruneWindowOpen') IS NOT '1'
  BEGIN
    SELECT RAISE(ABORT, 'audit_log entries cannot be deleted');
  END;

  INSERT INTO audit_log (entity, entity_id, action, before_json, after_json, user_name, app_version)
  VALUES ('migration', 31, 'update', NULL, json_object(
    'migration', 31,
    'change', 'audit trail hash chain (SHA-256, total-audit-v1), append-only triggers, clock-skew notes',
    'rowsBackfilled', (SELECT n FROM m031_before),
    'highestIdBefore', (SELECT COALESCE(seq, max_id, 0) FROM m031_before),
    'missingIdsBefore', (SELECT COALESCE(seq, max_id, 0) - n FROM m031_before)
  ), 'system', NULL);

  DROP TABLE m031_before;
  `,
  // 033 (WP 4.2) — receivables. Number assigned by the orchestrator: 032 is a parallel branch
  // (WP 4.1 banking), so on a branch without it this runs as the 32nd migration — dbtests locate
  // it by content (the reminder_log table), never by index. Additive only:
  // - ledgers: party email (statements / reminders are "email-ready" via mailto:), the annual
  //   simple-interest rate on overdue bills in basis points (NULL = no interest) with its
  //   interest-free grace days, and the credit hold (flag, reason, when) InvoiceEntry enforces.
  // - reminder_log: one row per reminder letter generated (party, bucket, date, document, channel)
  //   — the "don't remind twice within N days" check reads it.
  // - interest_charges: one row per bill per charged period, owned by the debit note that posted
  //   it (CASCADE on purge; a binned note's rows stop counting by query) — never double-charge.
  // - bill_followups: notes and promised payment dates per open bill. Bills are computed, so a
  //   bill is keyed by (party, voucher, ref name); voucher NULL = the opening balance.
  `
  ALTER TABLE ledgers ADD COLUMN email TEXT;
  ALTER TABLE ledgers ADD COLUMN interest_rate_bp INTEGER CHECK (interest_rate_bp IS NULL OR interest_rate_bp BETWEEN 0 AND 10000);
  ALTER TABLE ledgers ADD COLUMN interest_grace_days INTEGER NOT NULL DEFAULT 0 CHECK (interest_grace_days BETWEEN 0 AND 365);
  ALTER TABLE ledgers ADD COLUMN credit_hold INTEGER NOT NULL DEFAULT 0 CHECK (credit_hold IN (0, 1));
  ALTER TABLE ledgers ADD COLUMN credit_hold_reason TEXT;
  ALTER TABLE ledgers ADD COLUMN credit_hold_at TEXT;

  CREATE TABLE reminder_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    bucket TEXT NOT NULL CHECK (bucket IN ('gentle', 'firm', 'final')),
    date TEXT NOT NULL,
    amount_paise INTEGER NOT NULL DEFAULT 0,
    oldest_bill TEXT,
    max_overdue_days INTEGER NOT NULL DEFAULT 0,
    document_path TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'pdf', 'print', 'phone', 'other')),
    user_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_reminder_log_party ON reminder_log(party_ledger_id, date);

  CREATE TABLE interest_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    bill_voucher_id INTEGER,
    bill_ref TEXT NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    days INTEGER NOT NULL CHECK (days > 0),
    principal_paise INTEGER NOT NULL CHECK (principal_paise > 0),
    rate_bp INTEGER NOT NULL CHECK (rate_bp > 0),
    interest_paise INTEGER NOT NULL CHECK (interest_paise > 0),
    gst_paise INTEGER NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
    debit_note_voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (period_to >= period_from)
  );
  CREATE INDEX idx_interest_charges_bill ON interest_charges(party_ledger_id, bill_voucher_id, bill_ref);
  CREATE INDEX idx_interest_charges_note ON interest_charges(debit_note_voucher_id);

  CREATE TABLE bill_followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    bill_voucher_id INTEGER,
    bill_ref TEXT NOT NULL,
    date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    promised_date TEXT,
    promised_amount INTEGER CHECK (promised_amount IS NULL OR promised_amount > 0),
    user_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_bill_followups_party ON bill_followups(party_ledger_id, bill_voucher_id, bill_ref);
  CREATE INDEX idx_bill_followups_promised ON bill_followups(promised_date);
  `
]
