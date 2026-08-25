import type { DB } from '../db/connection'
import {
  jobWorkGodownName,
  jobWorkStatus,
  planJobWorkReturn,
  type JobWorkGoodsType,
  type JobWorkLineFacts,
  type JobWorkStatus,
  type ReturnRequestLine
} from '@shared/jobWork'
import { todayISO } from '@shared/dates'
import { writeAudit } from './audit'
import { saveVoucher, deleteVoucher, getLockDate } from './vouchers'
import { outwardCostOf, stockByGodown } from './stockAnalysis'

/**
 * Job work: goods sent out for processing, and what comes back (roadmap E #127).
 *
 * Checked before building: there is no ITC-04 and no job-work service anywhere in this codebase —
 * roadmap D #89 is still open. So this is the stock movement half, with the section 143 clock, and
 * `itc04Rows` below is deliberately shaped as the return's own table so that #89 can be built on
 * top of it rather than beside it.
 *
 * **Nothing is posted to the books.** Title never leaves the principal, so there is no sale, no
 * purchase and no ledger entry — the goods move to a godown named for the job worker and stay in
 * the principal's closing stock, where they belong. The voucher that does the moving is a stock
 * journal with no ledger lines at all, exactly like a godown transfer, and the challan row points
 * at it so the two can never disagree about what went out.
 */

export interface JobWorkChallanLine {
  id: number
  stockItemId: number
  itemName: string
  unitSymbol: string
  qtyMilli: number
  ratePaise: number
  returnedQtyMilli: number
  pendingQtyMilli: number
}

export interface JobWorkChallan {
  id: number
  challanNo: string
  partyLedgerId: number
  partyName: string
  godownId: number
  godownName: string
  sentOn: string
  goodsType: JobWorkGoodsType
  natureOfProcessing: string | null
  voucherId: number | null
  notes: string | null
  lines: JobWorkChallanLine[]
  status: JobWorkStatus
  returns: { id: number; receivedOn: string; voucherId: number | null; notes: string | null }[]
}

/** The godown that holds a job worker's stock, created on first use. */
export function jobWorkGodown(db: DB, partyLedgerId: number): { id: number; name: string } {
  const party = db.prepare('SELECT id, name FROM ledgers WHERE id = ?').get(partyLedgerId) as
    | { id: number; name: string }
    | undefined
  if (!party) throw new Error('Job worker ledger not found')
  const name = jobWorkGodownName(party.name)
  const existing = db.prepare('SELECT id, name FROM godowns WHERE name = ?').get(name) as
    | { id: number; name: string }
    | undefined
  if (existing) return existing
  const res = db.prepare('INSERT INTO godowns (name) VALUES (?)').run(name)
  const created = { id: Number(res.lastInsertRowid), name }
  writeAudit(db, 'godown', created.id, 'create', null, created)
  return created
}

function lineFacts(db: DB, challanId: number): JobWorkLineFacts[] {
  return db
    .prepare(
      `SELECT l.stock_item_id AS stockItemId, si.name,
              l.qty_milli AS sentQtyMilli,
              COALESCE((
                SELECT SUM(rl.qty_milli) FROM job_work_return_lines rl
                  JOIN job_work_returns r ON r.id = rl.return_id
                 WHERE r.challan_id = l.challan_id AND rl.stock_item_id = l.stock_item_id
              ), 0) AS returnedQtyMilli
         FROM job_work_challan_lines l
         JOIN stock_items si ON si.id = l.stock_item_id
        WHERE l.challan_id = ?
        ORDER BY l.id`
    )
    .all(challanId) as JobWorkLineFacts[]
}

