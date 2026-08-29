import type { DB } from '../db/connection'
import type { BankLineRow, BankRecon, ReconciliationStatus } from '@shared/reports'
import { isValidISODate } from '@shared/dates'
import {
  BUILTIN_PROFILES, guessProfile, detectProfile, parseStatement, statementHeader,
  type ParsedStatementRow, type ProfileColumns, type StatementProfile
} from '@shared/bankImport'
import {
  DEFAULT_CONFIDENCE_THRESHOLD, significantWords, suggestFromMemory,
  type MemoryEntry
} from '@shared/narrationMemory'
// IN_BOOKS, not NOT_DELETED: optional (memorandum) and unmatured post-dated vouchers are out of
// the books — the BRS/recon book balance must tie to the same ledger's statement (IN_BOOKS), and
// bank dates must not be assignable to out-of-books entries.
import { IN_BOOKS, saveVoucher } from './vouchers'
import { writeAudit } from './audit'
import { findSumCombos, matchRules, type RuleRow } from '@shared/bankRules'
import {
  CATEGORY_LABEL, classifyBankLine, voucherKindFor, type ChargeCategory
} from '@shared/bankCharges'
import { extractUtr, learnableNarration } from '@shared/upiStatement'
import { createLedger, descendantIdsByName } from './masters'
import type { BankRuleInput } from '@shared/schemas'

export function bankLedgers(db: DB): { id: number; name: string }[] {
  const ids = descendantIdsByName(db, ['Bank Accounts', 'Bank OD A/c'])
  return (db.prepare('SELECT id, name, group_id FROM ledgers ORDER BY name').all() as { id: number; name: string; group_id: number }[])
    .filter((l) => ids.has(l.group_id))
    .map((l) => ({ id: l.id, name: l.name }))
}

