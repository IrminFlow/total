/**
 * The audit trail's stable vocabulary — every `entity` and `action` value the app ever writes to
 * audit_log. Single source of truth for the edit-log report filters (renderer) and the write
 * side (src/main/services/audit.ts re-exports these). Kept in src/shared because the renderer
 * can't import main-process modules.
 *
 * When adding a writeAudit call with a NEW entity string, add it here too —
 * src/main/auditCoverage.dbtest.ts scans every writeAudit call site and fails on an entity that
 * is not listed, and also fails when a new write IPC channel has no entry in
 * src/main/auditCoverage.ts (WP 3.8: the MCA edit log may not silently skip a write path).
 *
 * Entries are never removed: old rows keep their entity forever (e.g. 'recurring_template',
 * whose feature was removed in 0.5.0).
 */
export const AUDIT_ENTITIES = [
  'audit_log',
  'backup',
  'bank_import_profile',
  'bank_learned_rule',
  'bank_rule',
  'bank_statement',
  'bank_statement_line',
  'batch',
  'bom',
  'budget',
  'ca_asset_class',
  'cheque',
  'cheque_book',
  'cheque_config',
  'company',
  'costCentre',
  'counter_sale',
  'csv_import',
  'currency',
  'depreciation_run',
  'discountScheme',
  'employee',
  'export',
  'fixed_asset',
  'fixed_asset_group',
  'forecast_item',
  'fx_ledger_currency',
  'fx_rate',
  'fx_revaluation',
  'fx_settlement',
  'godown',
  'group',
  'gst_ims',
  'gst_self_invoice',
  'held_bill',
  'it_block',
  'it_block_rate',
  'job_work',
  'ledger',
  'loan',
  'manufacture',
  'migration',
  'msme_bank_rate',
  'nic_credentials',
  'partyRate',
  'pay_head',
  'payment_batch',
  'payment_run',
  'payment_template',
  'payroll_run',
  'pdc',
  'priceLevel',
  'priceRate',
  'recurring_template',
  'statutory_payment',
  'statutory_rate',
  'stockGroup',
  'stockItem',
  'tally_import',
  'tcsEntry',
  'tcsExemption',
  'tdsCertificate',
  'tdsChallan',
  'tdsEntry',
  'tdsExemption',
  'tdsRate',
  'tdsSection',
  'trade_doc',
  'tradeDocType',
  'unit',
  'user',
  'voucher',
  'voucher_line',
  'voucherType',
  'year_end',
  // WP 4.2 receivables
  'bill_followup',
  'credit_hold',
  'credit_override',
  'interest_charge',
  'reminder',
  // WP 6.4 bulk edit, attachments, party notes / tasks
  'attachment',
  'bulk_batch',
  'party_note'
] as const

export type AuditEntity = (typeof AUDIT_ENTITIES)[number]

/**
 * Every audit_log action. Mirrors migration 031's CHECK (017's set plus 'restore' — a voucher
 * or trade document back from the bin, or a company restored from a backup — 'purge' — a
 * permanent delete from the bin — 'backup' and 'prune' — the retention job removing rows, which
 * the default `auditTrailRequired` setting never does).
 */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'restore',
  'purge',
  'login',
  'login_failed',
  'logout',
  'export',
  'import',
  'backup',
  'prune'
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** Human labels for the report's entity column/filter; anything missing falls back to the raw key. */
export const AUDIT_ENTITY_LABELS: Partial<Record<AuditEntity, string>> = {
  audit_log: 'Audit log',
  backup: 'Backup',
  bank_import_profile: 'Bank statement mapping',
  bank_learned_rule: 'Learned bank rule',
  bank_rule: 'Bank rule',
  bank_statement_line: 'Bank statement line',
  cheque: 'Cheque',
  cheque_book: 'Cheque book',
  pdc: 'Post-dated cheque',
  payment_batch: 'Bulk payment file',
  payment_template: 'Bulk payment template',
  bank_statement: 'Bank statement',
  batch: 'Batch',
  bom: 'Bill of materials',
  budget: 'Budget',
  ca_asset_class: 'Asset class (Companies Act)',
  cheque_config: 'Cheque layout',
  company: 'Company settings',
  costCentre: 'Cost centre',
  counter_sale: 'Counter sale',
  discountScheme: 'Discount scheme',
  held_bill: 'Held counter bill',
  partyRate: 'Party rate',
  csv_import: 'CSV import',
  currency: 'Currency',
  depreciation_run: 'Depreciation run',
  employee: 'Employee',
  export: 'Export',
  fixed_asset: 'Fixed asset',
  fixed_asset_group: 'Asset group',
  forecast_item: 'Cash forecast item',
  fx_ledger_currency: 'Ledger currency',
  fx_rate: 'Exchange rate',
  fx_revaluation: 'Forex revaluation',
  fx_settlement: 'Forex settlement',
  godown: 'Godown',
  group: 'Group',
  gst_ims: 'GST IMS action',
  gst_self_invoice: 'RCM self-invoice',
  it_block: 'IT Act block',
  it_block_rate: 'IT Act block rate',
  job_work: 'Job work challan',
  ledger: 'Ledger',
  loan: 'Loan',
  manufacture: 'Manufacture',
  migration: 'Database migration',
  nic_credentials: 'NIC credentials',
  pay_head: 'Pay head',
  payroll_run: 'Pay run',
  priceLevel: 'Price level',
  priceRate: 'Price rate',
  recurring_template: 'Recurring template',
  statutory_payment: 'Statutory payment',
  statutory_rate: 'Statutory rate',
  stockGroup: 'Stock group',
  stockItem: 'Stock item',
  tally_import: 'Tally import',
  tcsEntry: 'TCS entry',
  tcsExemption: 'TCS not-applicable mark',
  tdsCertificate: 'TDS/TCS certificate',
  tdsChallan: 'TDS/TCS challan',
  tdsEntry: 'TDS entry',
  tdsExemption: 'TDS not-applicable mark',
  tdsRate: 'TDS/TCS rate',
  tdsSection: 'TDS/TCS section',
  trade_doc: 'Order / quotation',
  tradeDocType: 'Order series',
  unit: 'Unit',
  user: 'User',
  voucher: 'Voucher',
  voucher_line: 'Voucher line',
  voucherType: 'Voucher type',
  year_end: 'Year-end close',
  bill_followup: 'Bill follow-up',
  credit_hold: 'Credit hold',
  credit_override: 'Credit-hold override',
  interest_charge: 'Interest charge',
  reminder: 'Payment reminder',
  attachment: 'Attachment',
  bulk_batch: 'Bulk edit',
  party_note: 'Party note / task'
}

export const auditEntityLabel = (entity: string): string => AUDIT_ENTITY_LABELS[entity as AuditEntity] ?? entity

/** 'os:irmin' → 'irmin (OS login)'; null (rows from before user attribution) → 'unknown'. */
export const auditUserLabel = (u: string | null): string =>
  u === null ? 'unknown' : u.startsWith('os:') ? `${u.slice(3)} (OS login)` : u

export const auditActionLabel = (a: string): string => (a.charAt(0).toUpperCase() + a.slice(1)).replace(/_/g, ' ')

/** Entities whose rows belong to one voucher: the report's voucher filter matches these by
 *  entity_id, and every other entity by a `voucherId` field in its before/after JSON. */
export const VOUCHER_ENTITIES: readonly AuditEntity[] = ['voucher', 'manufacture', 'job_work', 'gst_self_invoice', 'counter_sale', 'credit_override']
