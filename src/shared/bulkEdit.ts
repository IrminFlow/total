// WP 6.4 — bulk edit of vouchers and masters. Pure TypeScript (no DB): the change vocabulary,
// its Zod schemas, and the functions that turn one record's save payload into the edited payload
// (or a refusal with the reason). The main process (services/bulkEdit.ts) runs these per record
// and then saves through the NORMAL paths — saveVoucher / updateLedger / updateStockItem — so the
// lock date, immutable kinds, credit holds, posting rules and the audit trail all apply.
import { z } from 'zod'
import type { VoucherKind } from './domain'
import type { VoucherPayload } from './voucherEdit/payload'
import type { LedgerInput, StockItemInput } from './schemas'
import { validateHsn } from './gst/validate'

const id = z.number().int().positive()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')

/** At most this many records per batch — one transaction, one screen of results. */
export const BULK_MAX_RECORDS = 500

export const voucherChangeSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('narration'), mode: z.enum(['replace', 'append', 'prepend']), text: z.string().max(1000) }),
  z.object({ field: z.literal('date'), date: isoDate }),
  z.object({ field: z.literal('voucherType'), voucherTypeId: id }),
  /** from = only vouchers whose party is this ledger (null = whatever party they have). */
  z.object({ field: z.literal('party'), from: id.nullable(), to: id }),
  /** from = only allocations to this centre (null = every allocation). */
  z.object({ field: z.literal('costCentre'), from: id.nullable(), to: id }),
  /** from = only lines in this godown (null = every inventory line). */
  z.object({ field: z.literal('godown'), from: id.nullable(), to: id })
])
export type VoucherChange = z.infer<typeof voucherChangeSchema>

export const ledgerChangeSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('group'), groupId: id }),
  /** Credit terms: days of credit (null = none). */
  z.object({ field: z.literal('creditDays'), creditDays: z.number().int().min(0).max(365).nullable() }),
  z.object({ field: z.literal('priceLevel'), priceLevelId: id.nullable() })
])
export type LedgerChange = z.infer<typeof ledgerChangeSchema>

export const itemChangeSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('gstRate'), gstRate: z.number().min(0).max(100).nullable() }),
  z.object({ field: z.literal('hsn'), hsn: z.string().trim().max(8).nullable() }),
  z.object({ field: z.literal('stockGroup'), groupId: id.nullable() })
])
export type ItemChange = z.infer<typeof itemChangeSchema>

const ids = z.array(id).min(1).max(BULK_MAX_RECORDS)

export const bulkRequestSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('voucher'), ids, change: voucherChangeSchema }),
  z.object({ target: z.literal('ledger'), ids, change: ledgerChangeSchema }),
  z.object({ target: z.literal('stockItem'), ids, change: itemChangeSchema })
])
export type BulkRequest = z.infer<typeof bulkRequestSchema>
export type BulkTarget = BulkRequest['target']

export type BulkRecordStatus = 'applied' | 'refused' | 'unchanged'

/** One record's outcome — identical in the preview (dry run) and the apply. */
export interface BulkRecordResult {
  entity: BulkTarget
  id: number
  label: string
  status: BulkRecordStatus
  reason: string | null
  /** Short "before → after" of the edited field, for the preview list. */
  before: string | null
  after: string | null
}

export interface BulkResult {
  /** null for a preview; the bulk_batches id once applied. */
  batchId: number | null
  summary: string
  records: BulkRecordResult[]
  applied: number
  refused: number
  unchanged: number
}

export interface BulkBatchRow {
  id: number
  target: BulkTarget
  summary: string
  appliedCount: number
  refusedCount: number
  status: 'applied' | 'undone' | 'partly_undone'
  createdBy: string | null
  createdAt: string
  undoneBy: string | null
  undoneAt: string | null
}

export interface BulkBatchDetail extends BulkBatchRow {
  records: { entity: BulkTarget; id: number; label: string; status: string; reason: string | null }[]
}

export interface BulkUndoRecord {
  entity: BulkTarget
  id: number
  label: string
  status: 'undone' | 'undo_refused'
  reason: string | null
}

export interface BulkUndoResult {
  batchId: number
  status: BulkBatchRow['status']
  records: BulkUndoRecord[]
  undone: number
  refused: number
}

/** Voucher kinds that may change into one another by a bulk type change: the same kind always
 *  (another numbering series), and within the pure-accounting family when no stock moves. The
 *  save's own posting validation (validateVoucher) still decides each voucher. */
const ACCOUNTING_FAMILY: readonly VoucherKind[] = ['journal', 'payment', 'receipt', 'contra']

export function typeChangeAllowed(from: VoucherKind, to: VoucherKind, hasInventory: boolean): string | null {
  if (from === to) return null
  if (ACCOUNTING_FAMILY.includes(from) && ACCOUNTING_FAMILY.includes(to) && !hasInventory) return null
  return `A ${from.replace('_', ' ')} voucher can't become a ${to.replace('_', ' ')} voucher — their posting rules differ`
}

export type ApplyOutcome<P> = { kind: 'changed'; payload: P; before: string; after: string } | { kind: 'unchanged'; reason: string } | { kind: 'refused'; reason: string }

