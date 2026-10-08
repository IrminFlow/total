/**
 * WP 6.4 — bulk edit of vouchers and masters, with a server-side preview and undo.
 *
 * Every record goes through its NORMAL save path — saveVoucher for vouchers, updateLedger /
 * updateStockItem for masters — inside its own savepoint, so the lock date, the immutable kinds
 * (year-end closing journals, interest notes, loan / forex / pay-run / fixed-asset / manufacture
 * vouchers), credit holds, posting validation and the audit trail all apply exactly as they do
 * for a single edit; a record a rule refuses is listed with that rule's own message.
 *
 *  - preview = the same run inside one transaction that is then rolled back (a dry run), so the
 *    preview's per-record results are exactly what the apply will produce;
 *  - apply = one transaction per batch: the records that pass are saved, refused / unchanged ones
 *    are skipped, and bulk_batches / bulk_batch_records (migration 036) keep each record's
 *    before-image and the id of the audit row its save wrote;
 *  - undo = re-saves each record's before-image through the same path, but only while the audit
 *    row the apply wrote is still that record's latest (nothing changed it since); the rest are
 *    reported with who changed them and when.
 */
import type { DB } from '../db/connection'
import type { SaveVoucherWarnings, Voucher, VoucherKind } from '@shared/domain'
import {
  applyItemChange, applyLedgerChange, applyVoucherChange, bulkRequestSchema, describeChange,
  type ApplyOutcome, type BulkBatchDetail, type BulkBatchRow, type BulkRecordResult, type BulkRequest, type BulkResult, type BulkTarget,
  type BulkUndoRecord, type BulkUndoResult
} from '@shared/bulkEdit'
import { voucherToPayload, type VoucherPayload } from '@shared/voucherEdit'
import type { LedgerInput, StockItemInput } from '@shared/schemas'
import { getVoucher, saveVoucher, voucherNumberExists } from './vouchers'
import { getLedger, getStockItem, updateLedger, updateStockItem } from './masters'
import { currentAuditUserName, writeAudit } from './audit'

class DryRunRollback extends Error {}

type NameKind = 'ledger' | 'costCentre' | 'godown' | 'voucherType' | 'group' | 'priceLevel' | 'stockGroup'
const NAME_SQL: Record<NameKind, string> = {
  ledger: 'SELECT name FROM ledgers WHERE id = ?',
  costCentre: 'SELECT name FROM cost_centres WHERE id = ?',
  godown: 'SELECT name FROM godowns WHERE id = ?',
  voucherType: 'SELECT name FROM voucher_types WHERE id = ?',
  group: 'SELECT name FROM groups WHERE id = ?',
  priceLevel: 'SELECT name FROM price_levels WHERE id = ?',
  stockGroup: 'SELECT name FROM stock_groups WHERE id = ?'
}
const NONE_LABEL: Partial<Record<NameKind, string>> = { priceLevel: 'base rate', stockGroup: 'no group' }

function namer(db: DB): (what: string, id: number | null) => string {
  const cache = new Map<string, string>()
  return (what, id) => {
    if (id === null) return NONE_LABEL[what as NameKind] ?? 'none'
    const k = `${what}:${id}`
    let v = cache.get(k)
    if (v === undefined) {
      const sql = NAME_SQL[what as NameKind]
      v = sql ? ((db.prepare(sql).get(id) as { name: string } | undefined)?.name ?? `#${id}`) : `#${id}`
      cache.set(k, v)
    }
    return v
  }
}

/** The id of the newest audit row for this record (0 = none). */
function latestAudit(db: DB, entity: BulkTarget, id: number): { id: number; user: string | null; at: string; action: string } | null {
  return (
    (db.prepare('SELECT id, user_name AS user, at, action FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1').get(entity, id) as
      | { id: number; user: string | null; at: string; action: string }
      | undefined) ?? null
  )
}

interface Planned {
  result: BulkRecordResult
  /** What re-saves the record as it was (stored for undo); null when nothing was saved. */
  beforeImage: unknown
  afterAuditId: number | null
}

