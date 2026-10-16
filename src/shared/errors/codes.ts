// The error-code registry (WP 8.5): every code that saveVoucher (its posting rules, TDS / TCS
// checks and its own refusals), the bin / undo paths and the masters services raise, mapped to
// the form field it belongs to and a plain `errors.*` message ("what happened + what to do").
// `errorMapping.test.ts` enumerates the codes in those sources and fails on one missing here.
//
// Field paths are the form's own names: 'date', 'number', 'party', 'account' (the sales /
// purchase account), 'items', 'lines', 'lines.{line}.amount' / 'lines.{line}.account', 'billRefs',
// 'tds', 'tcs', and for masters 'name', 'group', 'gstin', 'pan', 'party'. `{line}` is filled from
// the issue's line index. A code without a field is shown as a message for the whole form.
//
// `vars` lists the params the message interpolates — the service must send them (when it can't,
// the mapper uses `plainKey` instead so a message never shows a raw {placeholder}).

import type { MessageKey } from '../i18n'

export interface ErrorMapEntry {
  field?: string
  key: MessageKey
  vars?: readonly string[]
  /** Param-free key used when `vars` are missing. */
  plainKey?: MessageKey
}

const e = (key: MessageKey, field?: string, vars?: readonly string[], plainKey?: MessageKey): ErrorMapEntry => ({
  key,
  ...(field ? { field } : {}),
  ...(vars ? { vars } : {}),
  ...(plainKey ? { plainKey } : {})
})

/** TDS / TCS entry checks (shared/withholding.ts) — the same suffixes under each prefix. */
const WITHHOLDING_SUFFIXES = [
  'no_party', 'unknown_section', 'bad_amount', 'exceeds_base', 'no_rate', 'amount_mismatch', 'no_payable_line', 'payable_mismatch'
] as const

type WithholdingSuffix = (typeof WITHHOLDING_SUFFIXES)[number]

const withholding = <P extends 'tds' | 'tcs'>(prefix: P): Record<`${P}_${WithholdingSuffix}`, ErrorMapEntry> =>
  Object.fromEntries(
    WITHHOLDING_SUFFIXES.map((s) => [`${prefix}_${s}`, e(s === 'no_party' ? 'errors.chooseParty' : prefix === 'tds' ? 'errors.tdsCheck' : 'errors.tcsCheck', s === 'no_party' ? 'party' : prefix)])
  ) as Record<`${P}_${WithholdingSuffix}`, ErrorMapEntry>

