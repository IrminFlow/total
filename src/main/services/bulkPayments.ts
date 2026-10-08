// Bulk NEFT/RTGS payment files (WP 4.1): the beneficiary master (bank details on ledgers,
// migration 034), user-defined file templates (shared/bulkPayments.ts — bank layouts are mostly
// not public, see there), payment-voucher candidates, and the export itself, which records every
// file with the vouchers and beneficiary details it carried (audited).
import type { DB } from '../db/connection'
import type { BankDetails, BeneficiaryRow, PaymentTemplateRecord, PaymentCandidate, ExportBatchInput, ExportBatchResult, PaymentBatchRow } from '@shared/bankTypes'
import { BUILTIN_PAYMENT_TEMPLATES, beneficiaryProblems, renderPaymentFile, type PaymentRow, type PaymentTemplate } from '@shared/bulkPayments'
import { paymentTemplateSchema } from '@shared/bankSchemas'
import { writeAudit } from './audit'
import { bankLedgers } from './banking'
import { descendantIdsByName } from './masters'
import { NOT_DELETED, NOT_OPTIONAL } from './vouchers'

// ---------- beneficiary master ----------



function details(db: DB, ledgerId: number): (BankDetails & { name: string; groupId: number }) | undefined {
  return db
    .prepare('SELECT name, group_id AS groupId, bank_account_no AS accountNo, bank_ifsc AS ifsc, bank_account_name AS accountName, bank_email AS email FROM ledgers WHERE id = ?')
    .get(ledgerId) as (BankDetails & { name: string; groupId: number }) | undefined
}

/** Parties (Sundry Creditors / Debtors and anything else that has bank details) and the bank
 *  accounts themselves (their own account number is the debit account of a payment file). */
export function listBeneficiaries(db: DB): BeneficiaryRow[] {
  const parties = descendantIdsByName(db, ['Sundry Creditors', 'Sundry Debtors'])
  const banks = new Set(bankLedgers(db).map((b) => b.id))
  const rows = db
    .prepare(
      `SELECT l.id AS ledgerId, l.name, g.name AS groupName, l.group_id AS groupId, l.bank_account_no AS accountNo, l.bank_ifsc AS ifsc,
              l.bank_account_name AS accountName, l.bank_email AS email
       FROM ledgers l JOIN groups g ON g.id = l.group_id ORDER BY l.name`
    )
    .all() as (BankDetails & { ledgerId: number; name: string; groupName: string; groupId: number })[]
  return rows
    .filter((r) => parties.has(r.groupId) || banks.has(r.ledgerId) || r.accountNo || r.ifsc)
    .map((r) => ({
      ledgerId: r.ledgerId, name: r.name, groupName: r.groupName, accountNo: r.accountNo, ifsc: r.ifsc, accountName: r.accountName, email: r.email,
      isBank: banks.has(r.ledgerId),
      problems: beneficiaryProblems({ accountNo: r.accountNo, ifsc: r.ifsc, accountName: r.accountName ?? (banks.has(r.ledgerId) ? r.name : null) })
    }))
}

export function setBankDetails(db: DB, ledgerId: number, input: BankDetails): BeneficiaryRow {
  const before = details(db, ledgerId)
  if (!before) throw new Error('Ledger not found')
  const norm = (s: string | null): string | null => (s && s.trim() ? s.trim() : null)
  const next: BankDetails = {
    accountNo: norm(input.accountNo)?.replace(/\s/g, '') ?? null,
    ifsc: norm(input.ifsc)?.toUpperCase() ?? null,
    accountName: norm(input.accountName),
    email: norm(input.email)
  }
  if (next.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(next.ifsc)) throw new Error('IFSC must be 11 characters: 4 letters, 0, then 6 letters/digits')
  if (next.accountNo && !/^[0-9A-Za-z]{6,34}$/.test(next.accountNo)) throw new Error('Account number should be 6–34 letters/digits')
  db.prepare('UPDATE ledgers SET bank_account_no = ?, bank_ifsc = ?, bank_account_name = ?, bank_email = ? WHERE id = ?').run(
    next.accountNo, next.ifsc, next.accountName, next.email, ledgerId
  )
  writeAudit(db, 'ledger', ledgerId, 'update',
    { bankAccountNo: before.accountNo, bankIfsc: before.ifsc, bankAccountName: before.accountName, bankEmail: before.email },
    { bankAccountNo: next.accountNo, bankIfsc: next.ifsc, bankAccountName: next.accountName, bankEmail: next.email })
  return listBeneficiaries(db).find((b) => b.ledgerId === ledgerId) ?? {
    ledgerId, name: before.name, groupName: '', isBank: false, ...next, problems: beneficiaryProblems(next)
  }
}

