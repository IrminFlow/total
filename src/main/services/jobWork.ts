import type { DB } from '../db/connection'
import type { VoucherInput } from '@shared/schemas'
import { jobWorkChallanSaveSchema, voucherInputSchema, type JobWorkChallanSaveInput } from '@shared/schemas'
import { isGodownTransferShape } from '@shared/voucherEdit/stockJournal'
import { ageLots, daysBetween, type JobWorkChallan, type JobWorkPendingRow, type Itc04Data } from '@shared/jobWork'
import { getVoucher, saveVoucher, IN_BOOKS, type SaveVoucherResult } from './vouchers'
import { stockSummary } from './stockAnalysis'
import { writeAudit } from './audit'

/**
 * Job work (WP 2.4). Material sent to a job worker sits in a godown of kind 'job_worker' that
 * carries the job worker's party ledger (Masters → Godowns):
 *  - SEND / RETURN challans are godown transfers (Stock journal → "Send to job worker"): out of
 *    our godown into the job worker's (send), or back unprocessed (return). They are same-item
 *    transfer pairs, so the engine's 'transfer' rule keeps their value exactly at cost.
 *  - The RECEIPT of finished goods is a manufacture (Manufacture → "Receive from job worker",
 *    services/manufacture.ts): raw rows consumed at the job worker's godown, job charges
 *    (Dr Job Work Charges / Cr the job worker) capitalised by the derived rule.
 * `job_work_challans` / `job_work_losses` (migration 023) keep the ITC-04 facts; quantities and
 * values are the vouchers' own inventory lines (itc04Data reads them back).
 */

interface ChallanRow {
  voucher_id: number
  kind: 'send' | 'receive' | 'return'
  godown_id: number
  party_ledger_id: number
  challan_no: string | null
  challan_date: string | null
  nature_of_processing: string | null
  goods_type: 'inputs' | 'capital_goods'
  original_challan_voucher_id: number | null
}

const mapChallan = (r: ChallanRow): JobWorkChallan => ({
  voucherId: r.voucher_id,
  kind: r.kind,
  godownId: r.godown_id,
  partyLedgerId: r.party_ledger_id,
  challanNo: r.challan_no,
  challanDate: r.challan_date,
  natureOfProcessing: r.nature_of_processing,
  goodsType: r.goods_type,
  originalChallanVoucherId: r.original_challan_voucher_id
})

export function getJobWorkChallan(db: DB, voucherId: number): JobWorkChallan | null {
  const r = db.prepare('SELECT * FROM job_work_challans WHERE voucher_id = ?').get(voucherId) as ChallanRow | undefined
  return r ? mapChallan(r) : null
}

interface GodownFacts {
  id: number
  kind: 'own' | 'job_worker'
  partyLedgerId: number | null
}
const godownFacts = (db: DB, id: number | null): GodownFacts | undefined =>
  id == null
    ? undefined
    : (db.prepare('SELECT id, kind, party_ledger_id AS partyLedgerId FROM godowns WHERE id = ?').get(id) as GodownFacts | undefined)

export type SaveJobWorkChallanResult = SaveVoucherResult & { challan: JobWorkChallan }

/**
 * Save a send / return challan: the voucher must be a stock-journal godown transfer whose every
 * row moves stock INTO the job worker's godown from one of ours (send) or OUT of it back to one
 * of ours (return). Voucher + challan row in one transaction (saveVoucher's).
 */
