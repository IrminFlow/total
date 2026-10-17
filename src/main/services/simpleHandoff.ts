// WP 9.10 — "Back to simple" from a full-app screen lands on the matching simple screen WITH the
// same object (renderer lib/handoff.ts holds the one mapping table). The table needs two facts only
// main has, read here (viewer, read-only):
//
// - a voucher: its kind while it is IN the books (binned / optional / post-dated ones have no
//   simple view — the table then falls back to the flow), and for a credit / debit note the bill
//   it returns against (a `return` line link, else — a bill without item lines — the bill whose
//   number (sales) / supplier bill no. (purchase) the note carries as its reference, the way
//   services/simpleReturns.ts counts returns);
// - a ledger: whether it is a customer / supplier (a People page exists for it).
//
// WP 9.10 follow-up — `carryBackForm` (simple:carryBack): the unsaved editor's changes carried back
// into the simple form (the pure `carryBack`, shared/simple/carryBack.ts), over the context
// simple:post's own mapping loads (in a rehearsal — loading may create the walk-in, always rolled
// back) plus each party's open bills as on the entry's date. Writes nothing.
import type { DB } from '../db/connection'
import type { CompanyInfo, VoucherKind } from '@shared/domain'
import { isPartyLedger } from '@shared/chartOfAccounts'
import type { HandoffEntry, HandoffFacts } from '@shared/simple/handoff'
import { normaliseIntent } from '@shared/simple/intents'
import type { MoneyOpenBill } from '@shared/simple/money'
import { billOnly, carryBack, type CarryContext, type CarryFlow, type CarryForms, type CarryResult } from '@shared/simple/carryBack'
import { saleIntentFrom, type SellForm } from '@shared/simple/sell'
import { purchaseIntentFrom, type BuyForm } from '@shared/simple/buy'
import { moneyInIntentFrom, moneyOutIntentFrom, moveIntentFrom, type MoneyInForm, type MoneyOutForm, type MoveForm } from '@shared/simple/money'
import { returnIntentFrom, type ReturnForm } from '@shared/simple/returns'
import { listGroups } from './masters'
import { IN_BOOKS } from './vouchers'
import { intentForm, loadIntentContext } from './simplePost'
import { returnBill } from './simpleReturns'
import { moneyBills } from './simpleMoney'
import { WALK_IN_NAME } from './counter'
import { rehearse } from '../ai/drafting/rehearse'

export function handoffFacts(db: DB, q: { voucherId?: number; ledgerId?: number }): HandoffFacts {
  const out: HandoffFacts = {}
  if (q.voucherId != null) {
    const v = db
      .prepare(
        `SELECT v.id, vt.kind, v.party_ledger_id AS partyId, v.reference FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
         WHERE v.id = ? AND ${IN_BOOKS}`
      )
      .get(q.voucherId) as { id: number; kind: VoucherKind; partyId: number | null; reference: string | null } | undefined
    if (v) out.voucher = { id: v.id, kind: v.kind, originalId: v.kind === 'credit_note' || v.kind === 'debit_note' ? originalOf(db, v) : null }
  }
  if (q.ledgerId != null) {
    const l = db.prepare('SELECT id, group_id AS groupId FROM ledgers WHERE id = ?').get(q.ledgerId) as { id: number; groupId: number } | undefined
    if (l) out.ledger = { id: l.id, isParty: isPartyLedger(l, listGroups(db)) }
  }
  return out
}

function originalOf(db: DB, note: { id: number; kind: VoucherKind; partyId: number | null; reference: string | null }): number | null {
  const billKind = note.kind === 'credit_note' ? 'sales' : 'purchase'
  const linked = db
    .prepare(
      `SELECT ll.from_voucher_id AS id FROM line_links ll JOIN vouchers v ON v.id = ll.from_voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE ll.to_voucher_id = ? AND ll.link_type = 'return' AND vt.kind = ? AND ${IN_BOOKS} ORDER BY ll.id LIMIT 1`
    )
    .get(note.id, billKind) as { id: number } | undefined
  if (linked) return linked.id
  const ref = note.reference?.trim()
  if (!ref || note.partyId == null) return null
  const key = billKind === 'sales' ? 'v.number' : "COALESCE(NULLIF(TRIM(v.reference), ''), v.number)"
  const byRef = db
    .prepare(
      `SELECT v.id FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       WHERE vt.kind = ? AND v.party_ledger_id = ? AND ${key} = ? AND ${IN_BOOKS} ORDER BY v.date DESC, v.id DESC LIMIT 1`
    )
    .get(billKind, note.partyId, ref) as { id: number } | undefined
  return byRef?.id ?? null
}

