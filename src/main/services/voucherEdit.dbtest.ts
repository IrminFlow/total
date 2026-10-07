// WP 1.4 acceptance: for every voucher kind, a rich saved voucher read back with getVoucher,
// fed through the editor's own pure load → payload path (src/shared/voucherEdit — the code the
// entry screens run), and saved again leaves voucher_lines, inventory_lines, bill_refs, cost
// allocations and tds_entries identical apart from row ids. Also pins which entry mode each
// voucher opens in.
import { describe, it, expect } from 'vitest'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { DB } from '../db/connection'
import type { Group, Voucher, VoucherKind } from '@shared/domain'
import {
  buildAccountingPayload, buildInvoicePayload, buildPhysicalPayload, buildStockLinesPayload, buildTransferPayload, withJobWorker,
  derivePartyId, emptyInvoiceState, emptyPhysicalState, evaluateManufactureForm, planVoucherEdit, taxLedgerIdsFrom,
  LEGACY_STOCK_JOURNAL_BANNER, type EditPlan, type EditPlanContext, type VoucherPayload
} from '@shared/voucherEdit'
import { createBatch, createGodown, createLedger, createStockItem, listGroups, listLedgers, listStockItems } from './masters'
import { saveVoucher, getVoucher } from './vouchers'
import { saveCostCentre } from './costCentres'
import { listSections } from './tds'
import { setBom } from './extras'
import { costPreview, getManufactureDetails, saveManufacture } from './manufacture'
import type { ManufactureInput } from '@shared/manufacture'
import { setBankDate } from './banking'
import { dc, grn, item as tradeItem, trade, tradeBooks, uid as lineUid } from './tradeFixture.testutil'
import { getJobWorkChallan, saveJobWorkChallan } from './jobWork'
import { saveBomVersion } from './bom'
import { buildJobWorkChallan } from '@shared/voucherEdit'
import { applyTdsToVoucher, removeTdsFromVoucher } from './tdsWorkbench'

type LedgerKind = 'Sundry Debtors' | 'Sundry Creditors' | 'Sales Accounts' | 'Purchase Accounts' | 'Duties & Taxes' | 'Indirect Expenses' | 'Bank Accounts'

function ledger(
  db: DB, name: string, group: LedgerKind,
  extra: { stateCode?: string; taxType?: 'cgst' | 'sgst' | 'igst' | 'cess'; tdsSectionId?: number; tdsPayableSectionId?: number } = {}
): number {
  const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(group) as { id: number }
  return createLedger(db, {
    name, groupId: g.id, openingBalance: 0, gstin: null, stateCode: extra.stateCode ?? null, address: null,
    taxType: extra.taxType ?? null, gstRate: null, hsn: null, tdsSectionId: extra.tdsSectionId ?? null,
    pan: extra.tdsSectionId ? 'ABCDE1234F' : null, creditDays: null, exportType: null,
    tdsPayableSectionId: extra.tdsPayableSectionId ?? null
  }).id
}

function item(db: DB, name: string, gstRate: number | null, cessRate: number | null = null): number {
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }
  return createStockItem(db, {
    name, groupId: null, unitId: unit.id, hsn: '8471', gstRate, cessRate,
    openingQtyMilli: 1_000_000, openingValue: 1_000_000, barcode: null, reorderLevelMilli: null
  }).id
}

function typeId(db: DB, kind: VoucherKind): number {
  return (db.prepare('SELECT id FROM voucher_types WHERE kind = ?').get(kind) as { id: number }).id
}

const header = {
  partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
  vehicleNo: null, transportDistanceKm: null, posOverride: null, currencyCode: null, exchangeRate: null
}

function setup(db: DB) {
  const cgst = ledger(db, 'CGST', 'Duties & Taxes', { taxType: 'cgst' })
  const sgst = ledger(db, 'SGST', 'Duties & Taxes', { taxType: 'sgst' })
  const igst = ledger(db, 'IGST', 'Duties & Taxes', { taxType: 'igst' })
  const cess = ledger(db, 'Cess', 'Duties & Taxes', { taxType: 'cess' })
  const roundOff = ledger(db, 'Round Off', 'Indirect Expenses')
  const section = listSections(db)[0]!
  const ids = {
    cgst, sgst, igst, cess, roundOff,
    buyer: ledger(db, 'Buyer MH', 'Sundry Debtors', { stateCode: '27' }),
    buyerKa: ledger(db, 'Buyer KA', 'Sundry Debtors', { stateCode: '29' }),
    supplier: ledger(db, 'Supplier', 'Sundry Creditors', { stateCode: '27' }),
    contractor: ledger(db, 'Contractor', 'Sundry Creditors', { stateCode: '27', tdsSectionId: section.id }),
    // Tagged as the section's payable ledger (migration 020) — saveVoucher validates TDS against it.
    tdsPayable: ledger(db, 'TDS Payable', 'Duties & Taxes', { tdsPayableSectionId: section.id }),
    sales: ledger(db, 'Sales', 'Sales Accounts'),
    purchases: ledger(db, 'Purchases', 'Purchase Accounts'),
    freight: ledger(db, 'Freight', 'Indirect Expenses'),
    bank: ledger(db, 'HDFC', 'Bank Accounts'),
    cash: (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id,
    sectionId: section.id,
    widget: item(db, 'Widget', 18),
    gadget: item(db, 'Gadget', 5, 1),
    steel: item(db, 'Steel', 18),
    paint: item(db, 'Paint', 18),
    chair: item(db, 'Chair', 18),
    godownA: createGodown(db, { name: 'Main' }).id,
    godownB: createGodown(db, { name: 'Annex' }).id,
    ccA: saveCostCentre(db, { name: 'Mumbai', parentId: null, active: true }).id,
    ccB: saveCostCentre(db, { name: 'Pune', parentId: null, active: true }).id
  }
  const batch = createBatch(db, { stockItemId: ids.widget, name: 'B-1', mfgDate: null, expiryDate: null }).id
  const steelBatch = createBatch(db, { stockItemId: ids.steel, name: 'S-1', mfgDate: null, expiryDate: null }).id
  setBom(db, { itemId: ids.chair, lines: [{ componentId: ids.steel, qtyMilliPerUnit: 2000 }, { componentId: ids.paint, qtyMilliPerUnit: 250 }] })
  return { ...ids, batch, steelBatch }
}

/** The renderer's planning context, built from the same masters the screens load. */
function editContext(db: DB, voucherId?: number): EditPlanContext {
  const ledgers = listLedgers(db)
  const items = listStockItems(db)
  return {
    invoice: {
      companyStateCode: TEST_INFO.stateCode,
      items: new Map(items.map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
      ledgers: new Map(ledgers.map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate, tdsPayableSectionId: l.tdsPayableSectionId }]))
    },
    taxLedgers: taxLedgerIdsFrom(ledgers),
    manufacture: voucherId ? getManufactureDetails(db, voucherId) : null,
    jobWork: voucherId ? getJobWorkChallan(db, voucherId) : null,
    itemName: (id) => items.find((i) => i.id === id)?.name ?? ''
  }
}