export function saveJobWorkChallan(db: DB, raw: JobWorkChallanSaveInput, existingId?: number): SaveJobWorkChallanResult {
  const parsed = jobWorkChallanSaveSchema.parse(raw)
  const { challan } = parsed
  const voucher = voucherInputSchema.parse(parsed.voucher)
  const kind = (db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(voucher.voucherTypeId) as { kind: string } | undefined)?.kind
  if (kind !== 'stock_journal') throw new Error('A job-work challan must use a stock journal voucher type')
  const worker = godownFacts(db, challan.godownId)
  if (!worker || worker.kind !== 'job_worker' || worker.partyLedgerId == null) {
    throw new Error('Pick a job worker godown (Masters → Godowns, kind “Job worker”)')
  }
  if (!isGodownTransferShape(voucher)) throw new Error('Each row must move one item between two different godowns')
  for (let i = 0; i < voucher.inventory.length; i += 2) {
    const from = voucher.inventory[i]!.godownId
    const to = voucher.inventory[i + 1]!.godownId
    const [ours, theirs] = challan.kind === 'send' ? [from, to] : [to, from]
    if (theirs !== worker.id) {
      throw new Error(challan.kind === 'send' ? 'Every row must go to the job worker’s godown' : 'Every row must come back from the job worker’s godown')
    }
    if (godownFacts(db, ours)?.kind !== 'own') throw new Error('The other godown of each row must be one of your own godowns')
  }
  if (existingId) {
    const prior = getJobWorkChallan(db, existingId)
    if (!prior || prior.kind === 'receive') throw new Error('Not a job-work send / return challan')
  }
  if (challan.originalChallanVoucherId != null) {
    const orig = getJobWorkChallan(db, challan.originalChallanVoucherId)
    if (!orig || orig.kind !== 'send' || orig.godownId !== worker.id) throw new Error('The original challan is not a send challan to this job worker')
  }
  const before = existingId ? getJobWorkChallan(db, existingId) : null
  const saved = saveVoucher(db, voucher as VoucherInput, existingId, {
    jobWork: true,
    withinTransaction: (voucherId) => {
      db.prepare(
        `INSERT INTO job_work_challans (voucher_id, kind, godown_id, party_ledger_id, challan_no, challan_date,
           nature_of_processing, goods_type, original_challan_voucher_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(voucher_id) DO UPDATE SET kind = excluded.kind, godown_id = excluded.godown_id,
           party_ledger_id = excluded.party_ledger_id, challan_no = excluded.challan_no, challan_date = excluded.challan_date,
           nature_of_processing = excluded.nature_of_processing, goods_type = excluded.goods_type,
           original_challan_voucher_id = excluded.original_challan_voucher_id`
      ).run(
        voucherId, challan.kind, worker.id, worker.partyLedgerId,
        // A send challan IS our voucher: its number / date are the challan's (kept null here).
        challan.kind === 'return' ? (challan.challanNo?.trim() || null) : null,
        challan.kind === 'return' ? (challan.challanDate ?? null) : null,
        challan.natureOfProcessing?.trim() || null, challan.goodsType, challan.originalChallanVoucherId ?? null
      )
    }
  })
  const after = getJobWorkChallan(db, saved.id)!
  writeAudit(db, 'job_work', saved.id, existingId ? 'update' : 'create', before, after)
  return { ...saved, challan: after }
}

/** Live send challans to one job worker (newest first) — the receipt's "against challan" list. */
export function sendChallans(db: DB, godownId: number): { voucherId: number; number: string; date: string }[] {
  return db
    .prepare(
      `SELECT v.id AS voucherId, v.number, v.date FROM job_work_challans j JOIN vouchers v ON v.id = j.voucher_id
       WHERE j.kind = 'send' AND j.godown_id = ? AND ${IN_BOOKS} ORDER BY v.date DESC, v.id DESC`
    )
    .all(godownId) as { voucherId: number; number: string; date: string }[]
}

/**
 * Material at job workers as on `asOn`: per job worker godown × item, the quantity and engine
 * value there (Stock summary's godown view), aged by inward lot — everything that went into the
 * godown is a lot dated by its voucher, consumed oldest-first by everything that left it — with
 * the quantity pending beyond `pendingDays` (ITC-04 / the one-year input rule make that the
 * number to chase).
 */
export function materialAtJobWorkers(db: DB, asOn: string, pendingDays: number): JobWorkPendingRow[] {
  const workers = db
    .prepare(
      `SELECT g.id, g.name, g.party_ledger_id AS partyLedgerId, l.name AS partyName
       FROM godowns g LEFT JOIN ledgers l ON l.id = g.party_ledger_id WHERE g.kind = 'job_worker' ORDER BY g.name`
    )
    .all() as { id: number; name: string; partyLedgerId: number | null; partyName: string | null }[]
  const out: JobWorkPendingRow[] = []
  for (const w of workers) {
    const summary = stockSummary(db, asOn, { godownId: w.id }).filter((r) => r.closingQtyMilli !== 0)
    if (summary.length === 0) continue
    const moves = db
      .prepare(
        `SELECT il.stock_item_id AS itemId, il.direction, il.qty_milli AS qtyMilli, v.date
         FROM inventory_lines il JOIN vouchers v ON v.id = il.voucher_id
         WHERE il.godown_id = ? AND il.is_absolute = 0 AND v.date <= ? AND ${IN_BOOKS}
         ORDER BY v.date, v.id, il.line_order, il.id`
      )
      .all(w.id, asOn) as { itemId: number; direction: 'in' | 'out'; qtyMilli: number; date: string }[]
    for (const s of summary) {
      const mine = moves.filter((m) => m.itemId === s.stockItemId)
      const lots = ageLots(
        mine.filter((m) => m.direction === 'in').map((m) => ({ date: m.date, qtyMilli: m.qtyMilli })),
        mine.filter((m) => m.direction === 'out').reduce((t, m) => t + m.qtyMilli, 0)
      )
      const pending = lots.filter((l) => daysBetween(l.date, asOn) > pendingDays)
      const pendingQty = pending.reduce((t, l) => t + l.qtyMilli, 0)
      const oldest = lots[0]?.date ?? null
      out.push({
        godownId: w.id, godownName: w.name, partyLedgerId: w.partyLedgerId, partyName: w.partyName ?? '',
        stockItemId: s.stockItemId, itemName: s.name, unitSymbol: s.unitSymbol, decimals: s.decimals,
        qtyMilli: s.closingQtyMilli, valuePaise: s.closingValue,
        oldestDate: oldest, ageDays: oldest ? daysBetween(oldest, asOn) : null,
        pendingQtyMilli: pendingQty,
        pendingValuePaise: s.closingQtyMilli > 0 ? Math.round((s.closingValue * Math.min(pendingQty, s.closingQtyMilli)) / s.closingQtyMilli) : 0
      })
    }
  }
  return out
}

