/**
 * Job work — the challan out, what came back, the section 143 clock, and ITC-04 (roadmap D-89).
 *
 * The delivery challan's other half. `salesDocs.ts` already carries goods to a CUSTOMER on a
 * challan; this carries them to a JOB WORKER, and deliberately borrows that vocabulary — number,
 * date, description, qtyMilli, rate — because to the storekeeper it is the same piece of paper.
 * What differs is that these goods are expected back, and the law is counting.
 *
 * Nothing here posts. Sending goods for job work is not a supply (section 143, CGST Act), so
 * there is no voucher, no credit reversal and no entry in the books; there is a movement and a
 * clock. If the goods are not back within a year (inputs) or three (capital goods), section
 * 143(3)/(4) DEEMS them supplied on the day they were sent out — backdated, with interest under
 * section 50(1) running from that date's return. That is the number this service exists to state
 * before it becomes a notice.
 *
 * All of the statutory arithmetic lives in `@shared/gst/itc04` and is tested there. This file is
 * storage, validation and the join back to the books: it reads rows, hands the engine plain
 * documents, and hands the engine's answers back with ledger names and row ids attached.
 *
 * The engine carries `// VERIFY:` markers on three points — ITC-04 Table 5B's limb, the
 * periodicity notification number, and the anniversary-day boundary. They are reproduced in the
 * UI where a user would rely on them; do not delete them here without reading `itc04.ts` first.
 *
 * ---------------------------------------------------------------------------------------------
 * THE STOCK HALF (roadmap E #127, grafted on at merge)
 *
 * The paragraph above used to end "It does not move stock", and that was an accounting error
 * rather than a missing nicety. Goods sent for job work are STILL THE PRINCIPAL'S STOCK — title
 * never leaves him — so they have to stay in his closing stock, which is a figure that goes on
 * the balance sheet. Left unmoved they sat in the despatching godown as though they had never
 * gone out, and a stock report could not answer "what is lying with whom".
 *
 * So a challan with a stock item on it now also MOVES that item, into a godown named for the job
 * worker and created on first use. The mover is a **stock journal with no ledger lines at all**,
 * exactly like a godown transfer: nothing is bought, nothing is sold, no money moves and no
 * ledger is touched. Both legs are valued at `outwardCostOf`, so the pair cancels exactly and
 * company-wide stock VALUE does not move — only its location does.
 *
 * It hangs off `saveChallan` / `saveReturn` rather than being a second entry point, because two
 * ways to record the same despatch is how the paperwork and the stock come to disagree.
 *
 * A challan with no `stockItemId` (a description of something not in the item master, which this
 * form has always allowed) moves nothing and behaves exactly as it did before. So does every
 * challan saved before this shipped: the columns are nullable and empty means "paperwork only".
 */
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { fyOf, todayISO } from '@shared/dates'
import { bandFloorPaise } from '@shared/gst/turnover'
import {
  buildItc04,
  deemedSupplies,
  itc04Periodicity,
  itc04PeriodsForFy,
  type DeemedSupplyRow,
  type Itc04,
  type Itc04Issue,
  type Itc04Obligation,
  type Itc04Period,
  type JobWorkChallan as EngineChallan,
  type JobWorkDisposition,
  type JobWorkGoodsType,
  type JobWorkReturn as EngineReturn
} from '@shared/gst/itc04'
import { jobWorkGodownName } from '@shared/jobWork'
import { getLedger } from './masters'
import { writeAudit } from './audit'
import { NOT_DELETED, deleteVoucher, saveVoucher } from './vouchers'
import { outwardCostOf } from './stockAnalysis'

/** Its own series, like the sales chain's DC — never shared with the voucher numbering. */
const PREFIX = 'JW'

