/**
 * Every `entity` value the app ever writes to audit_log — the single source of truth for the
 * Settings → Audit trail entity filter (and re-exported by src/main/services/audit.ts, which
 * owns the write side). Kept in src/shared because the renderer can't import main-process
 * modules; when adding a writeAudit call with a NEW entity string, add it here too.
 *
 * Derived from the writeAudit call sites across src/main/services/*.ts and src/main/ipc.ts.
 */
export const AUDIT_ENTITIES = [
  'bank_rule',
  'bank_statement',
  'batch',
  'bom',
  'budget',
  'ca_asset_class',
  'cheque_config',
  'company',
  'costCentre',
  'currency',
  'depreciation_run',
  'employee',
  'export',
  'fixed_asset',
  'fixed_asset_group',
  'godown',
  'group',
  'it_block',
  'it_block_rate',
  'job_work',
  'ledger',
  'manufacture',
  'nic_credentials',
  'pay_head',
  'payroll_run',
  'priceLevel',
  'priceRate',
  'recurring_template',
  'statutory_payment',
  'statutory_rate',
  'stockGroup',
  'stockItem',
  'tally_import',
  'tdsCertificate',
  'tdsChallan',
  'tdsEntry',
  'tdsExemption',
  'tdsRate',
  'tdsSection',
  'tradeDocType',
  'unit',
  'user',
  'voucher',
  'voucher_line',
  'voucherType',
  'year_end'
] as const

export type AuditEntity = (typeof AUDIT_ENTITIES)[number]
