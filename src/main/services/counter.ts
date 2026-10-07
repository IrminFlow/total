import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import {
  buildInvoicePayload, computeInvoice, emptyInvoiceState, requiredTaxLedgers,
  type InvoiceContext, type InvoiceFormState, type TaxLedgerIds
} from '@shared/voucherEdit'
import { qtyText } from '@shared/voucherEdit/payload'
import {
  counterCheckoutSchema, counterConfigSchema, heldBillSchema, PAYMENT_MODE_LABELS,
  type CounterCheckoutInput, type CounterConfig, type HeldBillInput, type PaymentMode
} from '@shared/pricingSchemas'
import { formatPaise } from '@shared/money'
import { createLedger } from './masters'
import { IN_BOOKS, nextVoucherNumber, saveVoucher } from './vouchers'
import { getFeatures } from './config'
import { tcsSuggestion } from './tcs'
import { rememberSalePrices } from './pricing'
import type { CheckoutResult, CounterAccounts, CounterQuote, DayEndSummary, HeldBill } from '@shared/pricingTypes'
import { writeAudit } from './audit'

export type { CheckoutResult, CounterAccounts, CounterQuote, DayEndSummary, HeldBill }

/**
 * Counter billing (WP 2.6): a POS-style sale posts a NORMAL sales invoice (built by the same
 * buildInvoicePayload the invoice form uses — so GST, round-off, bills and every report are
 * unchanged) plus, when paid, one receipt voucher against that invoice's bill whose debits are
 * the cash / UPI / card accounts. Both are saved through saveVoucher inside one transaction; the
 * counter_sales row only links the pair and records cash tendered / change. Held bills are
 * session scratch kept in meta ('counter.heldBills').
 */

// ---------------------------------------------------------------- config (meta 'counter.config')

const CONFIG_KEY = 'counter.config'
const HELD_KEY = 'counter.heldBills'

function readMeta(db: DB, key: string): unknown {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}
function writeMeta(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

export function getCounterConfig(db: DB): CounterConfig {
  const r = counterConfigSchema.safeParse(readMeta(db, CONFIG_KEY) ?? {})
  return r.success ? r.data : counterConfigSchema.parse({})
}

export function setCounterConfig(db: DB, input: unknown): CounterConfig {
  const before = getCounterConfig(db)
  const parsed = counterConfigSchema.parse(input)
  writeMeta(db, CONFIG_KEY, parsed)
  writeAudit(db, 'company', 0, 'update', { counter: before }, { counter: parsed })
  return parsed
}

// ---------------------------------------------------------------- the accounts a sale needs

function groupIdsUnder(db: DB, rootName: string): number[] {
  return (
    db.prepare(
      `WITH RECURSIVE g(id) AS (SELECT id FROM groups WHERE name = ? UNION ALL SELECT c.id FROM groups c JOIN g ON c.parent_id = g.id)
       SELECT id FROM g`
    ).all(rootName) as { id: number }[]
  ).map((r) => r.id)
}

function firstLedgerUnder(db: DB, rootNames: string[]): number | null {
  const ids = rootNames.flatMap((n) => groupIdsUnder(db, n))
  if (ids.length === 0) return null
  const r = db.prepare(`SELECT id FROM ledgers WHERE group_id IN (${ids.map(() => '?').join(',')}) ORDER BY id LIMIT 1`).get(...ids) as { id: number } | undefined
  return r?.id ?? null
}

function ledgerExists(db: DB, id: number | null): id is number {
  return id != null && !!db.prepare('SELECT 1 FROM ledgers WHERE id = ?').get(id)
}

export const WALK_IN_NAME = 'Cash sale'

/** The walk-in party: the configured one, else a "Cash sale" ledger under Sundry Debtors
 *  (created on first use — a walk-in sale still needs a party for its bill). */
export function ensureWalkIn(db: DB, cfg: CounterConfig = getCounterConfig(db)): number {
  if (ledgerExists(db, cfg.walkInLedgerId)) return cfg.walkInLedgerId
  const named = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(WALK_IN_NAME) as { id: number } | undefined
  if (named) return named.id
  const debtors = db.prepare("SELECT id FROM groups WHERE name = 'Sundry Debtors'").get() as { id: number } | undefined
  if (!debtors) throw new Error('Sundry Debtors group missing')
  return createLedger(db, {
    name: WALK_IN_NAME, groupId: debtors.id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
    gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
  }).id
}


/** What the counter will post to (config, else sensible defaults) — read-only (the walk-in
 *  ledger may not exist yet; checkout creates it). */
export function counterAccounts(db: DB, cfg: CounterConfig = getCounterConfig(db)): CounterAccounts {
  const typeOf = (kind: string, id: number | null): number | null => {
    if (id != null && db.prepare('SELECT 1 FROM voucher_types WHERE id = ? AND kind = ?').get(id, kind)) return id
    return (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number } | undefined)?.id ?? null
  }
  const bank = firstLedgerUnder(db, ['Bank Accounts'])
  const walkIn = ledgerExists(db, cfg.walkInLedgerId)
    ? cfg.walkInLedgerId
    : ((db.prepare('SELECT id FROM ledgers WHERE name = ?').get(WALK_IN_NAME) as { id: number } | undefined)?.id ?? null)
  return {
    walkInLedgerId: walkIn,
    salesLedgerId: ledgerExists(db, cfg.salesLedgerId) ? cfg.salesLedgerId : firstLedgerUnder(db, ['Sales Accounts']),
    voucherTypeId: typeOf('sales', cfg.voucherTypeId),
    receiptTypeId: typeOf('receipt', cfg.receiptTypeId),
    cashLedgerId: ledgerExists(db, cfg.cashLedgerId)
      ? cfg.cashLedgerId
      : ((db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number } | undefined)?.id ?? firstLedgerUnder(db, ['Cash-in-Hand'])),
    upiLedgerId: ledgerExists(db, cfg.upiLedgerId) ? cfg.upiLedgerId : bank,
    cardLedgerId: ledgerExists(db, cfg.cardLedgerId) ? cfg.cardLedgerId : bank
  }
}