export function bankRecon(db: DB, ledgerId: number, from: string, to: string): BankRecon {
  const ledger = db.prepare('SELECT id, name, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; opening_balance: number }
    | undefined
  if (!ledger) throw new Error('Bank ledger not found')

  const rows = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.date, vt.name AS voucherType, v.number,
              v.instrument_no AS instrumentNo, vl.dr_cr AS drCr, vl.amount, vl.bank_date AS bankDate,
              (SELECT GROUP_CONCAT(DISTINCT l2.name)
               FROM voucher_lines vl2 JOIN ledgers l2 ON l2.id = vl2.ledger_id
               WHERE vl2.voucher_id = v.id AND vl2.dr_cr <> vl.dr_cr) AS particulars
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(ledgerId, from, to) as (Omit<BankLineRow, 'deposit' | 'withdrawal'> & { drCr: 'dr' | 'cr'; amount: number })[]

  const mapped: BankLineRow[] = rows.map((r) => ({
    lineId: r.lineId,
    voucherId: r.voucherId,
    date: r.date,
    voucherType: r.voucherType,
    number: r.number,
    particulars: r.particulars ?? '',
    instrumentNo: r.instrumentNo,
    deposit: r.drCr === 'dr' ? r.amount : 0,
    withdrawal: r.drCr === 'cr' ? r.amount : 0,
    bankDate: r.bankDate
  }))

  const bookRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}`
    )
    .get(ledgerId, to) as { m: number }
  const bookBalance = ledger.opening_balance + bookRow.m

  // As-on-date correctness: an entry cleared AFTER the period end was still outstanding within
  // the period, so a bank_date beyond `to` counts as unreconciled here.
  const unrec = (r: BankLineRow): boolean => !r.bankDate || r.bankDate > to
  const unrecDeposits = mapped.filter(unrec).reduce((s, r) => s + r.deposit, 0)
  const unrecWithdrawals = mapped.filter(unrec).reduce((s, r) => s + r.withdrawal, 0)

  return {
    ledgerId,
    ledgerName: ledger.name,
    bookBalance,
    unreconciledDeposits: unrecDeposits,
    unreconciledWithdrawals: unrecWithdrawals,
    bankBalance: bookBalance - unrecDeposits + unrecWithdrawals,
    rows: mapped
  }
}

// ---------- reconciliation freeze (#142) ----------

/**
 * Per-bank-account reconciliation lock.
 *
 * The company-wide books lock (`meta.lock_before`, see vouchers.ts) stops vouchers moving. It
 * says nothing about bank dates, so until now a signed-off reconciliation could be silently
 * undone: clearing one `bank_date` in a closed quarter changes last year's BRS, and nothing
 * anywhere records that it happened.
 *
 * Kept per ledger rather than company-wide on purpose. Accounts are reconciled on their own
 * schedules — the current account monthly with the statement, the OD account when the bank sends
 * its certificate — and one shared date would either lock an account nobody has reconciled yet
 * or leave the reconciled one open.
 *
 * Stored in `meta` under `recon_lock.<ledgerId>`, the same key/value pattern as the books lock,
 * so no migration and no new table for what is one date per account.
 */
export function getReconLock(db: DB, ledgerId: number): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`recon_lock.${ledgerId}`) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setReconLock(db: DB, ledgerId: number, date: string | null): void {
  if (date !== null && !isValidISODate(date)) throw new Error('Invalid reconciliation lock date')
  const bank = bankLedgers(db).find((b) => b.id === ledgerId)
  if (!bank) throw new Error('That ledger is not a bank account')
  const before = getReconLock(db, ledgerId)
  if (date === null) db.prepare('DELETE FROM meta WHERE key = ?').run(`recon_lock.${ledgerId}`)
  else {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`recon_lock.${ledgerId}`, date)
  }
  writeAudit(db, 'bank_recon_lock', ledgerId, 'update', { reconLockedTo: before }, { reconLockedTo: date })
}

/** Every bank account with its lock date, for the UI's one-glance answer to "what is frozen". */
export function listReconLocks(db: DB): { ledgerId: number; ledgerName: string; lockedTo: string | null }[] {
  return bankLedgers(db).map((b) => ({ ledgerId: b.id, ledgerName: b.name, lockedTo: getReconLock(db, b.id) }))
}

/**
 * Refuse a bank-date change that would alter a frozen reconciliation.
 *
 * Both ends are checked, and that is the point: moving a date OUT of the locked window changes
 * the frozen BRS exactly as much as moving one in. Inclusive of the lock date itself, to match
 * the books lock, which reads "locked up to and including".
 */
function assertReconOpen(db: DB, ledgerId: number, dates: (string | null)[]): void {
  const lock = getReconLock(db, ledgerId)
  if (!lock) return
  for (const d of dates) {
    if (d !== null && d <= lock) {
      throw new Error(`Reconciliation is frozen up to ${lock} on this account`)
    }
  }
}

export function setBankDate(db: DB, lineId: number, bankDate: string | null): void {
  if (bankDate !== null && !isValidISODate(bankDate)) throw new Error('Invalid bank date')
  const before = db
    .prepare(
      `SELECT vl.bank_date AS bankDate, vl.ledger_id AS ledgerId
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.id = ? AND ${IN_BOOKS}`
    )
    .get(lineId) as { bankDate: string | null; ledgerId: number } | undefined
  if (!before) throw new Error('Entry not found in the books')
  assertReconOpen(db, before.ledgerId, [before.bankDate, bankDate])
  const res = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?').run(bankDate, lineId)
  if (res.changes === 0) throw new Error('Entry not found')
  writeAudit(db, 'voucher_line', lineId, 'update', { bankDate: before.bankDate }, { bankDate })
}

// ---------- statement CSV import ----------

/** What one statement line says, once a profile has been applied to it. */
type StatementRow = ParsedStatementRow

/** A bank line in the books, with the two fields a reference match can be made on. */
interface OpenLine {
  lineId: number
  date: string
  drCr: 'dr' | 'cr'
  amount: number
  reference: string | null
  instrumentNo: string | null
}

/**
 * Read a statement CSV, choosing the profile the same way the UI does.
 *
 * Kept exported and CSV-in/rows-out because every caller in this file (import, suggestions,
 * bulk accept) has to read the same file the same way; if two of them disagreed about which
 * column held the amount, a preview would promise something the apply would not deliver.
 */
export function parseStatementCsv(csv: string, profile?: StatementProfile | null): StatementRow[] {
  return parseStatement(csv, profile).rows
}

export interface UnmatchedRow {
  date: string
  description: string
  reference: string
  amount: number
  kind: 'deposit' | 'withdrawal'
}

export interface ImportResult {
  statementRows: number
  matched: number
  alreadyReconciled: number
  unmatched: UnmatchedRow[]
  /** Per-match detail so the renderer can preview-confirm before applying (dryRun). */
  matches: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal'; lineId: number }[]
  /** Vouchers auto-created by auto_apply rules during an applying import (audited; empty on dryRun). */
  autoCreated: { date: string; description: string; amount: number; kind: 'deposit' | 'withdrawal'; voucherId: number; ruleId: number }[]
  /** Which profile read the file, so the preview can say so before anything is written. */
  profileId: string
  profileName: string
  /** Lines the profile could not read (no date, no amount, zero amount) — a big number here
   *  against a small statementRows is the signature of the wrong profile. */
  skipped: number
}

/**
 * Read-only matching pass shared by importStatement (which then writes bank_date on the matches)
 * and suggestVouchers (which only cares about what's left over): statement rows are matched to
 * unreconciled book entries by same amount, same direction, book date within ±5 days of the
 * statement date. Rows that miss every open entry but hit an ALREADY-reconciled one under the
 * same test are reported truthfully as alreadyReconciled (a re-imported statement) rather than
 * being lumped into unmatched.
 */
function matchStatement(
  db: DB,
  ledgerId: number,
  csv: string,
  profile?: StatementProfile | null
): {
  statement: StatementRow[]
  matches: { row: StatementRow; lineId: number }[]
  alreadyReconciled: StatementRow[]
  unmatched: UnmatchedRow[]
  usedLineIds: Set<number>
} {
  const statement = parseStatementCsv(csv, profile)
  const open = db
    .prepare(
      `SELECT vl.id AS lineId, v.date, vl.dr_cr AS drCr, vl.amount,
              v.reference, v.instrument_no AS instrumentNo
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NULL AND ${IN_BOOKS}`
    )
    .all(ledgerId) as OpenLine[]
  const reconciled = db
    .prepare(
      `SELECT vl.id AS lineId, v.date, vl.dr_cr AS drCr, vl.amount,
              v.reference, v.instrument_no AS instrumentNo
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NOT NULL AND ${IN_BOOKS}`
    )
    .all(ledgerId) as OpenLine[]

  const used = new Set<number>()
  const usedReconciled = new Set<number>()
  const matches: { row: StatementRow; lineId: number }[] = []
  const alreadyReconciled: StatementRow[] = []
  const unmatched: UnmatchedRow[] = []

  /**
   * A reference the two sides can be compared on: the statement row's own reference cell, or the
   * UPI UTR buried in its narration (#141). Digits only and case-folded, because one side writes
   * `N123456789` and the other `n-123456789` for the same transfer.
   */
  const refKeys = (text: string): string[] => {
    const keys: string[] = []
    const cleaned = text.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    // Under five characters is a serial number, not a reference — '1', '12' and 'chq' collide
    // with everything, and a reference match is only worth trusting when it is specific.
    if (cleaned.length >= 5) keys.push(cleaned)
    const utr = extractUtr(text)
    if (utr) keys.push(utr)
    return keys
  }

  /**
   * Exact-reference match, tried before the date-proximity one.
   *
   * A shared reference number is much stronger evidence than "same amount, within five days":
   * a UPI payer quotes the UTR when they say they have paid, and it lands in the receipt's
   * reference or cheque-number field. The amount still has to agree exactly — a reference that
   * matches on a different amount is a part-payment or a mis-keying, and neither should be
   * reconciled silently.
   */
  const byReference = (
    pool: OpenLine[],
    taken: Set<number>,
    row: StatementRow,
    amount: number,
    wantSide: 'dr' | 'cr'
  ): { lineId: number } | undefined => {
    const wanted = new Set([...refKeys(row.reference), ...refKeys(row.description)])
    if (wanted.size === 0) return undefined
    return pool.find((o) => {
      if (taken.has(o.lineId) || o.drCr !== wantSide || o.amount !== amount) return false
      const theirs = [...refKeys(o.reference ?? ''), ...refKeys(o.instrumentNo ?? '')]
      return theirs.some((k) => wanted.has(k))
    })
  }

  const closest = (
    pool: OpenLine[],
    taken: Set<number>,
    row: StatementRow,
    amount: number,
    wantSide: 'dr' | 'cr'
  ): { lineId: number } | undefined =>
    pool
      .filter((o) => !taken.has(o.lineId) && o.drCr === wantSide && o.amount === amount)
      .map((o) => ({ o, gap: Math.abs(Date.parse(o.date) - Date.parse(row.date)) }))
      .filter((c) => c.gap <= 5 * 86_400_000)
      .sort((a, b) => a.gap - b.gap)[0]?.o

  for (const row of statement) {
    const amount = row.deposit || row.withdrawal
    const wantSide = row.deposit > 0 ? 'dr' : 'cr'
    const candidate = byReference(open, used, row, amount, wantSide) ?? closest(open, used, row, amount, wantSide)
    if (candidate) {
      used.add(candidate.lineId)
      matches.push({ row, lineId: candidate.lineId })
      continue
    }
    const done =
      byReference(reconciled, usedReconciled, row, amount, wantSide) ??
      closest(reconciled, usedReconciled, row, amount, wantSide)
    if (done) {
      usedReconciled.add(done.lineId)
      alreadyReconciled.push(row)
      continue
    }
    unmatched.push({
      date: row.date,
      description: row.description,
      reference: row.reference,
      amount,
      kind: row.deposit > 0 ? 'deposit' : 'withdrawal'
    })
  }

  return { statement, matches, alreadyReconciled, unmatched, usedLineIds: used }
}

/**
 * Match statement rows to unreconciled book entries: same amount, same direction, book date
 * within ±5 days of the statement date. With `apply` (the default), matches get their bank_date
 * set and active auto_apply rules create vouchers for whatever's left — all in one transaction.
 * With `apply: false` this is a pure preview (nothing written), so the renderer can confirm
 * before committing; there is no undo, the preview IS the safety net.
 */
export function importStatement(
  db: DB,
  ledgerId: number,
  csv: string,
  opts: { apply?: boolean; profile?: StatementProfile | null } = {}
): ImportResult {
  const apply = opts.apply !== false
  const read = parseStatement(csv, opts.profile)
  const { statement, matches, alreadyReconciled, unmatched } = matchStatement(db, ledgerId, csv, read.profile)

  const matchDetail = matches.map((m) => ({
    date: m.row.date,
    description: m.row.description,
    amount: m.row.deposit || m.row.withdrawal,
    kind: (m.row.deposit > 0 ? 'deposit' : 'withdrawal') as 'deposit' | 'withdrawal',
    lineId: m.lineId
  }))
  const autoCreated: ImportResult['autoCreated'] = []
  let remaining = unmatched

  if (apply) {
    // #142: an import writes bank dates in bulk, so it is the easiest way to walk over a frozen
    // period without noticing. Checked before anything is written rather than row by row — a
    // half-applied import is worse than a refused one.
    assertReconOpen(db, ledgerId, matches.map((m) => m.row.date))
    const setStmt = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?')
    const run = db.transaction(() => {
      for (const m of matches) setStmt.run(m.row.date, m.lineId)

      // Opt-in auto-apply: rules flagged auto_apply create the voucher outright (same draft
      // shape suggestVouchers offers) and reconcile its bank line against the statement row.
      const autoRules: RuleRow[] = listRules(db)
        .filter((r) => r.active && r.autoApply)
        .map((r) => ({
          id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind,
          matchField: r.matchField === 'reference' ? 'reference' : 'description',
          minAmount: r.minAmount, maxAmount: r.maxAmount
        }))
      if (autoRules.length > 0) {
        const stillUnmatched: UnmatchedRow[] = []
        for (const u of unmatched) {
          const like = {
            description: u.description,
            reference: u.reference,
            deposit: u.kind === 'deposit' ? u.amount : 0,
            withdrawal: u.kind === 'withdrawal' ? u.amount : 0
          }
          const hit = matchRules([like], autoRules)[0]
          if (!hit) {
            stillUnmatched.push(u)
            continue
          }
          const rule = hit.rule
          const isPayment = rule.kind === 'payment'
          const vt = db
            .prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1')
            .get(rule.kind) as { id: number } | undefined
          if (!vt) {
            stillUnmatched.push(u)
            continue
          }
          const voucher = saveVoucher(db, {
            voucherTypeId: vt.id,
            date: u.date,
            number: undefined,
            partyLedgerId: null,
            narration: `${u.description} (auto-created by bank rule)`,
            reference: u.reference || null,
            instrumentNo: null,
            instrumentDate: null,
            transporterId: null,
            vehicleNo: null,
            transportDistanceKm: null,
            currencyCode: null,
            exchangeRate: null,
            lines: [
              { ledgerId: rule.ledgerId, drCr: isPayment ? 'dr' : 'cr', amount: u.amount, costAllocations: [] },
              { ledgerId, drCr: isPayment ? 'cr' : 'dr', amount: u.amount, costAllocations: [] }
            ],
            inventory: [],
            billRefs: [],
            tds: null
          })
          const bankLine = voucher.lines.find((l) => l.ledgerId === ledgerId)
          if (bankLine) setStmt.run(u.date, bankLine.id)
          recordRuleHit(db, rule.id)
          autoCreated.push({ date: u.date, description: u.description, amount: u.amount, kind: u.kind, voucherId: voucher.id, ruleId: rule.id })
        }
        remaining = stillUnmatched
      }
    })
    run()
  }

  // [lane-Q audit block — keep as one unit when merging] statement-import summary audit row.
  // Not written for dry runs (lane Y's preview-confirm flow) — only an applied import is an event.
  if (apply) {
    writeAudit(db, 'bank_statement', ledgerId, 'import', null,
      { statementRows: statement.length, matched: matches.length, unmatched: remaining.length })
  }

  return {
    statementRows: statement.length,
    matched: matches.length,
    alreadyReconciled: alreadyReconciled.length,
    unmatched: remaining,
    matches: matchDetail,
    autoCreated,
    profileId: read.profile.id,
    profileName: read.profile.name,
    skipped: read.skipped.length
  }
}

// ---------- bank rules (auto-categorization) ----------

export interface BankRuleRecord {
  id: number
  pattern: string
  matchField: string
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  /** Amount window (paise, inclusive); null = unbounded. */
  minAmount: number | null
  maxAmount: number | null
  /** Opt-in: an applying statement import creates the voucher outright when this rule matches. */
  autoApply: boolean
  active: boolean
  hits: number
}

export function listRules(db: DB): BankRuleRecord[] {
  return (
    db
      .prepare(
        `SELECT r.id, r.pattern, r.match_field AS matchField, r.ledger_id AS ledgerId,
                l.name AS ledgerName, r.kind, r.min_amount AS minAmount, r.max_amount AS maxAmount,
                r.auto_apply AS autoApply, r.active, r.hits
         FROM bank_rules r JOIN ledgers l ON l.id = r.ledger_id
         ORDER BY r.pattern COLLATE NOCASE`
      )
      .all() as (Omit<BankRuleRecord, 'active' | 'autoApply'> & { active: number; autoApply: number })[]
  ).map((r) => ({ ...r, active: !!r.active, autoApply: !!r.autoApply }))
}

export function saveRule(db: DB, input: BankRuleInput, id?: number): BankRuleRecord {
  const matchField = input.matchField ?? 'description'
  const minAmount = input.minAmount ?? null
  const maxAmount = input.maxAmount ?? null
  const autoApply = input.autoApply ? 1 : 0
  if (minAmount != null && maxAmount != null && minAmount > maxAmount) {
    throw new Error('Minimum amount cannot exceed the maximum')
  }
  if (id != null) {
    const before = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(id)
    if (!before) throw new Error('Bank rule not found')
    db.prepare(
      `UPDATE bank_rules SET pattern = ?, match_field = ?, ledger_id = ?, kind = ?,
       min_amount = ?, max_amount = ?, auto_apply = ?, active = ? WHERE id = ?`
    ).run(input.pattern, matchField, input.ledgerId, input.kind, minAmount, maxAmount, autoApply, input.active ? 1 : 0, id)
    writeAudit(db, 'bank_rule', id, 'update', before, input)
  } else {
    const res = db
      .prepare(
        `INSERT INTO bank_rules (pattern, match_field, ledger_id, kind, min_amount, max_amount, auto_apply, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.pattern, matchField, input.ledgerId, input.kind, minAmount, maxAmount, autoApply, input.active ? 1 : 0)
    id = Number(res.lastInsertRowid)
    writeAudit(db, 'bank_rule', id, 'create', null, input)
  }
  const row = listRules(db).find((r) => r.id === id)
  if (!row) throw new Error('Bank rule not found after save')
  return row
}