export function getChallan(db: DB, id: number, asOn = todayISO()): JobWorkChallan | null {
  const head = db
    .prepare(
      `SELECT c.id, c.challan_no AS challanNo, c.party_ledger_id AS partyLedgerId, l.name AS partyName,
              c.godown_id AS godownId, g.name AS godownName, c.sent_on AS sentOn, c.goods_type AS goodsType,
              c.nature_of_processing AS natureOfProcessing, c.voucher_id AS voucherId, c.notes
         FROM job_work_challans c
         JOIN ledgers l ON l.id = c.party_ledger_id
         JOIN godowns g ON g.id = c.godown_id
        WHERE c.id = ?`
    )
    .get(id) as Omit<JobWorkChallan, 'lines' | 'status' | 'returns'> | undefined
  if (!head) return null

  const facts = lineFacts(db, id)
  const status = jobWorkStatus({ sentOn: head.sentOn, goodsType: head.goodsType, lines: facts }, asOn)
  const detail = db
    .prepare(
      `SELECT l.id, l.stock_item_id AS stockItemId, si.name AS itemName, u.symbol AS unitSymbol,
              l.qty_milli AS qtyMilli, l.rate_paise AS ratePaise
         FROM job_work_challan_lines l
         JOIN stock_items si ON si.id = l.stock_item_id
         JOIN units u ON u.id = si.unit_id
        WHERE l.challan_id = ? ORDER BY l.id`
    )
    .all(id) as { id: number; stockItemId: number; itemName: string; unitSymbol: string; qtyMilli: number; ratePaise: number }[]
  const byItem = new Map(status.lines.map((l) => [l.stockItemId, l]))

  return {
    ...head,
    lines: detail.map((d) => ({
      ...d,
      returnedQtyMilli: byItem.get(d.stockItemId)?.returnedQtyMilli ?? 0,
      pendingQtyMilli: byItem.get(d.stockItemId)?.pendingQtyMilli ?? d.qtyMilli
    })),
    status,
    returns: db
      .prepare(
        'SELECT id, received_on AS receivedOn, voucher_id AS voucherId, notes FROM job_work_returns WHERE challan_id = ? ORDER BY received_on, id'
      )
      .all(id) as { id: number; receivedOn: string; voucherId: number | null; notes: string | null }[]
  }
}

export interface ChallanQuery {
  /** 'open' hides the ones that all came back — the default a person wants. */
  state?: 'all' | 'pending' | 'overdue'
  partyLedgerId?: number | null
  asOn?: string
}

export function listChallans(db: DB, query: ChallanQuery = {}): JobWorkChallan[] {
  const asOn = query.asOn ?? todayISO()
  const params: unknown[] = []
  let where = ''
  if (query.partyLedgerId != null) {
    where = ' WHERE party_ledger_id = ?'
    params.push(query.partyLedgerId)
  }
  const ids = db
    .prepare(`SELECT id FROM job_work_challans${where} ORDER BY sent_on DESC, id DESC`)
    .all(...params) as { id: number }[]
  const all = ids.map((r) => getChallan(db, r.id, asOn)!).filter(Boolean)
  if (query.state === 'pending') return all.filter((c) => c.status.state !== 'closed')
  if (query.state === 'overdue') return all.filter((c) => c.status.state === 'overdue')
  return all
}

export interface SendInput {
  partyLedgerId: number
  challanNo: string
  sentOn: string
  goodsType: JobWorkGoodsType
  natureOfProcessing?: string | null
  notes?: string | null
  /** Where the goods are leaving FROM. Null takes them from unallocated stock. */
  fromGodownId?: number | null
  lines: { stockItemId: number; qtyMilli: number }[]
}

function stockJournalTypeId(db: DB): number {
  const vt = db
    .prepare("SELECT id FROM voucher_types WHERE kind = 'stock_journal' ORDER BY is_system DESC, id LIMIT 1")
    .get() as { id: number } | undefined
  if (!vt) throw new Error('No stock journal voucher type exists')
  return vt.id
}

/**
 * Send goods out.
 *
 * The value on each line is the item's own outward cost, not a price: nothing is being sold, and
 * the figure the challan has to declare is what the goods are worth — which is also what a deemed
 * supply under 143(3) would be taxed on. Taking it from `outwardCostOf` keeps it the same number
 * the stock summary would show, rather than a second opinion computed here.
 */