function kindOf(db: DB, v: Voucher): VoucherKind {
  return (db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(v.voucherTypeId) as { kind: VoucherKind }).kind
}

/** Exactly what the Manufacture screen posts when the user opens a manufacture and hits Save:
 *  the reconstructed form, priced by manufacture:costPreview at the voucher's own position. */
function manufactureEditorInput(db: DB, v: Voucher, plan: EditPlan & { mode: 'manufacture' }): ManufactureInput {
  const first = evaluateManufactureForm(plan.state, { voucherTypeId: v.voucherTypeId, materialPaise: undefined })
  const preview = costPreview(db, {
    date: plan.state.date, voucherId: v.id, finishedItemId: plan.state.finishedItemId,
    lines: first.input.raw.map((r) => ({ itemId: r.stockItemId, qtyMilli: r.qtyMilli }))
  })
  const ev = evaluateManufactureForm(plan.state, { voucherTypeId: v.voucherTypeId, materialPaise: preview.totalPaise, confirmLoss: true })
  if (ev.issues.length) throw new Error(ev.issues[0]!.message)
  return ev.input
}

/** Exactly what the entry screen posts when the user opens `v` and hits Save. */
function editorPayload(db: DB, v: Voucher): { plan: EditPlan; payload: VoucherPayload } {
  const kind = kindOf(db, v)
  const ctx = editContext(db, v.id)
  const plan = planVoucherEdit(v, kind, ctx)
  if (plan.mode === 'manufacture') throw new Error('manufacture saves through manufactureEditorInput')
  const ledgers = listLedgers(db)
  const groups = new Map(listGroups(db).map((g) => [g.id, g]))
  const isPartyOrTds = (id: number): boolean => {
    const l = ledgers.find((x) => x.id === id)
    if (!l) return false
    let g: Group | undefined = groups.get(l.groupId)
    while (g) {
      if (g.name === 'Sundry Debtors' || g.name === 'Sundry Creditors') return true
      g = g.parentId ? groups.get(g.parentId) : undefined
    }
    return l.tdsSectionId != null
  }
  const r =
    plan.mode === 'invoice'
      ? buildInvoicePayload(plan.state, { ...ctx.invoice, kind }, v.voucherTypeId, ctx.taxLedgers)
      : plan.mode === 'accounting'
        ? buildAccountingPayload(plan.state, { kind, voucherTypeId: v.voucherTypeId, derivedPartyId: derivePartyId(plan.state.rows, isPartyOrTds, null) })
        : plan.mode === 'physical'
            ? buildPhysicalPayload(plan.state, { voucherTypeId: v.voucherTypeId, itemName: ctx.itemName })
            : plan.mode === 'transfer'
              ? buildTransferPayload(plan.state, { voucherTypeId: v.voucherTypeId, costs: [] })
              : plan.mode === 'jobWorkSend'
                ? buildTransferPayload(withJobWorker(plan.state.transfer, plan.state.challan), { voucherTypeId: v.voucherTypeId, costs: [] })
                : buildStockLinesPayload(plan.state, { voucherTypeId: v.voucherTypeId })
  if (!r.ok) throw new Error(`${plan.mode}: ${r.error}`)
  return { plan, payload: r.payload }
}

