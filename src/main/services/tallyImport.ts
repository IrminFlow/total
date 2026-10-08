import type { DB } from '../db/connection'
import { orderLineMoney, parseTallyExport, TALLY_ORDER_TYPE, type TallyImport, type TallyOrder } from '@shared/tally'
import { GST_STATES } from '@shared/gst/states'
import { fyOf } from '@shared/dates'
import { saveVoucher } from './vouchers'
import { saveTradeDoc } from './tradeDocs'
import { listTradeDocTypes } from './tradeDocTypes'
import { writeAudit } from './audit'
import { readCompanyInfo, writeCompanyInfo } from '../db/seed'
import type { TradePurpose, VoucherKind } from '@shared/domain'

export interface ImportSummary {
  groups: number
  ledgers: number
  units: number
  items: number
  vouchers: number
  /** Sales / purchase orders imported into trade_docs (WP 6.3). */
  orders: number
  skipped: number
  /** The books-from FY start year the import set on the company (null = left as it was). */
  booksFromSet: number | null
  warnings: string[]
}

/** Tally order voucher types (Sales Order, Purchase Order, Job Work In/Out Order): not books
 *  documents, so never vouchers. The parser hands sales / purchase orders over as `orders`,
 *  which import into trade_docs (WP 6.3, design §8 Q8); job-work orders are skipped. */
export function isOrderTypeName(name: string): boolean {
  return TALLY_ORDER_TYPE.test(name)
}

/** The FY the books start in: the company master's BOOKSFROM when the file has it, else the FY of
 *  the earliest voucher or order in the file. Null when the file has neither. */
export function tallyBooksFromYear(data: TallyImport): number | null {
  if (data.booksFrom) return fyOf(data.booksFrom).startYear
  // Books start with the first real voucher: optional (memorandum) vouchers and orders post nothing.
  const dates = data.vouchers.filter((v) => !v.isOptional).map((v) => v.date).sort()
  return dates[0] ? fyOf(dates[0]).startYear : null
}

/** Map a Tally voucher-type name to one of our kinds. The stock notes are matched FIRST —
 *  "Receipt Note" used to fall into 'receipt' (a cash/bank voucher) and "Delivery Note" into
 *  'journal'. Tally's "Rejections In" is goods back from a customer (a receipt note), "Rejections
 *  Out" goods back to a supplier (a delivery note). Orders never get here (isOrderTypeName). */
export function kindForName(name: string): VoucherKind {
  const n = name.toLowerCase()
  if (n.includes('delivery note') || n.includes('delivery challan')) return 'delivery_note'
  if (n.includes('receipt note') || n.includes('goods receipt')) return 'receipt_note'
  if (n.includes('rejection')) return /\bout\b/.test(n) ? 'delivery_note' : 'receipt_note'
  if (n.includes('contra')) return 'contra'
  if (n.includes('payment')) return 'payment'
  if (n.includes('receipt')) return 'receipt'
  if (n.includes('credit note')) return 'credit_note'
  if (n.includes('debit note')) return 'debit_note'
  if (n.includes('sales')) return 'sales'
  if (n.includes('purchase')) return 'purchase'
  if (n.includes('stock')) return 'stock_journal'
  return 'journal'
}

/** A rejection note returns goods (to the supplier / from the customer); other notes are a
 *  supply out or a purchase in. */
function stockNotePurpose(kind: VoucherKind, typeName: string): TradePurpose {
  const rejection = /rejection/i.test(typeName)
  if (kind === 'delivery_note') return rejection ? 'non_supply' : 'supply'
  return rejection ? 'return' : 'purchase'
}

function stateCodeFromName(stateName: string | null): string | null {
  if (!stateName) return null
  const entry = Object.entries(GST_STATES).find(([, name]) => name.toLowerCase() === stateName.trim().toLowerCase())
  return entry ? entry[0] : null
}

/** Parse-only sibling of importTallyXml: reads what the file contains without touching the
 *  database at all — no ledger/group lookups (which would run against whatever company happens
 *  to be open), so a dry run always sees the same counts for the same file. Used by the wizard's
 *  Preview step; `skipped` is always 0 here since nothing is attempted against a live company. */