export interface CarryBackRequest {
  flow: CarryFlow
  /** The answers the hand-off was made from (what simple:intentForm mapped). */
  intent: unknown
  original: HandoffEntry
  current: HandoffEntry
  base: CarryForms[CarryFlow]
}

export function carryBackForm(db: DB, company: CompanyInfo, req: CarryBackRequest, today: string): CarryResult {
  const n = normaliseIntent(req.intent, today)
  const ctx = rehearse(db, (): CarryContext => {
    const ic = loadIntentContext(db, company, n)
    const date = req.current.state.date
    // Open bills of every customer / supplier the editor's rows name (Money in / out ticks).
    const parties = new Set<number>()
    const ids = req.current.form === 'accounting' ? req.current.state.rows.map((r) => r.ledgerId) : req.current.form === 'invoice' ? [req.current.state.partyId] : []
    for (const id of ids) {
      const cls = id != null ? ic.ledgers.get(id)?.cls : undefined
      if (id != null && (cls === 'debtor' || cls === 'creditor')) parties.add(id)
    }
    const bills = new Map<number, MoneyOpenBill[]>()
    for (const id of parties) bills.set(id, moneyBills(db, id, date))
    const walkIn = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(WALK_IN_NAME) as { id: number } | undefined
    return {
      invoice: ic.invoice,
      ledgers: ic.ledgers,
      taxLedgers: ic.taxLedgers,
      walkInId: walkIn?.id ?? null,
      defaults: { salesId: ic.defaults.salesId, purchaseId: ic.defaults.purchaseId, drawingsId: ic.defaults.drawingsId },
      openBills: bills,
      original: ic.original
    }
  })
  return carryBack({ flow: req.flow, original: req.original, current: req.current, base: req.base }, ctx, {
    remap: (form) => remapForm(db, company, req.flow, form, ctx, n.kind === 'return_sale' || n.kind === 'return_purchase' ? n.billId : null, today)
  })
}

/** The entry the carried form itself hands off — the flow's own intent builder, then
 *  simple:intentForm's mapping (rolled back), the bill alone (what is paid now is not in the
 *  editor). Its fields are what the editor would hold for these answers. */
function remapForm(db: DB, company: CompanyInfo, flow: CarryFlow, form: CarryForms[CarryFlow], ctx: CarryContext, billId: number | null, today: string): HandoffEntry | null {
  const none = { cash: null, upi: null, card: null, bank: null }
  const sell = { invoice: ctx.invoice, salesAccountId: ctx.defaults.salesId }
  const buy = { invoice: ctx.invoice, purchaseAccountId: ctx.defaults.purchaseId }
  let intent: Record<string, unknown>
  switch (flow) {
    case 'simple-sell':
      intent = saleIntentFrom(form as SellForm, sell, none)
      break
    case 'simple-buy':
      intent = purchaseIntentFrom(form as BuyForm, buy, none)
      break
    case 'simple-money-in': {
      const f = form as MoneyInForm
      intent = moneyInIntentFrom(f, f.customerId != null ? (ctx.openBills.get(f.customerId) ?? []) : [], none, { ownerId: f.sourceId })
      break
    }
    case 'simple-money-out': {
      const f = form as MoneyOutForm
      intent = moneyOutIntentFrom(f, f.supplierId != null ? (ctx.openBills.get(f.supplierId) ?? []) : [], none, {
        facts: ctx.invoice,
        companyStateCode: ctx.invoice.companyStateCode,
        supplierState: (id) => ctx.ledgers.get(id)?.stateCode ?? null,
        drawingsId: ctx.defaults.drawingsId
      })
      break
    }
    case 'simple-move-money':
      intent = moveIntentFrom(form as MoveForm)
      break
    case 'simple-return-sale':
    case 'simple-return-purchase': {
      const f = form as ReturnForm
      const bill = billId != null ? returnBill(db, company, flow === 'simple-return-sale' ? 'sale' : 'purchase', billId, f.date) : null
      if (!bill) return null
      intent = returnIntentFrom(f, bill, { invoice: ctx.invoice }, none)
      break
    }
  }
  return intentForm(db, company, { ...billOnly(intent), clientId: 'accountant-view-carry-back' }, today).entries[0] ?? null
}