/** Run the save inside a savepoint: a throw rolls back just this record and becomes its refusal. */
function inSavepoint(db: DB, fn: () => void): string | null {
  try {
    db.transaction(fn)()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function voucherLabel(db: DB, v: { voucherTypeId: number; number: string; date: string }): string {
  const t = db.prepare('SELECT name FROM voucher_types WHERE id = ?').get(v.voucherTypeId) as { name: string } | undefined
  return `${t?.name ?? 'Voucher'} ${v.number} · ${v.date}`
}

function planVoucher(db: DB, req: Extract<BulkRequest, { target: 'voucher' }>, id: number, name: ReturnType<typeof namer>): Planned {
  const v = getVoucher(db, id)
  const base = { entity: 'voucher' as const, id, before: null, after: null, warnings: [] as string[] }
  if (!v) return { result: { ...base, label: `Voucher #${id}`, status: 'refused', reason: 'Voucher not found' }, beforeImage: null, afterAuditId: null }
  const label = voucherLabel(db, v)
  if (v.deletedAt) return { result: { ...base, label, status: 'refused', reason: 'Voucher is in the bin; restore it first' }, beforeImage: null, afterAuditId: null }
  const kindOf = (typeId: number): { kind: VoucherKind; numbering: 'auto' | 'manual' } | undefined =>
    db.prepare('SELECT kind, numbering FROM voucher_types WHERE id = ?').get(typeId) as { kind: VoucherKind; numbering: 'auto' | 'manual' } | undefined
  const kind = kindOf(v.voucherTypeId)!.kind
  const target = req.change.field === 'voucherType' ? kindOf(req.change.voucherTypeId) : undefined
  // Re-validated server-side: a voucher that has left the period the list showed is not touched.
  if (req.scope && (v.date < req.scope.from || v.date > req.scope.to)) {
    return { result: { ...base, label, status: 'refused', reason: `No longer in the period shown (${req.scope.from} to ${req.scope.to})` }, beforeImage: null, afterAuditId: null }
  }
  const before = voucherToPayload(v)
  let outcome = applyVoucherChange(before, req.change, {
    kind,
    targetKind: target?.kind,
    targetNumbering: target?.numbering,
    name: (w, i) => name(w, i)
  })
  if (outcome.kind === 'changed' && req.change.field === 'party') {
    const why = partyChangeRefusal(db, v, req.change.to)
    if (why) outcome = { kind: 'refused', reason: why }
  }
  // Duplicate numbers (the editors' check): a number already used in the target series is
  // renumbered in an auto series (reported) and refused in a manual one.
  let renumberedFrom: string | null = null
  if (outcome.kind === 'changed' && (req.change.field === 'date' || req.change.field === 'voucherType')) {
    const p = outcome.payload
    if (p.number !== undefined && voucherNumberExists(db, p.voucherTypeId, p.number, id)) {
      if (kindOf(p.voucherTypeId)!.numbering === 'manual') {
        outcome = { kind: 'refused', reason: `Number ${p.number} is already used by another ${name('voucherType', p.voucherTypeId)} voucher` }
      } else {
        renumberedFrom = p.number
        outcome = { ...outcome, payload: { ...p, number: undefined } }
      }
    } else if (p.number === undefined) {
      renumberedFrom = v.number
    }
  }
  return execute(db, 'voucher', id, label, before, outcome, (p) => {
    const saved = saveVoucher(db, p, id)
    if (saved.duplicateNumber) throw new Error(`Number ${saved.number} is already used by another voucher of this type`)
    return [...saveWarnings(saved.warnings), ...(renumberedFrom !== null && renumberedFrom !== saved.number ? [`Renumbered ${renumberedFrom} → ${saved.number}`] : [])]
  })
}

/** saveVoucher's non-blocking warnings, as the batch result's lines. */
function saveWarnings(w: SaveVoucherWarnings): string[] {
  const out: string[] = []
  if (w.negativeStock.length) out.push(`Stock goes negative: ${w.negativeStock.map((x) => x.name).join(', ')}`)
  if (w.creditLimitExceeded) out.push(`Over the credit limit of ${w.creditLimitExceeded.ledgerName}`)
  if (w.linkDates?.length) out.push(...w.linkDates)
  if (w.frozenRepricing?.length) out.push(...w.frozenRepricing)
  return out
}

/** Company state for place-of-supply comparisons. */
function companyState(db: DB): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'company'").get() as { value: string } | undefined
  try {
    return r ? ((JSON.parse(r.value) as { stateCode?: string }).stateCode ?? null) : null
  } catch {
    return null
  }
}

/**
 * Why a party change would leave the voucher wrong, or null. Refused: bills it settles (against
 * refs — they belong to the old party), bills of its own another voucher already settles, trade
 * links (orders / challans of the old party), TDS / TCS entries (deducted from the old party), and
 * GST lines whose supply type (intra / inter-state, export / SEZ) the new party would change — the
 * tax would have to be recomputed, which a bulk edit doesn't do. Its own 'new' bills move with it.
 */
export function partyChangeRefusal(db: DB, v: Voucher, to: number): string | null {
  if (v.billRefs.some((r) => r.kind === 'against')) return 'It settles bills of the current party (bill references) — change it in the voucher'
  const own = v.billRefs.filter((r) => r.kind === 'new').map((r) => r.name)
  if (own.length > 0) {
    const settled = db
      .prepare(
        `SELECT br.name FROM bill_refs br WHERE br.kind = 'against' AND br.party_ledger_id = ? AND br.voucher_id <> ?
         AND br.name IN (${own.map(() => '?').join(',')}) LIMIT 1`
      )
      .get(v.partyLedgerId, v.id, ...own) as { name: string } | undefined
    if (settled) return `Bill ${settled.name} already has payments or notes against it — move those first`
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'line_links'").get()) {
    if (db.prepare('SELECT 1 FROM line_links WHERE from_voucher_id = ? OR to_voucher_id = ? LIMIT 1').get(v.id, v.id)) {
      return 'It is linked to orders / challans of the current party'
    }
  }
  if (v.tds || v.tcs) return `It carries a ${v.tds ? 'TDS' : 'TCS'} entry for the current party`
  const taxType = db.prepare('SELECT tax_type FROM ledgers WHERE id = ?')
  const taxLines = v.lines.some((l) => (taxType.get(l.ledgerId) as { tax_type: string | null } | undefined)?.tax_type)
  if (taxLines && !v.posOverride) {
    const facts = db.prepare('SELECT state_code AS s, export_type AS e FROM ledgers WHERE id = ?')
    const party = (pid: number | null): { s: string | null; e: string | null } =>
      (pid === null ? undefined : (facts.get(pid) as { s: string | null; e: string | null } | undefined)) ?? { s: null, e: null }
    const home = companyState(db)
    const a = party(v.partyLedgerId)
    const b = party(to)
    const inter = (x: { s: string | null }): boolean => (x.s ?? home) !== home
    if (inter(a) !== inter(b) || (a.e ?? null) !== (b.e ?? null)) {
      return 'The new party changes the GST supply type (state / export) — the tax lines would have to be recomputed; change it in the voucher'
    }
  }
  return null
}

function planLedger(db: DB, req: Extract<BulkRequest, { target: 'ledger' }>, id: number, name: ReturnType<typeof namer>): Planned {
  const l = getLedger(db, id)
  const base = { entity: 'ledger' as const, id, before: null, after: null, warnings: [] as string[] }
  if (!l) return { result: { ...base, label: `Ledger #${id}`, status: 'refused', reason: 'Ledger not found' }, beforeImage: null, afterAuditId: null }
  const before: LedgerInput = { ...l }
  const outcome = applyLedgerChange(before, req.change, { name: (w, i) => name(w, i), isSystem: l.isSystem })
  // Tagged tax ledgers (GST component, TDS / TCS payable) belong under Duties & Taxes — a bulk
  // move would quietly take them out of the returns' reach.
  const tagged = l.taxType ? `a ${l.taxType.toUpperCase()} ledger` : l.tdsPayableSectionId ? 'a TDS payable ledger' : l.tcsPayableSectionId ? 'a TCS payable ledger' : null
  const guarded: ApplyOutcome<LedgerInput> =
    req.change.field === 'group' && outcome.kind === 'changed' && tagged ? { kind: 'refused', reason: `It is ${tagged} — change its group in the ledger itself` } : outcome
  return execute(db, 'ledger', id, l.name, before, guarded, (p) => {
    updateLedger(db, id, p)
    return []
  })
}

function planItem(db: DB, req: Extract<BulkRequest, { target: 'stockItem' }>, id: number, name: ReturnType<typeof namer>): Planned {
  const i = getStockItem(db, id)
  const base = { entity: 'stockItem' as const, id, before: null, after: null, warnings: [] as string[] }
  if (!i) return { result: { ...base, label: `Item #${id}`, status: 'refused', reason: 'Stock item not found' }, beforeImage: null, afterAuditId: null }
  const before: StockItemInput = { ...i }
  const outcome = applyItemChange(before, req.change, { name: (w, x) => name(w, x) })
  return execute(db, 'stockItem', id, i.name, before, outcome, (p) => {
    updateStockItem(db, id, p)
    return []
  })
}

function execute<P>(db: DB, entity: BulkTarget, id: number, label: string, before: P, outcome: ApplyOutcome<P>, save: (p: P) => string[]): Planned {
  const base = { entity, id, label, warnings: [] as string[] }
  if (outcome.kind !== 'changed') {
    return {
      result: { ...base, status: outcome.kind, reason: outcome.reason, before: null, after: null },
      beforeImage: null,
      afterAuditId: null
    }
  }
  let warnings: string[] = []
  const refusal = inSavepoint(db, () => {
    warnings = save(outcome.payload)
  })
  if (refusal) return { result: { ...base, status: 'refused', reason: refusal, before: outcome.before, after: outcome.after }, beforeImage: null, afterAuditId: null }
  return {
    result: { ...base, warnings, status: 'applied', reason: null, before: outcome.before, after: outcome.after },
    beforeImage: before,
    afterAuditId: latestAudit(db, entity, id)?.id ?? null
  }
}

function run(db: DB, raw: unknown, dryRun: boolean): BulkResult {
  const req = bulkRequestSchema.parse(raw)
  const ids = [...new Set(req.ids)]
  const name = namer(db)
  const summary = describeChange({ ...req, ids } as BulkRequest, name)
  let out: BulkResult | null = null
  const tx = db.transaction(() => {
    const planned: Planned[] = ids.map((id) =>
      req.target === 'voucher' ? planVoucher(db, req, id, name) : req.target === 'ledger' ? planLedger(db, req, id, name) : planItem(db, req, id, name)
    )
    const records = planned.map((p) => p.result)
    const count = (s: BulkRecordResult['status']): number => records.filter((r) => r.status === s).length
    let batchId: number | null = null
    if (!dryRun && count('applied') > 0) {
      batchId = Number(
        db
          .prepare('INSERT INTO bulk_batches (target, change_json, summary, applied_count, refused_count, created_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(req.target, JSON.stringify(req.change), summary, count('applied'), count('refused'), currentAuditUserName()).lastInsertRowid
      )
      const ins = db.prepare(
        'INSERT INTO bulk_batch_records (batch_id, entity, entity_id, label, status, reason, before_json, after_audit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const p of planned) {
        ins.run(batchId, p.result.entity, p.result.id, p.result.label, p.result.status, p.result.reason, p.beforeImage === null ? null : JSON.stringify(p.beforeImage), p.afterAuditId)
      }
      writeAudit(db, 'bulk_batch', batchId, 'create', null, {
        target: req.target, change: req.change, summary, applied: count('applied'), refused: count('refused'), unchanged: count('unchanged'),
        records: records.map((r) => ({ id: r.id, status: r.status, reason: r.reason }))
      })
    }
    out = { batchId, summary, records, applied: count('applied'), refused: count('refused'), unchanged: count('unchanged') }
    if (dryRun) throw new DryRunRollback()
  })
  try {
    tx()
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err
  }
  return out!
}

/** Dry run: every record through its save path inside a transaction that is rolled back. */
export function previewBulk(db: DB, raw: unknown): BulkResult {
  return run(db, raw, true)
}

/** Apply: one transaction for the batch; refused / unchanged records are skipped and listed. */
export function applyBulk(db: DB, raw: unknown): BulkResult {
  return run(db, raw, false)
}

interface BatchDbRow {
  id: number; target: BulkTarget; summary: string; applied_count: number; refused_count: number; status: BulkBatchRow['status']
  created_by: string | null; created_at: string; undone_by: string | null; undone_at: string | null
}
const mapBatch = (r: BatchDbRow): BulkBatchRow => ({
  id: r.id, target: r.target, summary: r.summary, appliedCount: r.applied_count, refusedCount: r.refused_count, status: r.status,
  createdBy: r.created_by, createdAt: r.created_at, undoneBy: r.undone_by, undoneAt: r.undone_at
})

export function listBulkBatches(db: DB, target?: BulkTarget): BulkBatchRow[] {
  const rows = db
    .prepare(`SELECT * FROM bulk_batches ${target ? 'WHERE target = ?' : ''} ORDER BY id DESC LIMIT 100`)
    .all(...(target ? [target] : [])) as BatchDbRow[]
  return rows.map(mapBatch)
}

export function getBulkBatch(db: DB, id: number): BulkBatchDetail {
  const b = db.prepare('SELECT * FROM bulk_batches WHERE id = ?').get(id) as BatchDbRow | undefined
  if (!b) throw new Error('Bulk edit not found')
  const records = db
    .prepare('SELECT entity, entity_id AS id, label, status, reason FROM bulk_batch_records WHERE batch_id = ? ORDER BY id')
    .all(id) as BulkBatchDetail['records']
  return { ...mapBatch(b), records }
}

/**
 * Undo a batch: each applied record whose latest audit row is still the one the apply wrote is
 * re-saved from its before-image through the normal path (so today's lock date and rules apply
 * to the undo too). Records changed since — edited, binned, deleted — are reported, not touched.
 * Records whose undo was refused earlier are retried. One transaction.
 */
export function undoBulk(db: DB, batchId: number): BulkUndoResult {
  const b = db.prepare('SELECT * FROM bulk_batches WHERE id = ?').get(batchId) as BatchDbRow | undefined
  if (!b) throw new Error('Bulk edit not found')
  if (b.status === 'undone') throw new Error('This bulk edit has already been undone')
  let out: BulkUndoResult | null = null
  const name = namer(db)
  db.transaction(() => {
    const recs = db
      .prepare("SELECT id AS rid, entity, entity_id AS id, label, before_json AS beforeJson, after_audit_id AS afterAuditId FROM bulk_batch_records WHERE batch_id = ? AND status IN ('applied', 'undo_refused') ORDER BY id")
      .all(batchId) as { rid: number; entity: BulkTarget; id: number; label: string; beforeJson: string | null; afterAuditId: number | null }[]
    const results: BulkUndoRecord[] = []
    const mark = db.prepare('UPDATE bulk_batch_records SET status = ?, reason = ?, undo_audit_id = ? WHERE id = ?')
    for (const r of recs) {
      const latest = latestAudit(db, r.entity, r.id)
      let reason: string | null = null
      if (!r.beforeJson || r.afterAuditId === null) reason = 'Nothing recorded to undo'
      else if (!latest || latest.id !== r.afterAuditId) {
        reason = latest
          ? `Changed since the bulk edit (${latest.action} by ${latest.user ?? 'unknown'} at ${latest.at}) — left as it is`
          : 'No longer in the books'
      } else if (latest.action === 'delete' || latest.action === 'purge') {
        reason = 'No longer in the books'
      }
      if (!reason && r.entity === 'voucher') {
        // The number the voucher had may have been issued to another voucher since (a type or date
        // change vacated it) — re-saving would duplicate it.
        const b = JSON.parse(r.beforeJson!) as VoucherPayload
        if (b.number && voucherNumberExists(db, b.voucherTypeId, b.number, r.id)) {
          reason = `Its old number ${b.number} (${name('voucherType', b.voucherTypeId)}) has been used by another voucher since — left as it is`
        }
      }
      if (!reason) {
        const before = JSON.parse(r.beforeJson!) as unknown
        reason = inSavepoint(db, () => {
          if (r.entity === 'voucher') saveVoucher(db, before as VoucherPayload, r.id)
          else if (r.entity === 'ledger') updateLedger(db, r.id, before as LedgerInput)
          else updateStockItem(db, r.id, before as StockItemInput)
        })
      }
      if (reason) {
        mark.run('undo_refused', reason, null, r.rid)
        results.push({ entity: r.entity, id: r.id, label: r.label, status: 'undo_refused', reason })
      } else {
        mark.run('undone', null, latestAudit(db, r.entity, r.id)?.id ?? null, r.rid)
        results.push({ entity: r.entity, id: r.id, label: r.label, status: 'undone', reason: null })
      }
    }
    const left = (db.prepare("SELECT COUNT(*) AS n FROM bulk_batch_records WHERE batch_id = ? AND status IN ('applied', 'undo_refused')").get(batchId) as { n: number }).n
    const undoneAny = (db.prepare("SELECT COUNT(*) AS n FROM bulk_batch_records WHERE batch_id = ? AND status = 'undone'").get(batchId) as { n: number }).n
    const status: BulkBatchRow['status'] = left === 0 ? 'undone' : undoneAny > 0 ? 'partly_undone' : 'applied'
    const before = mapBatch(b)
    db.prepare("UPDATE bulk_batches SET status = ?, undone_by = ?, undone_at = datetime('now') WHERE id = ?").run(status, currentAuditUserName(), batchId)
    const undone = results.filter((x) => x.status === 'undone').length
    writeAudit(db, 'bulk_batch', batchId, 'update', before, {
      ...mapBatch(db.prepare('SELECT * FROM bulk_batches WHERE id = ?').get(batchId) as BatchDbRow),
      undo: results.map((x) => ({ id: x.id, status: x.status, reason: x.reason }))
    })
    out = { batchId, status, records: results, undone, refused: results.length - undone }
  })()
  return out!
}