export function dryRunTallyXml(xml: string): ImportSummary {
  const data: TallyImport = parseTallyExport(xml)
  return {
    groups: data.groups.length,
    ledgers: data.ledgers.length,
    units: data.units.length,
    items: data.items.length,
    vouchers: data.vouchers.length,
    orders: data.orders.length,
    skipped: 0,
    booksFromSet: tallyBooksFromYear(data),
    warnings: [...data.warnings]
  }
}

/** Apply a parsed Tally export to the open company. Idempotent-ish: existing names are reused,
 *  not duplicated. The whole apply runs in ONE transaction (task Q1 #94) — a hard failure
 *  partway through (e.g. a constraint violation) rolls back every master and voucher written so
 *  far, never leaving a half-imported company. Per-voucher validation failures are still soft
 *  (skipped + warned), same as before. A single summary audit row (entity 'tally_import',
 *  action 'import') records the counts. */
export interface TallyImportOptions {
  /** Changing the books-from year is a company-details change: owner only (the IPC layer passes
   *  the session's right; services and tests default to allowed). */
  canSetBooksFrom?: boolean
}

export function importTallyXml(db: DB, xml: string, opts: TallyImportOptions = {}): ImportSummary {
  // Parse outside the transaction — a malformed file fails before any write is attempted.
  const data: TallyImport = parseTallyExport(xml)
  const run = db.transaction((): ImportSummary => {
    const summary = applyParsedTallyImport(db, data, opts.canSetBooksFrom !== false)
    writeAudit(db, 'tally_import', 0, 'import', null, {
      groups: summary.groups,
      ledgers: summary.ledgers,
      units: summary.units,
      items: summary.items,
      vouchers: summary.vouchers,
      orders: summary.orders,
      skipped: summary.skipped,
      booksFromSet: summary.booksFromSet,
      warnings: summary.warnings.length
    })
    return summary
  })
  return run()
}