export interface VoucherChangeContext {
  kind: VoucherKind
  /** Kind of the target voucher type (type change only). */
  targetKind?: VoucherKind
  targetNumbering?: 'auto' | 'manual'
  /** Display names for the before / after summary. */
  name: (what: 'ledger' | 'costCentre' | 'godown' | 'voucherType', id: number | null) => string
}

const clip = (s: string | null, n = 60): string => {
  const t = (s ?? '').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t || '—'
}

/** The edited payload for one voucher, or why it is refused / unchanged. Never mutates `p`. */
export function applyVoucherChange(p: VoucherPayload, change: VoucherChange, ctx: VoucherChangeContext): ApplyOutcome<VoucherPayload> {
  switch (change.field) {
    case 'narration': {
      const text = change.text.trim()
      if (change.mode !== 'replace' && !text) return { kind: 'unchanged', reason: 'Nothing to add' }
      const cur = p.narration ?? ''
      const next =
        change.mode === 'replace' ? text : change.mode === 'append' ? (cur ? `${cur} ${text}` : text) : cur ? `${text} ${cur}` : text
      const value = next.trim() === '' ? null : next
      if ((value ?? '') === cur) return { kind: 'unchanged', reason: 'Narration is already that' }
      return { kind: 'changed', payload: { ...p, narration: value }, before: clip(p.narration), after: clip(value) }
    }
    case 'date': {
      if (p.date === change.date) return { kind: 'unchanged', reason: 'Already dated that day' }
      return { kind: 'changed', payload: { ...p, date: change.date }, before: p.date, after: change.date }
    }
    case 'voucherType': {
      if (p.voucherTypeId === change.voucherTypeId) return { kind: 'unchanged', reason: 'Already of that voucher type' }
      if (!ctx.targetKind) return { kind: 'refused', reason: 'Voucher type not found' }
      const why = typeChangeAllowed(ctx.kind, ctx.targetKind, p.inventory.length > 0)
      if (why) return { kind: 'refused', reason: why }
      // An auto-numbered series numbers the voucher afresh; a manual one keeps the number it has.
      const number = ctx.targetNumbering === 'auto' ? undefined : p.number
      return {
        kind: 'changed',
        payload: { ...p, voucherTypeId: change.voucherTypeId, number },
        before: ctx.name('voucherType', p.voucherTypeId),
        after: ctx.name('voucherType', change.voucherTypeId)
      }
    }
    case 'party': {
      const from = p.partyLedgerId
      if (from === null) return { kind: 'refused', reason: 'This voucher has no party' }
      if (change.from !== null && from !== change.from) return { kind: 'unchanged', reason: `Party is ${ctx.name('ledger', from)}, not ${ctx.name('ledger', change.from)}` }
      if (from === change.to) return { kind: 'unchanged', reason: 'Already that party' }
      if (p.lines.some((l) => l.ledgerId === change.to)) {
        return { kind: 'refused', reason: `${ctx.name('ledger', change.to)} already has a line on this voucher` }
      }
      // The party's own lines move with it; bill references follow the voucher's party at save.
      const lines = p.lines.map((l) => (l.ledgerId === from ? { ...l, ledgerId: change.to } : l))
      return { kind: 'changed', payload: { ...p, partyLedgerId: change.to, lines }, before: ctx.name('ledger', from), after: ctx.name('ledger', change.to) }
    }
    case 'costCentre': {
      let touched = false
      const lines = p.lines.map((l) => {
        const allocs = l.costAllocations ?? []
        if (!allocs.some((a) => (change.from === null || a.costCentreId === change.from) && a.costCentreId !== change.to)) return l
        touched = true
        // Re-point the matching allocations, then merge any that now share the target centre.
        const merged = new Map<number, number>()
        for (const a of allocs) {
          const cc = change.from === null || a.costCentreId === change.from ? change.to : a.costCentreId
          merged.set(cc, (merged.get(cc) ?? 0) + a.amount)
        }
        return { ...l, costAllocations: [...merged.entries()].map(([costCentreId, amount]) => ({ costCentreId, amount })) }
      })
      if (!touched) {
        return {
          kind: 'unchanged',
          reason: change.from === null ? 'No cost-centre allocations to move' : `No allocations to ${ctx.name('costCentre', change.from)}`
        }
      }
      return {
        kind: 'changed',
        payload: { ...p, lines },
        before: change.from === null ? 'all centres' : ctx.name('costCentre', change.from),
        after: ctx.name('costCentre', change.to)
      }
    }
    case 'godown': {
      if (p.inventory.length === 0) return { kind: 'refused', reason: 'This voucher has no stock lines' }
      let touched = false
      const inventory = p.inventory.map((l) => {
        if ((change.from !== null && l.godownId !== change.from) || l.godownId === change.to) return l
        touched = true
        return { ...l, godownId: change.to }
      })
      if (!touched) return { kind: 'unchanged', reason: change.from === null ? 'Every line is already in that godown' : `No lines in ${ctx.name('godown', change.from)}` }
      return {
        kind: 'changed',
        payload: { ...p, inventory },
        before: change.from === null ? 'all godowns' : ctx.name('godown', change.from),
        after: ctx.name('godown', change.to)
      }
    }
  }
}

