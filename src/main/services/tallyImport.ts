import type { DB } from '../db/connection'
import { parseTallyExport, type TallyImport } from '@shared/tally'
import { GST_STATES } from '@shared/gst/states'
import { saveVoucher } from './vouchers'
import { writeAudit } from './audit'
import type { VoucherKind } from '@shared/domain'
import { createHash } from 'crypto'
import { assertImportNotApplied, findSemanticImportBatch, importSourceHash, recordImportBatch } from './importBatches'

export interface ImportSummary {
  groups: number
  ledgers: number
  units: number
  items: number
  vouchers: number
  skipped: number
  warnings: string[]
  batchId?: number
  sourceHash?: string
  semanticHash?: string
  alreadyImported?: { id: number; appliedAt: string } | null
}

function sorted<T>(rows: T[]): T[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

/** Stable identity for the accounting meaning of a Tally export. Formatting, BOMs, XML wrapper
 * layout and master order do not affect it; source GUID/MASTERID/ALTERID values remain evidence. */
export function tallySemanticHash(xml: string): string {
  const data = parseTallyExport(xml.replace(/^\uFEFF/, ''))
  const canonical = {
    groups: sorted(data.groups),
    ledgers: sorted(data.ledgers),
    units: sorted(data.units),
    items: sorted(data.items),
    vouchers: sorted(data.vouchers.map((voucher) => ({
      ...voucher,
      lines: sorted(voucher.lines),
      inventory: sorted(voucher.inventory),
    }))),
    warnings: [...data.warnings].sort(),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Map a Tally voucher-type name to one of our kinds. */
function kindForName(name: string): VoucherKind {
  const n = name.toLowerCase()
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
    skipped: 0,
    warnings: [...data.warnings]
  }
}

/** Database-aware review used by the import wizard. Unknown inventory masters are blocking
 * review findings because silently omitting stock lines would change both stock and valuation. */
export function previewTallyXml(db: DB, xml: string): ImportSummary {
  const data = parseTallyExport(xml);
  const summary = dryRunTallyXml(xml);
  const existingUnits = new Set(
    (db.prepare("SELECT name,symbol FROM units").all() as Array<{ name: string; symbol: string }>)
      .flatMap((row) => [row.name.toLowerCase(), row.symbol.toLowerCase()]),
  );
  const exportedUnits = new Set(data.units.map((unit) => unit.name.toLowerCase()));
  const existingItems = new Set(
    (db.prepare("SELECT name FROM stock_items").all() as Array<{ name: string }>)
      .map((row) => row.name.toLowerCase()),
  );
  const importableItems = new Set(existingItems);
  for (const item of data.items) {
    if (existingItems.has(item.name.toLowerCase())) continue;
    if (!item.unit || (!existingUnits.has(item.unit.toLowerCase()) && !exportedUnits.has(item.unit.toLowerCase()))) {
      summary.skipped++;
      summary.warnings.push(`Item "${item.name}" requires unknown unit "${item.unit || "(blank)"}"`);
    } else importableItems.add(item.name.toLowerCase());
  }
  for (const voucher of data.vouchers) {
    const unknown = voucher.inventory.find((line) => !importableItems.has(line.item.toLowerCase()));
    if (!unknown) continue;
    summary.skipped++;
    summary.warnings.push(`Voucher ${voucher.number || voucher.date} requires unknown stock item "${unknown.item}"`);
  }
  return summary;
}

/** Apply a parsed Tally export to the open company. Idempotent-ish: existing names are reused,
 *  not duplicated. The whole apply runs in ONE transaction (task Q1 #94) — a hard failure
 *  partway through (e.g. a constraint violation) rolls back every master and voucher written so
 *  far, never leaving a half-imported company. Per-voucher validation failures are still soft
 *  (skipped + warned), same as before. A single summary audit row (entity 'tally_import',
 *  action 'import') records the counts. */
export function importTallyXml(db: DB, xml: string): ImportSummary {
  // Parse outside the transaction — a malformed file fails before any write is attempted.
  const data: TallyImport = parseTallyExport(xml)
  const semanticHash = tallySemanticHash(xml)
  const run = db.transaction((): ImportSummary => {
    assertImportNotApplied(db, 'tally', xml)
    const semanticReplay = findSemanticImportBatch(db, 'tally', semanticHash)
    if (semanticReplay)
      throw new Error(`An equivalent Tally export was already imported on ${semanticReplay.appliedAt} (batch #${semanticReplay.id})`)
    const summary = applyParsedTallyImport(db, data)
    const sourceRows = data.groups.length + data.ledgers.length + data.units.length + data.items.length + data.vouchers.length
    const batch = recordImportBatch(db, 'tally', xml, {
      sourceRows,
      acceptedRows: sourceRows - summary.skipped,
      rejectedRows: summary.skipped,
      summary,
      semanticHash,
    })
    writeAudit(db, 'tally_import', batch.id, 'import', null, {
      groups: summary.groups,
      ledgers: summary.ledgers,
      units: summary.units,
      items: summary.items,
      vouchers: summary.vouchers,
      skipped: summary.skipped,
      warnings: summary.warnings.length,
      sourceHash: batch.sourceHash
    })
    return { ...summary, batchId: batch.id, sourceHash: batch.sourceHash, semanticHash }
  })
  return run()
}

function applyParsedTallyImport(db: DB, data: TallyImport): ImportSummary {
  const warnings = [...data.warnings]
  let counts = { groups: 0, ledgers: 0, units: 0, items: 0, vouchers: 0, skipped: 0 }

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
  for (const g of pending) {
    warnings.push(`Group "${g.name}" skipped: parent "${g.parent}" not found`)
    counts.skipped++
  }

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
  for (const item of data.items) {
    const exists = db.prepare('SELECT id FROM stock_items WHERE name = ? COLLATE NOCASE').get(item.name)
    if (exists) continue
    const unit = db.prepare('SELECT id FROM units WHERE name = ? COLLATE NOCASE OR symbol = ? COLLATE NOCASE').get(item.unit, item.unit) as { id: number } | undefined
    if (!unit) {
      warnings.push(`Item "${item.name}" skipped: unknown unit "${item.unit || '(blank)'}"`)
      counts.skipped++
      continue
    }
    db.prepare(
      'INSERT INTO stock_items (name, unit_id, hsn, gst_rate, opening_qty_milli, opening_value) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(item.name, unit.id, item.hsn, item.gstRate, item.openingQtyMilli, item.openingValue)
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
    const unknownInventory = v.inventory.find((line) => !itemId(line.item))
    if (unknownInventory) {
      warnings.push(`Voucher ${v.number || v.date} skipped: unknown stock item "${unknownInventory.item}"`)
      counts.skipped++
      continue
    }
    const missing = v.lines.filter((l) => !ledgerId(l.ledger))
    if (missing.length) {
      warnings.push(`Voucher ${v.number || v.date} skipped: unknown ledger "${missing[0]!.ledger}" (import masters first)`)
      counts.skipped++
      continue
    }
    const vt = typeIdFor(v.vchType || 'Journal')
    const goodsIn = vt.kind === 'purchase' || vt.kind === 'credit_note'
    try {
      saveVoucher(db, {
        voucherTypeId: vt.id,
        date: v.date,
        number: v.number || undefined,
        partyLedgerId: v.party ? ledgerId(v.party) : null,
        narration: v.narration,
        reference: null,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: v.lines.map((l) => ({ ledgerId: ledgerId(l.ledger)!, drCr: l.drCr, amount: l.amount, costAllocations: [] })),
        inventory: v.inventory.map((inv) => ({
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

  return { ...counts, warnings }
}