/** Find-or-create the GST / Round Off ledgers a computed invoice posts to (the invoice form's
 *  useTaxLedgers, server-side: first ledger of the tax type; "Round Off" under Indirect Expenses). */
function ensureTaxLedgers(db: DB, needed: (keyof TaxLedgerIds)[]): TaxLedgerIds {
  const out: TaxLedgerIds = { cgst: null, sgst: null, igst: null, cess: null, roundOff: null }
  for (const k of needed) {
    if (k === 'roundOff') {
      const r = db.prepare("SELECT id FROM ledgers WHERE lower(name) = 'round off' ORDER BY id LIMIT 1").get() as { id: number } | undefined
      if (r) out.roundOff = r.id
      else {
        const g = db.prepare("SELECT id FROM groups WHERE name = 'Indirect Expenses'").get() as { id: number } | undefined
        if (!g) throw new Error('Indirect Expenses group missing')
        out.roundOff = createLedger(db, {
          name: 'Round Off', groupId: g.id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null,
          gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
        }).id
      }
      continue
    }
    const r = db.prepare('SELECT id FROM ledgers WHERE tax_type = ? ORDER BY id LIMIT 1').get(k) as { id: number } | undefined
    if (r) out[k] = r.id
    else {
      const g = db.prepare("SELECT id FROM groups WHERE name = 'Duties & Taxes'").get() as { id: number } | undefined
      if (!g) throw new Error('Duties & Taxes group missing')
      out[k] = createLedger(db, {
        name: k.toUpperCase(), groupId: g.id, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: k,
        gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
      }).id
    }
  }
  return out
}

function invoiceContext(db: DB, company: CompanyInfo, itemIds: number[], ledgerIds: number[]): InvoiceContext {
  const items = new Map<number, { gstRate: number | null; cessRate: number | null }>()
  const itemStmt = db.prepare('SELECT gst_rate, cess_rate FROM stock_items WHERE id = ?')
  for (const id of itemIds) {
    const r = itemStmt.get(id) as { gst_rate: number | null; cess_rate: number | null } | undefined
    if (!r) throw new Error('Stock item not found')
    items.set(id, { gstRate: r.gst_rate, cessRate: r.cess_rate })
  }
  const ledgers: InvoiceContext['ledgers'] = new Map()
  const ledgerStmt = db.prepare('SELECT state_code, gst_rate FROM ledgers WHERE id = ?')
  for (const id of ledgerIds) {
    const r = ledgerStmt.get(id) as { state_code: string | null; gst_rate: number | null } | undefined
    if (!r) throw new Error('Ledger not found')
    ;(ledgers as Map<number, { stateCode: string | null; gstRate: number | null }>).set(id, { stateCode: r.state_code, gstRate: r.gst_rate })
  }
  return { kind: 'sales', companyStateCode: company.stateCode, items, ledgers }
}

