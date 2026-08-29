import type { DB } from '../db/connection'
import type {
  PaymentAccount,
  PaymentRun,
  PaymentRunBillInput,
  PaymentRunItem,
  PaymentRunPreview
} from '@shared/payables'
import { descendantIdsByName } from './masters'
import { openBills } from './analysis'
import { IN_BOOKS, saveVoucher } from './vouchers'
import { writeAudit } from './audit'
import { rowsToCsv } from '@shared/csv'
import { getInvoiceConfig } from './config'

interface StoredBill {
  number: string
  date: string
  amount: number
}

function paymentGroupIds(db: DB): Set<number> {
  return descendantIdsByName(db, ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'])
}

function ledgerBalance(db: DB, ledgerId: number, asOn: string): number {
  const row = db.prepare(
    `SELECT l.opening_balance + COALESCE((
       SELECT SUM(CASE WHEN vl.dr_cr = 'dr' THEN vl.amount ELSE -vl.amount END)
       FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
       WHERE vl.ledger_id = l.id AND v.date <= ? AND ${IN_BOOKS}
     ), 0) AS balance FROM ledgers l WHERE l.id = ?`
  ).get(asOn, ledgerId) as { balance: number } | undefined
  if (!row) throw new Error('Payment account not found')
  return row.balance
}

function requirePaymentAccount(db: DB, ledgerId: number, date: string): PaymentAccount {
  const row = db.prepare('SELECT id, name, group_id AS groupId FROM ledgers WHERE id = ?').get(ledgerId) as
    | { id: number; name: string; groupId: number }
    | undefined
  if (!row || !paymentGroupIds(db).has(row.groupId)) throw new Error('Choose a cash, bank or bank OD ledger')
  return { ledgerId: row.id, name: row.name, balance: ledgerBalance(db, row.id, date) }
}

export function paymentAccounts(db: DB, asOn: string): PaymentAccount[] {
  const groupIds = [...paymentGroupIds(db)]
  if (groupIds.length === 0) return []
  const placeholders = groupIds.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id, name FROM ledgers WHERE group_id IN (${placeholders}) ORDER BY name COLLATE NOCASE`).all(...groupIds) as { id: number; name: string }[]
  return rows.map((row) => ({ ledgerId: row.id, name: row.name, balance: ledgerBalance(db, row.id, asOn) }))
}

function groupedAndValidatedBills(db: DB, bills: PaymentRunBillInput[], asOn: string): Map<number, StoredBill[]> {
  if (bills.length === 0) throw new Error('Select at least one supplier bill')
  const grouped = new Map<number, StoredBill[]>()
  const seen = new Set<string>()
  for (const input of bills) {
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('Every selected amount must be positive paise')
    const key = `${input.partyLedgerId}|${input.billNumber.trim().toLowerCase()}|${input.billDate}`
    if (seen.has(key)) throw new Error(`Bill ${input.billNumber} is selected more than once`)
    seen.add(key)
    const open = openBills(db, input.partyLedgerId, asOn)
    const matching = open.filter((bill) => bill.number === input.billNumber && bill.date === input.billDate)
    if (matching.length !== 1) throw new Error(`Bill ${input.billNumber} is no longer uniquely open for payment`)
    if (input.amount > matching[0]!.pending) throw new Error(`Bill ${input.billNumber} now has only ${matching[0]!.pending} paise pending`)
    const list = grouped.get(input.partyLedgerId) ?? []
    list.push({ number: input.billNumber, date: input.billDate, amount: input.amount })
    grouped.set(input.partyLedgerId, list)
  }
  return grouped
}

export function previewPaymentRun(db: DB, bankLedgerId: number, date: string, bills: PaymentRunBillInput[]): PaymentRunPreview {
  const grouped = groupedAndValidatedBills(db, bills, date)
  const account = requirePaymentAccount(db, bankLedgerId, date)
  const totalAmount = bills.reduce((sum, bill) => sum + bill.amount, 0)
  return {
    account,
    totalAmount,
    balanceAfter: account.balance - totalAmount,
    supplierCount: grouped.size,
    billCount: bills.length
  }
}

export function createPaymentRun(
  db: DB,
  input: { bankLedgerId: number; date: string; note: string | null; bills: PaymentRunBillInput[] },
  author: string
): PaymentRun {
  const grouped = groupedAndValidatedBills(db, input.bills, input.date)
  const preview = previewPaymentRun(db, input.bankLedgerId, input.date, input.bills)
  const id = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO payment_runs (date, bank_ledger_id, total_amount, note, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).run(input.date, input.bankLedgerId, preview.totalAmount, input.note?.trim() || null, author)
    const runId = Number(result.lastInsertRowid)
    const insert = db.prepare(
      'INSERT INTO payment_run_items (run_id, party_ledger_id, amount, bill_refs_json) VALUES (?, ?, ?, ?)'
    )
    for (const [partyLedgerId, bills] of grouped) {
      insert.run(runId, partyLedgerId, bills.reduce((sum, bill) => sum + bill.amount, 0), JSON.stringify(bills))
    }
    writeAudit(db, 'payment_run', runId, 'create', null, {
      date: input.date,
      bankLedgerId: input.bankLedgerId,
      totalAmount: preview.totalAmount,
      suppliers: grouped.size,
      bills: input.bills.length
    })
    return runId
  })()
  return getPaymentRun(db, id)!
}

function mapItem(row: {
  id: number; partyLedgerId: number; partyName: string; amount: number; billRefsJson: string; voucherId: number | null
}): PaymentRunItem {
  return {
    id: row.id,
    partyLedgerId: row.partyLedgerId,
    partyName: row.partyName,
    amount: row.amount,
    bills: JSON.parse(row.billRefsJson) as StoredBill[],
    voucherId: row.voucherId
  }
}

export function getPaymentRun(db: DB, id: number): PaymentRun | null {
  const row = db.prepare(
    `SELECT pr.id, pr.date, pr.bank_ledger_id AS bankLedgerId, l.name AS bankLedgerName,
            pr.status, pr.total_amount AS totalAmount, pr.note, pr.created_by AS createdBy,
            pr.created_at AS createdAt, pr.posted_by AS postedBy, pr.posted_at AS postedAt
     FROM payment_runs pr JOIN ledgers l ON l.id = pr.bank_ledger_id WHERE pr.id = ?`
  ).get(id) as Omit<PaymentRun, 'items'> | undefined
  if (!row) return null
  const items = db.prepare(
    `SELECT pri.id, pri.party_ledger_id AS partyLedgerId, l.name AS partyName, pri.amount,
            pri.bill_refs_json AS billRefsJson, pri.voucher_id AS voucherId
     FROM payment_run_items pri JOIN ledgers l ON l.id = pri.party_ledger_id
     WHERE pri.run_id = ? ORDER BY l.name COLLATE NOCASE`
  ).all(id) as { id: number; partyLedgerId: number; partyName: string; amount: number; billRefsJson: string; voucherId: number | null }[]
  return { ...row, items: items.map(mapItem) }
}

export function listPaymentRuns(db: DB): PaymentRun[] {
  const ids = db.prepare('SELECT id FROM payment_runs ORDER BY id DESC LIMIT 50').all() as { id: number }[]
  return ids.map((row) => getPaymentRun(db, row.id)!)
}

export function cancelPaymentRun(db: DB, id: number, author: string): PaymentRun {
  const before = getPaymentRun(db, id)
  if (!before) throw new Error('Payment run not found')
  if (before.status !== 'draft') throw new Error('Only a draft payment run can be cancelled')
  db.prepare("UPDATE payment_runs SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now') WHERE id = ?").run(author, id)
  const after = getPaymentRun(db, id)!
  writeAudit(db, 'payment_run', id, 'update', before, after)
  return after
}

export function postPaymentRun(db: DB, id: number, author: string): PaymentRun {
  return db.transaction(() => {
    const before = getPaymentRun(db, id)
    if (!before) throw new Error('Payment run not found')
    if (before.status !== 'draft') throw new Error('Only a draft payment run can be posted')
    requirePaymentAccount(db, before.bankLedgerId, before.date)
    const flattened = before.items.flatMap((item) => item.bills.map((bill) => ({
      partyLedgerId: item.partyLedgerId,
      billNumber: bill.number,
      billDate: bill.date,
      amount: bill.amount
    })))
    groupedAndValidatedBills(db, flattened, before.date)
    const paymentType = db.prepare("SELECT id FROM voucher_types WHERE kind = 'payment' ORDER BY is_system DESC, id LIMIT 1").get() as { id: number } | undefined
    if (!paymentType) throw new Error('Create a payment voucher type before posting this run')
    const updateItem = db.prepare('UPDATE payment_run_items SET voucher_id = ? WHERE id = ?')
    for (const item of before.items) {
      const voucher = saveVoucher(db, {
        voucherTypeId: paymentType.id,
        date: before.date,
        partyLedgerId: item.partyLedgerId,
        narration: `Payment run #${before.id}${before.note ? ` — ${before.note}` : ''}`,
        reference: `PAYRUN-${before.id}`,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [
          { ledgerId: item.partyLedgerId, drCr: 'dr', amount: item.amount, costAllocations: [] },
          { ledgerId: before.bankLedgerId, drCr: 'cr', amount: item.amount, costAllocations: [] }
        ],
        inventory: [],
        billRefs: item.bills.map((bill) => ({ kind: 'against' as const, name: bill.number, amount: bill.amount, dueDate: null })),
        tds: null
      })
      updateItem.run(voucher.id, item.id)
    }
    db.prepare("UPDATE payment_runs SET status = 'posted', posted_by = ?, posted_at = datetime('now') WHERE id = ?").run(author, id)
    const after = getPaymentRun(db, id)!
    writeAudit(db, 'payment_run', id, 'update', before, after)
    return after
  })()
}