/** Every stored row of a voucher, ids stripped (line order kept — it's stored). */
function snapshot(db: DB, id: number): unknown {
  return {
    voucher: db
      .prepare(
        `SELECT voucher_type_id, date, number, party_ledger_id, narration, reference, instrument_no, instrument_date,
                transporter_id, vehicle_no, transport_distance, pos_override, currency_code, exchange_rate,
                irn, irn_ack_no, irn_ack_date, ewb_no, ewb_valid_upto, post_dated, is_optional, deleted_at, created_at
         FROM vouchers WHERE id = ?`
      )
      .get(id),
    lines: db.prepare('SELECT ledger_id, dr_cr, amount, line_order, bank_date FROM voucher_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    inventory: db
      .prepare(
        `SELECT stock_item_id, godown_id, batch_id, qty_milli, rate_paise, discount_paise, amount, direction, is_absolute, line_order, serials
         FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order`
      )
      .all(id),
    billRefs: db.prepare('SELECT party_ledger_id, kind, name, amount, due_date FROM bill_refs WHERE voucher_id = ? ORDER BY id').all(id),
    costAllocations: db
      .prepare(
        `SELECT vl.line_order, a.cost_centre_id, a.amount FROM voucher_line_cost_allocations a
         JOIN voucher_lines vl ON vl.id = a.voucher_line_id WHERE vl.voucher_id = ? ORDER BY vl.line_order, a.id`
      )
      .all(id),
    // The entry id is part of the snapshot: an edit must update the entry in place (challan
    // allocations key on it), never delete + reinsert.
    tds: db
      .prepare('SELECT id, section_id, party_ledger_id, pan, base_amount, tds_amount, is_manual, rate_bp_at, deductee_type_at, certificate_id FROM tds_entries WHERE voucher_id = ?')
      .all(id),
    manufacture: db.prepare('SELECT * FROM manufacture_details WHERE voucher_id = ?').all(id),
    // WP 2.4
    outputs: db.prepare('SELECT line_order, stock_item_id, qty_milli, value_paise, kind FROM manufacture_outputs WHERE voucher_id = ? ORDER BY line_order').all(id),
    jobWork: db.prepare('SELECT * FROM job_work_challans WHERE voucher_id = ?').all(id),
    losses: db.prepare('SELECT * FROM job_work_losses WHERE voucher_id = ? ORDER BY line_order').all(id),
    transferMark: db.prepare('SELECT * FROM stock_transfers WHERE voucher_id = ?').all(id),
    // WP 2.5: stable line uids (except manufactures — manufacture:save rebuilds the journal and
    // renumbers its lines; they can never be linked), moves_stock, the voucher's links both
    // ways and the challan / GRN purpose all survive an open → save.
    lineUids: db.prepare('SELECT 1 FROM manufacture_details WHERE voucher_id = ?').get(id)
      ? null
      : db.prepare('SELECT line_uid, moves_stock FROM inventory_lines WHERE voucher_id = ? ORDER BY line_order').all(id),
    links: db
      .prepare(
        `SELECT link_type, from_voucher_id, from_line_uid, to_voucher_id, to_line_uid, qty_milli, reprices FROM line_links
         WHERE to_voucher_id = ? OR from_voucher_id = ? ORDER BY to_line_uid`
      )
      .all(id, id),
    trade: db.prepare('SELECT purpose, closed_at FROM trade_voucher_details WHERE voucher_id = ?').all(id)
  }
}

/** Open → save through whichever path the screen uses (manufacture:save or voucher:save). */
function resave(db: DB, id: number): EditPlan {
  const v = getVoucher(db, id)!
  const plan = planVoucherEdit(v, kindOf(db, v), editContext(db, id))
  if (plan.mode === 'manufacture') saveManufacture(db, manufactureEditorInput(db, v, plan), id)
  else if (plan.mode === 'jobWorkSend') {
    const built = buildJobWorkChallan(plan.state, { voucherTypeId: v.voucherTypeId, costs: [] })
    if (!built.ok) throw new Error(built.error)
    saveJobWorkChallan(db, built.payload, id)
  } else saveVoucher(db, editorPayload(db, v).payload, id)
  return plan
}

function expectRoundTrip(db: DB, id: number, mode: EditPlan['mode']): EditPlan {
  const before = snapshot(db, id)
  const plan = resave(db, id)
  expect(plan.mode).toBe(mode)
  expect(snapshot(db, id)).toEqual(before)
  // …and a second pass is just as stable.
  resave(db, id)
  expect(snapshot(db, id)).toEqual(before)
  return plan
}

describe('voucher editor round-trip (WP 1.4): load → save unchanged stores identical rows', () => {
  const db = seededDb()
  const x = setup(db)
  const ctx = editContext(db)
  const invoiceFrom = (kind: VoucherKind, over: Partial<ReturnType<typeof emptyInvoiceState>>): number => {
    const r = buildInvoicePayload({ ...emptyInvoiceState('2025-05-10'), ...over }, { ...ctx.invoice, kind }, typeId(db, kind), ctx.taxLedgers)
    if (!r.ok) throw new Error(r.error)
    return saveVoucher(db, r.payload).id
  }

  it('purchase (invoice form): batch + godown + discount + new bill + transport + reference', () => {
    const id = invoiceFrom('purchase', {
      partyId: x.supplier, accountId: x.purchases, billName: 'SUP-INV-1', billDueDate: '2025-06-10', reference: 'PO-1',
      rows: [
        { itemId: x.widget, qtyText: '10', rate: 50000, discount: 2500, godownId: x.godownA, batchId: x.batch },
        { itemId: x.gadget, qtyText: '2.5', rate: 9999, discount: null, godownId: x.godownB, batchId: null }
      ]
    })
    expectRoundTrip(db, id, 'invoice')
  })

  it('sales (invoice form): discount, batch, godown, e-way details, POS override, optional flag', () => {
    const id = invoiceFrom('sales', {
      partyId: x.buyerKa, accountId: x.sales, billName: 'INV-1', billDueDate: '2025-06-01', vehicleNo: 'MH01AB1234',
      transporterId: '27ABCDE1234F1Z5', distanceKm: '210', narration: 'Being goods sold', posOverride: '29',
      rows: [{ itemId: x.widget, qtyText: '3', rate: 70000, discount: 10000, godownId: x.godownA, batchId: x.batch }]
    })
    const plan = expectRoundTrip(db, id, 'invoice')
    expect(plan.mode === 'invoice' && plan.state.rows[0]).toMatchObject({ discount: 10000, batchId: x.batch, godownId: x.godownA, qtyText: '3' })
  })

  it('credit note (invoice form) allocated against bills', () => {
    const r = buildInvoicePayload(
      { ...emptyInvoiceState('2025-05-11'), partyId: x.buyer, accountId: x.sales, rows: [{ itemId: x.gadget, qtyText: '1', rate: 10000, discount: null, godownId: null, batchId: null }] },
      { ...ctx.invoice, kind: 'credit_note' }, typeId(db, 'credit_note'), ctx.taxLedgers
    )
    if (!r.ok) throw new Error(r.error)
    const total = r.payload.lines[0]!.amount
    const id = saveVoucher(db, { ...r.payload, billRefs: [{ kind: 'against', name: 'INV-1', amount: total, dueDate: null }] }).id
    expectRoundTrip(db, id, 'invoice')
  })

  it('debit note (invoice form) as a new bill', () => {
    const id = invoiceFrom('debit_note', {
      partyId: x.supplier, accountId: x.purchases, manualNewBillMode: true, billName: 'DN-1', billDueDate: '',
      rows: [{ itemId: x.widget, qtyText: '1', rate: 50000, discount: null, godownId: x.godownA, batchId: x.batch }]
    })
    expectRoundTrip(db, id, 'invoice')
  })

  it('hand-built sales with freight + cost allocations opens in accounting mode, losslessly', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'sales'), date: '2025-05-12', number: 'S-HAND', partyLedgerId: x.buyer, narration: 'hand-built',
      lines: [
        { ledgerId: x.buyer, drCr: 'dr', amount: 128000 },
        { ledgerId: x.sales, drCr: 'cr', amount: 100000, costAllocations: [{ costCentreId: x.ccB, amount: 60000 }, { costCentreId: x.ccA, amount: 40000 }] },
        { ledgerId: x.freight, drCr: 'cr', amount: 10000 },
        { ledgerId: x.cgst, drCr: 'cr', amount: 9000 },
        { ledgerId: x.sgst, drCr: 'cr', amount: 9000 }
      ],
      inventory: [{ stockItemId: x.widget, godownId: x.godownB, batchId: x.batch, qtyMilli: 2000, ratePaise: 55000, discountPaise: 10000, amount: 100000, direction: 'out' }],
      billRefs: [{ kind: 'new', name: 'S-HAND', amount: 128000, dueDate: '2025-06-12' }]
    }).id
    const plan = expectRoundTrip(db, id, 'accounting')
    expect(plan.mode === 'accounting' && plan.fallbackReason).toBeTruthy()
  })

  it('purchase (invoice form) with TDS: opens in invoice mode, entry and payable credit unchanged', () => {
    // Contractor flagged for the first section (194A, 10%): base = taxable value 5,00,000 paise.
    const taxable = 500000
    // Its own item, so the purchase doesn't move the average cost other tests' stock relies on
    // (a fresh context, since the shared one predates the item).
    const kit = item(db, 'TDS Service Kit', 18)
    const fresh = editContext(db)
    const r = buildInvoicePayload({
      ...emptyInvoiceState('2025-05-10'),
      partyId: x.contractor, accountId: x.purchases, billName: 'CON-INV-1', billDueDate: '2025-06-10',
      rows: [{ itemId: kit, qtyText: '1', rate: taxable, discount: null, godownId: null, batchId: null }],
      tds: { sectionId: x.sectionId, baseAmount: taxable, tdsAmount: 50000, isManual: false, payableLedgerId: x.tdsPayable, pending: false }
    }, { ...fresh.invoice, kind: 'purchase' }, typeId(db, 'purchase'), fresh.taxLedgers)
    if (!r.ok) throw new Error(r.error)
    const id = saveVoucher(db, r.payload).id
    const v = getVoucher(db, id)!
    expect(v.tds).toMatchObject({ tdsAmount: 50000, isManual: false, rateBp: 1000 })
    expect(v.lines[v.lines.length - 1]).toMatchObject({ ledgerId: x.tdsPayable, drCr: 'cr', amount: 50000 })
    expectRoundTrip(db, id, 'invoice')
  })

  it('payment with TDS, cost allocations, cheque details and a reconciled bank line', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'payment'), date: '2025-05-13', partyLedgerId: x.contractor,
      instrumentNo: '000123', instrumentDate: '2025-05-01', reference: 'Contract #9', narration: 'Being paid',
      lines: [
        { ledgerId: x.contractor, drCr: 'dr', amount: 100000, costAllocations: [{ costCentreId: x.ccA, amount: 100000 }] },
        { ledgerId: x.bank, drCr: 'cr', amount: 99000 },
        { ledgerId: x.tdsPayable, drCr: 'cr', amount: 1000 }
      ],
      billRefs: [{ kind: 'against', name: 'CON-1', amount: 100000, dueDate: null }],
      // Manual: 1% isn't 194A's table rate — the server then only requires the payable credit.
      tds: { sectionId: x.sectionId, baseAmount: 100000, tdsAmount: 1000, isManual: true }
    }).id
    const bankLine = getVoucher(db, id)!.lines.find((l) => l.ledgerId === x.bank)!
    setBankDate(db, bankLine.id, '2025-05-15')
    expectRoundTrip(db, id, 'accounting')
    expect(getVoucher(db, id)!.lines.find((l) => l.ledgerId === x.bank)!.bankDate).toBe('2025-05-15')
  })

  // WP 3.2 — Move to TDS / remove from the TDS screen keep every editor round-trip intact.
  it('Move to TDS on a purchase invoice: still opens in invoice mode; removing restores the original rows', () => {
    const kit = item(db, 'TDS Move Kit', 18)
    const fresh = editContext(db)
    const r = buildInvoicePayload({
      ...emptyInvoiceState('2025-05-20'),
      partyId: x.contractor, accountId: x.purchases, billName: 'CON-INV-MOVE', billDueDate: '2025-06-20',
      rows: [{ itemId: kit, qtyText: '1', rate: 500000, discount: null, godownId: null, batchId: null }]
    }, { ...fresh.invoice, kind: 'purchase' }, typeId(db, 'purchase'), fresh.taxLedgers)
    if (!r.ok) throw new Error(r.error)
    const id = saveVoucher(db, r.payload).id
    const original = snapshot(db, id) as { lines: unknown; billRefs: unknown }
    applyTdsToVoucher(db, { voucherId: id })
    const v = getVoucher(db, id)!
    expect(v.tds).toMatchObject({ baseAmount: 500000, tdsAmount: 50000 })
    expect(v.lines[v.lines.length - 1]).toMatchObject({ ledgerId: x.tdsPayable, drCr: 'cr', amount: 50000 })
    expectRoundTrip(db, id, 'invoice')
    removeTdsFromVoucher(db, id)
    const back = snapshot(db, id) as { lines: unknown; billRefs: unknown; tds: unknown[] }
    expect(back.lines).toEqual(original.lines)
    expect(back.billRefs).toEqual(original.billRefs)
    expect(back.tds).toEqual([])
    expectRoundTrip(db, id, 'invoice')
  })

  it('Move to TDS on a journal and on a payment: accounting mode round-trips both ways', () => {
    const j = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'journal'), date: '2025-05-21', partyLedgerId: x.contractor,
      lines: [{ ledgerId: x.freight, drCr: 'dr', amount: 200000 }, { ledgerId: x.contractor, drCr: 'cr', amount: 200000 }],
      billRefs: [{ kind: 'new', name: 'J-MOVE', amount: 200000, dueDate: null }]
    }).id
    const p = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'payment'), date: '2025-05-22', partyLedgerId: x.contractor,
      lines: [{ ledgerId: x.contractor, drCr: 'dr', amount: 300000 }, { ledgerId: x.bank, drCr: 'cr', amount: 300000 }]
    }).id
    for (const id of [j, p]) {
      const original = snapshot(db, id) as { lines: unknown; billRefs: unknown }
      applyTdsToVoucher(db, { voucherId: id, manualPaise: 2000 })
      expectRoundTrip(db, id, 'accounting')
      removeTdsFromVoucher(db, id)
      const back = snapshot(db, id) as { lines: unknown; billRefs: unknown }
      expect(back.lines).toEqual(original.lines)
      expect(back.billRefs).toEqual(original.billRefs)
      expectRoundTrip(db, id, 'accounting')
    }
  })

  it('receipt with an advance bill ref, post-dated', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'receipt'), date: '2025-05-14', partyLedgerId: x.buyer, postDated: true,
      lines: [{ ledgerId: x.bank, drCr: 'dr', amount: 50000 }, { ledgerId: x.buyer, drCr: 'cr', amount: 50000 }],
      billRefs: [{ kind: 'against', name: 'INV-1', amount: 20000, dueDate: null }, { kind: 'new', name: 'ADV-1', amount: 30000, dueDate: null }]
    }).id
    expectRoundTrip(db, id, 'accounting')
  })

  it('contra', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'contra'), date: '2025-05-15', narration: 'cash deposit',
      lines: [{ ledgerId: x.bank, drCr: 'dr', amount: 20000 }, { ledgerId: x.cash, drCr: 'cr', amount: 20000 }]
    }).id
    expectRoundTrip(db, id, 'accounting')
  })

  it('journal with TDS, cost allocations, an optional flag and stock lines (batch, discount, godown, absolute)', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'journal'), date: '2025-05-16', partyLedgerId: x.contractor, isOptional: true,
      lines: [
        { ledgerId: x.freight, drCr: 'dr', amount: 10000, costAllocations: [{ costCentreId: x.ccA, amount: 7000 }, { costCentreId: x.ccB, amount: 3000 }] },
        { ledgerId: x.contractor, drCr: 'cr', amount: 9900 },
        { ledgerId: x.tdsPayable, drCr: 'cr', amount: 100 }
      ],
      inventory: [
        { stockItemId: x.widget, godownId: x.godownA, batchId: x.batch, qtyMilli: 500, ratePaise: 50000, discountPaise: 500, amount: 24500, direction: 'in' },
        { stockItemId: x.paint, godownId: x.godownB, batchId: null, qtyMilli: 0, ratePaise: 0, amount: 0, direction: 'in', isAbsolute: true }
      ],
      billRefs: [{ kind: 'new', name: 'J-BILL', amount: 9900, dueDate: '2025-07-01' }],
      tds: { sectionId: x.sectionId, baseAmount: 10000, tdsAmount: 100, isManual: true }
    }).id
    expectRoundTrip(db, id, 'accounting')
  })

  it('manufacture (Manufacture screen): godowns, labour posted, custom narration — opens in the manufacture form', () => {
    const sj = typeId(db, 'stock_journal')
    const saved = saveManufacture(db, {
      date: '2025-05-17', godownId: x.godownB, narration: 'Run #4', finishedItemId: x.chair, qtyMilli: 3000, saleRatePaise: 250000,
      raw: [{ stockItemId: x.steel, qtyMilli: 6000, godownId: x.godownA }, { stockItemId: x.paint, qtyMilli: 750 }],
      labourPaise: 12345, labourPosted: true,
      profitPaise: 750000 - (6000 + 750 + 12345), // opening stock costs ₹10 (1000 paise) per unit for every item
      voucherTypeId: sj
    })
    const plan = expectRoundTrip(db, saved.id, 'manufacture')
    expect(plan.mode === 'manufacture' && plan.state).toMatchObject({ finishedItemId: x.chair, qtyText: '3', godownId: x.godownB, narration: 'Run #4', labourPosted: true })
    // A raw line in a different godown than the header keeps its own.
    expect(getVoucher(db, saved.id)!.inventory.map((l) => l.godownId)).toEqual([x.godownA, x.godownB, x.godownB])
  })

  it('manufacture with labour already booked (no ledger lines) — lossless too', () => {
    const saved = saveManufacture(db, {
      date: '2025-05-17', finishedItemId: x.chair, qtyMilli: 1000, saleRatePaise: 0,
      raw: [{ stockItemId: x.paint, qtyMilli: 250 }], labourPaise: 500, labourPosted: false,
      profitPaise: -(250 + 500), confirmLoss: true
    })
    expect(getVoucher(db, saved.id)!.lines).toEqual([])
    expectRoundTrip(db, saved.id, 'manufacture')
  })

  it('manufacture with by-products, scrap, a BOM version and the explode flag (WP 2.4) — lossless', () => {
    const v2 = saveBomVersion(db, { itemId: x.chair, name: 'v2', effectiveFrom: '2025-05-01', isDefault: false, lines: [{ componentId: x.steel, qtyMilliPerUnit: 2000, scrapPctBp: 500 }] })
    const raw = [{ stockItemId: x.steel, qtyMilli: 6300 }]
    const bp = [
      { stockItemId: x.widget, qtyMilli: 500, valuePaise: 1000, kind: 'by_product' as const },
      { stockItemId: x.paint, qtyMilli: 100, valuePaise: 50, kind: 'scrap' as const }
    ]
    const saved = saveManufacture(db, {
      date: '2025-05-19', godownId: x.godownA, finishedItemId: x.chair, qtyMilli: 3000, saleRatePaise: 1000,
      raw, labourPaise: 200, labourPosted: true, byProducts: bp, bomVersionId: v2.id, bomExploded: true,
      profitPaise: 3000 - (6300 + 200 - 1050), confirmLoss: true
    })
    const inv = getVoucher(db, saved.id)!.inventory
    expect(inv.map((l) => [l.stockItemId, l.direction, l.amount])).toEqual([
      [x.steel, 'out', 6300], [x.chair, 'in', 6300 + 200 - 1050], [x.widget, 'in', 1000], [x.paint, 'in', 50]
    ])
    const plan = expectRoundTrip(db, saved.id, 'manufacture')
    expect(plan.mode === 'manufacture' && plan.state).toMatchObject({
      bomVersionId: v2.id, bomExploded: true,
      byProducts: [
        { itemId: x.widget, qtyText: '0.5', valuePaise: 1000, kind: 'by_product' },
        { itemId: x.paint, qtyText: '0.1', valuePaise: 50, kind: 'scrap' }
      ]
    })
  })

  it('job-work send challan and receipt (WP 2.4) reopen in their own forms and re-save identically', () => {
    const worker = ledger(db, 'Job Worker Co', 'Sundry Creditors', { stateCode: '27' })
    const jw = createGodown(db, { name: 'At Job Worker', kind: 'job_worker', partyLedgerId: worker }).id
    const sj = typeId(db, 'stock_journal')
    const sent = saveJobWorkChallan(db, {
      voucher: {
        ...header, voucherTypeId: sj, date: '2025-05-20', lines: [],
        inventory: [
          { stockItemId: x.steel, godownId: x.godownA, batchId: null, qtyMilli: 5000, ratePaise: 1000, amount: 5000, direction: 'out' },
          { stockItemId: x.steel, godownId: jw, batchId: null, qtyMilli: 5000, ratePaise: 1000, amount: 5000, direction: 'in' }
        ]
      },
      challan: { kind: 'send', godownId: jw, natureOfProcessing: 'Powder coating', goodsType: 'inputs' }
    })
    const plan = expectRoundTrip(db, sent.id, 'jobWorkSend')
    expect(plan.mode === 'jobWorkSend' && plan.state.challan).toMatchObject({ kind: 'send', godownId: jw, natureOfProcessing: 'Powder coating' })
    const got = saveManufacture(db, {
      date: '2025-05-25', godownId: x.godownA, finishedItemId: x.chair, qtyMilli: 2000, saleRatePaise: 0,
      raw: [{ stockItemId: x.steel, qtyMilli: 4500, lossQtyMilli: 500 }], labourPaise: 900, labourPosted: true,
      jobWork: { godownId: jw, challanNo: 'JW-77', challanDate: '2025-05-24', natureOfProcessing: 'Powder coating', originalChallanVoucherId: sent.id },
      profitPaise: -(4500 + 900), confirmLoss: true
    })
    expect(getVoucher(db, got.id)!.inventory.map((l) => l.godownId)).toEqual([jw, x.godownA])
    const rplan = expectRoundTrip(db, got.id, 'manufacture')
    expect(rplan.mode === 'manufacture' && rplan.state.jobWork).toMatchObject({ godownId: jw, challanNo: 'JW-77', originalChallanVoucherId: sent.id })
    expect(rplan.mode === 'manufacture' && rplan.state.rows[0]).toMatchObject({ lossText: '0.5', godownId: null })
  })

  it('legacy stock journal (no manufacture_details row) opens as plain stock lines with the 0.6.0 banner', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'stock_journal'), date: '2025-05-17', narration: 'Manufactured 3 × Chair', lines: [],
      inventory: [
        { stockItemId: x.steel, godownId: x.godownA, batchId: null, qtyMilli: 6000, ratePaise: 15000, amount: 90000, direction: 'out' },
        { stockItemId: x.paint, godownId: null, batchId: null, qtyMilli: 750, ratePaise: 33333, amount: 25000, direction: 'out' },
        { stockItemId: x.chair, godownId: x.godownB, batchId: null, qtyMilli: 3000, ratePaise: 43125, amount: 129375, direction: 'in' }
      ]
    }).id
    const plan = expectRoundTrip(db, id, 'stockLines')
    expect(plan).toMatchObject({ legacy: true, fallbackReason: LEGACY_STOCK_JOURNAL_BANNER })
    expect(getManufactureDetails(db, id)).toBeNull()
  })

  it('a same-item godown transfer (WP 2.3) opens in the transfer form', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'stock_journal'), date: '2025-05-18', narration: 'Main → Annex', reference: 'TR-1',
      lines: [],
      inventory: [
        { stockItemId: x.widget, godownId: x.godownA, batchId: x.batch, qtyMilli: 1000, ratePaise: 50000, amount: 50000, direction: 'out' },
        { stockItemId: x.widget, godownId: x.godownB, batchId: x.batch, qtyMilli: 1000, ratePaise: 50000, amount: 50000, direction: 'in' }
      ]
    }).id
    const plan = expectRoundTrip(db, id, 'transfer')
    expect(plan.mode === 'transfer' && plan.state.rows).toEqual([
      expect.objectContaining({ itemId: x.widget, fromGodownId: x.godownA, toGodownId: x.godownB, qtyText: '1', batchId: x.batch })
    ])
  })

  it('arbitrary stock journal (unequal transfer legs) falls back to the generic stock-lines editor', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'stock_journal'), date: '2025-05-18', narration: 'Main → Annex', reference: 'TR-2',
      lines: [],
      inventory: [
        { stockItemId: x.widget, godownId: x.godownA, batchId: x.batch, qtyMilli: 1000, ratePaise: 50000, amount: 50000, direction: 'out' },
        { stockItemId: x.widget, godownId: x.godownB, batchId: x.batch, qtyMilli: 1000, ratePaise: 48000, amount: 48000, direction: 'in' }
      ]
    }).id
    expectRoundTrip(db, id, 'stockLines')
  })

  it('physical stock (absolute counts, zero count, godown, batch)', () => {
    const r = buildPhysicalPayload(
      {
        ...emptyPhysicalState('2025-05-19'), narration: 'Count',
        rows: [
          { itemId: x.widget, qtyText: '7.5', godownId: x.godownA, batchId: x.batch },
          { itemId: x.paint, qtyText: '0', godownId: null, batchId: null }
        ]
      },
      { voucherTypeId: typeId(db, 'physical_stock'), itemName: ctx.itemName }
    )
    if (!r.ok) throw new Error(r.error)
    const id = saveVoucher(db, r.payload).id
    expectRoundTrip(db, id, 'physical')
    expect(getVoucher(db, id)!.inventory.every((l) => l.isAbsolute)).toBe(true)
  })

  it('a valued physical-stock voucher (e.g. imported) uses the generic editor and keeps isAbsolute', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'physical_stock'), date: '2025-05-20',
      lines: [],
      inventory: [{ stockItemId: x.gadget, godownId: x.godownB, batchId: null, qtyMilli: 4000, ratePaise: 100, amount: 400, direction: 'in', isAbsolute: true }]
    }).id
    expectRoundTrip(db, id, 'stockLines')
    expect(getVoucher(db, id)!.inventory[0]!.isAbsolute).toBe(true)
  })

  it('getVoucher returns cost allocations in stored order', () => {
    const v = getVoucher(db, db.prepare("SELECT id FROM vouchers WHERE number = 'S-HAND'").pluck().get() as number)!
    expect(v.lines[1]!.costAllocations.map((a) => a.costCentreId)).toEqual([x.ccB, x.ccA])
  })
})

