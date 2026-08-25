/**
 * Every `entity` value the app ever writes to audit_log — the single source of truth for the
 * Settings → Audit trail entity filter (and re-exported by src/main/services/audit.ts, which
 * owns the write side). Kept in src/shared because the renderer can't import main-process
 * modules; when adding a writeAudit call with a NEW entity string, add it here too.
 *
 * Derived from the writeAudit call sites across src/main/services/*.ts and src/main/ipc.ts.
 */
export const AUDIT_ENTITIES = [
  'bank_recon_lock',
  'bank_rule',
  'bank_statement',
  'batch',
  'bom',
  'budget',
  'cheque_bounce',
  'cheque_config',
  'company',
  'costCentre',
  'currency',
  'employee',
  'export',
  'godown',
  'group',
  'ledger',
  'nic_credentials',
  'pay_head',
  'payroll_run',
  'priceLevel',
  'priceRate',
  'recurring_template',
  'report_schedule',
  'report_view',
  'stockGroup',
  'stockItem',
  'tally_import',
  'tdsSection',
  'unit',
  'user',
  'voucher',
  'voucher_line',
  'voucher_template',
  'voucherType',
  'year_end'
] as const

export type AuditEntity = (typeof AUDIT_ENTITIES)[number]