// ---------------------------------------------------------------- checkout


/** The bill's totals exactly as the invoice will post them (no writes). */
export function counterQuote(db: DB, company: CompanyInfo, raw: CounterCheckoutInput): CounterQuote {
  const input = counterCheckoutSchema.parse(raw)
  const acc = counterAccounts(db)
  const partyId = input.partyLedgerId ?? acc.walkInLedgerId
  const ledgerIds = [partyId, acc.salesLedgerId].filter((x): x is number => x != null)
  const ctx = invoiceContext(db, company, [...new Set(input.lines.map((l) => l.itemId))], ledgerIds)
  const c = computeInvoice(stateFor(input, partyId ?? -1, acc.salesLedgerId ?? -2, '', null), ctx)
  return { ...c.gst, roundOff: c.roundDiff, total: c.rounded, supply: c.supply }
}

function stateFor(input: ReturnType<typeof counterCheckoutSchema.parse>, partyId: number, salesId: number, number: string, godownId: number | null): InvoiceFormState {
  return {
    ...emptyInvoiceState(input.date),
    number,
    partyId,
    accountId: salesId,
    rows: input.lines.map((l) => ({
      itemId: l.itemId, qtyText: qtyText(l.qtyMilli), rate: l.ratePaise, discount: l.discountPaise || null, godownId, batchId: null
    })),
    narration: input.narration ?? 'Counter sale',
    billName: number,
    billDueDate: input.date
  }
}


