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
  // WP 8.3: the setup wizard — company + preset accounts / units + features / gstProfile / ui.
  'simple:setup': a('company', 'ledger', 'unit'),
  // WP 8.7: the opening setup — accounts' / items' openings through the masters services, the
  // opening bills and one batch row; "I started fresh" is a company (meta ui) update.
  'simple:openings:get': QUERY,
  'simple:openings:preview': r('rehearses the opening setup in a transaction that is always rolled back; writes nothing'),
  'simple:openings': a('opening_batch', 'opening_bills', 'ledger', 'stockItem'),
  'simple:openings:skip': a('company'),
  // WP 9.3: the simple Buy screens' reads (suppliers / accounts / defaults, the purchase list, one bill).
  'simple:buy:setup': QUERY,
  'simple:purchases': QUERY,
  'simple:purchase': QUERY,
  // WP 9.1: an intent saved through saveVoucher (the vouchers log themselves; the intent as one
  // event); the walk-in customer / tax ledgers the editor would create on first use log as ledgers.
  // WP 10.1: + the Ask Total draft the flow was opened from, consumed in the same transaction.
  'simple:post': a('simple_intent', 'voucher', 'ledger', 'manufacture', 'ai_draft'),
  // WP 9.4: the simple Money screens' reads (choices / defaults, a party's open bills, the money list, one entry).
  'simple:money:setup': QUERY,
  'simple:money:bills': QUERY,
  'simple:money:list': QUERY,
  'simple:money:entry': QUERY,
  // WP 9.2: the simple Sell screens' reads (customers / accounts / defaults, the sales list, one bill).
  'simple:sell:setup': QUERY,
  'simple:sales': QUERY,
  // WP 9.8: the simple People screens — reads (the list, one person, bills to pay); phone /
  // WhatsApp / credit days through masters.updateLedger; a sent reminder through reminder_log.
  'simple:people:list': QUERY,
  'simple:people:person': QUERY,
  'simple:people:billsToPay': QUERY,
  'simple:people:update': a('ledger'),
  'simple:people:reminded': a('reminder'),
  'simple:sale': QUERY,
  // WP 9.5: the simple return screens' reads (recent bills with what is returnable, one bill).
  'simple:returns:bills': QUERY,
  'simple:returns:bill': QUERY,
  // WP 9.7: the simple Stock screens (services/simpleStock.ts); counting / making go through simple:post.
  'simple:stock:list': QUERY,
  'simple:stock:product': QUERY,
  'simple:stock:madeSetup': QUERY,
  'simple:stock:count': QUERY,
  'simple:stock:setPrice': a('priceRate', 'priceLevel'),
  // WP 9.9: the simple Reports and Taxes screens' reads; "I've filed" (meta gstFiled) is a company update.
  'simple:reports:doing': QUERY,
  'simple:reports:cash': QUERY,
  'simple:reports:owed': QUERY,
  'simple:reports:byMonth': QUERY,
  'simple:taxes': QUERY,
  'simple:taxes:filed': a('company'),
  // WP 9.6: the simple Bank screen — reads (accounts; lines + suggestions + the BRS sentence) and
  // accepting lines: a confirmed match (voucher_line / bank_statement_line / learned rules) or an
  // intent saved like simple:post and its line reconciled (the same rows reconcileSavedDraft writes).
  'simple:bank:setup': QUERY,
  'simple:bank:lines': QUERY,
  'simple:bank:accept': a('simple_intent', 'voucher', 'ledger', 'voucher_line', 'bank_statement_line', 'bank_learned_rule'),
  'simple:preview': r('rehearses simple:post in a transaction that is always rolled back; writes nothing'),
  // WP 9.10: the Accountant-view hand-off — an unsaved simple form's editor state (simple:post's
  // mapping, rehearsed and rolled back) and the facts "Back to simple" maps a full screen with.
  'simple:intentForm': r("maps the intent with simple:post's mapping in a transaction that is always rolled back; writes nothing"),
  'simple:handoffTarget': QUERY,
  'company:delete': a('company'),
  // WP 7.2: + the (deferred, at most daily) restore check of the on-open backup.
  'company:open': a('backup', 'voucher', 'audit_log', 'attachment', 'backup_check'),
  'company:close': r('closes the database handle'),
  'company:updateInfo': a('company'),
  'company:lock:set': a('company'),
  'company:backup': a('backup', 'backup_check'),
  'company:revealExports': r('opens the exports folder in Finder'),
  // WP 8.1: the company mode (meta `ui`).
  'ui:get': QUERY,
  'ui:mode:set': a('company'),
  // WP 8.6: the simple Home (every figure computed at query time).
  'simple:home': QUERY,
  // WP 10.3: opens an allow-listed GST portal / CBIC page in the system browser.
  'help:openLink': r('opens an allow-listed government web page in the browser; writes nothing'),
  'simple:homeAttention': QUERY,
  'app:info': QUERY,
  'app:updates:get': QUERY,
  'app:updates:set': r('app-level setting in <dataRoot>/app-settings.json (append-only app-settings-audit.jsonl), outside every company; writes no company audit row'),
  'app:updates:act': r('app-level: starts a download the user approved, or remembers a skipped version in app-settings.json; writes no company audit row'),
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
  // WP 7.2: a manual backup is restore-checked at once.
  'backup:run': a('backup', 'backup_check'),
  'backup:restore': a('backup'),
  'backup:reveal': r('shows a backup file (or the backups folder) in Finder; writes nothing'),
  'backup:exportEncrypted': EXPORT,
  'backup:importEncrypted': a('backup'),
  // WP 7.2: the restore checks (list; check now) — a check is its own audited row.
  'backup:checks': QUERY,
  'backup:check': a('backup_check'),

  // ---------- WP 7.2 security: the screen lock, the passphrase lock ----------
  'session:activity': r('moves the idle clock of the auto-lock; writes nothing'),
  'session:lock': a('user'),
  'session:unlock': a('user'),
  'security:get': QUERY,
  'security:autoLock:set': a('security'),
  // On / off: a backup first, the change audited inside the converted file ('security').
  'security:passphrase:on': a('security', 'backup'),
  'security:passphrase:off': a('security', 'backup'),
  'security:passphrase:change': a('security'),

  // ---------- settings ----------
  'config:features:set': a('company'),
  'gstProfile:get': QUERY,
  'gstProfile:set': a('company'),
  'config:invoice:set': a('company'),
  'config:audit:set': a('company'),
  'config:audit:required': a('company'),
  'agent:setConfig': a('company'),
  'agent:mcp:set': a('company'),
  'agent:exportMirror': EXPORT,
  'nic:save': a('nic_credentials'),
  'cheque:config:set': a('cheque_config'),

  // ---------- banking depth (WP 4.1, ipcBanking.ts) ----------
  'bankImport:pickFile': r('opens a file dialog and returns the chosen statement; writes nothing'),
  'bankImport:preview': QUERY,
  'bankImport:commit': a('bank_statement', 'bank_import_profile'),
  'bankImport:saveProfile': a('bank_import_profile'),
  'bankImport:confirm': a('voucher_line', 'bank_statement_line', 'bank_learned_rule'),
  'bankImport:unmatch': a('voucher_line', 'bank_statement_line'),
  'bankImport:ignore': a('bank_statement_line'),
  'bankImport:createVouchers': a('voucher', 'bank_statement_line', 'bank_learned_rule'),
  'bankImport:undo': a('bank_statement', 'voucher', 'voucher_line'),
  'bankLearned:update': a('bank_learned_rule'),
  'bankLearned:delete': a('bank_learned_rule'),
  'cheques:saveBook': a('cheque_book'),
  'cheques:deleteBook': a('cheque_book'),
  'cheques:setStatus': a('cheque'),
  'cheques:print': a('cheque', 'voucher', 'export'),
  'pdc:bounce': a('voucher', 'pdc'),
  'bulkPay:setBankDetails': a('ledger'),
  'bulkPay:saveTemplate': a('payment_template'),
  'bulkPay:deleteTemplate': a('payment_template'),
  'bulkPay:export': a('payment_batch', 'export'),
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
  'master:ledgers:update': a('ledger', 'opening_bills'),
  'master:ledgers:delete': a('ledger'),
  'master:voucherTypes:create': a('voucherType'),
  'master:voucherTypes:update': a('voucherType'),
  'master:units:create': a('unit'),
  'master:stockGroups:create': a('stockGroup'),
  'master:stockItems:create': a('stockItem'),
  // WP 8.4: item + (optional) default price level + its selling-price row.
  'master:stockItems:quickCreate': a('stockItem', 'priceLevel', 'priceRate'),
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
  // WP 2.6 pricing + counter billing
  'pricing:setGridRate': a('priceRate'),
  'pricing:updateRate': a('priceRate'),
  'pricing:bulkUpdate': a('priceRate'),
  'pricing:copyLevel': a('priceLevel', 'priceRate'),
  'pricing:importCsv': a('csv_import', 'priceRate'),
  'pricing:savePartyRate': a('partyRate'),
  'pricing:deletePartyRate': a('partyRate'),
  'pricing:saveScheme': a('discountScheme'),
  'pricing:deleteScheme': a('discountScheme'),
  'pricing:setConfig': a('company'),
  'counter:setConfig': a('company'),
  'counter:checkout': a('counter_sale', 'voucher'),
  'counter:hold': a('held_bill'),
  'counter:recall': a('held_bill'),
  'counter:discardHeld': a('held_bill'),
  'counter:print': EXPORT,
  // WP 4.2 receivables
  'receivables:setConfig': a('company'),
  'receivables:statementPdf': EXPORT,
  'receivables:statementsBulk': EXPORT,
  'receivables:remind': a('reminder'),
  'receivables:remindBulk': a('reminder'),
  'receivables:postInterest': a('voucher', 'interest_charge', 'ledger'),
  'receivables:setHold': a('credit_hold'),
  'receivables:addFollowup': a('bill_followup'),
  'receivables:deleteFollowup': a('bill_followup'),
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
  // WP 5.4: saving a capture draft attaches its file and marks the queue item saved; a
  // statement-line draft reconciles its line (bank date, match, learned rule).
  'voucher:save': a('voucher', 'credit_override', 'ai_draft', 'attachment', 'capture_item', 'voucher_line', 'bank_statement_line', 'bank_learned_rule'),
  'voucher:delete': a('voucher'),
  // WP 8.5: restoring a voucher undone with others restores its undo group (one row per group).
  'voucher:restore': a('voucher', 'undo_group'),
  'voucher:undoSave': a('voucher', 'undo_group'),
  'voucher:purge': a('voucher', 'attachment'),
  'voucher:nextNumber': QUERY,
  'voucher:numberExists': QUERY,
  'voucher:duplicates': QUERY,
  'pdc:mature': a('voucher'),
  'yearend:close': a('year_end', 'voucher', 'ledger', 'company'),
  // The stock journal goes through saveVoucher (a 'voucher' row) — listed so canPost covers it.
  'manufacture:save': a('manufacture', 'voucher', 'ai_draft'),
  'jobWork:saveChallan': a('job_work'),

  // ---------- trade cycle ----------
  'tradeDocTypes:save': a('tradeDocType'),
  'tradeDocs:save': a('trade_doc', 'ai_draft'),
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
  'bank:setBankDate': a('voucher_line', 'bank_statement_line'),
  'bank:importCsv': a('bank_statement', 'voucher'),
  'bankrule:save': a('bank_rule'),
  'bankrule:delete': a('bank_rule'),
  'bankrule:hit': r('increments a rule usage counter (a matching hint, not books data)'),
  'banking:suggest': QUERY,

  // ---------- imports ----------
  'import:pickCsv': r('file dialog; returns the text'),
  'import:preview': QUERY,
  'import:apply': a('csv_import', 'ledger', 'stockItem', 'opening_bills'),
  'import:template': EXPORT,
  // WP 6.3: orders land in trade_docs (saveTradeDoc audits them); booksFrom is company info.
  'tally:import': a('tally_import', 'trade_doc', 'company', 'ledger'),
  // WP 6.3 import wizard (ipcDataImport.ts). Every record goes through its own service's audit;
  // csv_import is the run's summary row; a dry run writes and rolls everything back.
  'importwiz:load': r('reads a file into memory; writes nothing'),
  'importwiz:sheet': QUERY,
  'importwiz:preview': r('dry run: applies inside a transaction that is always rolled back'),
  'importwiz:run': a(
    'csv_import', 'import_template', 'group', 'ledger', 'unit', 'stockGroup', 'godown', 'stockItem', 'batch', 'priceLevel', 'priceRate',
    'voucherType', 'voucher', 'voucher_line', 'trade_doc', 'bank_statement', 'costCentre', 'company', 'backup', 'opening_bills'
  ),
  'importwiz:planPreview': r('dry run: applies inside a transaction that is always rolled back'),
  'importwiz:planRun': a('csv_import', 'company', 'costCentre', 'voucher_line', 'group', 'ledger', 'unit', 'stockGroup', 'godown', 'stockItem', 'batch', 'priceLevel', 'priceRate', 'voucherType', 'voucher', 'trade_doc', 'backup', 'opening_bills'),
  'importwiz:batches': QUERY,
  'importwiz:undo': a('import_batch', 'voucher', 'voucher_line', 'costCentre', 'trade_doc', 'ledger', 'stockItem', 'group', 'unit', 'stockGroup', 'godown', 'batch', 'priceLevel', 'priceRate', 'voucherType', 'backup', 'opening_bills'),
  'importwiz:templates': QUERY,
  'importwiz:templateSave': a('import_template'),
  'importwiz:templateDelete': a('import_template'),
  'importwiz:sample': EXPORT,
  'export:xlsx': EXPORT,
  'export:books': EXPORT,

  // ---------- GST / e-documents ----------
  'gst:exportGstr1': EXPORT,
  'gst:exportGstr3b': EXPORT,
  'gst:3bManualSet': a('company'),
  'gst:recon2bTolerancesSet': a('company'),
  'gst:imsSet': a('gst_ims'),
  'gst:selfInvoiceGenerate': a('gst_self_invoice', 'voucher'),
  'gst:selfInvoiceSeriesSet': a('gst_self_invoice'),
  'gst:itcReversalInputsSet': a('company'),
  'gst:itcReversalApply': a('company', 'itc_reversal'),
  'gst:itcReversalPost': a('itc_reversal', 'voucher', 'ledger'),
  'edoc:exportEInvoice': EXPORT,
  'edoc:exportEwb': EXPORT,
  'edoc:ewbJson': EXPORT,
  'edoc:transportSet': a('voucher'),
  'nic:testConnection': r('NIC auth handshake only — files nothing, writes nothing to the books'),
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

  // ---------- report builder, scheduled packs (WP 6.1 / 6.2) ----------
  'rb:save': a('saved_report'),
  'rb:rename': a('saved_report'),
  'rb:pin': a('saved_report'),
  'rb:duplicate': a('saved_report'),
  'rb:delete': a('saved_report'),
  'rb:import': a('saved_report'),
  'rb:exportJson': EXPORT,
  'pack:save': a('report_pack'),
  'pack:delete': a('report_pack'),
  'pack:runNow': a('report_pack'),
  // ---------- group consolidation (WP 6.5) — the definition lives in this company; members are read read-only ----------
  'consolGroup:save': a('consolidation_group'),
  'consolGroup:delete': a('consolidation_group'),
  'consolMapping:save': a('consolidation_mapping'),
  'consolMapping:delete': a('consolidation_mapping'),
  'consolPair:save': a('intercompany_pair'),
  'consolPair:delete': a('intercompany_pair'),
  'pack:chooseFolder': r('opens a folder picker; the chosen path is saved by pack:save'),

  // ---------- AI agent (WP 5.1) — conversations are not books; settings, drafts and deletions are audited ----------
  'ai:settings:set': a('ai_settings'),
  'ai:notice:accept': a('ai_settings'),
  'ai:key:set': a('ai_settings'),
  'ai:key:clear': a('ai_settings'),
  'ai:testConnection': r('lists the provider\'s models over the network; sends no company data and writes nothing'),
  'ai:thread:delete': a('ai_thread'),
  // Viewer-level, listed anyway: a question writes only the AI tables (thread, messages, usage,
  // outbound log) — never the books — and audits any draft a draft tool creates.
  'ai:send': a('ai_draft', 'ai_memory'),
  'ai:cancel': r('stops an in-flight answer; the partial reply is kept in the AI tables only'),
  'ai:draft:discard': a('ai_draft', 'capture_item'),
  // ---------- document capture (WP 5.4, ai/capture/ipc.ts) ----------
  'capture:pick': a('capture_item'),
  'capture:addFiles': a('capture_item'),
  'capture:process': a('capture_item'),
  'capture:stop': a('capture_item'),
  'capture:cancel': a('capture_item'),
  'capture:retry': a('capture_item'),
  'capture:resolve': a('capture_item', 'ai_draft'),
  'capture:remove': a('capture_item'),
  'capture:watchInbox': r('creates and watches <company>/capture-inbox (files dropped there are queued and audited as capture_item by the watcher)'),
  'bankImport:categorise': r('proposes ledgers for open statement lines (the residual may go to the provider — logged in ai_outbound_log / ai_usage, not the books); writes nothing else'),
  'bankImport:categoriseAccept': a('ai_draft'),
  // WP 5.2 — the chat panel. Viewer-level, listed anyway: regenerate re-runs a question (AI tables
  // only, plus any draft it makes); a rename is audited; a pin is a display preference.
  'ai:regenerate': a('ai_draft', 'ai_thread', 'ai_memory'),
  'ai:thread:rename': a('ai_thread'),
  'ai:thread:pin': r('pins a conversation in the panel’s list (a display preference in the AI tables; not the books)'),
  'ai:data:deleteAll': a('ai_data'),
  // ---------- assistants (WP 5.5) — computed at query time; only marks, settings, the 2B statement and drafts are stored ----------
  // WP 10.1 Ask Total: answers from the read services (an entry request is rehearsed in a
  // transaction that is always rolled back); a draft for the simple flow is an audited ai_draft.
  'assist:ask': r('answers from the read services; an entry request is rehearsed in a transaction that is always rolled back; writes nothing'),
  'assist:draft': a('ai_draft'),
  'assist:draft:discard': a('ai_draft'),
  'assist:close': QUERY,
  'assist:close:mark': a('assistant_mark'),
  'assist:anomalies': QUERY,
  'assist:anomaly:dismiss': a('assistant_mark'),
  'assist:settings:get': QUERY,
  'assist:settings:set': a('assistant_settings'),
  'assist:gst2b': QUERY,
  'assist:gst2b:store': a('gst2b_statement'),
  'assist:gst2b:resolve': a('assistant_mark'),
  'assist:gst2b:draft': a('ai_draft'),
  'assist:nlReport': r('maps a question to a report-builder model (deterministic); runs nothing and writes nothing'),
  // WP 5.6 — memory. Every change is audited with the whole before/after; `remember` (a tool run
  // by ai:send / ai:regenerate) only proposes and audits the suggested row.
  'ai:memory:list': QUERY,
  'ai:memory:create': a('ai_memory'),
  'ai:memory:update': a('ai_memory'),
  'ai:memory:setStatus': a('ai_memory'),
  'ai:memory:delete': a('ai_memory'),
  'ai:memory:resolveDerived': a('ai_memory'),
  'ai:memory:forgetAll': a('ai_memory'),
  // ---------- payables (WP 4.3) ----------
  'payables:plan': QUERY,
  'payables:msmeDue': QUERY,
  'payables:previewRun': r('computes what a payment run would post; writes nothing'),
  'payables:createRun': a('payment_run', 'voucher', 'ledger'),
  'payables:runs': QUERY,
  'payables:run': QUERY,
  'payables:runExportCsv': EXPORT,
  'payables:msmeReport': QUERY,
  'payables:msmeForm1Csv': EXPORT,
  'payables:bankRates': QUERY,
  'payables:bankRateSave': a('msme_bank_rate'),
  'payables:bankRateDelete': a('msme_bank_rate'),
  'payables:supplierStatement': QUERY,
  'payables:supplierRecon': r('matches a pasted supplier ledger against the books; writes nothing'),
  // ---------- cash and finance (WP 4.4) ----------
  'forecast:itemSave': a('forecast_item'),
  'forecast:itemDelete': a('forecast_item'),
  'loan:save': a('loan'),
  'loan:delete': a('loan'),
  'loan:setStatus': a('loan'),
  'loan:prepaymentAdd': a('loan'),
  'loan:prepaymentDelete': a('loan'),
  'loan:postEmi': a('loan', 'voucher'),
  'fx:rateSave': a('fx_rate'),
  'fx:rateDelete': a('fx_rate'),
  'fx:setLedgerCurrency': a('fx_ledger_currency'),
  'fx:revalue': a('fx_revaluation', 'voucher'),
  'fx:reverse': a('fx_revaluation', 'voucher'),
  'fx:settle': a('fx_settlement', 'voucher'),
  'budget:importCsv': a('budget'),
  'budget:exportCsv': EXPORT,

  // ---------- bulk edit, attachments, party notes (WP 6.4) ----------
  'bulk:preview': r('a dry run: every save runs inside a transaction that is rolled back — nothing is kept, not even its audit rows'),
  'bulk:apply': a('bulk_batch', 'voucher', 'ledger', 'stockItem', 'opening_bills'),
  'bulk:undo': a('bulk_batch', 'voucher', 'ledger', 'stockItem', 'opening_bills'),
  'attachments:add': a('attachment'),
  'attachments:remove': a('attachment'),
  'attachments:setConfig': a('company'),
  'partyNotes:add': a('party_note'),
  'partyNotes:update': a('party_note'),
  'partyNotes:delete': a('party_note'),

  // ---------- the audit trail itself (viewer-level, listed for completeness) ----------
  'audit:exportCsv': EXPORT,
  'audit:exportPdf': EXPORT
}