export function deleteRule(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM bank_rules WHERE id = ?').get(id)
  if (!before) throw new Error('Bank rule not found')
  db.prepare('DELETE FROM bank_rules WHERE id = ?').run(id)
  writeAudit(db, 'bank_rule', id, 'delete', before, null)
}

/** Increments a rule's hit counter — called when the user files a voucher built from one of its
 *  suggestions (see suggestVouchers), so "Rules…" can show how often each rule actually fires. */
export function recordRuleHit(db: DB, ruleId: number): void {
  const res = db.prepare('UPDATE bank_rules SET hits = hits + 1 WHERE id = ?').run(ruleId)
  if (res.changes === 0) throw new Error('Bank rule not found')
}

/** Neutral voucher-draft shape consumed by the renderer's voucher-entry nav draft
 *  (see src/renderer/src/state/stores.ts VoucherDraft — partyLedgerId is simply omitted here). */
export interface BankVoucherDraft {
  date: string
  narration: string
  lines: { ledgerId: number; drCr: 'dr' | 'cr'; amount: number }[]
}

export interface BankSuggestion {
  /** null for a suggestion the narration memory produced — there is no rule behind it yet. */
  ruleId: number | null
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  voucherDraft: BankVoucherDraft
  /** 'rule': a rule the user wrote. 'learned': words remembered from past matches (#133).
   *  'charge': the bank's own charge or interest, recognised from the narration (#135). */
  source: 'rule' | 'learned' | 'charge'
  /** 0–100. A rule is 100 — the user already said so in as many words. */
  confidence: number
  /** The narration words that carried a learned match; empty for a rule. */
  matched: string[]
  /** Another ledger fits the narration exactly as well. Never bulk-accepted. */
  ambiguous: boolean
}