describe('serial numbers round-trip through every editor (WP 2.3)', () => {
  const db = seededDb()
  const x = setup(db)
  const unit = db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }
  const phone = createStockItem(db, {
    name: 'Phone', groupId: null, unitId: unit.id, hsn: '8517', gstRate: 18, cessRate: null, openingQtyMilli: 0, openingValue: 0,
    barcode: null, reorderLevelMilli: null, trackSerials: true
  }).id
  const ctx = editContext(db)
  const invoiceFrom = (kind: VoucherKind, over: Partial<ReturnType<typeof emptyInvoiceState>>): number => {
    const r = buildInvoicePayload({ ...emptyInvoiceState('2025-06-01'), ...over }, { ...ctx.invoice, kind }, typeId(db, kind), ctx.taxLedgers)
    if (!r.ok) throw new Error(r.error)
    return saveVoucher(db, r.payload).id
  }

  it('purchase and sale invoices with serials (godown + batch too) re-save identically', () => {
    const purchase = invoiceFrom('purchase', {
      partyId: x.supplier, accountId: x.purchases, billName: 'PH-1',
      rows: [{ itemId: phone, qtyText: '3', rate: 1_000_000, discount: null, godownId: x.godownA, batchId: null, serials: ['IMEI-3', 'IMEI-1', 'IMEI-2'] }]
    })
    expectRoundTrip(db, purchase, 'invoice')
    expect(getVoucher(db, purchase)!.inventory[0]!.serials).toEqual(['IMEI-3', 'IMEI-1', 'IMEI-2'])
    const sale = invoiceFrom('sales', {
      partyId: x.buyer, accountId: x.sales, billName: 'S-PH',
      rows: [{ itemId: phone, qtyText: '1', rate: 1_500_000, discount: null, godownId: x.godownA, batchId: null, serials: ['IMEI-1'] }]
    })
    const plan = expectRoundTrip(db, sale, 'invoice')
    expect(plan.mode === 'invoice' && plan.state.rows[0]!.serials).toEqual(['IMEI-1'])
  })

  it('a serial transfer opens in the transfer form and re-saves identically', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'stock_journal'), date: '2025-06-02', lines: [],
      inventory: [
        { stockItemId: phone, godownId: x.godownA, batchId: null, qtyMilli: 1000, ratePaise: 1_000_000, amount: 1_000_000, direction: 'out', serials: ['IMEI-2'] },
        { stockItemId: phone, godownId: x.godownB, batchId: null, qtyMilli: 1000, ratePaise: 1_000_000, amount: 1_000_000, direction: 'in', serials: ['IMEI-2'] }
      ]
    }).id
    expectRoundTrip(db, id, 'transfer')
  })

  it('a hand-built sale with serials falls back to accounting mode and keeps them', () => {
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'sales'), date: '2025-06-03', number: 'S-PH-HAND', partyLedgerId: x.buyer,
      lines: [{ ledgerId: x.buyer, drCr: 'dr', amount: 1_000_000 }, { ledgerId: x.sales, drCr: 'cr', amount: 1_000_000 }],
      inventory: [{ stockItemId: phone, godownId: x.godownB, batchId: null, qtyMilli: 1000, ratePaise: 1_000_000, amount: 1_000_001, direction: 'out', serials: ['IMEI-2'] }]
    }).id
    expectRoundTrip(db, id, 'accounting')
    expect(getVoucher(db, id)!.inventory[0]!.serials).toEqual(['IMEI-2'])
  })
})