export type PaymentFileFormat = 'generic_neft' | 'hdfc_bulk' | 'icici_bulk'

export interface PaymentFilePreview {
  runId: number
  format: PaymentFileFormat
  totalAmount: number
  rows: { partyLedgerId: number; beneficiaryName: string; bankAccount: string; ifsc: string; amount: number; reference: string }[]
  blockers: string[]
  debitAccount: string | null
}

export function paymentFilePreview(db: DB, runId: number, format: PaymentFileFormat): PaymentFilePreview {
  const run = getPaymentRun(db, runId)
  if (!run) throw new Error('Payment run not found')
  if (run.status === 'cancelled') throw new Error('A cancelled payment run cannot be exported')
  const profiles = db.prepare(
    `SELECT ledger_id AS ledgerId, bank_account AS bankAccount, ifsc, status
     FROM vendor_profiles WHERE ledger_id = ?`
  )
  const blockers: string[] = []
  const account = db.prepare('SELECT group_id AS groupId FROM ledgers WHERE id = ?').get(run.bankLedgerId) as { groupId: number } | undefined
  const bankGroups = descendantIdsByName(db, ['Bank Accounts', 'Bank OD A/c'])
  if (!account || !bankGroups.has(account.groupId)) blockers.push('Choose a bank or bank OD account; cash runs cannot be uploaded')
  const debitAccount = getInvoiceConfig(db).bankDetails?.account.replace(/\s+/g, '') || null
  if (format === 'icici_bulk') {
    if (!debitAccount) blockers.push('Add the company debit account in Settings → Invoice → Bank details before ICICI export')
    else if (!/^[A-Z0-9]{6,34}$/i.test(debitAccount)) blockers.push('The company debit account in invoice settings is not valid for ICICI export')
  }
  const rows = run.items.map((item) => {
    const profile = profiles.get(item.partyLedgerId) as { ledgerId: number; bankAccount: string | null; ifsc: string | null; status: string } | undefined
    if (!profile?.bankAccount || !profile.ifsc) blockers.push(`${item.partyName}: bank account and IFSC are required`)
    else if (!/^[A-Z0-9]{6,34}$/i.test(profile.bankAccount)) blockers.push(`${item.partyName}: bank account must contain 6–34 letters or digits`)
    else if (!/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(profile.ifsc)) blockers.push(`${item.partyName}: IFSC is not valid`)
    else if (profile.status !== 'verified') blockers.push(`${item.partyName}: vendor bank details are not verified`)
    return {
      partyLedgerId: item.partyLedgerId, beneficiaryName: item.partyName,
      bankAccount: profile?.bankAccount ?? '', ifsc: profile?.ifsc ?? '', amount: item.amount,
      reference: `PAYRUN-${run.id}-${item.id}`
    }
  })
  return { runId, format, totalAmount: run.totalAmount, rows, blockers: [...new Set(blockers)], debitAccount }
}

