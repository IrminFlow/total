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

  // 18 — party contact details.
  //
  // Reminders had only an email address to work with, and in this market almost nobody sends a
  // payment reminder by email. A phone number turns the existing reminder text into a WhatsApp
  // message, which is how these conversations actually happen.
  `
  ALTER TABLE ledgers ADD COLUMN phone TEXT;
  ALTER TABLE ledgers ADD COLUMN email TEXT;
  `,

  // 19 — the filing register.
  //
  // The app showed due dates and then had nowhere to record that a return was actually filed, so
  // "did we file August?" was answered by looking at the portal. One row per (form, period): the
  // ARN, when it was filed, the tax paid, and the late fee and interest that came with it.
  //
  // Deliberately NOT derived from vouchers: filing is an act performed on the portal, not
  // something the books can infer. The schedule of what is owed is computed (filingSchedule);
  // only what happened is stored.
  `
  CREATE TABLE gst_filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form TEXT NOT NULL,
    -- 'YYYY-MM', 'YYYY-Qn' or 'YYYY-FY', as src/shared/period.ts keys them.
    period TEXT NOT NULL,
    due_date TEXT NOT NULL,
    filed_at TEXT,
    -- Acknowledgement Reference Number from the portal. The proof a return was filed.
    arn TEXT,
    tax_paid INTEGER NOT NULL DEFAULT 0,
    late_fee INTEGER NOT NULL DEFAULT 0,
    interest INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    UNIQUE (form, period)
  );
  CREATE INDEX idx_gst_filings_period ON gst_filings(period);
  `,

  // 20 — per-item negative-stock block.
  //
  // The company-wide F11 flag is all-or-nothing, and a business that sells services alongside
  // goods, or that legitimately books a sale before the purchase invoice arrives, has to leave it
  // off — which leaves it off for the items where going negative really is always a mistake.
  //
  // NULL means "follow the company setting", which is what every existing item wants. A per-item
  // yes/no would have forced a migration to guess an answer for items nobody has an opinion on.
  `
  ALTER TABLE stock_items ADD COLUMN block_negative INTEGER;
  `,

  // 21 — employee bank details, for the salary transfer file.
  //
  // Paying salaries one transfer at a time is how a business with fifteen people spends an hour
  // every month typing account numbers into a banking portal, and how one of them eventually goes
  // to the wrong account. Every bank accepts a bulk file; none of them can be given one without
  // the account number and IFSC being somewhere.
  //
  // Nullable, because an employee genuinely paid in cash has neither, and requiring them would
  // make the payroll refuse a run it should accept.
  `
  ALTER TABLE employees ADD COLUMN bank_account TEXT;
  ALTER TABLE employees ADD COLUMN ifsc TEXT;
  `,

  // 22 — party notes and promised payments.
  //
  // Chasing money is a conversation, and the app remembered none of it. "He said he'd pay on the
  // 20th" lived in someone's head or a diary, so the next call started from nothing and a promise
  // nobody wrote down is a promise nobody follows up.
  //
  // A promise is a note with a date on it rather than a separate field on the party: a party can
  // promise more than once, the promises are what the call log IS, and the last one is not
  // automatically the one that matters.
  `
  CREATE TABLE party_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_name TEXT,
    note TEXT NOT NULL,
    -- ISO date they said they would pay, when they said one. NULL for an ordinary note.
    promised_date TEXT,
    -- Paise they promised, when a figure was named. NULL means "the balance" or nothing specific.
    promised_amount INTEGER,
    -- Set when the promise is settled or written off, so an open promise list stays short.
    closed_at TEXT
  );
  CREATE INDEX idx_party_notes_ledger ON party_notes(ledger_id, at DESC);
  CREATE INDEX idx_party_notes_promised ON party_notes(promised_date) WHERE promised_date IS NOT NULL;
  `,

  // 23 — party credit terms beyond the limit: interest, and who the party belongs to.
  //
  // Interest is stored in basis points rather than a percentage float because a rate is a rounded
  // human number ("eighteen percent"), and 0.18 stored as a double is how 18% becomes 17.999999
  // in a statement the customer is going to argue about. Grace days sit next to it because a rate
  // without a grace period is a rate nobody applies — everybody forgives the first week.
  //
  // Salesperson and territory are free text, not a foreign key to a table that does not exist and
  // that most companies would never fill in. The ageing report groups on whatever is typed; an
  // empty one groups under "Unassigned", which is itself a useful row.
  `
  ALTER TABLE ledgers ADD COLUMN interest_rate_bp INTEGER;
  ALTER TABLE ledgers ADD COLUMN interest_grace_days INTEGER;
  ALTER TABLE ledgers ADD COLUMN salesperson TEXT;
  ALTER TABLE ledgers ADD COLUMN territory TEXT;
  `,

  // 24 — attendance, salary advances, and where a salary lands.
  //
  // Payable days were typed into the pay run and forgotten the moment it was posted, so "why was
  // Anita paid for 22 days in June" had no answer three months later. Attendance is now a record
  // in its own right: one row per employee per month, entered before the run and kept after it.
  //
  // The three counts are stored rather than derived from each other because they are three
  // different facts — a paid leave is not a present day and is not a loss of pay — and a business
  // that reconciles its own register against ours needs to see each of them.
  //
  // Advances are their own table rather than a recurring deduction head: a head is a rate, and an
  // advance is a balance that runs down. Recoveries are recorded per run, so the outstanding
  // amount is derived and cannot drift from the payslips that actually deducted it.
  `
  CREATE TABLE attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    -- 'YYYY-MM'.
    month TEXT NOT NULL,
    present_days REAL NOT NULL DEFAULT 0,
    paid_leave_days REAL NOT NULL DEFAULT 0,
    -- Loss of pay: days present in the month that are not paid for.
    lop_days REAL NOT NULL DEFAULT 0,
    note TEXT,
    UNIQUE (employee_id, month)
  );
  CREATE INDEX idx_attendance_month ON attendance(month);

  CREATE TABLE employee_loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    granted_on TEXT NOT NULL,
    principal INTEGER NOT NULL,
    -- Paise recovered per pay run. The last instalment is whatever is left, never an overshoot.
    instalment INTEGER NOT NULL,
    note TEXT,
    -- Set when written off or settled outside payroll; a fully recovered loan closes itself.
    closed_at TEXT
  );
  CREATE INDEX idx_employee_loans_employee ON employee_loans(employee_id);

  CREATE TABLE loan_recoveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id INTEGER NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
    run_id INTEGER REFERENCES payroll_runs(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    amount INTEGER NOT NULL,
    UNIQUE (loan_id, month)
  );
  CREATE INDEX idx_loan_recoveries_run ON loan_recoveries(run_id);

  -- What the payslip actually recovered. Stored on the line rather than derived from
  -- loan_recoveries so a reprinted payslip shows the figure it showed the first time, even if
  -- the advance is later written off.
  ALTER TABLE payroll_lines ADD COLUMN advance_recovery INTEGER NOT NULL DEFAULT 0;

  -- Which cost centre carries this employee's salary. NULL means the salary journal is posted
  -- unallocated, exactly as it was before — no existing company's books change under this.
  ALTER TABLE employees ADD COLUMN cost_centre_id INTEGER REFERENCES cost_centres(id);
  `,

  // 25 — income tax on salary: how to reach the employee, and what regime they chose.
  //
  // Section 192 asks the employer to estimate the year's salary, compute the tax on it and deduct
  // it in parts. That needs two things the employee master never held: which regime they opted
  // for (the new one is the default, and the old one has to be chosen), and what they declared
  // under Chapter VI-A, which only the old regime allows anyway.
  //
  // Phone and email are here for the same reason they are on a party ledger: a payslip that has
  // to be printed, walked over and handed across a desk is a payslip that arrives late.
  `
  ALTER TABLE employees ADD COLUMN email TEXT;
  ALTER TABLE employees ADD COLUMN phone TEXT;
  -- 'new' | 'old'. NULL means the default, which is the new regime.
  ALTER TABLE employees ADD COLUMN tax_regime TEXT;
  -- Chapter VI-A deductions the employee declared and the employer accepted, paise. Old regime only.
  ALTER TABLE employees ADD COLUMN declared_deductions INTEGER;
  -- Tax deducted before this app started running payroll mid-year, so the spread over the
  -- remaining months does not re-deduct what another system already took.
  ALTER TABLE employees ADD COLUMN opening_tds INTEGER;

  ALTER TABLE payroll_lines ADD COLUMN tds INTEGER NOT NULL DEFAULT 0;
  `,

  // 26 — the item master, made worth typing into.
  //
  // A code, because at a counter nobody types "Parle-G Biscuit 200g" — they type the six
  // characters printed on the shelf label, and the picker should find it on the first one.
  //
  // An alternate unit, because a trade buys in boxes and sells in pieces. Stock is always kept in
  // the base unit (the small one, or a part box becomes unrepresentable); the alternate is a
  // named multiple that entry accepts and converts. The conversion is in thousandths so
  // "1 box = 12 pieces" is 12000 and no float ever touches a quantity.
  //
  // GST rate and HSN on the group, inherited by items that do not state their own. A trade with
  // two hundred items in one tax band should set the band once, and NULL on the item is the only
  // way to say "whatever the group says" — a copied-down value silently stops following it.
  `
  ALTER TABLE stock_items ADD COLUMN code TEXT;
  CREATE UNIQUE INDEX idx_stock_items_code ON stock_items(code) WHERE code IS NOT NULL;

  ALTER TABLE stock_items ADD COLUMN alt_unit_id INTEGER REFERENCES units(id);
  -- Base units in one alternate unit, thousandths. NULL when there is no alternate.
  ALTER TABLE stock_items ADD COLUMN alt_conversion_milli INTEGER;

  ALTER TABLE stock_groups ADD COLUMN gst_rate REAL;
  ALTER TABLE stock_groups ADD COLUMN cess_rate REAL;
  ALTER TABLE stock_groups ADD COLUMN hsn TEXT;
  `,

  // 27 — MSME classification, for section 43B(h).
  //
  // Since FY 2023-24 a sum payable to a micro or small enterprise beyond the section 15 limit is
  // not deductible in that year at all — it is allowed only in the year it is actually paid. The
  // books already know what is unpaid and for how long; what they could not know is which
  // suppliers are covered, because that is a fact about the supplier, not about the invoice.
  //
  // NULL is deliberately distinct from 'not_registered'. An unclassified supplier is not a
  // supplier outside 43B(h) — it is one nobody has asked yet, and the report says so rather than
  // quietly treating silence as an exemption.
  `
  -- 'micro' | 'small' | 'medium' | 'not_registered'. NULL = never asked.
  ALTER TABLE ledgers ADD COLUMN msme_status TEXT;
  ALTER TABLE ledgers ADD COLUMN udyam_number TEXT;
  `,

  // 28 — the fixed asset register.
  //
  // "Fixed Assets" existed here as a ledger group and nothing else: the books recorded that four
  // lakh of machinery was bought and nothing recorded what the machinery was, when it was put to
  // use, or what it is worth now. Every year-end needs all three.
  //
  // Two schedules, because the law asks for two different numbers. The Companies Act depreciates
  // per asset over a useful life, pro-rated from the day it was put to use. The Income-tax Act
  // pools assets into blocks by rate and charges half in the first year if it was used for fewer
  // than 180 days. They disagree on purpose, and the difference is a deferred tax somebody has to
  // see — so both are stored per asset per year rather than one being derived from the other.
  `
  CREATE TABLE asset_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    -- Written-down-value rate under the Income-tax Act, whole percent.
    it_rate REAL NOT NULL
  );

  CREATE TABLE fixed_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT,
    block_id INTEGER REFERENCES asset_blocks(id),
    -- The ledger the asset's cost sits in, so the register can be reconciled to the books.
    ledger_id INTEGER REFERENCES ledgers(id),
    purchase_date TEXT NOT NULL,
    -- Depreciation starts here, not at purchase. An asset in a crate is not in use.
    put_to_use_date TEXT,
    cost INTEGER NOT NULL,
    -- Schedule II caps this at 5% of cost; a company may assume less.
    residual_value INTEGER NOT NULL DEFAULT 0,
    useful_life_months INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT 'slm' CHECK (method IN ('slm','wdv')),
    location TEXT,
    notes TEXT,
    disposed_on TEXT,
    disposal_proceeds INTEGER,
    disposal_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_fixed_assets_block ON fixed_assets(block_id);
  CREATE UNIQUE INDEX idx_fixed_assets_code ON fixed_assets(code) WHERE code IS NOT NULL;

  CREATE TABLE depreciation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fy_start_year INTEGER NOT NULL UNIQUE,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE depreciation_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES depreciation_runs(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
    opening_wdv INTEGER NOT NULL,
    -- Companies Act charge for the year, per asset.
    depreciation INTEGER NOT NULL,
    closing_wdv INTEGER NOT NULL,
    UNIQUE (run_id, asset_id)
  );
  CREATE INDEX idx_depreciation_lines_asset ON depreciation_lines(asset_id);
  `,

  // 29 — related parties, and the LUT an exporter supplies under.
  //
  // A related-party disclosure is a schedule every audited entity has to produce and nothing here
  // could answer: the books know every transaction with a ledger, and only a person knows whether
  // that ledger is a director, a relative, or a company under common control. One flag and a
  // relationship, and the report writes itself.
  //
  // The LUT is annual, expires on 31 March whenever it was filed, and an expired one silently
  // turns a zero-rated export into a taxable supply. Stored per financial year rather than as a
  // single current value, because "which LUT covered this invoice" is a question that gets asked
  // a year later.
  `
  ALTER TABLE ledgers ADD COLUMN related_party INTEGER NOT NULL DEFAULT 0;
  -- Free text: 'Director', 'Relative of director', 'Company under common control', …
  ALTER TABLE ledgers ADD COLUMN relationship TEXT;

  CREATE TABLE luts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    arn TEXT NOT NULL,
    -- Financial year start: 2026 means FY 2026-27.
    fy_start_year INTEGER NOT NULL UNIQUE,
    filed_on TEXT NOT NULL
  );
  `,

  // 30 — assets that existed before this app did, and the tax written-down value.
  //
  // Two gaps found in review, both of which make the register wrong for every real adopter.
  //
  // A business installing this in 2026 owns a machine bought in 2018. Without an opening
  // accumulated figure the first schedule computes depreciation off full cost and reports a book
  // value years out of date — wrong on day one for exactly the users a launch targets.
  //
  // And the income-tax block has its own written-down value, which rolls forward at the block's
  // own rate. Deriving it from the Companies Act charge (the only depreciation stored until now)
  // is wrong from the second year and compounds annually, because the two schedules depreciate at
  // different rates by design.
  `
  -- Companies Act depreciation charged before this app started keeping the register.
  ALTER TABLE fixed_assets ADD COLUMN opening_accumulated INTEGER NOT NULL DEFAULT 0;
  -- The asset's share of its block's written-down value when it was brought on to the register.
  -- NULL means "cost", which is right for an asset bought after the app was installed.
  ALTER TABLE fixed_assets ADD COLUMN opening_tax_wdv INTEGER;

  -- The income-tax charge per asset per year, so the block rolls forward on its own rate rather
  -- than on the books'. Stored beside the Companies Act charge, never derived from it.
  ALTER TABLE depreciation_lines ADD COLUMN tax_depreciation INTEGER NOT NULL DEFAULT 0;
  `,

  // 31 — how each bank writes its statement, and what the user taught us about narrations.
  //
  // Two tables, both about the same hour of work: the one spent every month turning a CSV nobody
  // designed for us into reconciled entries.
  //
  // A statement profile is the shape of one bank's export — which header holds the narration, how
  // the dates are written, whether direction is two columns or a flag. The built-in five ship as
  // code (src/shared/bankImport.ts) because they are facts about banks, not user data; this table
  // is only for the ones a user maps by hand. The column map is one JSON blob on purpose: it is
  // the profile's own vocabulary, and no query will ever filter on "which column held the
  // balance".
  //
  // The narration memory is the other half. When a user matches a statement line to a ledger, the
  // significant words of that narration are remembered against it, so the next month's identical
  // remark can be offered back. `hits` is the whole safety mechanism: it separates "seen once"
  // from "seen every month for a year", and the confidence the suggestion is offered with is
  // computed from it. UNIQUE on the triple, because the same word learned twice is evidence, not
  // a second row.
  `
  CREATE TABLE bank_import_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    date_format TEXT NOT NULL DEFAULT 'dmy' CHECK (date_format IN ('dmy','mdy','ymd')),
    convention TEXT NOT NULL CHECK (convention IN ('debit_credit','signed','flagged')),
    -- Cell text that means "money out" under the 'flagged' convention, e.g. 'DR'.
    debit_flag TEXT,
    -- { date, narration, reference, debit, credit, amount, drCr, balance } → header text.
    columns_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE bank_narration_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    -- Direction is part of the key: a name learned from payments says nothing about a deposit
    -- with the same wording, which is usually a refund and belongs somewhere else.
    kind TEXT NOT NULL CHECK (kind IN ('payment','receipt')),
    hits INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (keyword, ledger_id, kind)
  );
  CREATE INDEX idx_bank_narration_keyword ON bank_narration_memory(keyword);
  `,

  // 32 — freight, insurance and duty that belong in the cost of the goods.
  //
  // Money paid to get a purchase to the door is part of what those goods cost. Left sitting in an
  // expense ledger it makes closing stock too low and gross margin too high, and every price set
  // off that margin is wrong in the same direction.
  //
  // A row here does NOT post anything: the charge is already an ordinary debit line on the
  // purchase voucher. What is recorded is the instruction to carry that line's money into the
  // value of the item lines, and on which basis — by value (insurance, duty, commission) or by
  // quantity (freight, handling). The valuation engine reads these the same way it already reads
  // a stock journal's additional costs.
  `
  CREATE TABLE landed_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    -- The expense ledger the charge is posted to on this very voucher. Kept so the allocation can
    -- be checked against a real line rather than being a number somebody typed.
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    -- Paise, always positive.
    amount INTEGER NOT NULL,
    basis TEXT NOT NULL CHECK (basis IN ('value','qty')),
    line_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_landed_costs_voucher ON landed_costs(voucher_id);
  `,

  // 33 — saved report views, and reports written on a timer.
  //
  //
  // A saved view is display state and nothing else: which columns, which period, which flags.
  // It is stored in the company database rather than in localStorage because it is a thing a
  // firm agrees on ("open the March view") and a thing that should survive a reinstall, unlike
  // the per-machine column preferences that already live in localStorage.
  //
  // A schedule is a standing instruction, not a daemon. The app is offline and has no background
  // process, so a due schedule is written the next time the company is opened — which is stated
  // on the screen rather than implied. `next_run` rolls forward from the day it actually runs,
  // so three weeks away from the laptop produces today's report, not twenty-one stale ones.
  `
  CREATE TABLE report_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The screen the view belongs to ('trial-balance', 'day-book', ...). Views are never shown
    -- on a screen that cannot restore them.
    screen TEXT NOT NULL,
    name TEXT NOT NULL,
    -- Opaque to the main process: the screen wrote it, the screen reads it back. Validated only
    -- as "is JSON", because a schema here would have to be revised every time a screen gains a
    -- filter, and a stale schema would silently refuse to save the view.
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (screen, name)
  );

  CREATE TABLE report_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report TEXT NOT NULL,
    -- 'mtd' | 'lastMonth' | 'fytd' | 'lastFy' — resolved against the date the run happens.
    period_kind TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('csv', 'xls', 'pdf')),
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    -- NULL means the company's own exports folder. An absolute path elsewhere is allowed so a
    -- firm can point it at a synced folder the accountant also sees.
    folder TEXT,
    next_run TEXT NOT NULL,
    last_run TEXT,
    last_path TEXT,
    -- The last failure, kept so a schedule that silently stopped working can say why.
    last_error TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_report_schedules_due ON report_schedules(active, next_run);
  `,

  // 34 — the counter: a till, a drawer and a walk-in.
  //
  // A kirana, a pharmacy or a hardware shop cannot run the voucher screen at a counter, and that
  // is most of the businesses this app is otherwise right for. What a counter needs that a
  // voucher form does not: a tender (which may be split across cash, card and UPI), a change
  // figure, and a drawer that is opened with a float in the morning and counted at night.
  //
  // The walk-in deliberately leaves no ledger behind. A shop doing two hundred cash sales a day
  // would otherwise accumulate two hundred masters a day and make the party picker unusable
  // within a month, so a counter sale posts straight to cash with the customer's name — if they
  // gave one — recorded against the sale rather than as a master record.
  `
  CREATE TABLE counter_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The business date the till is trading on, which is not always the wall-clock date: a shop
    -- open past midnight is still on yesterday's takings until somebody closes the drawer.
    opened_on TEXT NOT NULL,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    operator TEXT,
    opening_float INTEGER NOT NULL DEFAULT 0,
    -- Which cash ledger the till settles to.
    cash_ledger_id INTEGER REFERENCES ledgers(id),
    closed_at TEXT,
    -- What was physically counted at closing. NULL while the session is open.
    counted_paise INTEGER,
    -- Counted less expected, signed: negative is short. Stored rather than recomputed so a
    -- closed session still reports the variance it was closed on.
    variance_paise INTEGER,
    notes TEXT
  );
  CREATE INDEX idx_counter_sessions_open ON counter_sessions(closed_at);

  CREATE TABLE counter_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES counter_sessions(id) ON DELETE SET NULL,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    -- A walk-in leaves a name on the bill, never a ledger.
    customer_name TEXT,
    customer_phone TEXT,
    change_paise INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','return')),
    -- The sale a return reverses, when the customer still has the receipt.
    returns_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_counter_sales_voucher ON counter_sales(voucher_id);
  CREATE INDEX idx_counter_sales_session ON counter_sales(session_id);

  CREATE TABLE counter_tenders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    counter_sale_id INTEGER NOT NULL REFERENCES counter_sales(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('cash','card','upi','credit')),
    amount INTEGER NOT NULL,
    reference TEXT
  );
  CREATE INDEX idx_counter_tenders_sale ON counter_tenders(counter_sale_id);

  -- Cash in and out of the drawer that is not a sale: a bank drop, the tea money, a float top-up.
  -- Without these the closing count never agrees and the operator learns to ignore the variance,
  -- which is the same as not counting at all.
  CREATE TABLE counter_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES counter_sessions(id) ON DELETE CASCADE,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    kind TEXT NOT NULL CHECK (kind IN ('payin','payout')),
    amount INTEGER NOT NULL,
    reason TEXT,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_counter_movements_session ON counter_movements(session_id);

  -- Quantity-break and scheme discounts. Priced by hand today, and got wrong in the customer's
  -- favour about as often as the reverse.
  CREATE TABLE discount_schemes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- Exactly one of these: a scheme is written for an item or for a group, never both.
    stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE CASCADE,
    stock_group_id INTEGER REFERENCES stock_groups(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('percent','rate','free')),
    -- The slab starts here, in thousandths.
    min_qty_milli INTEGER NOT NULL,
    -- Basis points off, for 'percent'.
    percent_bp INTEGER,
    -- Flat rate per base unit, for 'rate'.
    rate_paise INTEGER,
    -- Units free per min_qty_milli bought, for 'free'.
    free_qty_milli INTEGER,
    from_date TEXT NOT NULL,
    to_date TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX idx_discount_schemes_item ON discount_schemes(stock_item_id);
  CREATE INDEX idx_discount_schemes_group ON discount_schemes(stock_group_id);
  `,

  // 35 — quotation, order and delivery challan.
  //
  // The sale does not start at the invoice. It starts at a quotation, which becomes an order,
  // which is delivered on a challan, which is invoiced. None of the first three is an accounting
  // entry — no money has moved and no liability exists — so they are their own documents rather
  // than memorandum vouchers, and only the last stage posts.
  //
  // Each stage records what it became, and a document that has already been converted refuses to
  // convert again: quoting once and invoicing twice is the failure this chain exists to prevent.
  `
  CREATE TABLE sales_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL CHECK (stage IN ('quotation','order','challan')),
    number TEXT NOT NULL,
    date TEXT NOT NULL,
    -- A quotation often goes to somebody who is not a customer yet, so the party may be a name
    -- rather than a ledger. An order or a challan needs the ledger.
    party_ledger_id INTEGER REFERENCES ledgers(id),
    party_name TEXT,
    -- A quotation that never expires is a price the shop is still held to two years later.
    valid_until TEXT,
    reference TEXT,
    narration TEXT,
    terms TEXT,
    -- The document this one came from, and the one it became. A chain, walkable both ways.
    from_document_id INTEGER REFERENCES sales_documents(id) ON DELETE SET NULL,
    converted_to_id INTEGER REFERENCES sales_documents(id) ON DELETE SET NULL,
    invoice_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    converted_on TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','closed','lost')),
    -- Why a quotation was lost. The only field on this table worth a report of its own.
    closed_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_sales_documents_number ON sales_documents(stage, number);
  CREATE INDEX idx_sales_documents_party ON sales_documents(party_ledger_id);
  CREATE INDEX idx_sales_documents_status ON sales_documents(stage, status);

  CREATE TABLE sales_document_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES sales_documents(id) ON DELETE CASCADE,
    -- NULL for a service line, which a quotation has far more often than an invoice does.
    stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    qty_milli INTEGER NOT NULL,
    rate_paise INTEGER NOT NULL,
    discount_paise INTEGER NOT NULL DEFAULT 0,
    gst_rate REAL,
    hsn TEXT,
    -- Quantity already carried downstream, so an order can be part-delivered on two challans.
    fulfilled_milli INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_sales_document_lines_doc ON sales_document_lines(document_id);
  `,

  // 36 — what the business owes and what it has parked: loans, deposits, projects, prepayments,
  // and the return the bank asks for every month.
  //
  // Every business with a vehicle or a machine has a loan, and every one of them books the whole
  // EMI to the loan account — which leaves the loan balance wrong and the profit overstated by
  // the interest for as long as the loan runs. What was missing was not the arithmetic but a
  // place to record the terms it is computed from.
  //
  // The stock statement is stored rather than recomputed on demand because it is a FILED
  // document: what was sent to the bank in June must still read as it read in June, even after
  // somebody back-dates a purchase invoice into that month.
  `
  CREATE TABLE loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lender TEXT,
    account_number TEXT,
    kind TEXT NOT NULL DEFAULT 'term' CHECK (kind IN ('term','vehicle','machinery','working_capital','other')),
    -- The liability ledger the loan sits in, so the register reconciles to the books.
    ledger_id INTEGER REFERENCES ledgers(id),
    -- Where the interest is charged.
    interest_ledger_id INTEGER REFERENCES ledgers(id),
    principal INTEGER NOT NULL,
    -- Annual rate in basis points: 9.25% p.a. is 925.
    annual_rate_bp INTEGER NOT NULL,
    months INTEGER NOT NULL,
    -- The instalment the sanction letter states. NULL means compute it.
    emi INTEGER,
    disbursed_on TEXT NOT NULL,
    first_instalment_date TEXT NOT NULL,
    notes TEXT,
    closed_on TEXT
  );

  -- Which instalments have actually been posted, so a month is not booked twice and the register
  -- can show what is behind.
  CREATE TABLE loan_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    instalment_no INTEGER NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    posted_on TEXT NOT NULL,
    interest INTEGER NOT NULL,
    principal INTEGER NOT NULL,
    UNIQUE (loan_id, instalment_no)
  );

  -- Security deposits paid and received. Money that is genuinely the business's and is routinely
  -- forgotten — a shop deposit from 2014 that nobody has asked for back.
  CREATE TABLE deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK (direction IN ('paid','received')),
    counterparty TEXT NOT NULL,
    party_ledger_id INTEGER REFERENCES ledgers(id),
    ledger_id INTEGER REFERENCES ledgers(id),
    purpose TEXT,
    amount INTEGER NOT NULL,
    paid_on TEXT NOT NULL,
    -- When it is due back. NULL means "on termination", which is most of them.
    refundable_on TEXT,
    interest_rate_bp INTEGER,
    returned_on TEXT,
    returned_amount INTEGER,
    notes TEXT
  );
  CREATE INDEX idx_deposits_open ON deposits(returned_on);

  -- Capital work in progress: costs accumulate against a project and become an asset on a date.
  -- Today they land in an expense or sit in a ledger nobody revisits.
  CREATE TABLE cwip_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    started_on TEXT NOT NULL,
    ledger_id INTEGER REFERENCES ledgers(id),
    notes TEXT,
    -- Set when the project is capitalised into the fixed asset register.
    capitalised_on TEXT,
    fixed_asset_id INTEGER REFERENCES fixed_assets(id) ON DELETE SET NULL,
    capitalisation_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL
  );

  CREATE TABLE cwip_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES cwip_projects(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    supplier TEXT
  );
  CREATE INDEX idx_cwip_costs_project ON cwip_costs(project_id);

  -- An annual premium amortised across the months it covers, posted monthly, rather than
  -- expensed in April and explained in March. The same table runs the other way for an accrual.
  CREATE TABLE prepaid_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('prepaid','accrued')),
    name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    basis TEXT NOT NULL DEFAULT 'month' CHECK (basis IN ('month','day')),
    expense_ledger_id INTEGER REFERENCES ledgers(id),
    balance_ledger_id INTEGER REFERENCES ledgers(id),
    source_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    notes TEXT
  );

  CREATE TABLE prepaid_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES prepaid_schedules(id) ON DELETE CASCADE,
    -- 'YYYY-MM'.
    month TEXT NOT NULL,
    amount INTEGER NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    posted_on TEXT NOT NULL,
    UNIQUE (schedule_id, month)
  );

  -- The monthly stock statement a cash-credit borrower files, and the drawing power it produces.
  -- Stored as filed: the margins are copied on to the row rather than read from a setting, so a
  -- statement printed a year later shows the arithmetic that was actually sent.
  CREATE TABLE stock_statements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    as_on TEXT NOT NULL UNIQUE,
    stock INTEGER NOT NULL,
    eligible_debtors INTEGER NOT NULL,
    ineligible_debtors INTEGER NOT NULL,
    creditors INTEGER NOT NULL,
    utilised INTEGER NOT NULL,
    stock_margin_percent REAL NOT NULL,
    debtor_margin_percent REAL NOT NULL,
    debtor_age_limit_days INTEGER NOT NULL,
    sanctioned_limit INTEGER NOT NULL,
    drawing_power INTEGER NOT NULL,
    filed_on TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- What a salesperson earns, and on what. Dated, because a rate change is not retrospective.
  CREATE TABLE commission_schemes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salesperson TEXT NOT NULL,
    rate_bp INTEGER NOT NULL,
    basis TEXT NOT NULL DEFAULT 'net_of_tax' CHECK (basis IN ('gross','net_of_tax')),
    from_date TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (salesperson, from_date)
  );
  `,

  // 37 — the audit trail's own signature, permissions with a hole in them, and the entry
  // somebody was halfway through when the power went.
  //
  // The audit log could say it had never been switched off and could not say it had never been
  // rewritten: it is a table in a file in Documents, and sqlite3 is a free download. Each row now
  // carries the hash of its contents chained onto the row before it (services/auditChain.ts).
  // Both columns are nullable because every row already written was written without them, and a
  // row with no hash is evidence of nothing rather than evidence of tampering.
  //
  // Denials are per user and deny-only: the role still sets the ceiling and this cuts areas out
  // of it. There is no grant column on purpose — a grant would let a viewer post entries that the
  // audit trail then attributes to a viewer.
  //
  // A draft is not a voucher. It is deliberately opaque JSON owned by the entry screen: main
  // stores and returns it and never parses it, so a change to the entry form can never leave a
  // draft that main refuses to hand back. One row per person, because "the entry I was in the
  // middle of" is singular.
  `
  ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
  ALTER TABLE audit_log ADD COLUMN row_hash TEXT;

  ALTER TABLE users ADD COLUMN denied_json TEXT;

  CREATE TABLE voucher_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Signed-in user name, or '' when the company has no user accounts at all.
    owner TEXT NOT NULL UNIQUE,
    saved_at TEXT NOT NULL DEFAULT (datetime('now')),
    app_version TEXT,
    payload_json TEXT NOT NULL
  );
  `,

  // 38 — the cost centre a party's transactions belong to by default.
  //
  // Credit days and price level already prefill from the party ledger the moment it is picked.
  // Cost centre was the one party default still typed by hand on every voucher, and it is the
  // one that is invisible when forgotten: a missing due date shows up in the ageing report the
  // same day, whereas an unallocated line just quietly never appears in the branch's P&L.
  //
  // ON DELETE SET NULL, not CASCADE: deleting a cost centre must not delete the party. NULL is
  // the correct residue — "this party no longer has a default", which is exactly true.
  `
  ALTER TABLE ledgers ADD COLUMN default_cost_centre_id INTEGER REFERENCES cost_centres(id) ON DELETE SET NULL;
  `,

  // 39 — the bill in the drawer, the entry that is a decision, and the account number nobody
  // should be able to change alone.
  //
  // (The number is 37, not 33: migrations apply by ARRAY POSITION, and 33–36 are reserved for
  // branches being written in parallel with this one. The label is only a label — what matters
  // is that nothing is ever inserted BEFORE an existing entry, because an existing database has
  // already recorded how many it applied and would silently skip the newcomer.)
  //
  // ATTACHMENTS. "Where is the physical bill" is asked every day and the app has had no answer.
  // The file is COPIED into the company folder rather than referenced: a reference is a path,
  // and a path breaks the first time somebody empties Downloads, renames a folder, or restores
  // the books onto another machine — at which point the app confidently shows an attachment that
  // is not there. Copying doubles the disk a scan occupies, and that is the price of the company
  // folder being the whole of the user's data, which is the promise the rest of the app makes.
  // `sha256` is stored so the same scan attached twice is recognised rather than duplicated.
  //
  // APPROVALS. A voucher above a stated amount, entered by an accountant, is a decision rather
  // than a keystroke. `approval_state` is NULL for the overwhelming majority of entries — the
  // threshold is off by default, and an owner's own entry never waits for the owner. A 'pending'
  // voucher is deliberately kept OUT of the books (see IN_BOOKS in services/vouchers.ts) but
  // still visible in the day book to the person who typed it: it exists, it just does not count
  // yet. Rejected is a third state rather than a deletion, because the accountant needs to see
  // why and fix it.
  //
  // IMPORT IDENTITY. `import_key` is the fingerprint of the source voucher in a Tally export
  // (its GUID when the export carries one, otherwise its content). Indexed, NOT unique: a
  // voucher that was imported and then deliberately binned must be importable again, so the
  // duplicate check filters on deleted_at IS NULL rather than the database refusing the insert.
  //
  // BANK DETAILS ON A PARTY. Changing a supplier's account number is the highest-value fraud
  // available in this market and was, until now, not even recordable here. Two things follow:
  // a pending-change table so the change needs a second person (bank_detail_requests), and a
  // shared-account exception (`bank_shared_ok` marks the legitimate case — a proprietor and
  // their firm banking into one account — so the exception report can stay silent about it
  // without going blind to the next one).
  `
  CREATE TABLE voucher_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    -- What the user called it, shown in the UI.
    file_name TEXT NOT NULL,
    -- The name it has inside <company>/attachments/. Unique because it is a filename.
    stored_name TEXT NOT NULL UNIQUE,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    note TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    added_by TEXT
  );
  CREATE INDEX idx_voucher_attachments_voucher ON voucher_attachments(voucher_id);

  ALTER TABLE vouchers ADD COLUMN approval_state TEXT
    CHECK (approval_state IS NULL OR approval_state IN ('pending','approved','rejected'));
  ALTER TABLE vouchers ADD COLUMN approval_by TEXT;
  ALTER TABLE vouchers ADD COLUMN approval_at TEXT;
  ALTER TABLE vouchers ADD COLUMN approval_note TEXT;
  -- Partial: the column is NULL on almost every row, and the only query is "what is waiting".
  CREATE INDEX idx_vouchers_approval ON vouchers(approval_state) WHERE approval_state IS NOT NULL;

  ALTER TABLE vouchers ADD COLUMN import_key TEXT;
  CREATE INDEX idx_vouchers_import_key ON vouchers(import_key) WHERE import_key IS NOT NULL;

  ALTER TABLE ledgers ADD COLUMN bank_account TEXT;
  ALTER TABLE ledgers ADD COLUMN bank_ifsc TEXT;
  -- The name the account is held in. Not the ledger name: "S. Kumar" paying "Kumar Traders" is
  -- the ordinary case, and the mismatch is only worth flagging when a human looks at it.
  ALTER TABLE ledgers ADD COLUMN bank_holder TEXT;
  ALTER TABLE ledgers ADD COLUMN bank_shared_ok INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE bank_detail_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    old_account TEXT, old_ifsc TEXT, old_holder TEXT,
    new_account TEXT, new_ifsc TEXT, new_holder TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
    requested_by TEXT,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by TEXT,
    decided_at TEXT,
    decision_note TEXT
  );
  CREATE INDEX idx_bank_detail_requests_state ON bank_detail_requests(state);
  `,
  // ---- 40. the assistant audit trail (roadmap #217) ----
  //
  // Joins the question to the draft to the voucher that was finally saved. Three reasons this is
  // a table in the company database rather than a log file beside the key:
  //
  //  1. The join. "Which entries in these books came out of a conversation with a model?" is a
  //     question an auditor is entitled to ask, and it can only be answered where the vouchers
  //     are. A voucher_id foreign key answers it; a log file elsewhere cannot.
  //  2. It travels with the books. A CA restoring a client's backup gets the provenance too.
  //  3. It is not the key. The API key stays machine-level, in the keychain, and nothing here
  //     records the endpoint's credentials — only the host and model, which are the parts a
  //     reviewer needs.
  //
  // Nothing in this table is on any read path for a report. It is provenance, not books.
  `
  CREATE TABLE assistant_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    asked_at TEXT NOT NULL DEFAULT (datetime('now')),
    asked_by TEXT,
    question TEXT NOT NULL,
    answer TEXT,
    model TEXT NOT NULL,
    host TEXT NOT NULL,
    local INTEGER NOT NULL DEFAULT 0,
    -- JSON array of tool names, in call order.
    tools TEXT,
    -- How many tool-result fields were quarantined as instruction-shaped (roadmap #221).
    quarantined INTEGER NOT NULL DEFAULT 0,
    -- The proposed voucher as JSON, when the run produced one.
    draft TEXT,
    -- Set when the human saved that draft. ON DELETE SET NULL: deleting a voucher must not
    -- delete the record that a model proposed it.
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    cost_paise INTEGER NOT NULL DEFAULT 0,
    finish TEXT
  );
  CREATE INDEX idx_assistant_runs_at ON assistant_runs(asked_at);
  CREATE INDEX idx_assistant_runs_voucher ON assistant_runs(voucher_id) WHERE voucher_id IS NOT NULL;
  `,

  // 41 — statutory depth: the reverse-charge self-invoice, IMS decisions, and what was filed.
  //
  // (The label is 41, not 40: migrations apply by ARRAY POSITION and 40 is reserved for a branch
  // being written alongside this one. The label is only a label — what matters is that nothing is
  // ever inserted BEFORE an existing entry, because a database that has already applied N resumes
  // at N and would skip the newcomer in silence.)
  //
  // RCM SELF-INVOICES (roadmap #356). Section 31(3)(f) makes the recipient issue the invoice for a
  // reverse-charge inward supply, and the auditor asks to see it. `number` is UNIQUE because it is
  // a serial in a Rule 46(b) series and a duplicate serial is a defective invoice, not a warning.
  // The link table exists rather than a JSON array of voucher ids because the question asked every
  // month is "which reverse-charge purchases still have no self-invoice", and that is a LEFT JOIN
  // against a table, not a scan of a JSON column. ON DELETE CASCADE on the link and not on the
  // document: binning a purchase voucher removes it from the document, but a self-invoice that was
  // issued to satisfy Rule 46 does not stop having existed because the voucher behind it was
  // deleted — that is precisely the case an auditor is looking for.
  //
  // IMS ACTIONS (roadmap #352). Keyed on supplier GSTIN + normalised document number rather than
  // on a voucher, because the rows most in need of a decision are the ones with no voucher at all
  // (filed by the supplier, never recorded here). That key is also what survives re-downloading
  // GSTR-2B: the twelve invoices somebody worked through last week must not come back as
  // undecided. The action is a RECORD of what was done on the portal, not an instruction to it —
  // nothing here can take an IMS action, and the screen says so.
  //
  // FILED SNAPSHOTS (roadmap #353). GSTR-1A carries the difference between what was filed and what
  // the books now say, and without a copy of what was filed there is nothing to difference
  // against. Stored on the filing row as JSON: it is a frozen document, never queried by parts,
  // and the only thing that ever reads it is the amendment diff.
  `
  CREATE TABLE rcm_self_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL UNIQUE,
    doc_date TEXT NOT NULL,
    -- 'unregistered' = section 9(4), 'notified' = section 9(3). Decides which proviso the
    -- document sits under and whether monthly consolidation is available at all.
    basis TEXT NOT NULL CHECK (basis IN ('unregistered','notified')),
    party_ledger_id INTEGER REFERENCES ledgers(id),
    supplier_name TEXT NOT NULL,
    supplier_gstin TEXT,
    place_of_supply TEXT NOT NULL,
    supply_type TEXT NOT NULL CHECK (supply_type IN ('intra','inter')),
    taxable INTEGER NOT NULL DEFAULT 0,
    igst INTEGER NOT NULL DEFAULT 0,
    cgst INTEGER NOT NULL DEFAULT 0,
    sgst INTEGER NOT NULL DEFAULT 0,
    cess INTEGER NOT NULL DEFAULT 0,
    -- The document as issued, so a reprint is the same paper rather than a recomputation.
    doc_json TEXT NOT NULL,
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    issued_by TEXT
  );
  CREATE INDEX idx_rcm_self_invoices_date ON rcm_self_invoices(doc_date);

  CREATE TABLE rcm_self_invoice_vouchers (
    self_invoice_id INTEGER NOT NULL REFERENCES rcm_self_invoices(id) ON DELETE CASCADE,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    PRIMARY KEY (self_invoice_id, voucher_id)
  );
  CREATE INDEX idx_rcm_self_invoice_vouchers_voucher ON rcm_self_invoice_vouchers(voucher_id);

  CREATE TABLE ims_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- '<SUPPLIER GSTIN or NOGSTIN>|<normalised document number>' — see imsKey in shared/gst/ims.ts.
    doc_key TEXT NOT NULL UNIQUE,
    period TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('accept','reject','pending')),
    note TEXT,
    decided_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by TEXT
  );
  CREATE INDEX idx_ims_actions_period ON ims_actions(period);

  ALTER TABLE gst_filings ADD COLUMN docs_json TEXT;
  `,

  // 42 — dated rates, and the facts a TDS return needs that the books never held.
  //
  // ITEM RATE HISTORY (roadmap #358). `stock_items.gst_rate` is a single number, which was fine
  // until 22 September 2025 made the same item carry two different rates either side of a date.
  // The master column stays — it is what voucher entry prefills and what an unchanged item still
  // answers with — and this table records the changes. A credit note issued in 2026 against a 2025
  // invoice carries the ORIGINAL rate (section 34 read with section 15: a note adjusts the supply
  // it refers to), which is only answerable from a dated history.
  //
  // TDS CHALLANS (roadmap #360). A quarterly statement is built challan by challan: the BSR code
  // of the branch, the date, the serial the bank gave it, and under each one the deductees it
  // paid for. None of that was recorded anywhere, which is the actual reason a business pays
  // somebody else to file. `challan_id` on tds_entries is the link, nullable because a deduction
  // exists from the moment it is posted and the challan is paid later — an unlinked deduction is
  // a normal state for a few weeks and a blocking issue at filing time, which is exactly what
  // validateReturn says.
  //
  // 2025 ACT SECTIONS (roadmap #359). `code` holds the Income-tax Act 1961 section. From 1 April
  // 2026 the same deduction is made under the Income-tax Act 2025 and a certificate has to carry
  // that number instead. Both are kept, the voucher date decides which is printed, and the column
  // is NULL until a user fills it in — because the app's own proposed mapping is unverified and
  // must not be silently written into anyone's books. See src/shared/itAct2025.ts.
  `
  CREATE TABLE stock_item_gst_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    gst_rate REAL NOT NULL,
    cess_rate REAL NOT NULL DEFAULT 0,
    -- The user's own citation: the notification, the Council meeting, "as advised by our CA".
    note TEXT,
    UNIQUE (stock_item_id, effective_from)
  );

  CREATE TABLE tds_challans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- '24Q' or '26Q'. A challan is paid for one form's liability.
    form TEXT NOT NULL CHECK (form IN ('24Q','26Q')),
    -- Seven-digit Bank Branch Serial code. Empty for a book-adjustment entry.
    bsr_code TEXT NOT NULL DEFAULT '',
    paid_on TEXT NOT NULL,
    serial TEXT NOT NULL DEFAULT '',
    tax INTEGER NOT NULL DEFAULT 0,
    surcharge INTEGER NOT NULL DEFAULT 0,
    cess INTEGER NOT NULL DEFAULT 0,
    interest INTEGER NOT NULL DEFAULT 0,
    fee INTEGER NOT NULL DEFAULT 0,
    book_entry INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );
  CREATE INDEX idx_tds_challans_paid_on ON tds_challans(paid_on);

  ALTER TABLE tds_entries ADD COLUMN challan_id INTEGER REFERENCES tds_challans(id) ON DELETE SET NULL;
  CREATE INDEX idx_tds_entries_challan ON tds_entries(challan_id);

  ALTER TABLE tds_sections ADD COLUMN code_2025 TEXT;
  `,

  // 40 — pay cycles that are not a month (roadmap #179).
  //
  // Payroll assumed a month everywhere: one run per month, keyed by a UNIQUE month string. A
  // factory paying its floor weekly and its office monthly could not be run in this app at all.
  //
  // The hard part was never the arithmetic. PF's wage ceiling, ESI's gross limit, every state's
  // professional-tax slab and TDS under section 192 are all defined PER MONTH. Computing each of
  // them afresh on a week's wages does not produce a quarter of the monthly figure — it produces
  // a number that is wrong, and wrong in the direction the employee discovers years later when
  // EPFO's passbook does not match their payslips.
  //
  // So a run now carries the statutory month it accrues to alongside its own period. The month is
  // the unit the statutory computation runs on; the period is the unit the money moves on. A run
  // is identified by (cycle, period_start) rather than by month, which is what the UNIQUE had to
  // go for.
  //
  // The table is rebuilt because SQLite cannot drop a UNIQUE constraint. Its two children are
  // emptied into plain copies first: DROP TABLE runs ON DELETE CASCADE, and foreign_keys cannot
  // be turned off from inside the transaction a migration runs in.
  `
  ALTER TABLE employees ADD COLUMN pay_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (pay_cycle IN ('monthly','fortnightly','weekly'));

  CREATE TABLE payroll_runs_bak AS SELECT * FROM payroll_runs;
  CREATE TABLE payroll_lines_bak AS SELECT * FROM payroll_lines;
  CREATE TABLE loan_recoveries_bak AS SELECT * FROM loan_recoveries;
  DELETE FROM payroll_lines;
  DELETE FROM loan_recoveries;
  DROP TABLE payroll_runs;

  CREATE TABLE payroll_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The statutory month the run accrues to, 'YYYY-MM'. A weekly period that straddles a month
    -- end belongs to the month its LAST day falls in: wages accrue as the period closes.
    month TEXT NOT NULL,
    cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','fortnightly','weekly')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (cycle, period_start)
  );
  INSERT INTO payroll_runs (id, month, cycle, period_start, period_end, voucher_id, created_at)
    SELECT id, month, 'monthly', month || '-01',
           date(month || '-01', '+1 month', '-1 day'), voucher_id, created_at
    FROM payroll_runs_bak;

  INSERT INTO payroll_lines SELECT * FROM payroll_lines_bak;
  INSERT INTO loan_recoveries SELECT * FROM loan_recoveries_bak;
  DROP TABLE payroll_runs_bak;
  DROP TABLE payroll_lines_bak;
  DROP TABLE loan_recoveries_bak;

  CREATE INDEX idx_payroll_runs_month ON payroll_runs(month);
  `,

  // 41 — CMA data for a working-capital application (roadmap #371).
  //
  // Three tables and a boundary. `cma_packs` pins which five financial years a pack covers, so a
  // pack submitted to a bank in March still reads in June as it read when it was submitted.
  //
  // `cma_inputs` holds ONLY the figures the user typed. The audited columns are never stored:
  // they are recomputed from the books every time the pack is opened, because the books are what
  // the bank's own verification will be run against. Storing a copy would let the pack and the
  // ledgers drift apart silently, and the pack is the one that would be wrong.
  //
  // A row exists here for exactly the cells a person asserted. That is what makes it possible for
  // the screen to show a projection column as blank rather than as a column of confident zeros —
  // a CMA pack that prints zeros for a year that does not exist is a pack that gets refused.
  `
  CREATE TABLE cma_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- FY start year of the CURRENT-YEAR ESTIMATE column. The two audited years count back from
    -- it and the two projections count forward.
    estimate_fy_start_year INTEGER NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE cma_inputs (
    pack_id INTEGER NOT NULL REFERENCES cma_packs(id) ON DELETE CASCADE,
    column_key TEXT NOT NULL CHECK (column_key IN ('a2','a1','e','p1','p2')),
    line_key TEXT NOT NULL,
    -- Integer paise, like every other amount in this database.
    value INTEGER NOT NULL,
    PRIMARY KEY (pack_id, column_key, line_key)
  );

  CREATE TABLE cma_facilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id INTEGER NOT NULL REFERENCES cma_packs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    facility TEXT NOT NULL,
    existing_limit INTEGER NOT NULL DEFAULT 0,
    proposed_limit INTEGER NOT NULL DEFAULT 0,
    -- Typed. NULL when a ledger is linked, in which case the books answer instead.
    outstanding INTEGER,
    ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    security TEXT,
    notes TEXT
  );
  CREATE INDEX idx_cma_facilities_pack ON cma_facilities(pack_id);
  `,

  // 40 — the cheque that came back, the entry worth keeping a shape of, and the part of a batch
  // that was never going to survive the process.
  `
  -- BOUNCED CHEQUES (#138). A returned cheque is two facts, and only one of them is accounting:
  -- the reversal voucher restores the money, but "this customer's cheque bounced in June" is a
  -- fact about the customer that the reversal alone cannot be read back out of — a journal
  -- reversing a receipt looks identical to a journal correcting a keying error.
  --
  -- So the event is recorded: which receipt/payment came back, which voucher reversed it, on
  -- what date, and the bank's own charge if one was levied. UNIQUE on voucher_id because a
  -- cheque bounces once; a re-presented cheque that bounces again is a new receipt.
  CREATE TABLE cheque_bounces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE CASCADE,
    reversal_voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    bounce_date TEXT NOT NULL,
    reason TEXT,
    -- Paise. 0 when the bank charged nothing, which does happen on an own-cheque return.
    charge_amount INTEGER NOT NULL DEFAULT 0 CHECK (charge_amount >= 0),
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_cheque_bounces_date ON cheque_bounces(bounce_date);
  CREATE INDEX idx_cheque_bounces_reversal ON cheque_bounces(reversal_voucher_id);

  -- VOUCHER TEMPLATES (#27). recurring_templates already stores a voucher shape, but its
  -- cadence and next_due are NOT NULL: it is a schedule that happens to carry a shape. A
  -- template is the shape without the schedule — the monthly rent journal you post when the
  -- landlord asks rather than on the 1st — and forcing it into a cadence would put entries on
  -- the books nobody asked for.
  CREATE TABLE voucher_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id),
    voucher_json TEXT NOT NULL,
    -- Ordering hint for the picker: most-used first beats alphabetical for something typed daily.
    used_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_voucher_templates_type ON voucher_templates(voucher_type_id);

  -- BOM SCRAP AND YIELD (#125). Both are needed and they are not the same number.
  --
  -- Scrap is per component: cutting 100 shirts from cloth wastes cloth, and the wastage belongs
  -- to that component's issue quantity, not to the others. Yield is per finished item: of 100
  -- units started, 97 pass inspection, and that inflates EVERY component equally.
  --
  -- Stored in hundredths of a percent so 2.5% is 250 and no float touches a quantity. Scrap
  -- defaults to 0 and yield to 10000 (=100.00%), which is exactly today's behaviour, so every
  -- existing BOM keeps producing the numbers it produced yesterday.
  ALTER TABLE bom_lines ADD COLUMN scrap_bp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE stock_items ADD COLUMN bom_yield_bp INTEGER NOT NULL DEFAULT 10000;
  `,

  // 42 — the inventory lane's last five, and the foreign-currency bank account.
  //
  // One migration rather than five because they land together and a database that has three of
  // them is a database nobody ever had.
  `
  -- SERIAL NUMBERS (#115). A batch answers "which lot"; a serial answers "where is THAT one" —
  -- the engine number, the IMEI, the compressor on the warranty card.
  --
  -- Two tables, because a serial is not a field on a movement: it is a thing with a history, and
  -- the questions asked of it months later are all about dates ("was this in stock in March",
  -- "what did we pay for it"). So the MOVEMENTS are stored and the status is derived from the
  -- latest one. A a status column would be a second copy of a fact the movements already carry,
  -- and the two would disagree the first time a voucher was altered.
  --
  -- serial is NOCASE-unique per item and not globally: two manufacturers genuinely do stamp the
  -- same number on different things, and a global unique index would refuse the second one for a
  -- reason the user cannot act on. original_text keeps what was typed, for the warranty card.
  CREATE TABLE serial_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    serial TEXT NOT NULL COLLATE NOCASE,
    original_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (stock_item_id, serial)
  );

  -- ON DELETE CASCADE from the voucher: a purged voucher's serial movements are not history, they
  -- are a record of an entry that no longer exists, and leaving them would make a serial look
  -- issued to an invoice nobody can open.
  CREATE TABLE serial_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_id INTEGER NOT NULL REFERENCES serial_numbers(id) ON DELETE CASCADE,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    moved_on TEXT NOT NULL,
    -- Paise per unit at the time, so "what did this one cost" is answerable without re-deriving a
    -- weighted average that has moved on since.
    rate_paise INTEGER NOT NULL DEFAULT 0,
    party_ledger_id INTEGER REFERENCES ledgers(id) ON DELETE SET NULL,
    godown_id INTEGER REFERENCES godowns(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_serial_movements_serial ON serial_movements(serial_id, moved_on);
  CREATE INDEX idx_serial_movements_voucher ON serial_movements(voucher_id);

  -- Nullable-free: an item either tracks serials or it does not, and every item that existed
  -- before this migration did not.
  ALTER TABLE stock_items ADD COLUMN track_serials INTEGER NOT NULL DEFAULT 0;

  -- ITEM IMAGES (#119). The NAME of a file in <company>/item-images/, never the bytes. Images do
  -- not go in the database: a company.db carrying two hundred product photographs is a database
  -- that is copied, backed up and integrity-checked at forty times its real size, and the folder
  -- is the unit a user syncs anyway. Same rule as attachments, same reasons — see
  -- src/shared/itemImages.ts.
  ALTER TABLE stock_items ADD COLUMN image_name TEXT;

  -- STANDARD COSTING (#118). Dated data, not a column on the item: a standard revised in October
  -- must leave September's variance report saying what it said in September. UNIQUE on
  -- (item, date) so revising the same day's standard twice corrects it rather than stacking.
  CREATE TABLE standard_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    -- Paise per whole unit.
    standard_cost INTEGER NOT NULL CHECK (standard_cost >= 0),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (stock_item_id, effective_from)
  );

  -- JOB WORK (#127). Goods sent out for processing are NOT a sale: title never leaves the
  -- principal, so nothing is posted to the books and the stock moves to a godown named for the
  -- job worker. The voucher that does the moving is a stock journal, and voucher_id points at
  -- it, so the challan and the stock can never disagree about what went out.
  --
  -- goods_type decides the section 143 clock (one year for inputs, three for capital goods) and
  -- is stored rather than inferred: the same item can be sent as an input on Monday and as a
  -- capital good on Friday, and getting it wrong moves a statutory deadline by two years.
  CREATE TABLE job_work_challans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    godown_id INTEGER NOT NULL REFERENCES godowns(id),
    challan_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sent_on TEXT NOT NULL,
    goods_type TEXT NOT NULL CHECK (goods_type IN ('input','capital')),
    nature_of_processing TEXT,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_job_work_challans_party ON job_work_challans(party_ledger_id, sent_on);

  CREATE TABLE job_work_challan_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challan_id INTEGER NOT NULL REFERENCES job_work_challans(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    -- The value the goods went out at. Not a price: nothing is being sold. It is what the challan
    -- has to declare, and what the deemed supply under 143(3) would be taxed on.
    rate_paise INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_job_work_challan_lines_challan ON job_work_challan_lines(challan_id);

  CREATE TABLE job_work_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    challan_id INTEGER NOT NULL REFERENCES job_work_challans(id) ON DELETE CASCADE,
    received_on TEXT NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_job_work_returns_challan ON job_work_returns(challan_id);

  -- kind separates waste from goods because section 143(5) does: waste and scrap generated at
  -- the job worker's premises may be supplied by the job worker directly, and counting it as goods
  -- that failed to come back would leave every challan looking short by the scrap percentage.
  CREATE TABLE job_work_return_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL REFERENCES job_work_returns(id) ON DELETE CASCADE,
    stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
    qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
    kind TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods','waste'))
  );
  CREATE INDEX idx_job_work_return_lines_return ON job_work_return_lines(return_id);

  -- MULTI-CURRENCY BANK ACCOUNTS AND REVALUATION (#140).
  --
  -- Three columns and a table, and each one exists because the alternative loses a fact.
  --
  -- ledgers.currency_code is what makes an account foreign. Without it there is nothing to
  -- revalue: a rupee figure alone cannot say how many dollars it was, and dividing it back out by
  -- today's rate invents a different dollar balance every day.
  --
  -- voucher_lines.fc_amount is the foreign amount as it was agreed — USD 1,200.00 stays USD
  -- 1,200.00 forever. voucher_lines.fc_rate_micro is the rate that was USED, recorded on the
  -- entry that used it rather than looked up again later, which is the whole point: a March
  -- revaluation has to keep saying March's rate in June. Micro-units (millionths of a rupee per
  -- one foreign unit) because a rate is not money and rounding it to paise before use would put
  -- the error into every amount computed from it. See src/shared/fx.ts.
  ALTER TABLE ledgers ADD COLUMN currency_code TEXT REFERENCES currencies(code);
  ALTER TABLE voucher_lines ADD COLUMN fc_amount INTEGER;
  ALTER TABLE voucher_lines ADD COLUMN fc_rate_micro INTEGER;

  -- One row per account per period end. UNIQUE so a period cannot be revalued twice and post the
  -- difference twice; the second run corrects the first by being refused, not by adding to it.
  CREATE TABLE fx_revaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    as_on TEXT NOT NULL,
    currency_code TEXT NOT NULL,
    closing_rate_micro INTEGER NOT NULL CHECK (closing_rate_micro > 0),
    -- All signed dr-positive, like every balance in this database.
    fc_minor INTEGER NOT NULL,
    book_paise INTEGER NOT NULL,
    restated_paise INTEGER NOT NULL,
    difference_paise INTEGER NOT NULL,
    voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ledger_id, as_on)
  );
  CREATE INDEX idx_fx_revaluations_as_on ON fx_revaluations(as_on);
  `
]
