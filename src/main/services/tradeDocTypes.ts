import type { DB } from '../db/connection'
import { VOUCHER_KINDS, type TradeDocType, type VoucherKind } from '@shared/domain'
import type { TradeDocTypeInput } from '@shared/schemas'
import { writeAudit } from './audit'
import { nextSeriesNumber } from './numbering'
import type { VoucherKindRow } from '@shared/tradeCycle/types'

/**
 * Numbering series for quotations and orders (trade_doc_types, migration 025) — the same knobs
 * as voucher types (prefix, suffix, pad, FY restart). WP 2.5a ships the series; the documents
 * themselves (trade_docs) get their screens in WP 2.5c. System series keep their name and kind.
 */

interface TdtRow {
  id: number; name: string; kind: TradeDocType['kind']; numbering: 'auto' | 'manual'; prefix: string; suffix: string
  pad_width: number; restart_fy: number; is_system: number
}

const mapTdt = (r: TdtRow): TradeDocType => ({
  id: r.id, name: r.name, kind: r.kind, numbering: r.numbering, prefix: r.prefix, suffix: r.suffix,
  padWidth: r.pad_width, restartFy: !!r.restart_fy, isSystem: !!r.is_system
})

export function listTradeDocTypes(db: DB): TradeDocType[] {
  return (db.prepare('SELECT * FROM trade_doc_types ORDER BY id').all() as TdtRow[]).map(mapTdt)
}

export function getTradeDocType(db: DB, id: number): TradeDocType {
  const row = db.prepare('SELECT * FROM trade_doc_types WHERE id = ?').get(id) as TdtRow | undefined
  if (!row) throw new Error('Order / quotation type not found')
  return mapTdt(row)
}

/** Create (no id) or alter a series. Audit entity 'tradeDocType'. */
export function saveTradeDocType(db: DB, input: TradeDocTypeInput, id?: number): TradeDocType {
  if (id === undefined) {
    const res = db
      .prepare(
        'INSERT INTO trade_doc_types (name, kind, numbering, prefix, suffix, pad_width, restart_fy, is_system) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
      )
      .run(input.name, input.kind, input.numbering, input.prefix, input.suffix, input.padWidth, input.restartFy ? 1 : 0)
    const created = getTradeDocType(db, Number(res.lastInsertRowid))
    writeAudit(db, 'tradeDocType', created.id, 'create', null, created)
    return created
  }
  const existing = getTradeDocType(db, id)
  const used = !!db.prepare('SELECT 1 FROM trade_docs WHERE doc_type_id = ? LIMIT 1').get(id)
  // A series' kind is part of what its documents ARE: never changed on a system series, nor once used.
  const kind = existing.isSystem || used ? existing.kind : input.kind
  db.prepare('UPDATE trade_doc_types SET name = ?, kind = ?, numbering = ?, prefix = ?, suffix = ?, pad_width = ?, restart_fy = ? WHERE id = ?').run(
    existing.isSystem ? existing.name : input.name, kind, input.numbering, input.prefix, input.suffix, input.padWidth, input.restartFy ? 1 : 0, id
  )
  const updated = getTradeDocType(db, id)
  writeAudit(db, 'tradeDocType', id, 'update', existing, updated)
  return updated
}

/** Next auto number of a quotation / order series (binned documents still count). */
export function nextTradeDocNumber(db: DB, docTypeId: number, date: string, excludeDocId?: number): string {
  return nextSeriesNumber(db, { table: 'trade_docs', typeColumn: 'doc_type_id', type: getTradeDocType(db, docTypeId), date, excludeId: excludeDocId })
}

/** The voucher_kinds lookup table (migration 024), in VOUCHER_KINDS order. */
export function listVoucherKinds(db: DB): VoucherKindRow[] {
  const order = (k: string): number => {
    const i = (VOUCHER_KINDS as readonly string[]).indexOf(k)
    return i === -1 ? VOUCHER_KINDS.length : i
  }
  return (db.prepare('SELECT kind, stock_only AS stockOnly FROM voucher_kinds').all() as { kind: VoucherKind; stockOnly: number }[])
    .map((r) => ({ kind: r.kind, stockOnly: r.stockOnly === 1 }))
    .sort((a, b) => order(a.kind) - order(b.kind) || a.kind.localeCompare(b.kind))
}
