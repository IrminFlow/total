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
  // 020 (WP 3.1) — TDS core. Number assigned by the orchestrator; it is appended after 018 here
  // because 019 (WP 2.2) lands on main separately — the SQL below does not depend on 019's
  // content, so on rebase it simply sits after 019.
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
  `
]
