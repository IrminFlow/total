import type { AuditEntity } from '@shared/auditEntities'

/**
 * Audit-coverage registry (WP 3.8) — for every IPC channel that can change anything, which
 * audit_log entities its handler (or the services it calls) writes. Channels that change nothing
 * in the company's books are listed as `read` with the reason.
 *
 * src/main/auditCoverage.dbtest.ts fails when a channel registered with a non-viewer role (or an
 * ungated channel) is missing here, when an entry names a channel that no longer exists, when an
 * entity is not in AUDIT_ENTITIES, and — for a sample of channels driven end to end — when the
 * call does not actually write a row of a mapped entity. So a new write path cannot ship without
 * deciding what it logs.
 *
 * Exports are audited too (entity 'export'): they are not changes to the books, but who took a
 * copy of what is part of the trail the app has always kept.
 */
export type AuditCoverage = { audit: readonly AuditEntity[] } | { read: string }

const a = (...entities: AuditEntity[]): AuditCoverage => ({ audit: entities })
const r = (reason: string): AuditCoverage => ({ read: reason })
const EXPORT = a('export')
const QUERY = r('computes and returns data; writes nothing')

export const AUDIT_COVERAGE: Record<string, AuditCoverage> = {
  // ---------- company / app lifecycle ----------
  'company:list': r('reads the company registry'),
  'company:current': QUERY,
  'company:create': a('company'),
  'company:createDemo': a('company', 'ledger', 'stockItem', 'voucher'),
  'company:delete': a('company'),
  'company:open': a('backup', 'voucher', 'audit_log'),
  'company:close': r('closes the database handle'),
  'company:updateInfo': a('company'),
  'company:lock:set': a('company'),
  'company:backup': a('backup'),
  'company:revealExports': r('opens the exports folder in Finder'),
  'app:info': QUERY,
  'log:renderer': r('writes the app log file (outside the books)'),
  'log:reveal': r('opens the logs folder'),

  // ---------- auth / users ----------
  'auth:users': QUERY,
  'auth:current': QUERY,
  'auth:login': a('user'),
  'auth:logout': a('user'),
  'users:list': QUERY,
  'users:save': a('user'),
  'users:deactivate': a('user'),

  // ---------- backups ----------
  'backup:run': a('backup'),
  'backup:restore': a('backup'),
  'backup:exportEncrypted': EXPORT,
  'backup:importEncrypted': a('backup'),

  // ---------- settings ----------
  'config:features:set': a('company'),
  'config:invoice:set': a('company'),
  'config:audit:set': a('company'),
  'config:audit:required': a('company'),
  'agent:setConfig': a('company'),
  'agent:exportMirror': EXPORT,
  'nic:save': a('nic_credentials'),
  'cheque:config:set': a('cheque_config'),
  'template:save': a('company'),
  'template:duplicate': a('company'),
  'template:delete': a('company'),
  'template:reset': a('company'),
  'template:setDefault': a('company'),
  'template:import': a('company'),
  'template:testPdf': EXPORT,

  // ---------- masters ----------
  'master:groups:create': a('group'),
  'master:groups:update': a('group'),
  'master:groups:delete': a('group'),
  'master:ledgers:create': a('ledger'),
  'master:ledgers:update': a('ledger'),
  'master:ledgers:delete': a('ledger'),
  'master:voucherTypes:create': a('voucherType'),
  'master:voucherTypes:update': a('voucherType'),
  'master:units:create': a('unit'),
  'master:stockGroups:create': a('stockGroup'),
  'master:stockItems:create': a('stockItem'),
  'master:stockItems:update': a('stockItem'),
  'master:stockItems:delete': a('stockItem'),
  'master:godowns:create': a('godown'),
  'master:godowns:update': a('godown'),
  'master:godowns:delete': a('godown'),
  'master:batches:create': a('batch'),
  'master:priceLevels:create': a('priceLevel'),
  'master:priceLevels:update': a('priceLevel'),
  'master:priceLevels:delete': a('priceLevel'),
  'priceLevels:saveRate': a('priceRate'),
  'priceLevels:deleteRate': a('priceRate'),
  'currency:create': a('currency'),
  'currency:delete': a('currency'),
  'cc:save': a('costCentre'),
  'cc:delete': a('costCentre'),
  'budget:save': a('budget'),
  'budget:delete': a('budget'),
  'bom:set': a('bom'),
  'bom:saveVersion': a('bom'),
  'bom:deleteVersion': a('bom'),

  // ---------- vouchers ----------
  'voucher:save': a('voucher'),
  'voucher:delete': a('voucher'),
  'voucher:restore': a('voucher'),
  'voucher:purge': a('voucher'),
  'voucher:nextNumber': QUERY,
  'voucher:numberExists': QUERY,
  'voucher:duplicates': QUERY,
  'pdc:mature': a('voucher'),
  'yearend:close': a('year_end', 'voucher', 'ledger', 'company'),
  'manufacture:save': a('manufacture'),
  'jobWork:saveChallan': a('job_work'),

  // ---------- trade cycle ----------
  'tradeDocTypes:save': a('tradeDocType'),
  'tradeDocs:save': a('trade_doc'),
  'tradeDocs:delete': a('trade_doc'),
  'tradeDocs:restore': a('trade_doc'),
  'tradeDocs:cancel': a('trade_doc'),
  'tradeDocs:close': a('trade_doc'),
  'tradeDocs:reopen': a('trade_doc'),
  'tradeDocs:convert': r('returns an unsaved draft; saving it is tradeDocs:save / voucher:save'),
  'tradeDocs:duplicate': r('returns an unsaved draft; saving it is tradeDocs:save'),
  'tradeDocs:pdf': EXPORT,
  // WP 2.5d (merged alongside WP 3.8): challan / GRN short-close and reopen, bulk close of stale quotations
  'trade:closeVoucher': a('voucher'),
  'trade:reopenVoucher': a('voucher'),
  'trade:closeStaleQuotations': a('trade_doc'),

  // ---------- banking ----------
  'bank:setBankDate': a('voucher_line'),
  'bank:importCsv': a('bank_statement', 'voucher'),
  'bankrule:save': a('bank_rule'),
  'bankrule:delete': a('bank_rule'),
  'bankrule:hit': r('increments a rule usage counter (a matching hint, not books data)'),
  'banking:suggest': QUERY,

  // ---------- imports ----------
  'import:pickCsv': r('file dialog; returns the text'),
  'import:preview': QUERY,
  'import:apply': a('csv_import', 'ledger', 'stockItem'),
  'import:template': EXPORT,
  'tally:import': a('tally_import'),

  // ---------- GST / e-documents ----------
  'gst:exportGstr1': EXPORT,
  'gst:exportGstr3b': EXPORT,
  'gst:3bManualSet': a('company'),
  'gst:recon2bTolerancesSet': a('company'),
  'gst:imsSet': a('gst_ims'),
  'gst:selfInvoiceGenerate': a('gst_self_invoice', 'voucher'),
  'gst:selfInvoiceSeriesSet': a('gst_self_invoice'),
  'gst:itcReversalInputsSet': a('company'),
  'gst:itcReversalApply': a('company'),
  'gst:itcReversalPost': a('voucher', 'ledger'),
  'edoc:exportEInvoice': EXPORT,
  'edoc:exportEwb': EXPORT,
  'edoc:ewbJson': EXPORT,
  'edoc:transportSet': a('voucher'),
  'nic:generateIrn': a('voucher'),
  'nic:generateEwb': a('voucher'),
  'invoice:pdf': EXPORT,
  'invoice:pdfBatch': EXPORT,
  'export:caPack': EXPORT,
  'export:tallyXml': EXPORT,
  'cheque:pdf': EXPORT,
  'cheque:testGrid': EXPORT,
  'cheque:advice': EXPORT,

  // ---------- TDS / TCS ----------
  'tds:sectionSave': a('tdsSection'),
  'tds:rateSave': a('tdsRate'),
  'tds:rateDelete': a('tdsRate'),
  'tds:certificateSave': a('tdsCertificate'),
  'tds:certificateDelete': a('tdsCertificate'),
  'tds:challanSave': a('tdsChallan'),
  'tds:challanDelete': a('tdsChallan'),
  'tds:challanFromPayment': a('tdsChallan'),
  'tds:allocate': a('tdsChallan'),
  'tds:unallocate': a('tdsChallan'),
  'tds:autoAllocate': a('tdsChallan'),
  'tds:ensurePayable': a('ledger'),
  'tds:applyToVoucher': a('tdsEntry', 'voucher', 'ledger'),
  'tds:applyMany': a('tdsEntry', 'voucher', 'ledger'),
  'tds:removeFromVoucher': a('tdsEntry', 'voucher'),
  'tds:exempt': a('tdsExemption'),
  'tds:unexempt': a('tdsExemption'),
  'tds:suggest': QUERY,
  'tds:export26q': EXPORT,
  'tcs:sectionSave': a('tdsSection'),
  'tcs:rateSave': a('tdsRate'),
  'tcs:rateDelete': a('tdsRate'),
  'tcs:certificateSave': a('tdsCertificate'),
  'tcs:certificateDelete': a('tdsCertificate'),
  'tcs:challanSave': a('tdsChallan'),
  'tcs:challanDelete': a('tdsChallan'),
  'tcs:challanFromPayment': a('tdsChallan'),
  'tcs:allocate': a('tdsChallan'),
  'tcs:unallocate': a('tdsChallan'),
  'tcs:autoAllocate': a('tdsChallan'),
  'tcs:applyToVoucher': a('tcsEntry', 'voucher', 'ledger'),
  'tcs:applyMany': a('tcsEntry', 'voucher', 'ledger'),
  'tcs:removeFromVoucher': a('tcsEntry', 'voucher'),
  'tcs:exempt': a('tcsExemption'),
  'tcs:unexempt': a('tcsExemption'),

  // ---------- payroll ----------
  'payroll:employees:save': a('employee'),
  'payroll:employees:delete': a('employee'),
  'payroll:heads:save': a('pay_head'),
  'payroll:heads:delete': a('pay_head'),
  'payroll:employeeHeads:set': a('employee'),
  'payroll:declarations:set': a('employee'),
  'payroll:rates:save': a('statutory_rate'),
  'payroll:rates:delete': a('statutory_rate'),
  'payroll:payments:record': a('statutory_payment'),
  'payroll:payments:delete': a('statutory_payment'),
  'payroll:preview': QUERY,
  'payroll:commit': a('payroll_run', 'voucher', 'ledger'),
  'payroll:deleteRun': a('payroll_run', 'voucher'),
  'payroll:payslip': EXPORT,
  'payroll:ecr': EXPORT,
  'payroll:esi': EXPORT,
  'payroll:ptCsv': EXPORT,
  'payroll:ptReturnCsv': EXPORT,

  // ---------- fixed assets ----------
  'fa:classSave': a('ca_asset_class'),
  'fa:classDelete': a('ca_asset_class'),
  'fa:blockSave': a('it_block'),
  'fa:blockDelete': a('it_block'),
  'fa:blockRateSave': a('it_block_rate'),
  'fa:blockRateDelete': a('it_block_rate'),
  'fa:blockOpeningSet': a('it_block'),
  'fa:blockOpeningClear': a('it_block'),
  'fa:groupSave': a('fixed_asset_group'),
  'fa:groupDelete': a('fixed_asset_group'),
  'fa:save': a('fixed_asset'),
  'fa:delete': a('fixed_asset'),
  'fa:additionSave': a('fixed_asset'),
  'fa:additionDelete': a('fixed_asset'),
  'fa:runPost': a('depreciation_run', 'voucher'),
  'fa:dispose': a('fixed_asset', 'voucher'),

  // ---------- the audit trail itself (viewer-level, listed for completeness) ----------
  'audit:exportCsv': EXPORT,
  'audit:exportPdf': EXPORT
}