export function counterCheckout(db: DB, company: CompanyInfo, raw: CounterCheckoutInput): CheckoutResult {
  const input = counterCheckoutSchema.parse(raw)
  const cfg = getCounterConfig(db)
  const result = db.transaction((): CheckoutResult => {
    const walkIn = ensureWalkIn(db, cfg)
    const acc = counterAccounts(db, cfg)
    if (!acc.salesLedgerId) throw new Error('No sales ledger — create one under Sales Accounts or pick it in Counter options')
    if (!acc.voucherTypeId) throw new Error('No sales voucher type')
    const partyId = input.partyLedgerId ?? walkIn
    const isWalkIn = partyId === walkIn
    const ctx = invoiceContext(db, company, [...new Set(input.lines.map((l) => l.itemId))], [partyId, acc.salesLedgerId])
    const number = nextVoucherNumber(db, acc.voucherTypeId, input.date)
    const state = stateFor(input, partyId, acc.salesLedgerId, number, cfg.godownId)
    const computed = computeInvoice(state, ctx)
    if (computed.detail.length === 0) throw new Error('Add an item')
    const total = computed.rounded

    // TCS is collected through Voucher entry's banner (it needs the section / threshold review).
    if (getFeatures(db).tcs) {
      const tcs = tcsSuggestion(db, {
        partyLedgerId: partyId, date: input.date, voucherKind: 'sales', taxablePaise: computed.gst.taxable,
        gstPaise: total - computed.gst.taxable, salesLedgerId: acc.salesLedgerId,
        items: computed.detail.map((d) => ({ stockItemId: d.itemId, amount: d.amount }))
      })
      if (tcs && tcs.tdsPaise > 0) throw new Error(`TCS u/s ${tcs.code} applies to this sale — enter it in Voucher entry`)
    }

    // Payments: a walk-in sale is paid in full; a named party may leave a balance on account.
    const payments = input.payments.filter((p) => p.amountPaise > 0)
    const paid = payments.reduce((s, p) => s + p.amountPaise, 0)
    if (paid > total) throw new Error(`Payments ${formatPaise(paid, { symbol: true })} exceed the bill ${formatPaise(total, { symbol: true })} — the change comes off the cash tendered`)
    if (isWalkIn && paid !== total) throw new Error(`A walk-in sale must be paid in full (${formatPaise(total - paid, { symbol: true })} unpaid) — pick the customer to sell on credit`)
    const cash = payments.filter((p) => p.mode === 'cash').reduce((s, p) => s + p.amountPaise, 0)
    const tendered = input.tenderedPaise > 0 ? input.tenderedPaise : cash
    if (tendered < cash) throw new Error('Cash tendered is less than the cash payment')
    if (tendered > 0 && cash === 0) throw new Error('Cash tendered without a cash payment')
    const change = tendered - cash

    const built = buildInvoicePayload(state, ctx, acc.voucherTypeId, ensureTaxLedgers(db, requiredTaxLedgers(computed)))
    if (!built.ok) throw new Error(built.error)
    const invoice = saveVoucher(db, built.payload)

    let receipt: { id: number; number: string } | null = null
    if (paid > 0) {
      if (!acc.receiptTypeId) throw new Error('No receipt voucher type')
      const ledgerFor = (mode: PaymentMode): number => {
        const id = mode === 'cash' ? acc.cashLedgerId : mode === 'upi' ? acc.upiLedgerId : acc.cardLedgerId
        if (id == null) throw new Error(`No ${PAYMENT_MODE_LABELS[mode]} account — pick one in Counter options`)
        return id
      }
      // One debit per account (UPI and card may share a bank account).
      const debits = new Map<number, number>()
      for (const p of payments) {
        const id = ledgerFor(p.mode)
        debits.set(id, (debits.get(id) ?? 0) + p.amountPaise)
      }
      const saved = saveVoucher(db, {
        voucherTypeId: acc.receiptTypeId, date: input.date, partyLedgerId: partyId,
        narration: `Against counter bill ${invoice.number}${change > 0 ? ` · tendered ${formatPaise(tendered)} change ${formatPaise(change)}` : ''}`,
        reference: invoice.number, instrumentNo: null, instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null,
        currencyCode: null, exchangeRate: null,
        lines: [
          ...[...debits].map(([ledgerId, amount]) => ({ ledgerId, drCr: 'dr' as const, amount, costAllocations: [] })),
          { ledgerId: partyId, drCr: 'cr' as const, amount: paid, costAllocations: [] }
        ],
        inventory: [],
        billRefs: [{ kind: 'against', name: invoice.number, amount: paid, dueDate: null }],
        tds: null
      })
      receipt = { id: saved.id, number: saved.number }
    }
    db.prepare('INSERT INTO counter_sales (invoice_voucher_id, receipt_voucher_id, tendered_paise, change_paise) VALUES (?, ?, ?, ?)').run(
      invoice.id, receipt?.id ?? null, tendered, change
    )
    // WP 3.8: the sale as one event (the invoice and receipt vouchers log themselves).
    writeAudit(db, 'counter_sale', invoice.id, 'create', null, {
      invoiceVoucherId: invoice.id, invoiceNumber: invoice.number, receiptVoucherId: receipt?.id ?? null, totalPaise: total,
      paidPaise: paid, tenderedPaise: tendered, changePaise: change, payments
    })
    rememberSalePrices(db, invoice.id, { skipLedgerId: walkIn })
    return {
      invoiceId: invoice.id, invoiceNumber: invoice.number, totalPaise: total, receiptId: receipt?.id ?? null, receiptNumber: receipt?.number ?? null,
      paidPaise: paid, balancePaise: total - paid, changePaise: change,
      negativeStock: invoice.warnings.negativeStock.map((w) => ({ name: w.name }))
    }
  })()
  return result
}

// ---------------------------------------------------------------- held bills (meta)


export function listHeldBills(db: DB): HeldBill[] {
  const raw = readMeta(db, HELD_KEY)
  return Array.isArray(raw) ? (raw as HeldBill[]) : []
}

export function holdBill(db: DB, raw: HeldBillInput): HeldBill {
  const input = heldBillSchema.parse(raw)
  const bills = listHeldBills(db)
  if (bills.length >= 50) throw new Error('50 bills are on hold — recall or discard some first')
  const now = new Date().toISOString()
  const bill: HeldBill = {
    id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: input.label || `Bill ${bills.length + 1}`,
    heldAt: now,
    partyLedgerId: input.partyLedgerId,
    lines: input.lines.map((l) => ({ itemId: l.itemId, qtyMilli: l.qtyMilli, ratePaise: l.ratePaise, discountPaise: l.discountPaise, rateSource: l.rateSource }))
  }
  writeMeta(db, HELD_KEY, [...bills, bill])
  // Held bills have string ids — entity_id 0, the id is in the JSON (WP 3.8).
  writeAudit(db, 'held_bill', 0, 'create', null, bill)
  return bill
}