/**
 * The ITC-04 facts for [from, to] (WP 3.4 builds the return from these): goods sent (our
 * challan no/date, job worker, item, HSN, unit, quantity, taxable value = the line's value at
 * cost, goods type, nature of processing), goods received back (the job worker's challan no/date,
 * the original challan, the finished goods and the inputs consumed with their losses) and goods
 * returned unprocessed.
 */
export function itc04Data(db: DB, from: string, to: string): Itc04Data {
  const challans = db
    .prepare(
      `SELECT j.*, v.number AS voucher_number, v.date AS voucher_date, l.name AS party_name, l.gstin, l.state_code,
              ov.number AS orig_number, ov.date AS orig_date
       FROM job_work_challans j
       JOIN vouchers v ON v.id = j.voucher_id
       JOIN ledgers l ON l.id = j.party_ledger_id
       LEFT JOIN vouchers ov ON ov.id = j.original_challan_voucher_id
       WHERE v.date BETWEEN ? AND ? AND ${IN_BOOKS}
       ORDER BY v.date, v.id`
    )
    .all(from, to) as (ChallanRow & {
      voucher_number: string; voucher_date: string; party_name: string; gstin: string | null; state_code: string | null
      orig_number: string | null; orig_date: string | null
    })[]
  const lineStmt = db.prepare(
    `SELECT il.line_order AS lineOrder, il.stock_item_id AS itemId, si.name AS itemName, si.hsn, u.symbol AS unit,
            il.qty_milli AS qtyMilli, il.amount, il.direction, il.godown_id AS godownId
     FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id JOIN units u ON u.id = si.unit_id
     WHERE il.voucher_id = ? AND il.is_absolute = 0 ORDER BY il.line_order, il.id`
  )
  const lossStmt = db.prepare('SELECT line_order AS lineOrder, loss_qty_milli AS q FROM job_work_losses WHERE voucher_id = ?')
  const data: Itc04Data = { sent: [], received: [], returned: [] }
  for (const c of challans) {
    const party = { jobWorkerName: c.party_name, gstin: c.gstin, stateCode: c.state_code }
    const lines = lineStmt.all(c.voucher_id) as {
      lineOrder: number; itemId: number; itemName: string; hsn: string | null; unit: string; qtyMilli: number; amount: number
      direction: 'in' | 'out'; godownId: number | null
    }[]
    const item = (l: (typeof lines)[number]) => ({ stockItemId: l.itemId, itemName: l.itemName, hsn: l.hsn, unit: l.unit, qtyMilli: l.qtyMilli })
    if (c.kind === 'send') {
      for (const l of lines.filter((x) => x.direction === 'in' && x.godownId === c.godown_id)) {
        data.sent.push({
          voucherId: c.voucher_id, challanNo: c.voucher_number, challanDate: c.voucher_date, ...party, ...item(l),
          taxableValuePaise: l.amount, goodsType: c.goods_type, natureOfProcessing: c.nature_of_processing
        })
      }
    } else if (c.kind === 'return') {
      for (const l of lines.filter((x) => x.direction === 'out' && x.godownId === c.godown_id)) {
        data.returned.push({
          voucherId: c.voucher_id, challanNo: c.challan_no, challanDate: c.challan_date, originalChallanNo: c.orig_number,
          originalChallanDate: c.orig_date, ...party, ...item(l), natureOfProcessing: c.nature_of_processing
        })
      }
    } else {
      const losses = new Map((lossStmt.all(c.voucher_id) as { lineOrder: number; q: number }[]).map((r) => [r.lineOrder, r.q]))
      const finished = lines.filter((l) => l.direction === 'in')
      data.received.push({
        voucherId: c.voucher_id, voucherNumber: c.voucher_number, voucherDate: c.voucher_date, challanNo: c.challan_no,
        challanDate: c.challan_date, originalChallanNo: c.orig_number, originalChallanDate: c.orig_date, ...party,
        natureOfProcessing: c.nature_of_processing,
        goods: finished.map(item),
        inputs: lines.filter((l) => l.direction === 'out').map((l) => ({ ...item(l), lossQtyMilli: losses.get(l.lineOrder) ?? 0 }))
      })
    }
  }
  return data
}

/** The voucher of a challan, for the send form's alteration. */
export function getJobWorkVoucher(db: DB, voucherId: number) {
  const voucher = getVoucher(db, voucherId)
  return voucher ? { voucher, challan: getJobWorkChallan(db, voucherId) } : null
}