describe('saveVoucher keeps bank reconciliation across an alteration', () => {
  it('carries bank_date to the matching line; a changed amount drops it', () => {
    const db = seededDb()
    const x = setup(db)
    const id = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'payment'), date: '2025-05-13',
      lines: [{ ledgerId: x.freight, drCr: 'dr', amount: 5000 }, { ledgerId: x.bank, drCr: 'cr', amount: 5000 }]
    }).id
    const line = getVoucher(db, id)!.lines[1]!
    setBankDate(db, line.id, '2025-05-20')
    saveVoucher(db, { ...header, voucherTypeId: typeId(db, 'payment'), date: '2025-05-13', narration: 'edited',
      lines: [{ ledgerId: x.freight, drCr: 'dr', amount: 5000 }, { ledgerId: x.bank, drCr: 'cr', amount: 5000 }] }, id)
    expect(getVoucher(db, id)!.lines[1]!.bankDate).toBe('2025-05-20')
    saveVoucher(db, { ...header, voucherTypeId: typeId(db, 'payment'), date: '2025-05-13',
      lines: [{ ledgerId: x.freight, drCr: 'dr', amount: 6000 }, { ledgerId: x.bank, drCr: 'cr', amount: 6000 }] }, id)
    expect(getVoucher(db, id)!.lines[1]!.bankDate).toBeNull()
  })
})

