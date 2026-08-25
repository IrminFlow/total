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
  'branchTransferInvoice',
  'budget',
  'cheque_bounce',
  'cheque_config',
  'company',
  'costCentre',
  'currency',
  'custom_field',
  'employee',
  'export',
  'fx_revaluation',
  'godown',
  'group',
  'isdCredit',
  'isdInvoice',
  'isdRegistration',
  'item_image',
  'job_work_challan',
  'job_work_return',
  'ledger',
  'nic_credentials',
  'pay_head',
  'payroll_run',
  'priceLevel',
  'priceRate',
  'recurring_template',
  'report_schedule',
  'report_view',
  'sales_document',
  'standardCost',
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
