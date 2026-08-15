import type { DB } from '../db/connection'
import { parseTallyExport, type TallyImport } from '@shared/tally'
import { GST_STATES } from '@shared/gst/states'
import { saveVoucher } from './vouchers'
import type { VoucherKind } from '@shared/domain'

export interface ImportSummary {
  groups: number
  ledgers: number
  units: number
  items: number
  vouchers: number
  skipped: number
  warnings: string[]
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

/** Apply a parsed Tally export to the open company. Idempotent-ish: existing names are reused, not duplicated. */
export function importTallyXml(db: DB, xml: string): ImportSummary {
  const data: TallyImport = parseTallyExport(xml)
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
        lines: v.lines.map((l) => ({ ledgerId: ledgerId(l.ledger)!, drCr: l.drCr, amount: l.amount })),
        inventory: v.inventory
          .filter((inv) => itemId(inv.item))
          .map((inv) => ({
            stockItemId: itemId(inv.item)!,
            godownId: null,
            qtyMilli: inv.qtyMilli,
            ratePaise: inv.qtyMilli > 0 ? Math.round((inv.amount * 1000) / inv.qtyMilli) : 0,
            amount: inv.amount,
            direction: goodsIn ? ('in' as const) : ('out' as const)
          }))
      })
      counts.vouchers++
    } catch (err) {
      warnings.push(`Voucher ${v.number || v.date} skipped: ${(err as Error).message}`)
      counts.skipped++
    }
  }

  return { ...counts, warnings }
}