export const DISPOSITION_LABEL: Record<JobWorkDisposition, string> = {
  returned: 'Received back',
  sent_to_other_job_worker: 'Sent to another job worker',
  supplied_from_job_worker_premises: 'Supplied from his premises',
  waste_and_scrap: 'Waste and scrap'
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface JobWorkReturnRow {
  id: number
  challanId: number
  date: string
  number: string | null
  qtyMilli: number
  disposition: JobWorkDisposition
  invoiceVoucherId: number | null
  /** The invoice raised when the goods were sold from the job worker's premises, if any. */
  invoiceNumber: string | null
  notes: string | null
  /** The stock journal that brought the goods back out of the job worker's godown, if any. */
  voucherId: number | null
  /** Where they came back TO. Null is unallocated stock, the inventory_lines convention. */
  toGodownId: number | null
}

export interface JobWorkChallanRow {
  id: number
  number: string
  date: string
  jobWorkerLedgerId: number | null
  jobWorkerName: string | null
  jobWorkerGstin: string | null
  jobWorkerStateCode: string
  goodsType: JobWorkGoodsType
  stockItemId: number | null
  description: string
  hsn: string | null
  qtyMilli: number
  uqc: string
  taxablePaise: number
  gstRate: number
  mouldsDiesJigsTools: boolean
  receivedByJobWorkerOn: string | null
  extendedDueBackBy: string | null
  notes: string | null
  createdAt: string
  /** The godown named for this job worker, once something has actually been sent there. */
  godownId: number | null
  godownName: string | null
  /** Where the goods left from. Null is unallocated stock. */
  fromGodownId: number | null
  /** The stock journal that moved them out. Null on a paperwork-only challan. */
  voucherId: number | null
  returns: JobWorkReturnRow[]
  /** Everything accounted for: returned, moved on, supplied out, waste. */
  accountedMilli: number
  /** Never negative — see `saveReturn`, which refuses to create one. */
  balanceMilli: number
}

interface ChallanDbRow {
  id: number; number: string; date: string; job_worker_ledger_id: number | null
  job_worker_gstin: string | null; job_worker_state_code: string | null
  goods_type: JobWorkGoodsType; stock_item_id: number | null; description: string; hsn: string | null
  qty_milli: number; uqc: string; taxable_paise: number; gst_rate: number
  moulds_dies_jigs_tools: number; received_by_job_worker_on: string | null
  extended_due_back_by: string | null; notes: string | null; created_at: string
  godown_id: number | null; from_godown_id: number | null; voucher_id: number | null
}

interface ReturnDbRow {
  id: number; challan_id: number; date: string; number: string | null; qty_milli: number
  disposition: JobWorkDisposition; invoice_voucher_id: number | null; invoice_number: string | null
  notes: string | null; voucher_id: number | null; to_godown_id: number | null
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function returnsOf(db: DB, challanIds: number[]): Map<number, JobWorkReturnRow[]> {
  const out = new Map<number, JobWorkReturnRow[]>()
  if (challanIds.length === 0) return out
  const placeholders = challanIds.map(() => '?').join(',')
  // The invoice join filters deleted vouchers: a receipt whose invoice was binned must not go on
  // showing a number that is no longer in the books.
  const rows = db
    .prepare(
      `SELECT r.*, v.number AS invoice_number
       FROM job_work_returns r
       LEFT JOIN vouchers v ON v.id = r.invoice_voucher_id AND ${NOT_DELETED}
       WHERE r.challan_id IN (${placeholders})
       ORDER BY r.date, r.id`
    )
    .all(...challanIds) as ReturnDbRow[]
  for (const r of rows) {
    const list = out.get(r.challan_id) ?? []
    list.push({
      id: r.id,
      challanId: r.challan_id,
      date: r.date,
      number: r.number,
      qtyMilli: r.qty_milli,
      disposition: r.disposition,
      invoiceVoucherId: r.invoice_voucher_id,
      invoiceNumber: r.invoice_number,
      notes: r.notes,
      voucherId: r.voucher_id,
      toGodownId: r.to_godown_id
    })
    out.set(r.challan_id, list)
  }
  return out
}

function hydrate(db: DB, rows: ChallanDbRow[], info: CompanyInfo): JobWorkChallanRow[] {
  const returns = returnsOf(db, rows.map((r) => r.id))
  const godownNames = new Map(
    (db.prepare('SELECT id, name FROM godowns').all() as { id: number; name: string }[]).map((g) => [g.id, g.name])
  )
  return rows.map((r) => {
    const mine = returns.get(r.id) ?? []
    const accountedMilli = mine.reduce((s, x) => s + x.qtyMilli, 0)
    const ledger = r.job_worker_ledger_id ? getLedger(db, r.job_worker_ledger_id) : null
    return {
      id: r.id,
      number: r.number,
      date: r.date,
      jobWorkerLedgerId: r.job_worker_ledger_id,
      jobWorkerName: ledger?.name ?? null,
      jobWorkerGstin: r.job_worker_gstin,
      // A challan saved before this column was filled falls back to our own state, which is the
      // ordinary case (a job worker down the road) and keeps the form's state column populated.
      jobWorkerStateCode: r.job_worker_state_code ?? info.stateCode,
      goodsType: r.goods_type,
      stockItemId: r.stock_item_id,
      description: r.description,
      hsn: r.hsn,
      qtyMilli: r.qty_milli,
      uqc: r.uqc,
      taxablePaise: r.taxable_paise,
      gstRate: r.gst_rate,
      mouldsDiesJigsTools: r.moulds_dies_jigs_tools === 1,
      receivedByJobWorkerOn: r.received_by_job_worker_on,
      extendedDueBackBy: r.extended_due_back_by,
      notes: r.notes,
      createdAt: r.created_at,
      godownId: r.godown_id,
      godownName: r.godown_id ? godownNames.get(r.godown_id) ?? null : null,
      fromGodownId: r.from_godown_id,
      voucherId: r.voucher_id,
      returns: mine,
      accountedMilli,
      balanceMilli: Math.max(0, r.qty_milli - accountedMilli)
    }
  })
}

export interface ListOptions {
  from?: string
  to?: string
  /** Only challans with a quantity still out. */
  openOnly?: boolean
}

export function listChallans(db: DB, info: CompanyInfo, opts: ListOptions = {}): JobWorkChallanRow[] {
  const clauses: string[] = []
  const args: unknown[] = []
  if (opts.from) {
    clauses.push('date >= ?')
    args.push(opts.from)
  }
  if (opts.to) {
    clauses.push('date <= ?')
    args.push(opts.to)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM job_work_challans ${where} ORDER BY date DESC, id DESC`)
    .all(...args) as ChallanDbRow[]
  const hydrated = hydrate(db, rows, info)
  return opts.openOnly ? hydrated.filter((c) => c.balanceMilli > 0) : hydrated
}

export function getChallan(db: DB, id: number, info: CompanyInfo): JobWorkChallanRow | null {
  const row = db.prepare('SELECT * FROM job_work_challans WHERE id = ?').get(id) as ChallanDbRow | undefined
  return row ? (hydrate(db, [row], info)[0] as JobWorkChallanRow) : null
}

/** The next free challan number. Same shape as `salesDocs.nextNumber`, its own prefix. */
export function nextChallanNumber(db: DB): string {
  const row = db
    .prepare('SELECT number FROM job_work_challans WHERE number LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`${PREFIX}-%`) as { number: string } | undefined
  const last = row ? Number(row.number.split('-').pop()) : 0
  return `${PREFIX}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`
}

// ---------------------------------------------------------------------------------------------
// The stock half — the job worker's godown, and the journal that moves goods into it
// ---------------------------------------------------------------------------------------------

/**
 * The godown that holds a job worker's stock, created on first use.
 *
 * A named godown PER job worker rather than one shared "Job work" godown, because the question a
 * principal is asked in an audit is "what is lying with WHOM", and one pooled godown answers that
 * with a single number covering four job workers. `jobWorkGodownName` in `@shared/jobWork` is the
 * only place the name is spelt, so the lookup and the creation can never drift apart.
 *
 * Created lazily and not when the ledger is made: most parties are not job workers, and a godown
 * list padded with one empty godown per supplier is a list nobody reads.
 */
export function jobWorkGodown(db: DB, partyLedgerId: number): { id: number; name: string } {
  const party = getLedger(db, partyLedgerId)
  if (!party) throw new Error('That job worker is not a ledger in this company')
  const name = jobWorkGodownName(party.name)
  const existing = db.prepare('SELECT id, name FROM godowns WHERE name = ?').get(name) as
    | { id: number; name: string }
    | undefined
  if (existing) return existing
  const created = { id: Number(db.prepare('INSERT INTO godowns (name) VALUES (?)').run(name).lastInsertRowid), name }
  writeAudit(db, 'godown', created.id, 'create', null, created)
  return created
}

function stockJournalTypeId(db: DB): number {
  const vt = db
    .prepare("SELECT id FROM voucher_types WHERE kind = 'stock_journal' ORDER BY is_system DESC, id LIMIT 1")
    .get() as { id: number } | undefined
  if (!vt) throw new Error('No stock journal voucher type exists')
  return vt.id
}

interface MoveLeg {
  godownId: number | null
  direction: 'in' | 'out'
}

/**
 * Post (or repost) the stock journal behind one challan or one receipt.
 *
 * No ledger lines, ever — `lines: []`. That is the whole point: this is a movement, not a
 * transaction, and a single ledger line here would put a job-work despatch into the trial balance
 * as if something had been bought or sold.
 *
 * Both legs carry the SAME value, taken from `outwardCostOf`, so a transfer cancels to zero and
 * company-wide closing stock value is unchanged by where the goods are standing. Passing one leg
 * only (waste — see `returnLegs`) is how stock genuinely leaves.
 */
function postMovement(
  db: DB,
  opts: {
    date: string
    stockItemId: number
    qtyMilli: number
    legs: MoveLeg[]
    narration: string
    existingVoucherId: number | null
  }
): number {
  const costPaise = outwardCostOf(db, opts.date, opts.stockItemId, opts.qtyMilli)
  const ratePaise = opts.qtyMilli ? Math.round((costPaise * 1000) / opts.qtyMilli) : 0
  const saved = saveVoucher(
    db,
    {
      voucherTypeId: stockJournalTypeId(db),
      date: opts.date,
      lines: [],
      inventory: opts.legs.map((leg) => ({
        stockItemId: opts.stockItemId,
        godownId: leg.godownId,
        qtyMilli: opts.qtyMilli,
        ratePaise,
        amount: costPaise,
        direction: leg.direction
      })),
      // The only trace of this in a day book listing, so it names who holds the goods rather than
      // leaving a bare stock journal nobody can place.
      narration: opts.narration,
      billRefs: [],
      tds: null
    },
    opts.existingVoucherId ?? undefined
  )
  return saved.id
}

/** Drop a movement that should no longer exist — an edit that removed the stock item, or a
 *  deleted challan. Soft-deletes like any other voucher, so it is recoverable from the bin. */
function dropMovement(db: DB, voucherId: number | null): void {
  if (voucherId != null) deleteVoucher(db, voucherId)
}

/**
 * Move the goods out to the job worker, for a challan that has just been saved.
 *
 * A challan with no stock item on it moves nothing — that is not an oversight, it is the
 * "describe something not in the item master" case the form has always supported, and inventing
 * an item for it would be worse than moving nothing. Neither does one with no job worker ledger:
 * there is no godown to name.
 */
function syncChallanMovement(
  db: DB,
  challanId: number,
  input: ChallanInput,
  existing: { voucherId: number | null }
): void {
  if (!input.stockItemId || !input.jobWorkerLedgerId) {
    // Nothing to move, or nowhere to move it TO. Any movement posted under an earlier version of
    // the row is withdrawn rather than left behind saying goods are somewhere they are not.
    dropMovement(db, existing.voucherId)
    db.prepare(
      'UPDATE job_work_challans SET godown_id = NULL, from_godown_id = ?, voucher_id = NULL WHERE id = ?'
    ).run(input.fromGodownId ?? null, challanId)
    return
  }
  const godown = jobWorkGodown(db, input.jobWorkerLedgerId)
  const ledger = getLedger(db, input.jobWorkerLedgerId)
  const voucherId = postMovement(db, {
    date: input.date,
    stockItemId: input.stockItemId,
    qtyMilli: input.qtyMilli,
    legs: [
      { godownId: input.fromGodownId ?? null, direction: 'out' },
      { godownId: godown.id, direction: 'in' }
    ],
    narration: `Job work challan — sent to ${ledger?.name ?? 'job worker'}`,
    existingVoucherId: existing.voucherId
  })
  db.prepare('UPDATE job_work_challans SET godown_id = ?, from_godown_id = ?, voucher_id = ? WHERE id = ?').run(
    godown.id,
    input.fromGodownId ?? null,
    voucherId,
    challanId
  )
}

/**
 * Which legs a receipt posts, by what the goods did.
 *
 * `waste_and_scrap` has NO inward leg. Section 143(5): waste and scrap generated at the job
 * worker's premises may be supplied by him directly on payment of tax — it does not come back and
 * it is not the principal's stock any more. Bringing it back in would inflate closing stock by the
 * scrap of every job the business has ever sent out.
 *
 * Everything else comes back into stock, including the two dispositions where the goods never
 * physically reach the principal's premises:
 *
 *  - `sent_to_other_job_worker` — the goods stay out, but they stay HIS. Returning them to
 *    unallocated stock is what lets the follow-on challan to the second job worker despatch them;
 *    the alternative, leaving them nowhere, is the disappearing-stock bug this whole change
 *    exists to fix.
 *  - `supplied_from_job_worker_premises` — the goods were sold, and the SALES INVOICE is what
 *    takes them out of stock. If this removed them too the item would go out twice and the stock
 *    would go negative; that invoice is already linked on the receipt row.
 */
function returnLegs(disposition: JobWorkDisposition, godownId: number, toGodownId: number | null): MoveLeg[] {
  const out: MoveLeg = { godownId, direction: 'out' }
  if (disposition === 'waste_and_scrap') return [out]
  return [out, { godownId: toGodownId, direction: 'in' }]
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export interface ChallanInput {
  number?: string
  date: string
  jobWorkerLedgerId?: number | null
  jobWorkerGstin?: string | null
  jobWorkerStateCode?: string | null
  goodsType: JobWorkGoodsType
  stockItemId?: number | null
  description: string
  hsn?: string | null
  qtyMilli: number
  uqc?: string
  taxablePaise?: number
  gstRate?: number
  mouldsDiesJigsTools?: boolean
  receivedByJobWorkerOn?: string | null
  extendedDueBackBy?: string | null
  notes?: string | null
  /** Where the goods leave FROM. Null (the default) takes them from unallocated stock. */
  fromGodownId?: number | null
}

/**
 * The job worker's registration, as at despatch.
 *
 * Denormalised on purpose (see the migration): a job worker who registers next year does not
 * change what last year's challan said, and an ITC-04 already filed has to stay reproducible.
 * The state code is resolved rather than demanded, because the form reports the STATE in place of
 * a GSTIN for an unregistered job worker — a missing state is a row the portal will reject.
 */
function jobWorkerIdentity(
  db: DB,
  info: CompanyInfo,
  input: ChallanInput
): { gstin: string | null; stateCode: string } {
  const ledger = input.jobWorkerLedgerId ? getLedger(db, input.jobWorkerLedgerId) : null
  const gstin = input.jobWorkerGstin?.trim() || ledger?.gstin || null
  const stateCode =
    input.jobWorkerStateCode?.trim() ||
    ledger?.stateCode ||
    (gstin && gstin.length >= 2 ? gstin.slice(0, 2) : null) ||
    info.stateCode
  return { gstin, stateCode }
}

export function saveChallan(db: DB, info: CompanyInfo, input: ChallanInput, id?: number): JobWorkChallanRow {
  if (!input.description.trim()) throw new Error('What went out? A challan needs a description')
  if (input.qtyMilli <= 0) throw new Error('A challan must send a positive quantity')
  const before = id ? getChallan(db, id, info) : null
  if (id && !before) throw new Error('No such challan')
  if (before && input.qtyMilli < before.accountedMilli) {
    // Editing the quantity down below what has already come back would leave the balance
    // negative, and a negative balance quietly cancels a real deemed supply somewhere else.
    throw new Error(
      `${before.number} already has ${before.accountedMilli / 1000} accounted for — it cannot be reduced to ${input.qtyMilli / 1000}`
    )
  }
  const { gstin, stateCode } = jobWorkerIdentity(db, info, input)

  const saved = id
    ? (db
        .prepare(
          `UPDATE job_work_challans SET date = ?, job_worker_ledger_id = ?, job_worker_gstin = ?,
             job_worker_state_code = ?, goods_type = ?, stock_item_id = ?, description = ?, hsn = ?,
             qty_milli = ?, uqc = ?, taxable_paise = ?, gst_rate = ?, moulds_dies_jigs_tools = ?,
             received_by_job_worker_on = ?, extended_due_back_by = ?, notes = ? WHERE id = ?`
        )
        .run(
          input.date, input.jobWorkerLedgerId ?? null, gstin, stateCode, input.goodsType,
          input.stockItemId ?? null, input.description.trim(), input.hsn ?? null, input.qtyMilli,
          input.uqc ?? 'NOS', input.taxablePaise ?? 0, input.gstRate ?? 0,
          input.mouldsDiesJigsTools ? 1 : 0, input.receivedByJobWorkerOn ?? null,
          input.extendedDueBackBy ?? null, input.notes ?? null, id
        ),
      id)
    : Number(
        db
          .prepare(
            `INSERT INTO job_work_challans (number, date, job_worker_ledger_id, job_worker_gstin,
               job_worker_state_code, goods_type, stock_item_id, description, hsn, qty_milli, uqc,
               taxable_paise, gst_rate, moulds_dies_jigs_tools, received_by_job_worker_on,
               extended_due_back_by, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.number?.trim() || nextChallanNumber(db), input.date, input.jobWorkerLedgerId ?? null,
            gstin, stateCode, input.goodsType, input.stockItemId ?? null, input.description.trim(),
            input.hsn ?? null, input.qtyMilli, input.uqc ?? 'NOS', input.taxablePaise ?? 0,
            input.gstRate ?? 0, input.mouldsDiesJigsTools ? 1 : 0, input.receivedByJobWorkerOn ?? null,
            input.extendedDueBackBy ?? null, input.notes ?? null
          ).lastInsertRowid
      )

  // The stock leg. After the row exists (it needs the id) and before the row is read back, so
  // `after` — and therefore the audit entry — carries the godown and the voucher that were
  // actually written rather than the nulls they were inserted with.
  syncChallanMovement(db, saved, input, { voucherId: before?.voucherId ?? null })

  const after = getChallan(db, saved, info) as JobWorkChallanRow
  writeAudit(db, 'job_work_challan', saved, before ? 'update' : 'create', before, after)
  return after
}

export function deleteChallan(db: DB, id: number, info: CompanyInfo): void {
  const before = getChallan(db, id, info)
  if (!before) throw new Error('No such challan')
  if (before.returns.length > 0) {
    throw new Error(
      `${before.number} has ${before.returns.length} receipt(s) against it — delete those first, so nothing is thrown away silently`
    )
  }
  db.prepare('DELETE FROM job_work_challans WHERE id = ?').run(id)
  // The goods never went out, so the stock journal that said they did must go with the paperwork.
  dropMovement(db, before.voucherId)
  writeAudit(db, 'job_work_challan', id, 'delete', before, null)
}

export interface ReturnInput {
  challanId: number
  date: string
  number?: string | null
  qtyMilli: number
  disposition: JobWorkDisposition
  invoiceVoucherId?: number | null
  notes?: string | null
  /** Where the goods come back TO. Null (the default) returns them to unallocated stock. */
  toGodownId?: number | null
}

/**
 * Record what came back — or where else it went.
 *
 * The over-return is refused here rather than netted: more coming back than went out is a data
 * error (usually a challan typed twice), and the honest answer is to say so. `deemedSupplies`
 * clamps and reports the same case for rows that reach it some other way, e.g. an import.
 */
export function saveReturn(db: DB, info: CompanyInfo, input: ReturnInput, id?: number): JobWorkChallanRow {
  const challan = getChallan(db, input.challanId, info)
  if (!challan) throw new Error('No such challan')
  if (input.qtyMilli <= 0) throw new Error('A receipt must be for a positive quantity')
  if (input.date < challan.date) {
    throw new Error(`Goods cannot come back on ${input.date}, before ${challan.number} sent them out on ${challan.date}`)
  }
  const existing = id ? challan.returns.find((r) => r.id === id) : null
  if (id && !existing) throw new Error('No such receipt')
  const alreadyElsewhere = challan.accountedMilli - (existing?.qtyMilli ?? 0)
  if (alreadyElsewhere + input.qtyMilli > challan.qtyMilli) {
    const free = challan.qtyMilli - alreadyElsewhere
    throw new Error(
      `${challan.number} sent ${challan.qtyMilli / 1000} and ${alreadyElsewhere / 1000} is already accounted for — ${input.qtyMilli / 1000} would be ${(alreadyElsewhere + input.qtyMilli - challan.qtyMilli) / 1000} more than went out. At most ${free / 1000} can come back.`
    )
  }
  if (input.invoiceVoucherId != null) {
    const v = db
      .prepare(`SELECT v.id FROM vouchers v WHERE v.id = ? AND ${NOT_DELETED}`)
      .get(input.invoiceVoucherId) as { id: number } | undefined
    if (!v) throw new Error('That invoice is not in the books')
  }

  let returnId: number
  if (id) {
    db.prepare(
      `UPDATE job_work_returns SET date = ?, number = ?, qty_milli = ?, disposition = ?,
         invoice_voucher_id = ?, notes = ?, to_godown_id = ? WHERE id = ?`
    ).run(
      input.date, input.number?.trim() || null, input.qtyMilli, input.disposition,
      input.invoiceVoucherId ?? null, input.notes ?? null, input.toGodownId ?? null, id
    )
    returnId = id
  } else {
    returnId = Number(
      db
        .prepare(
          `INSERT INTO job_work_returns (challan_id, date, number, qty_milli, disposition,
             invoice_voucher_id, notes, to_godown_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.challanId, input.date, input.number?.trim() || null, input.qtyMilli, input.disposition,
          input.invoiceVoucherId ?? null, input.notes ?? null, input.toGodownId ?? null
        ).lastInsertRowid
    )
  }

  // The stock leg back. Only a challan that actually moved goods has anything to move back: a
  // paperwork-only challan (no stock item, or no job-worker godown) has no godown to take them
  // out of, and posting half a movement from nowhere would create stock out of thin air.
  if (challan.stockItemId && challan.godownId) {
    const voucherId = postMovement(db, {
      date: input.date,
      stockItemId: challan.stockItemId,
      qtyMilli: input.qtyMilli,
      legs: returnLegs(input.disposition, challan.godownId, input.toGodownId ?? null),
      narration: `Job work ${challan.number} — ${DISPOSITION_LABEL[input.disposition].toLowerCase()} from ${challan.jobWorkerName ?? 'job worker'}`,
      existingVoucherId: existing?.voucherId ?? null
    })
    db.prepare('UPDATE job_work_returns SET voucher_id = ? WHERE id = ?').run(voucherId, returnId)
  } else {
    dropMovement(db, existing?.voucherId ?? null)
    db.prepare('UPDATE job_work_returns SET voucher_id = NULL WHERE id = ?').run(returnId)
  }

  const after = getChallan(db, input.challanId, info) as JobWorkChallanRow
  writeAudit(db, 'job_work_challan', input.challanId, 'update', challan, after)
  return after
}

export function deleteReturn(db: DB, id: number, info: CompanyInfo): JobWorkChallanRow {
  const row = db
    .prepare('SELECT challan_id AS challanId, voucher_id AS voucherId FROM job_work_returns WHERE id = ?')
    .get(id) as { challanId: number; voucherId: number | null } | undefined
  if (!row) throw new Error('No such receipt')
  const before = getChallan(db, row.challanId, info)
  db.prepare('DELETE FROM job_work_returns WHERE id = ?').run(id)
  // The goods are back out with the job worker, so the movement that brought them home goes too.
  dropMovement(db, row.voucherId)
  const after = getChallan(db, row.challanId, info) as JobWorkChallanRow
  writeAudit(db, 'job_work_challan', row.challanId, 'update', before, after)
  return after
}

// ---------------------------------------------------------------------------------------------
// The engine's view of the same rows
// ---------------------------------------------------------------------------------------------

function toEngineChallan(c: JobWorkChallanRow): EngineChallan {
  return {
    challanNumber: c.number,
    challanDate: c.date,
    jobWorkerGstin: c.jobWorkerGstin,
    jobWorkerStateCode: c.jobWorkerStateCode,
    goodsType: c.goodsType,
    description: c.description,
    hsn: c.hsn ?? '',
    qtyMilli: c.qtyMilli,
    uqc: c.uqc,
    taxableValuePaise: c.taxablePaise,
    gstRate: c.gstRate,
    receivedByJobWorkerOn: c.receivedByJobWorkerOn,
    extendedDueBackBy: c.extendedDueBackBy,
    // The engine's field is `mouldsDiesJigsOrTools`; ours is `mouldsDiesJigsTools`. Spelling
    // them alike is not optional — set the wrong one and the section 143(4) exclusion silently
    // stops applying, so every mould left with a job worker becomes a deemed supply at three
    // years. The `as EngineChallan` cast below is what let that through once already.
    mouldsDiesJigsOrTools: c.mouldsDiesJigsTools
  } as EngineChallan
}

function toEngineReturns(c: JobWorkChallanRow): EngineReturn[] {
  return c.returns.map((r) => ({
    originalChallanNumber: c.number,
    originalChallanDate: c.date,
    receiptChallanNumber: r.number ?? `(no number) #${r.id}`,
    receiptChallanDate: r.date,
    qtyMilli: r.qtyMilli,
    disposition: r.disposition,
    natureOfJobWork: r.notes
  }))
}

function documents(db: DB, info: CompanyInfo): {
  rows: JobWorkChallanRow[]
  challans: EngineChallan[]
  returns: EngineReturn[]
} {
  const rows = listChallans(db, info)
  return {
    rows,
    challans: rows.map(toEngineChallan),
    returns: rows.flatMap(toEngineReturns)
  }
}

/** A clock row with the things only the database knows: which row it is, and who holds it. */
export interface JobWorkClockRow extends DeemedSupplyRow {
  challanId: number
  jobWorkerName: string | null
}

export interface JobWorkClock {
  asOn: string
  rows: JobWorkClockRow[]
  /** Just the ones the clock has run out on — what the user actually has to act on. */
  overdue: JobWorkClockRow[]
  totalDeemedValuePaise: number
  totalDeemedTaxPaise: number
  issues: Itc04Issue[]
}

/**
 * The section 143 clock over every challan in the books.
 *
 * Deliberately not scoped to a period: the challan whose year has run out is the one from LAST
 * year, and a report that only looked at this quarter would never show it.
 */
export function jobWorkClock(db: DB, info: CompanyInfo, asOn: string = todayISO()): JobWorkClock {
  const { rows, challans, returns } = documents(db, info)
  const byNumber = new Map(rows.map((r) => [r.number, r]))
  const report = deemedSupplies(challans, returns, asOn, { principalStateCode: info.stateCode })
  const decorate = (r: DeemedSupplyRow): JobWorkClockRow => {
    const row = byNumber.get(r.challanNumber)
    return { ...r, challanId: row?.id ?? 0, jobWorkerName: row?.jobWorkerName ?? null }
  }
  const decorated = report.rows.map(decorate)
  return {
    asOn: report.asOn,
    rows: decorated,
    overdue: decorated.filter((r) => r.overdue),
    totalDeemedValuePaise: report.totalDeemedValuePaise,
    totalDeemedTaxPaise: report.totalDeemedTaxPaise,
    issues: report.issues
  }
}

// ---------------------------------------------------------------------------------------------
// ITC-04
// ---------------------------------------------------------------------------------------------

export interface Itc04Options {
  fyStartYear?: number
  /** Which of the FY's periods (0-based). Out of range clamps to the last one. */
  periodIndex?: number
  asOn?: string
  /**
   * The principal's aggregate turnover in the PRECEDING financial year, paise, when the user
   * knows it. Absent, the company's declared turnover band is used — see `turnoverForPeriodicity`.
   */
  aggregateTurnoverPaise?: number
}

/**
 * Turnover for the rule 45(3) test, from the declared band.
 *
 * The band is a range, and the periodicity test is a strict "exceeds ₹5 crore". A business in the
 * '5Cr-10Cr' band is above the line unless it is at EXACTLY ₹5,00,00,000, which the band cannot
 * express — so a paisa is added to the floor and the ambiguity resolves toward filing more often.
 * Filing half-yearly when annual would have done is a wasted afternoon; the other error is a late
 * return. An exact figure passed by the caller overrides all of this.
 */
export function turnoverForPeriodicity(info: CompanyInfo): number {
  return info.turnoverBand === null ? 0 : bandFloorPaise(info.turnoverBand) + 1
}

export interface Itc04Working {
  /** How often this principal files, and the dated rule that says so. */
  obligation: Itc04Obligation
  turnoverPaise: number
  turnoverSource: 'declared-band' | 'given'
  /** Every period of the chosen FY at that frequency, for a period picker. */
  periods: Itc04Period[]
  periodIndex: number
  fyStartYear: number
  /** The form itself — tables 4, 5A, 5B, 5C, totals, and the clock. */
  form: Itc04
  /** Challan number → the row it came from, so a table row can open the challan. */
  challanIds: Record<string, number>
  jobWorkerNames: Record<string, string>
}

/**
 * One period's ITC-04, with the periodicity that decided which period that is.
 *
 * A period with no challans at all is a NIL return, not an absence of one: `form.nil` is true and
 * every table is empty, and the obligation to file is unchanged. That is why this never returns
 * null.
 */
export function itc04(db: DB, info: CompanyInfo, opts: Itc04Options = {}): Itc04Working {
  const asOn = opts.asOn ?? todayISO()
  const fyStartYear = opts.fyStartYear ?? fyOf(asOn).startYear
  const turnoverPaise = opts.aggregateTurnoverPaise ?? turnoverForPeriodicity(info)
  // The regime is read on the period's own dates, not on today: re-opening FY 2019-20 must still
  // answer "quarterly", which is what it was.
  const obligation = itc04Periodicity(turnoverPaise, `${fyStartYear + 1}-03-31`)
  const periods = itc04PeriodsForFy(fyStartYear, obligation.frequency)
  const periodIndex = Math.min(Math.max(opts.periodIndex ?? 0, 0), periods.length - 1)
  const period = periods[periodIndex] as Itc04Period

  const { rows, challans, returns } = documents(db, info)
  const form = buildItc04(period, challans, returns, {
    principalStateCode: info.stateCode,
    // The clock is read as at the period end unless the caller asks otherwise, so a filing shows
    // what was overdue when it was filed rather than what is overdue today.
    asOn: opts.asOn ?? period.to
  })

  return {
    obligation,
    turnoverPaise,
    turnoverSource: opts.aggregateTurnoverPaise === undefined ? 'declared-band' : 'given',
    periods,
    periodIndex,
    fyStartYear,
    form,
    challanIds: Object.fromEntries(rows.map((r) => [r.number, r.id])),
    jobWorkerNames: Object.fromEntries(
      rows.filter((r) => r.jobWorkerName).map((r) => [r.number, r.jobWorkerName as string])
    )
  }
}