export interface MasterChangeContext {
  name: (what: 'group' | 'priceLevel' | 'stockGroup', id: number | null) => string
  isSystem?: boolean
}

/** The edited ledger input, or why it is refused / unchanged. */
export function applyLedgerChange(l: LedgerInput, change: LedgerChange, ctx: MasterChangeContext): ApplyOutcome<LedgerInput> {
  switch (change.field) {
    case 'group':
      if (l.groupId === change.groupId) return { kind: 'unchanged', reason: 'Already in that group' }
      if (ctx.isSystem) return { kind: 'refused', reason: 'A system ledger stays in its group' }
      return { kind: 'changed', payload: { ...l, groupId: change.groupId }, before: ctx.name('group', l.groupId), after: ctx.name('group', change.groupId) }
    case 'creditDays': {
      const cur = l.creditDays ?? null
      if (cur === change.creditDays) return { kind: 'unchanged', reason: 'Credit terms are already that' }
      const show = (d: number | null): string => (d === null ? 'none' : `${d} days`)
      return { kind: 'changed', payload: { ...l, creditDays: change.creditDays }, before: show(cur), after: show(change.creditDays) }
    }
    case 'priceLevel': {
      const cur = l.priceLevelId ?? null
      if (cur === change.priceLevelId) return { kind: 'unchanged', reason: 'Already on that price level' }
      return {
        kind: 'changed',
        payload: { ...l, priceLevelId: change.priceLevelId },
        before: ctx.name('priceLevel', cur),
        after: ctx.name('priceLevel', change.priceLevelId)
      }
    }
  }
}

/** The edited stock item input, or why it is refused / unchanged. */
export function applyItemChange(i: StockItemInput, change: ItemChange, ctx: MasterChangeContext): ApplyOutcome<StockItemInput> {
  switch (change.field) {
    case 'gstRate': {
      if ((i.gstRate ?? null) === change.gstRate) return { kind: 'unchanged', reason: 'GST rate is already that' }
      const show = (r: number | null): string => (r === null ? 'none' : `${r}%`)
      return { kind: 'changed', payload: { ...i, gstRate: change.gstRate }, before: show(i.gstRate ?? null), after: show(change.gstRate) }
    }
    case 'hsn': {
      const hsn = change.hsn && change.hsn.trim() ? change.hsn.trim() : null
      if ((i.hsn ?? null) === hsn) return { kind: 'unchanged', reason: 'HSN is already that' }
      if (hsn) {
        const v = validateHsn(hsn)
        if (!v.valid) return { kind: 'refused', reason: v.error ?? 'Invalid HSN' }
      }
      return { kind: 'changed', payload: { ...i, hsn }, before: i.hsn ?? 'none', after: hsn ?? 'none' }
    }
    case 'stockGroup':
      if ((i.groupId ?? null) === change.groupId) return { kind: 'unchanged', reason: 'Already in that stock group' }
      return {
        kind: 'changed',
        payload: { ...i, groupId: change.groupId },
        before: ctx.name('stockGroup', i.groupId ?? null),
        after: ctx.name('stockGroup', change.groupId)
      }
  }
}

/** "Narration → append 'GST checked'" — the batch's one-line description. */
export function describeChange(req: BulkRequest, name: (what: string, id: number | null) => string): string {
  const n = req.ids.length
  const what = req.target === 'voucher' ? `${n} voucher${n === 1 ? '' : 's'}` : req.target === 'ledger' ? `${n} ledger${n === 1 ? '' : 's'}` : `${n} item${n === 1 ? '' : 's'}`
  const c = req.change
  switch (c.field) {
    case 'narration':
      return `${what}: narration ${c.mode} “${clip(c.text, 40)}”`
    case 'date':
      return `${what}: date → ${c.date}`
    case 'voucherType':
      return `${what}: voucher type → ${name('voucherType', c.voucherTypeId)}`
    case 'party':
      return `${what}: party ${c.from ? `${name('ledger', c.from)} ` : ''}→ ${name('ledger', c.to)}`
    case 'costCentre':
      return `${what}: cost centre ${c.from ? `${name('costCentre', c.from)} ` : ''}→ ${name('costCentre', c.to)}`
    case 'godown':
      return `${what}: godown ${c.from ? `${name('godown', c.from)} ` : ''}→ ${name('godown', c.to)}`
    case 'group':
      return `${what}: group → ${name('group', c.groupId)}`
    case 'creditDays':
      return `${what}: credit days → ${c.creditDays ?? 'none'}`
    case 'priceLevel':
      return `${what}: price level → ${name('priceLevel', c.priceLevelId)}`
    case 'gstRate':
      return `${what}: GST rate → ${c.gstRate ?? 'none'}${c.gstRate == null ? '' : '%'}`
    case 'hsn':
      return `${what}: HSN → ${c.hsn || 'none'}`
    case 'stockGroup':
      return `${what}: stock group → ${name('stockGroup', c.groupId)}`
  }
}