export const ERROR_MAP = {
  // ---------- posting rules (shared/posting.ts validateVoucher) ----------
  bad_date: e('errors.badDate', 'date'),
  no_inventory: e('errors.addItem', 'items'),
  too_few_lines: e('errors.twoSides', 'lines'),
  bad_amount: e('errors.enterAmount', 'lines.{line}.amount'),
  unknown_ledger: e('errors.unknownAccount', 'lines.{line}.account'),
  over_allocated: e('errors.overAllocated', 'lines.{line}.amount'),
  bill_refs_no_party: e('errors.chooseParty', 'party'),
  bill_refs_mismatch: e('errors.billsDontAddUp', 'billRefs'),
  bad_inventory_amount: e('errors.itemAmount', 'items'),
  bad_qty: e('errors.itemQty', 'items'),
  stock_note_ledger_lines: e('errors.goodsOnly'),
  stock_note_bills: e('errors.goodsOnly'),
  stock_note_party: e('errors.chooseParty', 'party'),
  stock_note_direction: e('errors.goodsDirection', 'items'),
  link_kind: e('errors.cantLink', 'items'),
  link_optional: e('errors.cantLink', 'items'),
  unbalanced: e('errors.unbalanced', 'lines', ['amount'], 'errors.unbalancedPlain'),
  zero_voucher: e('errors.enterAmount', 'lines'),
  cash_bank_rule: e('errors.moneyAccount', 'lines'),

  // ---------- TCS / TDS entries (shared/tcs.ts, shared/withholding.ts) ----------
  tcs_wrong_kind: e('errors.tcsCheck', 'tcs'),
  tcs_party_debit: e('errors.tcsCheck', 'tcs'),
  tcs_party_credit: e('errors.tcsCheck', 'tcs'),
  ...withholding('tds'),
  ...withholding('tcs'),

  // ---------- saveVoucher's own refusals (services/vouchers.ts) ----------
  /** Wrapper for several posting-rule issues at once (each issue carries its own code). */
  validation: e('errors.checkFields'),
  voucher_type_not_found: e('errors.entryTypeMissing'),
  number_required: e('errors.numberNeeded', 'number'),
  voucher_not_found: e('errors.entryMissing'),
  voucher_in_bin: e('errors.entryInBin'),
  irn_renumber: e('errors.einvoiceNumber', 'number'),
  books_locked: e('errors.dateLocked', 'date', ['date'], 'errors.dateLockedPlain'),
  gst_not_charged: e('errors.taxNotRegistered', 'items'),
  bad_purpose: e('errors.wrongPurpose'),
  credit_hold: e('errors.creditHold', 'party', ['name'], 'errors.creditHoldPlain'),
  credit_limit: e('errors.creditLimit', 'party', ['name'], 'errors.creditLimitPlain'),
  batch_not_found: e('errors.batchMissing', 'items'),
  batch_wrong_item: e('errors.batchWrongItem', 'items'),
  batch_short: e('errors.batchShort', 'items', ['batch'], 'errors.notEnoughStockPlain'),
  insufficient_stock: e('errors.notEnoughStock', 'items', ['names'], 'errors.notEnoughStockPlain'),
  year_end_close_immutable: e('errors.yearClosedEntry'),
  manufacture_edit_elsewhere: e('errors.editElsewhere'),
  job_work_edit_elsewhere: e('errors.editElsewhere'),
  interest_note_immutable: e('errors.interestNote'),
  payroll_voucher_edit: e('errors.editElsewhere'),
  not_in_bin: e('errors.notInBin'),
  interest_restore_clash: e('errors.interestNote'),
  year_closed_again: e('errors.yearClosedAgain'),

  // ---------- undo (services/undo.ts) ----------
  undo_edited: e('errors.undoEdited'),
  undo_closed_year: e('errors.undoClosedYear'),
  undo_closing_entry: e('errors.yearClosedEntry'),
  undo_nothing: e('errors.undoNothing'),
  undo_linked: e('errors.undoLinked'),
  undo_expired: e('errors.undoExpired'),
  simple_undo_negative_stock: e('errors.undoNegativeStock', undefined, ['name'], 'errors.undoNegativeStockPlain'),

  // ---------- masters (services/masters.ts) ----------
  group_not_found: e('errors.typeMissing', 'group'),
  group_system: e('errors.builtInType'),
  group_cycle: e('errors.typeCycle', 'group'),
  group_in_use: e('errors.typeInUse'),
  group_missing: e('errors.typeMissing'),
  ledger_not_found: e('errors.accountMissing'),
  ledger_system: e('errors.builtInAccount'),
  ledger_in_use: e('errors.accountInUse'),
  item_not_found: e('errors.productMissing'),
  item_in_use: e('errors.productInUse'),
  godown_needs_party: e('errors.chooseParty', 'party'),
  party_not_found: e('errors.chooseParty', 'party'),
  godown_not_found: e('errors.placeMissing'),
  godown_job_work: e('errors.placeJobWork'),
  godown_in_use: e('errors.placeInUse'),

  // ---------- opening setup (services/openings.ts, WP 8.7) ----------
  openings_invalid: e('errors.checkFields'),
  openings_name_taken: e('errors.openings.nameTaken', 'name'),
  openings_wrong_kind: e('errors.openings.wrongKind', 'name'),
  openings_date_after_start: e('errors.openings.dateAfterStartOn', 'date', ['date'], 'errors.openings.dateAfterStart'),
  openings_changed: e('errors.openings.changed'),
  openings_no_cash: e('errors.openings.noCash'),
  openings_bill_in_use: e('errors.openings.billInUse', 'name'),
  // services/openingBills.ts: an opening split into bills, one of them in use, changed elsewhere.
  opening_bills_in_use: e('errors.openings.billInUse', 'openingBalance'),

  // ---------- simple intents (shared/simple/intents.ts, services/simplePost.ts, WP 9.1) ----------
  simple_bad_amount: e('errors.enterAmount', 'amount'),
  simple_bad_qty: e('errors.itemQty', 'items'),
  simple_bad_date: e('errors.badDate', 'date'),
  simple_no_lines: e('errors.intent.noLines', 'items'),
  simple_no_party: e('errors.chooseParty', 'party'),
  simple_wrong_account: e('errors.intent.wrongAccount', 'account'),
  simple_no_type: e('errors.entryTypeMissing'),
  simple_no_money_account: e('errors.intent.noMoneyAccount', 'payment'),
  simple_cannot_build: e('errors.checkFields'),
  simple_no_item: e('errors.addItem', 'items'),
  simple_no_price: e('errors.intent.noPrice', 'items'),
  simple_overpaid: e('errors.intent.overpaid', 'payment', ['amount'], 'errors.intent.overpaidPlain'),
  simple_walk_in_unpaid: e('errors.intent.walkInUnpaid', 'payment'),
  simple_bill_unknown: e('errors.intent.billUnknown', 'bills', ['bill'], 'errors.intent.billUnknownPlain'),
  simple_bill_over: e('errors.intent.billOver', 'bills', ['bill', 'amount'], 'errors.intent.billOverPlain'),
  simple_bills_short: e('errors.intent.billsShort', 'bills', ['amount'], 'errors.intent.billsShortPlain'),
  simple_bills_exceed: e('errors.intent.billsExceed', 'amount', ['amount'], 'errors.intent.billsExceedPlain'),
  simple_bill_total: e('errors.intent.billTotal', 'amount', ['amount'], 'errors.intent.billTotalPlain'),
  simple_same_account: e('errors.intent.sameAccount', 'to'),
  simple_original_missing: e('errors.intent.originalMissing', 'bill'),
  simple_return_line: e('errors.intent.returnLine', 'items'),
  simple_return_qty: e('errors.intent.returnQty', 'items', ['qty'], 'errors.intent.returnQtyPlain'),
  simple_return_rate: e('errors.intent.returnRate', 'amount'),
  simple_return_before_bill: e('errors.intent.returnBeforeBill', 'date', ['date'], 'errors.intent.returnBeforeBillPlain'),
  simple_return_amount: e('errors.intent.returnAmount', 'amount', ['amount'], 'errors.intent.returnAmountPlain'),
  simple_refund_not_due: e('errors.intent.refundNotDue', 'refund', ['bill'], 'errors.intent.refundNotDuePlain'),
  simple_before_books: e('errors.intent.beforeBooks', 'date', ['date'], 'errors.intent.beforeBooksPlain'),
  simple_far_future: e('errors.intent.farFuture', 'date'),
  simple_save_refused: e('errors.intent.saveRefused'),
  simple_year_closed: e('errors.intent.yearClosed', 'date'),
  simple_duplicate_bill: e('errors.intent.duplicateBill', 'billNo', ['number'], 'errors.intent.duplicateBillPlain'),
  simple_client_reused: e('errors.intent.clientReused'),
  // WP 9.6: the simple Bank screen (services/simpleBank.ts) — on the line's row.
  simple_bank_not_bank: e('errors.bank.notBank', 'bank'),
  simple_bank_line_gone: e('errors.bank.lineGone', 'line'),
  simple_bank_line_done: e('errors.bank.lineDone', 'line'),
  simple_bank_wrong_choice: e('errors.bank.wrongChoice', 'choice'),
  simple_bank_no_match: e('errors.bank.noMatch', 'choice'),
  simple_bank_not_matched: e('errors.bank.notMatched', 'line'),
  simple_items_no_gst: e('errors.intent.itemsNoGst', 'gstOnBill'),
  // WP 9.8: the simple People screens (services/simplePeople.ts).
  simple_people_not_party: e('errors.people.notParty'),
  simple_people_bad_phone: e('errors.people.badPhone', 'phone'),
  simple_people_nothing_late: e('errors.people.nothingLate'),
  // WP 9.7: the stock intents (shared/simple/stock.ts).
  simple_count_twice: e('errors.intent.countTwice', 'counts', ['name'], 'errors.intent.countTwicePlain'),
  simple_no_recipe: e('errors.intent.noRecipe', 'item', ['name'], 'errors.intent.noRecipePlain'),
  simple_not_enough_material: e('errors.intent.notEnoughMaterial', 'qty', ['names'], 'errors.intent.notEnoughMaterialPlain'),
  simple_no_sale_price: e('errors.intent.noSalePrice', 'price', ['name'], 'errors.intent.noSalePricePlain'),
  // WP 9.9: the simple Reports / Taxes screens (services/simpleReports.ts, simpleTaxes.ts).
  simple_report_period: e('errors.reports.period', 'to'),
  simple_taxes_period: e('errors.taxes.period', 'period'),
  gst_filed_not_regular: e('errors.taxes.notRegular'),
  gst_filed_too_early: e('errors.taxes.tooEarly', 'date'),
  gst_filed_arn: e('errors.taxes.arn', 'arn'),
  gst_filed_date: e('errors.taxes.filedDate', 'date'),

  // ---------- IPC boundary (src/main/ipc.ts) ----------
  duplicate_name: e('errors.duplicateName', 'name'),
  not_permitted: e('errors.notAllowed'),
  session_locked: e('errors.signInFirst'),
  // ---------- WP 7.2 security (db/encryption.ts, services/dbEncryption.ts, ipc.ts) ----------
  db_locked: e('errors.security.locked'),
  db_key_mismatch: e('errors.security.keyMismatch'),
  passphrase_required: e('errors.security.passphraseRequired', 'passphrase'),
  wrong_passphrase: e('errors.security.wrongPassphrase', 'passphrase'),
  passphrase_throttled: e('errors.security.tooManyTries', 'passphrase'),
  passphrase_mismatch: e('errors.security.passphrasesDiffer', 'confirm'),
  security_already_locked: e('errors.security.alreadyLocked'),
  security_not_locked: e('errors.security.notLocked'),
  security_verify_failed: e('errors.security.verifyFailed'),
  /** No longer thrown since a business without people can lock its screen (a privacy screen); kept
   *  for an older main's answer, in the new words. */
  lock_needs_people: e('errors.security.lockPrivacyOnly'),
  unlock_needs_pin: e('errors.security.unlockNeedsPin'),
  // ---------- upgrade guard (db/migrate.ts, db/preUpgrade.ts) ----------
  db_newer_version: e('errors.upgrade.newer'),
  db_upgrade_copy_failed: e('errors.upgrade.copyFailed'),
  /** Zod: the payload didn't fit its schema — issues carry 'zod.<issue code>' (rules in map.ts). */
  invalid_input: e('errors.checkFields')
} as const satisfies Record<string, ErrorMapEntry>

export type ErrorCode = keyof typeof ERROR_MAP

export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_MAP, code)
}

export const WITHHOLDING_ERROR_SUFFIXES: readonly string[] = WITHHOLDING_SUFFIXES