export function paymentFileCsv(db: DB, runId: number, format: PaymentFileFormat): { csv: string; preview: PaymentFilePreview; filename: string } {
  const preview = paymentFilePreview(db, runId, format)
  if (preview.blockers.length) throw new Error(`Payment file is blocked:\n${preview.blockers.join('\n')}`)
  const header = format === 'hdfc_bulk'
    ? ['Transaction Type', 'Beneficiary Code', 'Beneficiary Name', 'Beneficiary Account', 'IFSC', 'Amount', 'Reference', 'Narration']
    : format === 'icici_bulk'
      ? ['PAYMODE', 'DEBITACCOUNT', 'BENEFICIARY', 'ACCOUNTNO', 'IFSCCODE', 'AMOUNT', 'CUSTOMERREF', 'REMARKS']
      : ['Payment mode', 'Beneficiary name', 'Account number', 'IFSC', 'Amount', 'Reference', 'Narration']
  const rows = preview.rows.map((row) => {
    const amount = (row.amount / 100).toFixed(2)
    if (format === 'hdfc_bulk') return ['NEFT', String(row.partyLedgerId), row.beneficiaryName, row.bankAccount, row.ifsc, amount, row.reference, `Supplier payment run ${runId}`]
    if (format === 'icici_bulk') return ['NEFT', preview.debitAccount ?? '', row.beneficiaryName, row.bankAccount, row.ifsc, amount, row.reference, `Supplier payment run ${runId}`]
    return ['NEFT', row.beneficiaryName, row.bankAccount, row.ifsc, amount, row.reference, `Supplier payment run ${runId}`]
  })
  return { csv: rowsToCsv(header, rows), preview, filename: `payment-run-${runId}-${format}.csv` }
}