/** Take a held bill back (it leaves the hold list). */
export function recallHeldBill(db: DB, id: string): HeldBill {
  const bills = listHeldBills(db)
  const bill = bills.find((b) => b.id === id)
  if (!bill) throw new Error('That bill is no longer on hold')
  writeMeta(db, HELD_KEY, bills.filter((b) => b.id !== id))
  writeAudit(db, 'held_bill', 0, 'delete', bill, { recalled: true, id })
  return bill
}

export function discardHeldBill(db: DB, id: string): void {
  const bills = listHeldBills(db)
  const bill = bills.find((b) => b.id === id)
  writeMeta(db, HELD_KEY, bills.filter((b) => b.id !== id))
  if (bill) writeAudit(db, 'held_bill', 0, 'delete', bill, { discarded: true, id })
}

// ---------------------------------------------------------------- day end


/** Sales by payment mode and items for one day's counter bills (live invoices only; the figures
 *  are read from their voucher lines, so an altered or binned bill is reflected). */
export function counterDayEnd(db: DB, date: string): DayEndSummary {
  const acc = counterAccounts(db)
  const invoices = db
    .prepare(
      `SELECT v.id AS voucherId, v.number, l.name AS partyName, cs.receipt_voucher_id AS receiptVoucherId, cs.change_paise AS change,
              (SELECT COALESCE(SUM(vl.amount), 0) FROM voucher_lines vl WHERE vl.voucher_id = v.id AND vl.ledger_id = v.party_ledger_id AND vl.dr_cr = 'dr') AS totalPaise
       FROM counter_sales cs JOIN vouchers v ON v.id = cs.invoice_voucher_id LEFT JOIN ledgers l ON l.id = v.party_ledger_id
       WHERE v.date = ? AND ${IN_BOOKS}
       ORDER BY v.id`
    )
    .all(date) as (DayEndSummary['invoices'][number] & { change: number })[]
  const ids = invoices.map((i) => i.voucherId)
  const receiptIds = invoices.map((i) => i.receiptVoucherId).filter((x): x is number => x != null)
  const ph = (n: number): string => Array(n).fill('?').join(',')
  const byLedger = receiptIds.length
    ? (db
        .prepare(
          `SELECT vl.ledger_id AS ledgerId, l.name, SUM(vl.amount) AS amount FROM voucher_lines vl
           JOIN vouchers v ON v.id = vl.voucher_id JOIN ledgers l ON l.id = vl.ledger_id
           WHERE vl.voucher_id IN (${ph(receiptIds.length)}) AND vl.dr_cr = 'dr' AND ${IN_BOOKS}
           GROUP BY vl.ledger_id ORDER BY vl.ledger_id`
        )
        .all(...receiptIds) as { ledgerId: number; name: string; amount: number }[])
    : []
  const modeOf = (ledgerId: number): PaymentMode | 'other' =>
    ledgerId === acc.cashLedgerId ? 'cash' : ledgerId === acc.upiLedgerId ? 'upi' : ledgerId === acc.cardLedgerId ? 'card' : 'other'
  const byMode = byLedger.map((r) => {
    const mode = modeOf(r.ledgerId)
    const shared = acc.upiLedgerId === acc.cardLedgerId && (mode === 'upi' || mode === 'card')
    return { mode, label: shared ? `UPI / Card · ${r.name}` : mode === 'other' ? r.name : `${PAYMENT_MODE_LABELS[mode]} · ${r.name}`, ledgerId: r.ledgerId, amountPaise: r.amount }
  })
  const items = ids.length
    ? (db
        .prepare(
          `SELECT il.stock_item_id AS itemId, si.name, u.symbol AS unitSymbol, SUM(il.qty_milli) AS qtyMilli, SUM(il.amount) AS amountPaise
           FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id JOIN units u ON u.id = si.unit_id
           WHERE il.voucher_id IN (${ph(ids.length)}) GROUP BY il.stock_item_id ORDER BY si.name`
        )
        .all(...ids) as DayEndSummary['items'])
    : []
  const totalPaise = invoices.reduce((s, i) => s + i.totalPaise, 0)
  const taxablePaise = items.reduce((s, i) => s + i.amountPaise, 0)
  const received = byMode.reduce((s, m) => s + m.amountPaise, 0)
  return {
    date, bills: invoices.length, totalPaise, taxablePaise, taxPaise: totalPaise - taxablePaise, byMode,
    onAccountPaise: totalPaise - received, changePaise: invoices.reduce((s, i) => s + i.change, 0), items,
    invoices: invoices.map(({ change: _c, ...i }) => i)
  }
}