describe('voucher editor round-trip (WP 2.5a): challans, GRNs and linked invoices', () => {
  it('a delivery challan, a GRN and the invoice / bill drawn from them re-save byte-identical', () => {
    const b = tradeBooks()
    const db = b.db
    const w = tradeItem(db, 'Widget', { opening: [20, 20000] })
    const p = tradeItem(db, 'Phone', { serials: true })
    trade(b, 'purchase', '2025-04-10', [{ item: p, qty: 2, amount: 20000, godown: b.godown, serials: ['P1', 'P2'] }])
    const d = dc(b, '2025-05-01', [
      { item: w, qty: 5, amount: 5000, godown: b.godown },
      { item: p, qty: 2, amount: 26000, godown: b.godown, serials: ['P1', 'P2'] }
    ], { purpose: 'approval' })
    const g = grn(b, '2025-05-02', [{ item: w, qty: 4, amount: 4000, godown: b.godown2 }])
    const inv = trade(b, 'sales', '2025-05-03', [
      { item: w, qty: 3, amount: 3600, godown: b.godown, from: lineUid(db, d.id, 0) },
      { item: p, qty: 1, amount: 13000, godown: b.godown, serials: ['P2'], from: lineUid(db, d.id, 1) },
      { item: w, qty: 1, amount: 1200 }
    ])
    const bill = trade(b, 'purchase', '2025-05-04', [{ item: w, qty: 4, amount: 4400, godown: b.godown2, from: lineUid(db, g.id) }])
    const cn = trade(b, 'credit_note', '2025-05-06', [{ item: w, qty: 1, amount: 1200, godown: b.godown, from: lineUid(db, inv.id, 2), link: 'return' }])
    expectRoundTrip(db, d.id, 'stockLines')
    expectRoundTrip(db, g.id, 'stockLines')
    expectRoundTrip(db, inv.id, 'accounting') // no GST ledgers on these test lines → the invoice form can't show it
    expectRoundTrip(db, bill.id, 'accounting')
    expectRoundTrip(db, cn.id, 'accounting')
    expect(getVoucher(db, inv.id)!.inventory.map((l) => l.movesStock)).toEqual([false, false, true])
  })

  it('an invoice-mode sale drawn from a challan keeps its uids and links', () => {
    const b = tradeBooks()
    const db = b.db
    const z = tradeItem(db, 'Zero-rated', { opening: [20, 20000], gstRate: 0 })
    const d = dc(b, '2025-05-01', [{ item: z, qty: 5, amount: 5000, godown: b.godown }])
    const inv = trade(b, 'sales', '2025-05-03', [
      { item: z, qty: 3, amount: 3600, godown: b.godown, from: lineUid(db, d.id) },
      { item: z, qty: 1, amount: 1200, godown: b.godown }
    ])
    expectRoundTrip(db, inv.id, 'invoice')
    expect(getVoucher(db, inv.id)!.inventory[0]!.source).toEqual({ lineUid: lineUid(db, d.id), linkType: 'fulfil' })
  })
})