// ---------- templates ----------


export function listPaymentTemplates(db: DB): PaymentTemplateRecord[] {
  const builtins = BUILTIN_PAYMENT_TEMPLATES.map(({ key, source, ...spec }) => ({ id: null, key: `builtin:${key}`, builtin: true, source, spec }))
  const users = (db.prepare('SELECT id, spec FROM bank_payment_templates ORDER BY name COLLATE NOCASE').all() as { id: number; spec: string }[]).map((r) => ({
    id: r.id, key: `user:${r.id}`, builtin: false, source: null, spec: paymentTemplateSchema.parse(JSON.parse(r.spec))
  }))
  return [...builtins, ...users]
}

export function savePaymentTemplate(db: DB, spec: PaymentTemplate, id?: number): PaymentTemplateRecord {
  const parsed = paymentTemplateSchema.parse(spec)
  if (BUILTIN_PAYMENT_TEMPLATES.some((b) => b.name.toLowerCase() === parsed.name.toLowerCase())) throw new Error('That name belongs to a built-in template — pick another')
  if (id != null) {
    const before = db.prepare('SELECT * FROM bank_payment_templates WHERE id = ?').get(id)
    if (!before) throw new Error('Template not found')
    db.prepare("UPDATE bank_payment_templates SET name = ?, spec = ?, updated_at = datetime('now') WHERE id = ?").run(parsed.name, JSON.stringify(parsed), id)
    writeAudit(db, 'payment_template', id, 'update', before, parsed)
  } else {
    const res = db.prepare('INSERT INTO bank_payment_templates (name, spec) VALUES (?, ?)').run(parsed.name, JSON.stringify(parsed))
    id = Number(res.lastInsertRowid)
    writeAudit(db, 'payment_template', id, 'create', null, parsed)
  }
  return listPaymentTemplates(db).find((t) => t.id === id)!
}

export function deletePaymentTemplate(db: DB, id: number): void {
  const before = db.prepare('SELECT * FROM bank_payment_templates WHERE id = ?').get(id)
  if (!before) throw new Error('Template not found')
  db.prepare('DELETE FROM bank_payment_templates WHERE id = ?').run(id)
  writeAudit(db, 'payment_template', id, 'delete', before, null)
}

// ---------- candidates + export ----------


/**
 * Payment vouchers crediting the bank account in the period (post-dated included — a payment
 * file is often prepared ahead; optional and binned vouchers excluded), as ONE ROW PER PAYEE:
 * each debit line to a party (Sundry Creditors / Debtors, or any ledger carrying bank details)
 * is one transfer of that line's amount. Debits to other ledgers (bank charges, TDS adjustments)
 * are not transfers and are left out. A voucher with no such line but a single debit pays that
 * ledger. A single payee's transfer is capped at what the bank actually paid (a TDS deduction
 * credited on the same voucher lowers it); several payees whose debits exceed the bank credit are
 * flagged rather than guessed at.
 */