export function sendForJobWork(db: DB, input: SendInput): JobWorkChallan {
  if (input.lines.length === 0) throw new Error('Nothing to send out')
  const lock = getLockDate(db)
  if (lock && input.sentOn <= lock) throw new Error(`Books are locked up to ${lock}`)
  const duplicate = db.prepare('SELECT id FROM job_work_challans WHERE challan_no = ?').get(input.challanNo)
  if (duplicate) throw new Error(`Challan ${input.challanNo} already exists`)

  const godown = jobWorkGodown(db, input.partyLedgerId)
  const available = new Map(
    stockByGodown(db, input.sentOn)
      .filter((r) => r.godownId === (input.fromGodownId ?? null))
      .map((r) => [r.stockItemId, r.closingQtyMilli])
  )

  const run = db.transaction((): number => {
    const values = input.lines.map((l) => {
      if (l.qtyMilli <= 0) throw new Error('A job-work line must send at least something')
      const held = available.get(l.stockItemId) ?? 0
      if (held < l.qtyMilli) {
        const name = (db.prepare('SELECT name FROM stock_items WHERE id = ?').get(l.stockItemId) as { name: string } | undefined)?.name
        throw new Error(`Not enough ${name ?? 'stock'} to send out`)
      }
      return { ...l, costPaise: outwardCostOf(db, input.sentOn, l.stockItemId, l.qtyMilli) }
    })

    const partyName = (db.prepare('SELECT name FROM ledgers WHERE id = ?').get(input.partyLedgerId) as { name: string }).name
    const voucher = saveVoucher(db, {
      voucherTypeId: stockJournalTypeId(db),
      date: input.sentOn,
      lines: [],
      inventory: values.flatMap((v) => [
        {
          stockItemId: v.stockItemId, godownId: input.fromGodownId ?? null, qtyMilli: v.qtyMilli,
          ratePaise: v.qtyMilli ? Math.round((v.costPaise * 1000) / v.qtyMilli) : 0,
          amount: v.costPaise, direction: 'out' as const
        },
        {
          stockItemId: v.stockItemId, godownId: godown.id, qtyMilli: v.qtyMilli,
          ratePaise: v.qtyMilli ? Math.round((v.costPaise * 1000) / v.qtyMilli) : 0,
          amount: v.costPaise, direction: 'in' as const
        }
      ]),
      // The narration is the only trace of this in a day book listing, so it says who has the
      // goods rather than leaving a bare stock journal nobody can place.
      narration: `Job work challan ${input.challanNo} — sent to ${partyName}`,
      billRefs: [],
      tds: null
    })

    const res = db
      .prepare(
        `INSERT INTO job_work_challans
           (party_ledger_id, godown_id, challan_no, sent_on, goods_type, nature_of_processing, voucher_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.partyLedgerId, godown.id, input.challanNo, input.sentOn, input.goodsType,
        input.natureOfProcessing ?? null, voucher.id, input.notes ?? null
      )
    const challanId = Number(res.lastInsertRowid)
    const insertLine = db.prepare(
      'INSERT INTO job_work_challan_lines (challan_id, stock_item_id, qty_milli, rate_paise) VALUES (?, ?, ?, ?)'
    )
    for (const v of values) {
      insertLine.run(challanId, v.stockItemId, v.qtyMilli, v.qtyMilli ? Math.round((v.costPaise * 1000) / v.qtyMilli) : 0)
    }
    return challanId
  })

  const id = run()
  const created = getChallan(db, id)!
  writeAudit(db, 'job_work_challan', id, 'create', null, {
    challanNo: created.challanNo, partyName: created.partyName, sentOn: created.sentOn
  })
  return created
}

export interface ReceiveInput {
  challanId: number
  receivedOn: string
  notes?: string | null
  /** Where the goods come back TO. Null returns them to unallocated stock. */
  toGodownId?: number | null
  lines: ReturnRequestLine[]
}

/**
 * Take goods back.
 *
 * Waste is moved out of the job worker's godown and NOT back into stock: under section 143(5) the
 * waste may be supplied by the job worker directly, and it does not physically return. Bringing it
 * back would inflate closing stock by the scrap of every job the business has ever sent out.
 */
export function receiveFromJobWork(db: DB, input: ReceiveInput): JobWorkChallan {
  const challan = getChallan(db, input.challanId, input.receivedOn)
  if (!challan) throw new Error('Challan not found')
  const lock = getLockDate(db)
  if (lock && input.receivedOn <= lock) throw new Error(`Books are locked up to ${lock}`)

  const plan = planJobWorkReturn({
    status: challan.status,
    requested: input.lines,
    returnedOn: input.receivedOn,
    sentOn: challan.sentOn
  })
  if (plan.errors.length) throw new Error(plan.errors.join('; '))

  const rateOf = new Map(challan.lines.map((l) => [l.stockItemId, l.ratePaise]))

  const run = db.transaction((): number => {
    const voucher = saveVoucher(db, {
      voucherTypeId: stockJournalTypeId(db),
      date: input.receivedOn,
      lines: [],
      inventory: input.lines.flatMap((l) => {
        const rate = rateOf.get(l.stockItemId) ?? 0
        const amount = Math.round((l.qtyMilli * rate) / 1000)
        const out = {
          stockItemId: l.stockItemId, godownId: challan.godownId, qtyMilli: l.qtyMilli,
          ratePaise: rate, amount, direction: 'out' as const
        }
        if (l.kind === 'waste') return [out]
        return [
          out,
          {
            stockItemId: l.stockItemId, godownId: input.toGodownId ?? null, qtyMilli: l.qtyMilli,
            ratePaise: rate, amount, direction: 'in' as const
          }
        ]
      }),
      narration: `Job work challan ${challan.challanNo} — received from ${challan.partyName}`,
      billRefs: [],
      tds: null
    })

    const res = db
      .prepare('INSERT INTO job_work_returns (challan_id, received_on, voucher_id, notes) VALUES (?, ?, ?, ?)')
      .run(input.challanId, input.receivedOn, voucher.id, input.notes ?? null)
    const returnId = Number(res.lastInsertRowid)
    const insertLine = db.prepare(
      'INSERT INTO job_work_return_lines (return_id, stock_item_id, qty_milli, kind) VALUES (?, ?, ?, ?)'
    )
    for (const l of input.lines) insertLine.run(returnId, l.stockItemId, l.qtyMilli, l.kind)
    return returnId
  })

  const returnId = run()
  writeAudit(db, 'job_work_return', returnId, 'create', null, {
    challanNo: challan.challanNo, receivedOn: input.receivedOn, lines: input.lines.length
  })
  return getChallan(db, input.challanId)!
}

/**
 * Delete a challan and the movement that made it.
 *
 * Only while nothing has come back. Once a return exists the challan is part of a chain that the
 * section 143 clock is being measured against, and deleting the head of it would leave a receipt
 * for goods nobody sent.
 */
export function deleteChallan(db: DB, id: number): void {
  const challan = getChallan(db, id)
  if (!challan) throw new Error('Challan not found')
  if (challan.returns.length > 0) {
    throw new Error('Goods have already come back against this challan — cancel the receipts first')
  }
  const run = db.transaction(() => {
    db.prepare('DELETE FROM job_work_challans WHERE id = ?').run(id)
    if (challan.voucherId) deleteVoucher(db, challan.voucherId)
  })
  run()
  writeAudit(db, 'job_work_challan', id, 'delete', { challanNo: challan.challanNo }, null)
}

export interface Itc04Row {
  challanNo: string
  sentOn: string
  partyGstin: string | null
  partyName: string
  goodsType: JobWorkGoodsType
  itemName: string
  hsn: string | null
  unitSymbol: string
  sentQtyMilli: number
  returnedQtyMilli: number
  pendingQtyMilli: number
  taxableValue: number
  dueDate: string
  overdue: boolean
}

/**
 * The rows an ITC-04 would be built from, for a quarter.
 *
 * Deliberately data and not a return: roadmap D #89 owns the form, and producing a half-form here
 * would be a second implementation for that lane to reconcile with. What this does is make sure
 * the DATA the form needs exists and is answerable — the challan, the party's GSTIN, the
 * quantities each way, and whether the section 143 clock has run out.
 */
export function itc04Rows(db: DB, from: string, to: string): Itc04Row[] {
  const rows: Itc04Row[] = []
  const ids = db
    .prepare('SELECT id FROM job_work_challans WHERE sent_on BETWEEN ? AND ? ORDER BY sent_on, id')
    .all(from, to) as { id: number }[]
  for (const { id } of ids) {
    const challan = getChallan(db, id, to)
    if (!challan) continue
    const party = db.prepare('SELECT gstin FROM ledgers WHERE id = ?').get(challan.partyLedgerId) as
      | { gstin: string | null }
      | undefined
    for (const line of challan.lines) {
      const hsn = (db.prepare('SELECT hsn FROM stock_items WHERE id = ?').get(line.stockItemId) as
        | { hsn: string | null }
        | undefined)?.hsn ?? null
      rows.push({
        challanNo: challan.challanNo,
        sentOn: challan.sentOn,
        partyGstin: party?.gstin ?? null,
        partyName: challan.partyName,
        goodsType: challan.goodsType,
        itemName: line.itemName,
        hsn,
        unitSymbol: line.unitSymbol,
        sentQtyMilli: line.qtyMilli,
        returnedQtyMilli: line.returnedQtyMilli,
        pendingQtyMilli: line.pendingQtyMilli,
        taxableValue: Math.round((line.qtyMilli * line.ratePaise) / 1000),
        dueDate: challan.status.dueDate,
        overdue: challan.status.state === 'overdue'
      })
    }
  }
  return rows
}