export interface BankSuggestionRow {
  statementRow: UnmatchedRow
  suggestion: BankSuggestion | null
  /** Set whenever the narration reads as the bank's own charge or interest (#135), even when the
   *  ledger to post it to does not exist yet — that is exactly when the UI needs to offer to
   *  create it, and a null `suggestion` alone could not tell the two situations apart. */
  chargeCategory?: ChargeCategory
}

// ---------- the bank's own charges and interest (#135) ----------

/** The four ledgers a recognised charge/interest row posts to, and where each belongs. */
const CHARGE_LEDGER_GROUPS: Record<ChargeCategory, string> = {
  charge: 'Indirect Expenses',
  // Input tax, not an expense: it is recoverable, and burying it in the P&L overstates costs and
  // loses the credit. Duties & Taxes is where the rest of the GST ledgers live.
  gst_on_charge: 'Duties & Taxes',
  interest_paid: 'Indirect Expenses',
  interest_earned: 'Indirect Incomes'
}

export interface ChargeLedgerRow {
  category: ChargeCategory
  name: string
  /** null when the ledger does not exist yet — setupChargeLedgers creates it. */
  ledgerId: number | null
  groupName: string
}

/**
 * Which of the four charge ledgers exist, by the exact name this app gives them.
 *
 * Matched on name rather than on a stored id because these are ordinary ledgers: a user may have
 * created "Bank Charges" years ago in Tally and imported it, and adopting theirs is right. A
 * rename means the app stops recognising it and offers to create one again, which is visible and
 * recoverable — a hidden id pointing at a ledger they since repurposed would not be.
 */
export function chargeLedgers(db: DB): ChargeLedgerRow[] {
  const stmt = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE')
  return (Object.keys(CHARGE_LEDGER_GROUPS) as ChargeCategory[]).map((category) => {
    const name = CATEGORY_LABEL[category]
    const row = stmt.get(name) as { id: number } | undefined
    return { category, name, ledgerId: row?.id ?? null, groupName: CHARGE_LEDGER_GROUPS[category] }
  })
}

/**
 * Create whichever of the four charge ledgers are missing. Idempotent.
 *
 * Deliberately an explicit action rather than something a statement import does on its own: four
 * ledgers appearing in the chart of accounts because a file was opened is the kind of surprise
 * that makes people distrust an importer.
 */
export function setupChargeLedgers(db: DB): { created: string[]; existing: string[] } {
  const created: string[] = []
  const existing: string[] = []
  const run = db.transaction(() => {
    for (const row of chargeLedgers(db)) {
      if (row.ledgerId != null) {
        existing.push(row.name)
        continue
      }
      const group = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(row.groupName) as
        | { id: number }
        | undefined
      if (!group) throw new Error(`No "${row.groupName}" group to create ${row.name} under`)
      createLedger(db, { name: row.name, groupId: group.id })
      created.push(row.name)
    }
  })
  run()
  return { created, existing }
}

/** Confidence a recognised charge is offered at. Below 100 (which means "the user wrote a rule
 *  saying so") and above the memory's own ceiling, so bulk-accept files these by default. */
const CHARGE_CONFIDENCE = 95

/** The recognised-charge suggestion for one row, or null when nothing about it is a bank charge
 *  or the ledger it would post to has not been created yet. */
function chargeSuggestionFor(
  bankLedgerId: number,
  row: UnmatchedRow,
  ledgers: Map<ChargeCategory, { id: number; name: string }>
): { suggestion: BankSuggestion | null; category: ChargeCategory | null } {
  const hit = classifyBankLine(row.description, row.kind)
  if (!hit) return { suggestion: null, category: null }
  const ledger = ledgers.get(hit.category)
  if (!ledger) return { suggestion: null, category: hit.category }
  const kind = voucherKindFor(hit.category)
  return {
    category: hit.category,
    suggestion: {
      ruleId: null,
      ledgerId: ledger.id,
      ledgerName: ledger.name,
      kind,
      voucherDraft: draftFor(bankLedgerId, row, ledger.id, kind),
      source: 'charge',
      confidence: CHARGE_CONFIDENCE,
      matched: [hit.phrase],
      ambiguous: false
    }
  }
}

/** Active bank rules in the shared matcher's RuleRow shape (matchField/amount bounds included). */
function activeRuleRows(db: DB): { rules: RuleRow[]; ruleNames: Map<number, string> } {
  const allRules = listRules(db)
  const rules: RuleRow[] = allRules
    .filter((r) => r.active)
    .map((r) => ({
      id: r.id, pattern: r.pattern, ledgerId: r.ledgerId, kind: r.kind,
      matchField: r.matchField === 'reference' ? 'reference' : 'description',
      minAmount: r.minAmount, maxAmount: r.maxAmount
    }))
  return { rules, ruleNames: new Map(allRules.map((r) => [r.id, r.ledgerName])) }
}

/**
 * Draft that turns one statement row into a voucher: the suggested ledger on one side, the bank
 * on the other. Shared by rule matches and learned matches so both file identically.
 */
function draftFor(
  bankLedgerId: number,
  row: UnmatchedRow,
  ledgerId: number,
  kind: 'payment' | 'receipt'
): BankVoucherDraft {
  const isPayment = kind === 'payment'
  return {
    date: row.date,
    narration: row.description,
    lines: [
      { ledgerId, drCr: isPayment ? 'dr' : 'cr', amount: row.amount },
      { ledgerId: bankLedgerId, drCr: isPayment ? 'cr' : 'dr', amount: row.amount }
    ]
  }
}

/**
 * Best suggestion for one unmatched statement row: a bank rule if one fires, otherwise whatever
 * the narration memory has learned.
 *
 * Rules win outright and at full confidence, because a rule is the user having already answered
 * this question in writing. The memory only speaks where nobody has.
 */