export function paymentCandidates(db: DB, bankLedgerId: number, from: string, to: string): PaymentCandidate[] {
  if (!bankLedgers(db).some((b) => b.id === bankLedgerId)) throw new Error('That ledger is not a bank account')
  const parties = descendantIdsByName(db, ['Sundry Creditors', 'Sundry Debtors'])
  const vouchers = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date, v.narration, v.post_dated AS postDated,
              (SELECT COALESCE(SUM(vl.amount), 0) FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = ? AND vl.dr_cr = 'cr') AS bankPaid
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = 'payment' AND v.date BETWEEN ? AND ? AND ${NOT_DELETED} AND ${NOT_OPTIONAL}
         AND EXISTS (SELECT 1 FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = ? AND vl.dr_cr = 'cr')
       ORDER BY v.date, v.id`
    )
    .all(bankLedgerId, from, to, bankLedgerId) as { voucherId: number; number: string; date: string; narration: string | null; postDated: number; bankPaid: number }[]
  const debitLines = db.prepare(
    `SELECT vl.ledger_id AS ledgerId, SUM(vl.amount) AS amount, l.group_id AS groupId, l.bank_account_no AS accountNo
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? AND vl.dr_cr = 'dr' GROUP BY vl.ledger_id ORDER BY MIN(vl.id)`
  )
  const batches = db.prepare(
    `SELECT b.id AS batchId, b.file_name AS fileName, b.created_at AS createdAt FROM bank_payment_batch_items i JOIN bank_payment_batches b ON b.id = i.batch_id
     WHERE i.voucher_id = ? AND i.ledger_id = ? ORDER BY b.id`
  )
  const cheque = db.prepare("SELECT number FROM cheques WHERE voucher_id = ? AND status = 'issued' LIMIT 1")
  const out: PaymentCandidate[] = []
  for (const v of vouchers) {
    const debits = debitLines.all(v.voucherId) as { ledgerId: number; amount: number; groupId: number; accountNo: string | null }[]
    let payees = debits.filter((d) => parties.has(d.groupId) || !!d.accountNo)
    if (payees.length === 0 && debits.length === 1) payees = debits
    const sum = payees.reduce((s, d) => s + d.amount, 0)
    const overpaid = payees.length > 1 && sum > v.bankPaid
    for (const p of payees) {
      const d = details(db, p.ledgerId)!
      const amount = payees.length === 1 ? Math.min(p.amount, v.bankPaid) : p.amount
      const problems = beneficiaryProblems({ accountNo: d.accountNo, ifsc: d.ifsc, accountName: d.accountName ?? d.name })
      if (overpaid) problems.unshift('payee debits exceed what the bank paid — split the voucher')
      out.push({
        key: `${v.voucherId}:${p.ledgerId}`,
        voucherId: v.voucherId, number: v.number, date: v.date, amount, narration: v.narration, postDated: !!v.postDated,
        payeeLedgerId: p.ledgerId, payeeName: d.name, accountNo: d.accountNo, ifsc: d.ifsc, accountName: d.accountName, email: d.email,
        problems,
        exportedIn: batches.all(v.voucherId, p.ledgerId) as PaymentCandidate['exportedIn'],
        chequeNo: (cheque.get(v.voucherId) as { number: string } | undefined)?.number ?? null
      })
    }
  }
  return out
}

/** Build the upload file and record the batch. Refuses (listing every problem) when any
 *  beneficiary or the debit account is incomplete, and — unless `allowRepeat` — when a payment
 *  is already in an exported file or already paid by a cheque. The caller writes the file. */
export function exportPaymentBatch(db: DB, input: ExportBatchInput): ExportBatchResult {
  const bank = bankLedgers(db).find((b) => b.id === input.bankLedgerId)
  if (!bank) throw new Error('That ledger is not a bank account')
  const template = listPaymentTemplates(db).find((t) => t.key === input.templateKey)
  if (!template) throw new Error('Payment file template not found')
  const keys = [...new Set(input.items.map((i) => `${i.voucherId}:${i.ledgerId}`))]
  if (keys.length === 0) throw new Error('Select at least one payment')
  const all = new Map(paymentCandidates(db, input.bankLedgerId, '0000-01-01', '9999-12-31').map((c) => [c.key, c]))
  const picked = keys.map((k) => {
    const c = all.get(k)
    if (!c) throw new Error('A selected payment is not a transfer from this bank account')
    return c
  })
  const problems = picked.filter((c) => c.problems.length > 0).map((c) => `${c.number} (${c.payeeName ?? 'no payee'}): ${c.problems.join(', ')}`)
  const own = details(db, input.bankLedgerId)!
  const usesDebit = template.spec.columns.some((c) => c.field === 'debit_account' || c.field === 'debit_ifsc')
  if (usesDebit && !own.accountNo) problems.push(`${bank.name}: set this bank account's own account number (Beneficiaries)`)
  if (template.spec.columns.some((c) => c.field === 'debit_ifsc') && !own.ifsc) problems.push(`${bank.name}: set this bank account's IFSC (Beneficiaries)`)
  if (problems.length) throw new Error(`Fix these before exporting — ${problems.join('; ')}`)
  if (!input.allowRepeat) {
    const repeats = picked
      .filter((c) => c.exportedIn.length > 0 || c.chequeNo)
      .map((c) => `${c.number} (${c.payeeName}): ${c.exportedIn.length ? `already in ${c.exportedIn[0]!.fileName}` : `cheque ${c.chequeNo} issued`}`)
    if (repeats.length) throw new Error(`These may be paid twice — ${repeats.join('; ')}. Confirm to export them again.`)
  }

  const run = db.transaction((): ExportBatchResult => {
    const batchNo = ((db.prepare('SELECT COUNT(*) AS n FROM bank_payment_batches WHERE bank_ledger_id = ?').get(input.bankLedgerId) as { n: number }).n) + 1
    const rows: PaymentRow[] = picked.map((c) => ({
      voucherId: c.voucherId, voucherNumber: c.number, date: c.date, amount: c.amount, beneficiaryName: c.accountName ?? c.payeeName ?? '',
      accountNo: c.accountNo ?? '', ifsc: c.ifsc ?? '', email: c.email ?? '', narration: c.narration ?? `Payment ${c.number}`
    }))
    const text = renderPaymentFile(template.spec, rows, {
      debitAccount: own.accountNo ?? '', debitIfsc: own.ifsc ?? '', corporateId: (input.corporateId ?? template.spec.corporateId ?? '').trim(),
      batchNo, date: input.date, remarks: (input.remarks ?? '').trim()
    })
    const total = rows.reduce((s, r) => s + r.amount, 0)
    const safeBank = bank.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
    const fileName = `bulk-payments-${safeBank}-${input.date}-${batchNo}.${template.spec.extension}`
    const res = db
      .prepare('INSERT INTO bank_payment_batches (bank_ledger_id, template_name, file_name, voucher_count, total) VALUES (?, ?, ?, ?, ?)')
      .run(input.bankLedgerId, template.spec.name, fileName, rows.length, total)
    const batchId = Number(res.lastInsertRowid)
    const ins = db.prepare(
      'INSERT INTO bank_payment_batch_items (batch_id, voucher_id, ledger_id, amount, beneficiary_name, beneficiary_account, beneficiary_ifsc) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    picked.forEach((c, i) => ins.run(batchId, c.voucherId, c.payeeLedgerId, rows[i]!.amount, rows[i]!.beneficiaryName, rows[i]!.accountNo, rows[i]!.ifsc))
    writeAudit(db, 'payment_batch', batchId, 'create', null, {
      bankLedgerId: input.bankLedgerId, template: template.spec.name, fileName, count: rows.length, total, repeatAllowed: !!input.allowRepeat,
      payments: picked.map((c, i) => ({ voucherId: c.voucherId, ledgerId: c.payeeLedgerId, amount: rows[i]!.amount, account: rows[i]!.accountNo, ifsc: rows[i]!.ifsc }))
    })
    return { batchId, fileName, text, count: rows.length, total }
  })
  return run()
}

export function listPaymentBatches(db: DB, bankLedgerId: number): PaymentBatchRow[] {
  return db
    .prepare(
      `SELECT id, created_at AS createdAt, bank_ledger_id AS bankLedgerId, template_name AS templateName, file_name AS fileName,
              voucher_count AS voucherCount, total FROM bank_payment_batches WHERE bank_ledger_id = ? ORDER BY id DESC`
    )
    .all(bankLedgerId) as PaymentBatchRow[]
}