function applyParsedTallyImport(db: DB, data: TallyImport, canSetBooksFrom: boolean): ImportSummary {
  const warnings = [...data.warnings]
  let counts = { groups: 0, ledgers: 0, units: 0, items: 0, vouchers: 0, orders: 0, skipped: 0 }

  // Books-from (Phase 1 gap): a company being migrated from Tally starts its books where Tally's
  // did — set it while the company has no vouchers yet (stored openings belong to that FY, the
  // WP 1.3 year-opening rule). Afterwards it is the user's call (Company details), so only warn.
  let booksFromSet: number | null = null
  const fileYear = tallyBooksFromYear(data)
  if (fileYear !== null) {
    const info = readCompanyInfo(db)
    if (info.booksFrom !== fileYear) {
      if (!canSetBooksFrom) {
        warnings.push(`The Tally books start in FY ${fileYear}-${String((fileYear + 1) % 100).padStart(2, '0')} — only an owner can change this company's first year (Company details)`)
      } else if (!db.prepare('SELECT 1 FROM vouchers LIMIT 1').get()) {
        writeCompanyInfo(db, { ...info, booksFrom: fileYear })
        writeAudit(db, 'company', 0, 'update', info, { ...info, booksFrom: fileYear })
        booksFromSet = fileYear
      } else {
        warnings.push(`The Tally books start in FY ${fileYear}-${String((fileYear + 1) % 100).padStart(2, '0')}, this company's in ${info.booksFrom}-${String((info.booksFrom + 1) % 100).padStart(2, '0')} — left unchanged because the company already has vouchers`)
      }
    }
  }

  const groupId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }

  // Groups first — parents may arrive in any order, so loop until stable.
  let pending = [...data.groups]
  for (let pass = 0; pass < 10 && pending.length; pass++) {
    const next: typeof pending = []
    for (const g of pending) {
      if (groupId(g.name)) continue
      const parentId = g.parent ? groupId(g.parent) : null
      if (g.parent && !parentId) {
        next.push(g)
        continue
      }
      const parent = parentId
        ? (db.prepare('SELECT nature, affects_gross_profit FROM groups WHERE id = ?').get(parentId) as { nature: string; affects_gross_profit: number })
        : { nature: 'asset', affects_gross_profit: 0 }
      db.prepare('INSERT INTO groups (name, parent_id, nature, affects_gross_profit, is_system) VALUES (?, ?, ?, ?, 0)')
        .run(g.name, parentId, parent.nature, parent.affects_gross_profit)
      counts.groups++
    }
    pending = next
  }
  for (const g of pending) warnings.push(`Group "${g.name}" skipped: parent "${g.parent}" not found`)

  // Units
  for (const u of data.units) {
    const exists = db.prepare('SELECT id FROM units WHERE name = ? COLLATE NOCASE OR symbol = ? COLLATE NOCASE').get(u.name, u.name)
    if (exists) continue
    db.prepare('INSERT INTO units (name, symbol, decimals, uqc) VALUES (?, ?, ?, ?)').run(u.name, u.name, u.decimals, 'OTH')
    counts.units++
  }

  // Ledgers
  const suspense = groupId('Suspense A/c')!
  for (const l of data.ledgers) {
    const exists = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(l.name)
    if (exists) continue
    const gid = groupId(l.parent) ?? suspense
    if (!groupId(l.parent)) warnings.push(`Ledger "${l.name}": group "${l.parent}" not found, placed under Suspense A/c`)
    db.prepare(
      'INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, is_system) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(l.name, gid, l.opening, l.gstin, stateCodeFromName(l.stateName))
    counts.ledgers++
  }

  // Stock items
  const defaultUnit = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id
  for (const item of data.items) {
    const exists = db.prepare('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE').get(item.name)
    if (exists) continue
    const unit = db.prepare('SELECT id FROM units WHERE name = ? COLLATE NOCASE OR symbol = ? COLLATE NOCASE').get(item.unit, item.unit) as { id: number } | undefined
    if (!unit && !defaultUnit) {
      warnings.push(`Item "${item.name}" skipped: no unit`)
      continue
    }
    db.prepare(
      'INSERT INTO stock_items (name, unit_id, hsn, gst_rate, opening_qty_milli, opening_value) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(item.name, unit?.id ?? defaultUnit, item.hsn, item.gstRate, item.openingQtyMilli, item.openingValue)
    counts.items++
  }

  // Vouchers
  const ledgerId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }
  const itemId = (name: string): number | null => {
    const row = db.prepare('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined
    return row?.id ?? null
  }
  const typeIdFor = (vchType: string): { id: number; kind: VoucherKind } => {
    const existing = db.prepare('SELECT id, kind FROM voucher_types WHERE name = ? COLLATE NOCASE').get(vchType) as
      | { id: number; kind: VoucherKind }
      | undefined
    if (existing) return existing
    const kind = kindForName(vchType)
    const res = db.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES (?, ?, 'manual', '', 0)")
      .run(vchType, kind)
    return { id: Number(res.lastInsertRowid), kind }
  }

  for (const v of data.vouchers) {
    const missing = v.lines.filter((l) => !ledgerId(l.ledger))
    if (missing.length) {
      warnings.push(`Voucher ${v.number || v.date} skipped: unknown ledger "${missing[0]!.ledger}" (import masters first)`)
      counts.skipped++
      continue
    }
    if (isOrderTypeName(v.vchType || '')) {
      warnings.push(`Voucher ${v.number || v.date} skipped: ${v.vchType} is an order — orders are not imported yet`)
      counts.skipped++
      continue
    }
    const vt = typeIdFor(v.vchType || 'Journal')
    const goodsIn = vt.kind === 'purchase' || vt.kind === 'credit_note' || vt.kind === 'receipt_note'
    // A delivery / receipt note moves goods only: Tally may still list the party's ledger entry
    // on it, but it posts nothing — keep the goods and the party, drop the ledger lines.
    const stockNote = vt.kind === 'delivery_note' || vt.kind === 'receipt_note'
    if (stockNote && v.lines.length > 0) {
      warnings.push(`Voucher ${v.number || v.date} (${v.vchType}): ledger entries on a ${vt.kind === 'delivery_note' ? 'delivery' : 'receipt'} note were not imported — it moves stock only`)
    }
    try {
      saveVoucher(db, {
        voucherTypeId: vt.id,
        date: v.date,
        number: v.number || undefined,
        partyLedgerId: v.party ? ledgerId(v.party) : null,
        ...(stockNote ? { trade: { purpose: stockNotePurpose(vt.kind, v.vchType || '') } } : {}),
        narration: v.narration,
        isOptional: v.isOptional || undefined,
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: stockNote ? [] : v.lines.map((l) => ({ ledgerId: ledgerId(l.ledger)!, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
        inventory: v.inventory
          .filter((inv) => itemId(inv.item))
          .map((inv) => ({
            stockItemId: itemId(inv.item)!,
            godownId: null,
            qtyMilli: inv.qtyMilli,
            ratePaise: inv.qtyMilli > 0 ? Math.round((inv.amount * 1000) / inv.qtyMilli) : 0,
            amount: inv.amount,
            direction: goodsIn ? ('in' as const) : ('out' as const)
          })),
        billRefs: [],
        tds: null
      })
      counts.vouchers++
    } catch (err) {
      warnings.push(`Voucher ${v.number || v.date} skipped: ${(err as Error).message}`)
      counts.skipped++
    }
  }

  // Orders → trade_docs (WP 6.3). Each in its own savepoint: a bad order is skipped and warned.
  const docTypes = listTradeDocTypes(db)
  for (const o of data.orders) {
    try {
      db.transaction(() => importTallyOrder(db, o, docTypes, ledgerId, itemId))()
      counts.orders++
    } catch (err) {
      warnings.push(`${o.vchType} ${o.number || o.date} skipped: ${(err as Error).message}`)
      counts.skipped++
    }
  }

  return { ...counts, booksFromSet, warnings }
}

function importTallyOrder(
  db: DB,
  o: TallyOrder,
  docTypes: ReturnType<typeof listTradeDocTypes>,
  ledgerId: (name: string) => number | null,
  itemId: (name: string) => number | null
): void {
  if (!o.party) throw new Error('no party ledger')
  const partyId = ledgerId(o.party)
  if (!partyId) throw new Error(`unknown party "${o.party}" (import masters first)`)
  // The series with the same name as the Tally type ("Sales Order"), else the kind's first.
  const type = docTypes.find((t) => t.kind === o.kind && t.name.toLowerCase() === o.vchType.toLowerCase()) ?? docTypes.find((t) => t.kind === o.kind)
  if (!type) throw new Error(`no ${o.kind.replace('_', ' ')} series`)
  // A number repeats every FY in a series that restarts numbering: duplicates are per FY then.
  const fy = fyOf(o.date)
  if (o.number && db.prepare(`SELECT 1 FROM trade_docs WHERE doc_type_id = ? AND number = ? AND deleted_at IS NULL${type.restartFy ? ' AND date BETWEEN ? AND ?' : ''}`).get(type.id, o.number, ...(type.restartFy ? [fy.from, fy.to] : []))) {
    throw new Error('already imported')
  }
  const godownId = (name: string | null): number | null =>
    name ? ((db.prepare('SELECT id FROM godowns WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined)?.id ?? null) : null
  const dues = o.lines.map((l) => l.dueDate).filter((d): d is string => !!d && d >= o.date).sort()
  saveTradeDoc(db, {
    docTypeId: type.id,
    date: o.date,
    number: o.number || undefined,
    partyLedgerId: partyId,
    dueDate: dues[dues.length - 1] ?? null,
    reference: o.reference ? o.reference.slice(0, 120) : null,
    narration: o.narration ? o.narration.slice(0, 1000) : null,
    lines: o.lines.map((l) => {
      const id = itemId(l.item)
      if (!id) throw new Error(`unknown stock item "${l.item}" (import masters first)`)
      const money = orderLineMoney(l.qtyMilli, l.ratePaise, l.amount)
      return {
        stockItemId: id, godownId: godownId(l.godown), qtyMilli: l.qtyMilli, ...money,
        dueDate: l.dueDate && l.dueDate >= o.date ? l.dueDate : null
      }
    })
  })
}