function suggestFor(
  bankLedgerId: number,
  row: UnmatchedRow,
  rules: RuleRow[],
  ruleNames: Map<number, string>,
  memory: MemoryEntry[],
  ledgerNames: Map<number, string>,
  chargeLedgerIds: Map<ChargeCategory, { id: number; name: string }>
): BankSuggestion | null {
  const statementLike = {
    description: row.description,
    reference: row.reference,
    deposit: row.kind === 'deposit' ? row.amount : 0,
    withdrawal: row.kind === 'withdrawal' ? row.amount : 0
  }
  const match = matchRules([statementLike], rules)[0]
  if (match) {
    const rule = match.rule
    return {
      ruleId: rule.id,
      ledgerId: rule.ledgerId,
      ledgerName: ruleNames.get(rule.id) ?? '',
      kind: rule.kind,
      voucherDraft: draftFor(bankLedgerId, row, rule.ledgerId, rule.kind),
      source: 'rule',
      confidence: 100,
      matched: [],
      ambiguous: false
    }
  }

  // Between a user's rule and a fuzzy word memory sits the bank's own charge line (#135): the
  // narration is the bank talking about itself, and there is nothing to learn about it. Ahead of
  // memory because memory would otherwise attach last quarter's charge to whichever supplier
  // happened to share a word with it.
  const charge = chargeSuggestionFor(bankLedgerId, row, chargeLedgerIds)
  if (charge.suggestion) return charge.suggestion

  const kind: 'payment' | 'receipt' = row.kind === 'deposit' ? 'receipt' : 'payment'
  const learned = suggestFromMemory(learnableNarration(row.description), kind, memory)
  if (!learned) return null
  const name = ledgerNames.get(learned.ledgerId)
  // A ledger deleted since it was learned leaves memory rows behind (FK cascade covers the row
  // itself, but a stale in-memory list would not) — no name, no suggestion.
  if (!name) return null
  return {
    ruleId: null,
    ledgerId: learned.ledgerId,
    ledgerName: name,
    kind,
    voucherDraft: draftFor(bankLedgerId, row, learned.ledgerId, kind),
    source: 'learned',
    confidence: learned.confidence,
    matched: learned.matched,
    ambiguous: learned.ambiguous
  }
}

/**
 * Runs the same matching importStatement uses (matchStatement) to find the statement rows that
 * still have no book-entry match, then offers a ledger per row — from an active bank rule where
 * one fires, otherwise from the narration memory, with the confidence that memory earns.
 * Read-only: never sets bank_date, never touches bank_rules.hits (that's recordRuleHit, called
 * once the user actually files a suggested voucher) and never learns (that's learnFromMatch).
 */
export function suggestVouchers(db: DB, ledgerId: number, csv: string, profile?: StatementProfile | null): BankSuggestionRow[] {
  const { unmatched } = matchStatement(db, ledgerId, csv, profile)
  const { rules, ruleNames } = activeRuleRows(db)
  const memory = loadMemory(db)
  const ledgerNames = allLedgerNames(db)
  const charges = new Map(
    chargeLedgers(db)
      .filter((c) => c.ledgerId != null)
      .map((c) => [c.category, { id: c.ledgerId!, name: c.name }] as const)
  )

  return unmatched.map((u) => {
    const category = classifyBankLine(u.description, u.kind)?.category
    const row: BankSuggestionRow = {
      statementRow: u,
      suggestion: suggestFor(ledgerId, u, rules, ruleNames, memory, ledgerNames, charges)
    }
    if (category) row.chargeCategory = category
    return row
  })
}

// ---------- statement matching v2: tolerance + many-to-one suggestions (task Y2) ----------

export interface BankMatchSuggestion {
  statementRow: UnmatchedRow
  /** 'tolerance': one open entry within ±tolerance of the row amount.
   *  'many_to_one': ≤3 open entries of the same party summing to the row amount. */
  kind: 'tolerance' | 'many_to_one'
  lines: { lineId: number; voucherId: number; date: string; number: string; amount: number }[]
}

/**
 * Suggestions-only second pass over the rows the exact matcher (pass 1, dbtest-locked) left
 * unmatched: (a) a single open entry whose amount is within ±tolerance (default ±₹1) of the
 * statement row, same direction, ±5 days; (b) many-to-one — up to three open entries from
 * vouchers of the SAME party whose amounts sum to the row (±tolerance), e.g. one NEFT settling
 * three invoices. Read-only: nothing is written; the renderer reconciles the suggested lines
 * explicitly via bank:setBankDate.
 */
export function matchSuggestions(db: DB, ledgerId: number, csv: string, tolerancePaise = 100, profile?: StatementProfile | null): BankMatchSuggestion[] {
  const { unmatched, usedLineIds } = matchStatement(db, ledgerId, csv, profile)
  if (unmatched.length === 0) return []

  const open = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.date, v.number, vl.dr_cr AS drCr, vl.amount,
              COALESCE(v.party_ledger_id,
                       (SELECT MIN(vl2.ledger_id) FROM voucher_lines vl2
                        WHERE vl2.voucher_id = v.id AND vl2.ledger_id <> vl.ledger_id)) AS partyKey
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND vl.bank_date IS NULL AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(ledgerId) as {
      lineId: number; voucherId: number; date: string; number: string
      drCr: 'dr' | 'cr'; amount: number; partyKey: number | null
    }[]

  const taken = new Set<number>(usedLineIds)
  const suggestions: BankMatchSuggestion[] = []

  for (const row of unmatched) {
    const wantSide = row.kind === 'deposit' ? 'dr' : 'cr'
    const pool = open.filter((o) => !taken.has(o.lineId) && o.drCr === wantSide)

    // (a) tolerance: closest near-miss single within ±5 days
    const single = pool
      .filter((o) => Math.abs(o.amount - row.amount) <= tolerancePaise)
      .map((o) => ({ o, gap: Math.abs(Date.parse(o.date) - Date.parse(row.date)) }))
      .filter((c) => c.gap <= 5 * 86_400_000)
      .sort((a, b) => a.gap - b.gap || Math.abs(a.o.amount - row.amount) - Math.abs(b.o.amount - row.amount))[0]
    if (single) {
      taken.add(single.o.lineId)
      suggestions.push({
        statementRow: row,
        kind: 'tolerance',
        lines: [{ lineId: single.o.lineId, voucherId: single.o.voucherId, date: single.o.date, number: single.o.number, amount: single.o.amount }]
      })
      continue
    }

    // (b) many-to-one: ≤3 open entries of the same party summing to the row amount
    const byParty = new Map<number, typeof pool>()
    for (const o of pool) {
      if (o.partyKey == null) continue
      const list = byParty.get(o.partyKey) ?? []
      list.push(o)
      byParty.set(o.partyKey, list)
    }
    for (const group of byParty.values()) {
      if (group.length < 2) continue
      const combo = findSumCombos(row.amount, group.map((g) => g.amount), 3, tolerancePaise, 1)[0]
      if (!combo) continue
      const lines = combo.map((i) => group[i]!)
      for (const l of lines) taken.add(l.lineId)
      suggestions.push({
        statementRow: row,
        kind: 'many_to_one',
        lines: lines.map((l) => ({ lineId: l.lineId, voucherId: l.voucherId, date: l.date, number: l.number, amount: l.amount }))
      })
      break
    }
  }

  return suggestions
}

// ---------- bank reconciliation statement (BRS, task Y2) ----------

export interface BrsItem {
  lineId: number
  voucherId: number
  date: string
  voucherType: string
  number: string
  particulars: string
  instrumentNo: string | null
  amount: number
}

export interface BrsReport {
  ledgerId: number
  ledgerName: string
  asOn: string
  /** Balance per company books as on the date (dr-positive paise). */
  bookBalance: number
  /** Deposits recorded in the books but not yet credited by the bank as on the date. */
  uncredited: BrsItem[]
  uncreditedTotal: number
  /** Cheques/withdrawals issued in the books but not yet presented as on the date. */
  unpresented: BrsItem[]
  unpresentedTotal: number
  /** Derived balance per bank statement: book − uncredited + unpresented. */
  bankBalance: number
}

/**
 * Bank reconciliation statement as on a date. As-on-date correctness (task Y2 #87): an entry
 * whose bank_date falls AFTER `asOn` was still outstanding on that date, so it lists as
 * unpresented/uncredited here even though it has since cleared.
 */
export function brs(db: DB, ledgerId: number, asOn: string): BrsReport {
  const ledger = db.prepare('SELECT id, name, opening_balance FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; opening_balance: number }
    | undefined
  if (!ledger) throw new Error('Bank ledger not found')

  const rows = db
    .prepare(
      `SELECT vl.id AS lineId, v.id AS voucherId, v.date, vt.name AS voucherType, v.number,
              v.instrument_no AS instrumentNo, vl.dr_cr AS drCr, vl.amount,
              (SELECT GROUP_CONCAT(DISTINCT l2.name)
               FROM voucher_lines vl2 JOIN ledgers l2 ON l2.id = vl2.ledger_id
               WHERE vl2.voucher_id = v.id AND vl2.dr_cr <> vl.dr_cr) AS particulars
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND (vl.bank_date IS NULL OR vl.bank_date > ?)
         AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(ledgerId, asOn, asOn) as (Omit<BrsItem, 'particulars'> & { drCr: 'dr' | 'cr'; particulars: string | null })[]

  const bookRow = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END), 0) AS m
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}`
    )
    .get(ledgerId, asOn) as { m: number }
  const bookBalance = ledger.opening_balance + bookRow.m

  const toItem = (r: (typeof rows)[number]): BrsItem => ({
    lineId: r.lineId, voucherId: r.voucherId, date: r.date, voucherType: r.voucherType,
    number: r.number, particulars: r.particulars ?? '', instrumentNo: r.instrumentNo, amount: r.amount
  })
  const uncredited = rows.filter((r) => r.drCr === 'dr').map(toItem)
  const unpresented = rows.filter((r) => r.drCr === 'cr').map(toItem)
  const uncreditedTotal = uncredited.reduce((s, r) => s + r.amount, 0)
  const unpresentedTotal = unpresented.reduce((s, r) => s + r.amount, 0)

  return {
    ledgerId,
    ledgerName: ledger.name,
    asOn,
    bookBalance,
    uncredited,
    uncreditedTotal,
    unpresented,
    unpresentedTotal,
    bankBalance: bookBalance - uncreditedTotal + unpresentedTotal
  }
}

/**
 * Where every bank account stands on reconciliation, as on one date.
 *
 * The reconciliation screen answers this one account at a time and only after you pick one, so a
 * business with four accounts has no way to see that three are current and one has not been
 * touched since June — which is exactly the account with the problem in it.
 *
 * "Unreconciled" is as-on-date, matching `bankRecon`: an entry cleared AFTER the date asked for
 * was still outstanding on that date, so a bank date beyond it counts as unreconciled here too.
 * Getting that wrong would make a back-dated report disagree with the BRS printed from the same
 * date, which is the one comparison anyone makes.
 */
export function reconciliationStatus(db: DB, asOn: string): ReconciliationStatus[] {
  const accounts = bankLedgers(db)

  return accounts.map((account) => {
    const rows = db
      .prepare(
        `SELECT v.date, vl.dr_cr AS drCr, vl.amount, vl.bank_date AS bankDate
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         WHERE vl.ledger_id = ? AND v.date <= ? AND ${IN_BOOKS}`
      )
      .all(account.id, asOn) as { date: string; drCr: 'dr' | 'cr'; amount: number; bankDate: string | null }[]

    const opening = (
      db.prepare('SELECT opening_balance AS o FROM ledgers WHERE id = ?').get(account.id) as { o: number }
    ).o
    const bookBalance =
      opening + rows.reduce((sum, r) => sum + (r.drCr === 'dr' ? r.amount : -r.amount), 0)

    const isUnreconciled = (r: { bankDate: string | null }): boolean => !r.bankDate || r.bankDate > asOn
    const unreconciled = rows.filter(isUnreconciled)

    const ageing: [number, number, number, number] = [0, 0, 0, 0]
    let oldestUnreconciledDays = 0
    for (const r of unreconciled) {
      const age = Math.max(
        0,
        Math.round((Date.parse(asOn + 'T00:00:00Z') - Date.parse(r.date + 'T00:00:00Z')) / 86_400_000)
      )
      oldestUnreconciledDays = Math.max(oldestUnreconciledDays, age)
      const bucket = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3
      ageing[bucket] += 1
    }

    const lastReconciled = rows
      .map((r) => r.bankDate)
      .filter((d): d is string => !!d && d <= asOn)
      .sort()
      .pop()

    const unreconciledDeposits = unreconciled.reduce((s, r) => s + (r.drCr === 'dr' ? r.amount : 0), 0)
    const unreconciledWithdrawals = unreconciled.reduce((s, r) => s + (r.drCr === 'cr' ? r.amount : 0), 0)

    return {
      ledgerId: account.id,
      name: account.name,
      bookBalance,
      // Same derivation as bankRecon's: a deposit we have booked but the bank has not credited
      // is money the statement does not show yet, and a cheque issued but not presented is money
      // the statement still shows.
      bankBalance: bookBalance - unreconciledDeposits + unreconciledWithdrawals,
      totalLines: rows.length,
      reconciledLines: rows.length - unreconciled.length,
      unreconciledDeposits,
      unreconciledWithdrawals,
      ageing,
      lastReconciledDate: lastReconciled ?? null,
      oldestUnreconciledDays
    }
  })
}

// ---------- statement import profiles (#131) ----------

/** A profile as the renderer sees it: built-ins and user-saved ones in one list. */
export type ImportProfileRecord = StatementProfile

export interface ImportProfileInput {
  name: string
  dateFormat: StatementProfile['dateFormat']
  convention: StatementProfile['convention']
  debitFlag: string | null
  columns: ProfileColumns
}

function userProfileRows(db: DB): StatementProfile[] {
  const rows = db
    .prepare(
      `SELECT id, name, date_format AS dateFormat, convention, debit_flag AS debitFlag,
              columns_json AS columnsJson
       FROM bank_import_profiles ORDER BY name COLLATE NOCASE`
    )
    .all() as { id: number; name: string; dateFormat: string; convention: string; debitFlag: string | null; columnsJson: string }[]

  return rows.map((r) => ({
    id: `user:${r.id}`,
    name: r.name,
    builtIn: false,
    dateFormat: r.dateFormat as StatementProfile['dateFormat'],
    convention: r.convention as StatementProfile['convention'],
    debitFlag: r.debitFlag,
    columns: JSON.parse(r.columnsJson) as ProfileColumns
  }))
}

/** Built-ins first (they are the common case), then whatever this company has mapped by hand. */
export function listImportProfiles(db: DB): ImportProfileRecord[] {
  return [...BUILTIN_PROFILES, ...userProfileRows(db)]
}

/**
 * Profiles are not audited.
 *
 * The audit trail is for things that change what the books say. A column map changes how one CSV
 * is read; the import it feeds IS audited, with the profile named on it. Filling the trail with
 * "user renamed a column mapping" would make the entries that matter harder to find.
 */
export function saveImportProfile(db: DB, input: ImportProfileInput, id?: number): ImportProfileRecord {
  const columnsJson = JSON.stringify(input.columns)
  if (input.convention === 'flagged' && !input.debitFlag?.trim()) {
    throw new Error('A Dr/Cr statement needs the text that means a withdrawal, e.g. DR')
  }
  if (id != null) {
    const before = db.prepare('SELECT * FROM bank_import_profiles WHERE id = ?').get(id)
    if (!before) throw new Error('Import profile not found')
    db.prepare(
      `UPDATE bank_import_profiles SET name = ?, date_format = ?, convention = ?, debit_flag = ?,
       columns_json = ? WHERE id = ?`
    ).run(input.name, input.dateFormat, input.convention, input.debitFlag, columnsJson, id)
  } else {
    const res = db
      .prepare(
        `INSERT INTO bank_import_profiles (name, date_format, convention, debit_flag, columns_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.name, input.dateFormat, input.convention, input.debitFlag, columnsJson)
    id = Number(res.lastInsertRowid)
  }
  const saved = userProfileRows(db).find((p) => p.id === `user:${id}`)
  if (!saved) throw new Error('Import profile not found after save')
  return saved
}

export function deleteImportProfile(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM bank_import_profiles WHERE id = ?').get(id)
  if (!before) throw new Error('Import profile not found')
  db.prepare('DELETE FROM bank_import_profiles WHERE id = ?').run(id)
}

/** An ad-hoc mapping the user made in the column mapper but has not saved as a profile. */
export type AdHocProfile = Omit<ImportProfileInput, 'name'> & { name?: string }

/**
 * Which profile to read a statement with.
 *
 * An explicit column map wins (the user is standing in the mapper looking at their own file), then
 * a named profile, then nothing — which leaves `parseStatement` to detect a built-in or fall back
 * to the wording heuristic.
 */
export function resolveProfile(
  db: DB,
  opts: { profileId?: string | null; adHoc?: AdHocProfile | null } = {}
): StatementProfile | null {
  if (opts.adHoc) {
    return {
      id: 'adhoc',
      name: opts.adHoc.name ?? 'Custom columns',
      builtIn: false,
      dateFormat: opts.adHoc.dateFormat,
      convention: opts.adHoc.convention,
      debitFlag: opts.adHoc.debitFlag,
      columns: opts.adHoc.columns
    }
  }
  if (!opts.profileId) return null
  const found = listImportProfiles(db).find((p) => p.id === opts.profileId)
  if (!found) throw new Error('Import profile not found')
  return found
}

export interface StatementInspection {
  header: string[]
  /** null when nothing recognised the file — the renderer's cue to open the column mapper. */
  profileId: string | null
  profileName: string | null
  /** True only when a stored/built-in profile claimed the header, not when we guessed. */
  detected: boolean
  /** The mapping being proposed, so the mapper opens pre-filled rather than blank. */
  columns: ProfileColumns | null
  dateFormat: StatementProfile['dateFormat']
  convention: StatementProfile['convention']
  debitFlag: string | null
  /** What that mapping would actually read, so the user sees the answer before committing. */
  rowsReadable: number
  rowsSkipped: number
  /** First few readable rows, for the mapper's preview table. */
  sample: { date: string; description: string; reference: string; deposit: number; withdrawal: number }[]
  /** Set when the chosen profile cannot be applied at all; the mapper is the only way forward. */
  error: string | null
}

/**
 * Look at a statement without importing it: which profile fits, what it would read, what it
 * would skip.
 *
 * The whole point of #131 is that an unrecognised file must not fail — it must land the user in a
 * column mapper with the best guess already filled in. So nothing here throws for a bad mapping;
 * the failure is data on the way back.
 */
export function inspectStatement(
  db: DB,
  csv: string,
  opts: { profileId?: string | null; adHoc?: AdHocProfile | null } = {}
): StatementInspection {
  const header = statementHeader(csv)
  let chosen: StatementProfile | null = null
  let detected = false
  try {
    chosen = resolveProfile(db, opts)
  } catch {
    chosen = null
  }
  if (!chosen) {
    chosen = detectProfile(header, listImportProfiles(db))
    detected = chosen != null
    if (!chosen) chosen = guessProfile(header)
  } else {
    detected = opts.adHoc == null
  }

  const base = {
    header,
    profileId: chosen?.id ?? null,
    profileName: chosen?.name ?? null,
    detected,
    columns: chosen?.columns ?? null,
    dateFormat: chosen?.dateFormat ?? ('dmy' as const),
    convention: chosen?.convention ?? ('debit_credit' as const),
    debitFlag: chosen?.debitFlag ?? null
  }
  if (!chosen) {
    return { ...base, rowsReadable: 0, rowsSkipped: 0, sample: [], error: 'No profile matches this file — pick the columns by hand' }
  }
  try {
    const read = parseStatement(csv, chosen)
    return {
      ...base,
      rowsReadable: read.rows.length,
      rowsSkipped: read.skipped.length,
      sample: read.rows.slice(0, 5).map((r) => ({
        date: r.date, description: r.description, reference: r.reference, deposit: r.deposit, withdrawal: r.withdrawal
      })),
      error: null
    }
  } catch (err) {
    return { ...base, rowsReadable: 0, rowsSkipped: 0, sample: [], error: (err as Error).message }
  }
}

// ---------- narration memory (#133) ----------

function loadMemory(db: DB): MemoryEntry[] {
  return db
    .prepare('SELECT keyword, ledger_id AS ledgerId, kind, hits FROM bank_narration_memory')
    .all() as MemoryEntry[]
}

function allLedgerNames(db: DB): Map<number, string> {
  const rows = db.prepare('SELECT id, name FROM ledgers').all() as { id: number; name: string }[]
  return new Map(rows.map((r) => [r.id, r.name]))
}

/**
 * Remember that this narration meant this ledger.
 *
 * Called when the user does something that says so out loud: files a voucher from a statement
 * row, accepts a suggestion, or writes a rule from the row. Learning from anything less — from a
 * suggestion merely shown, say — would teach the engine its own guesses back.
 *
 * Returns the keywords learned, which is empty for a narration that is all bank plumbing.
 */
export function learnFromMatch(
  db: DB,
  description: string,
  ledgerId: number,
  kind: 'payment' | 'receipt'
): string[] {
  // #141: a UPI narration carries a twelve-digit UTR that occurs exactly once and never
  // again, so learning on the raw cell teaches the memory a word it can never recognise.
  // learnableNarration reduces it to the counterparty; everything else passes through.
  const words = significantWords(learnableNarration(description))
  if (words.length === 0) return []
  const exists = db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(ledgerId)
  if (!exists) throw new Error('Ledger not found')

  const stmt = db.prepare(
    `INSERT INTO bank_narration_memory (keyword, ledger_id, kind, hits, last_seen)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT (keyword, ledger_id, kind)
     DO UPDATE SET hits = hits + 1, last_seen = datetime('now')`
  )
  const run = db.transaction(() => {
    for (const word of words) stmt.run(word, ledgerId, kind)
  })
  run()
  return words
}

export interface NarrationMemoryRow {
  keyword: string
  ledgerId: number
  ledgerName: string
  kind: 'payment' | 'receipt'
  hits: number
  lastSeen: string
}

/** Everything learned, strongest first — so a user can see (and delete) what the engine thinks. */
export function listNarrationMemory(db: DB): NarrationMemoryRow[] {
  return db
    .prepare(
      `SELECT m.keyword, m.ledger_id AS ledgerId, l.name AS ledgerName, m.kind, m.hits,
              m.last_seen AS lastSeen
       FROM bank_narration_memory m JOIN ledgers l ON l.id = m.ledger_id
       ORDER BY m.hits DESC, m.keyword COLLATE NOCASE`
    )
    .all() as NarrationMemoryRow[]
}

/** Forget one keyword→ledger pair. The escape hatch for a match the user regrets teaching. */
export function forgetNarration(db: DB, keyword: string, ledgerId: number, kind: 'payment' | 'receipt'): void {
  const res = db
    .prepare('DELETE FROM bank_narration_memory WHERE keyword = ? AND ledger_id = ? AND kind = ?')
    .run(keyword, ledgerId, kind)
  if (res.changes === 0) throw new Error('Nothing learned for that keyword')
}

// ---------- bulk accept (#134) ----------

export interface BulkAcceptRow {
  date: string
  description: string
  amount: number
  kind: 'deposit' | 'withdrawal'
  ledgerId: number
  ledgerName: string
  confidence: number
  source: 'rule' | 'learned' | 'charge'
  /** Only set once applied. */
  voucherId?: number
}

export interface BulkAcceptResult {
  /** The bar this ran at, echoed back so the confirmation cannot describe a different one. */
  minConfidence: number
  /** Rows at or above the bar — the ones this will (or did) file. */
  accepted: BulkAcceptRow[]
  count: number
  /** Sum of the accepted rows, paise. Deposits and withdrawals are summed separately because one
   *  net figure would let a big receipt hide a big payment. */
  depositTotal: number
  withdrawalTotal: number
  /** Suggestions deliberately left alone: below the bar, or ambiguous at any confidence. */
  skipped: number
  applied: boolean
}

/**
 * Accept every suggestion at or above a confidence, in one action (#134).
 *
 * `apply: false` is the whole safety story: it returns exactly the rows the applying call will
 * file, with the count and totals, so the confirmation the user reads is computed from the same
 * pass that does the work rather than from a second guess at it.
 *
 * Nothing below the threshold is touched, and an ambiguous suggestion — two ledgers fitting the
 * narration equally — is never accepted at any threshold, because "high confidence" and "the
 * engine cannot choose" are not both true.
 */
export function bulkAcceptSuggestions(
  db: DB,
  ledgerId: number,
  csv: string,
  minConfidence: number = DEFAULT_CONFIDENCE_THRESHOLD,
  opts: { apply?: boolean; profile?: StatementProfile | null } = {}
): BulkAcceptResult {
  const apply = opts.apply === true
  const rows = suggestVouchers(db, ledgerId, csv, opts.profile)

  const eligible = rows.filter(
    (r) => r.suggestion != null && !r.suggestion.ambiguous && r.suggestion.confidence >= minConfidence
  )
  const skipped = rows.filter((r) => r.suggestion != null).length - eligible.length

  const accepted: BulkAcceptRow[] = eligible.map((r) => ({
    date: r.statementRow.date,
    description: r.statementRow.description,
    amount: r.statementRow.amount,
    kind: r.statementRow.kind,
    ledgerId: r.suggestion!.ledgerId,
    ledgerName: r.suggestion!.ledgerName,
    confidence: r.suggestion!.confidence,
    source: r.suggestion!.source
  }))

  if (apply && accepted.length > 0) {
    // #142: same reason as importStatement — bulk accept reconciles what it files.
    assertReconOpen(db, ledgerId, accepted.map((a) => a.date))
    const setBank = db.prepare('UPDATE voucher_lines SET bank_date = ? WHERE id = ?')
    const run = db.transaction(() => {
      for (let i = 0; i < eligible.length; i++) {
        const row = eligible[i]!
        const s = row.suggestion!
        const vt = db.prepare('SELECT id FROM voucher_types WHERE kind = ? AND is_system = 1').get(s.kind) as
          | { id: number }
          | undefined
        if (!vt) throw new Error(`No ${s.kind} voucher type to file against`)
        const voucher = saveVoucher(db, {
          voucherTypeId: vt.id,
          date: row.statementRow.date,
          number: undefined,
          partyLedgerId: null,
          narration: row.statementRow.description,
          reference: row.statementRow.reference || null,
          instrumentNo: null,
          instrumentDate: null,
          transporterId: null,
          vehicleNo: null,
          transportDistanceKm: null,
          currencyCode: null,
          exchangeRate: null,
          lines: s.voucherDraft.lines.map((l) => ({ ...l, costAllocations: [] })),
          inventory: [],
          billRefs: [],
          tds: null
        })
        // The bank side of what we just filed IS the statement row, so reconcile it here rather
        // than leaving the user to import the same statement a second time.
        const bankLine = voucher.lines.find((l) => l.ledgerId === ledgerId)
        if (bankLine) setBank.run(row.statementRow.date, bankLine.id)
        if (s.ruleId != null) recordRuleHit(db, s.ruleId)
        // Accepting is the user saying yes, so it counts as evidence for next month.
        learnFromMatch(db, row.statementRow.description, s.ledgerId, s.kind)
        accepted[i]!.voucherId = voucher.id
      }
      // 'import': the same event class as a statement import, because that is what it is — the
      // rest of the same statement, filed in one go. The threshold is on the row so a later
      // reader can tell what bar these were accepted at.
      writeAudit(db, 'bank_statement', ledgerId, 'import', null, {
        bulkAccept: true,
        minConfidence,
        accepted: accepted.length,
        skipped
      })
    })
    run()
  }

  return {
    minConfidence,
    accepted,
    count: accepted.length,
    depositTotal: accepted.filter((a) => a.kind === 'deposit').reduce((s, a) => s + a.amount, 0),
    withdrawalTotal: accepted.filter((a) => a.kind === 'withdrawal').reduce((s, a) => s + a.amount, 0),
    skipped,
    applied: apply && accepted.length > 0
  }
}
