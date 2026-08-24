/**
 * Reading and writing the open books format (roadmap #254; the format itself is
 * `src/shared/portable.ts` and `docs/export-format.md`).
 *
 * The import writes rows directly rather than going through saveVoucher. That looks like a
 * shortcut and is a deliberate choice: saveVoucher applies the ENTRY rules — it renumbers a
 * voucher whose type numbers automatically, refuses dates inside a locked period, matures PDCs,
 * writes bill references. Every one of those would change what came out of the file, and a round
 * trip that changes the books is not a round trip. What must not be skipped is the arithmetic, so
 * every voucher is checked to balance before it is inserted (validatePortable does it for the
 * whole document first, and the insert refuses again per voucher — the second check costs
 * nothing and is the one that survives someone calling this from elsewhere).
 */
import type { DB } from '../db/connection'
import { readCompanyInfo } from '../db/seed'
import { IN_BOOKS } from './vouchers'
import { writeAudit } from './audit'
import {
  PORTABLE_COVERAGE,
  PORTABLE_FORMAT,
  PORTABLE_VERSION,
  canonicalisePortable,
  validatePortable,
  type PortableDoc,
  type PortableVoucher
} from '@shared/portable'

/**
 * Everything in the books, by name.
 *
 * IN_BOOKS, not NOT_DELETED: what leaves in an export is what the trial balance shows. Binned
 * vouchers and unmatured post-dated ones are not in the books, and a file that carried them would
 * not foot against the reports it claims to be a copy of.
 */
export function exportPortable(db: DB, now = new Date()): PortableDoc {
  const info = readCompanyInfo(db)

  const groups = db
    .prepare(
      `SELECT g.name, p.name AS parent, g.nature, g.affects_gross_profit AS affectsGrossProfit
       FROM groups g LEFT JOIN groups p ON p.id = g.parent_id`
    )
    .all() as { name: string; parent: string | null; nature: 'asset'; affectsGrossProfit: number }[]

  const ledgers = db
    .prepare(
      `SELECT l.name, g.name AS "group", l.opening_balance AS openingBalance, l.gstin, l.state_code AS stateCode,
              l.address, l.tax_type AS taxType, l.gst_rate AS gstRate, l.hsn
       FROM ledgers l JOIN groups g ON g.id = l.group_id`
    )
    .all() as PortableDoc['ledgers']

  const voucherTypes = db
    .prepare('SELECT name, kind, numbering, prefix FROM voucher_types')
    .all() as PortableDoc['voucherTypes']

  const units = db.prepare('SELECT name, symbol, decimals, uqc FROM units').all() as PortableDoc['units']

  const stockGroups = db
    .prepare('SELECT sg.name, p.name AS parent FROM stock_groups sg LEFT JOIN stock_groups p ON p.id = sg.parent_id')
    .all() as PortableDoc['stockGroups']

  const stockItems = db
    .prepare(
      `SELECT si.name, sg.name AS "group", u.name AS unit, si.hsn, si.gst_rate AS gstRate, si.cess_rate AS cessRate,
              si.opening_qty_milli AS openingQtyMilli, si.opening_value AS openingValue
       FROM stock_items si LEFT JOIN stock_groups sg ON sg.id = si.group_id JOIN units u ON u.id = si.unit_id`
    )
    .all() as PortableDoc['stockItems']

  const godowns = (db.prepare('SELECT name FROM godowns').all() as { name: string }[]).map((g) => g.name)

  const voucherRows = db
    .prepare(
      `SELECT v.id, vt.name AS type, v.number, v.date, p.name AS party, v.narration, v.reference
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
       LEFT JOIN ledgers p ON p.id = v.party_ledger_id
       WHERE ${IN_BOOKS}`
    )
    .all() as (Omit<PortableVoucher, 'lines' | 'inventory'> & { id: number })[]

  const lineStmt = db.prepare(
    `SELECT l.name AS ledger, vl.dr_cr AS drCr, vl.amount
     FROM voucher_lines vl JOIN ledgers l ON l.id = vl.ledger_id
     WHERE vl.voucher_id = ? ORDER BY vl.line_order, vl.id`
  )
  const invStmt = db.prepare(
    `SELECT si.name AS item, g.name AS godown, il.qty_milli AS qtyMilli, il.rate_paise AS ratePaise,
            il.amount, il.direction
     FROM inventory_lines il JOIN stock_items si ON si.id = il.stock_item_id
     LEFT JOIN godowns g ON g.id = il.godown_id
     WHERE il.voucher_id = ? ORDER BY il.line_order, il.id`
  )

  const vouchers: PortableVoucher[] = voucherRows.map(({ id, ...voucher }) => ({
    ...voucher,
    lines: lineStmt.all(id) as PortableVoucher['lines'],
    inventory: invStmt.all(id) as PortableVoucher['inventory']
  }))

  return canonicalisePortable({
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt: now.toISOString(),
    coverage: [...PORTABLE_COVERAGE],
    company: {
      name: info.name,
      stateCode: info.stateCode,
      gstin: info.gstin,
      pan: info.pan,
      address: info.address,
      booksFrom: info.booksFrom
    },
    groups: groups.map((g) => ({ ...g, affectsGrossProfit: !!g.affectsGrossProfit })),
    ledgers,
    voucherTypes,
    units,
    stockGroups,
    stockItems,
    godowns,
    vouchers
  })
}

export interface ImportPortableResult {
  vouchers: number
  ledgers: number
  stockItems: number
}

/**
 * Write a document into an empty set of books.
 *
 * Refuses a company that already has vouchers in it. Merging two sets of books is a different and
 * much harder job than restoring one, and doing it silently would duplicate every entry that
 * happens to differ by a character.
 *
 * Masters that already exist by name (the standard chart every new company is seeded with) are
 * updated to match the file rather than skipped, so what comes back is what went in.
 */
export function importPortable(db: DB, input: unknown): ImportPortableResult {
  const problems = validatePortable(input)
  if (problems.length > 0) throw new Error(problems.slice(0, 5).join(' '))
  const doc = canonicalisePortable(input as PortableDoc)

  const existing = db.prepare(`SELECT COUNT(*) AS n FROM vouchers v WHERE ${IN_BOOKS}`).get() as { n: number }
  if (existing.n > 0) {
    throw new Error(
      `These books already hold ${existing.n} vouchers. Import into a new, empty company — merging two sets of books is not something this can do safely.`
    )
  }

  const run = db.transaction((): ImportPortableResult => {
    const groupId = new Map<string, number>()
    for (const group of doc.groups) {
      const parentId = group.parent === null ? null : (groupId.get(group.parent) ?? null)
      const found = db.prepare('SELECT id FROM groups WHERE name = ?').get(group.name) as { id: number } | undefined
      if (found) {
        db.prepare('UPDATE groups SET parent_id = ?, nature = ?, affects_gross_profit = ? WHERE id = ?').run(
          parentId,
          group.nature,
          group.affectsGrossProfit ? 1 : 0,
          found.id
        )
        groupId.set(group.name, found.id)
      } else {
        const result = db
          .prepare('INSERT INTO groups (name, parent_id, nature, affects_gross_profit) VALUES (?, ?, ?, ?)')
          .run(group.name, parentId, group.nature, group.affectsGrossProfit ? 1 : 0)
        groupId.set(group.name, Number(result.lastInsertRowid))
      }
    }

    const ledgerId = new Map<string, number>()
    for (const ledger of doc.ledgers) {
      const gid = groupId.get(ledger.group)
      if (gid === undefined) throw new Error(`Ledger "${ledger.name}" belongs to a group the file does not define`)
      const found = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(ledger.name) as { id: number } | undefined
      if (found) {
        db.prepare(
          `UPDATE ledgers SET group_id = ?, opening_balance = ?, gstin = ?, state_code = ?, address = ?,
                              tax_type = ?, gst_rate = ?, hsn = ? WHERE id = ?`
        ).run(gid, ledger.openingBalance, ledger.gstin, ledger.stateCode, ledger.address, ledger.taxType, ledger.gstRate, ledger.hsn, found.id)
        ledgerId.set(ledger.name, found.id)
      } else {
        const result = db
          .prepare(
            `INSERT INTO ledgers (name, group_id, opening_balance, gstin, state_code, address, tax_type, gst_rate, hsn)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(ledger.name, gid, ledger.openingBalance, ledger.gstin, ledger.stateCode, ledger.address, ledger.taxType, ledger.gstRate, ledger.hsn)
        ledgerId.set(ledger.name, Number(result.lastInsertRowid))
      }
    }

    const typeId = new Map<string, number>()
    for (const type of doc.voucherTypes) {
      const found = db.prepare('SELECT id FROM voucher_types WHERE name = ?').get(type.name) as { id: number } | undefined
      if (found) {
        db.prepare('UPDATE voucher_types SET kind = ?, numbering = ?, prefix = ? WHERE id = ?').run(
          type.kind,
          type.numbering,
          type.prefix,
          found.id
        )
        typeId.set(type.name, found.id)
      } else {
        const result = db
          .prepare('INSERT INTO voucher_types (name, kind, numbering, prefix) VALUES (?, ?, ?, ?)')
          .run(type.name, type.kind, type.numbering, type.prefix)
        typeId.set(type.name, Number(result.lastInsertRowid))
      }
    }

    const unitId = new Map<string, number>()
    for (const unit of doc.units) {
      const found = db.prepare('SELECT id FROM units WHERE name = ?').get(unit.name) as { id: number } | undefined
      if (found) {
        db.prepare('UPDATE units SET symbol = ?, decimals = ?, uqc = ? WHERE id = ?').run(unit.symbol, unit.decimals, unit.uqc, found.id)
        unitId.set(unit.name, found.id)
      } else {
        const result = db
          .prepare('INSERT INTO units (name, symbol, decimals, uqc) VALUES (?, ?, ?, ?)')
          .run(unit.name, unit.symbol, unit.decimals, unit.uqc)
        unitId.set(unit.name, Number(result.lastInsertRowid))
      }
    }

    const stockGroupId = new Map<string, number>()
    for (const group of doc.stockGroups) {
      const parentId = group.parent === null ? null : (stockGroupId.get(group.parent) ?? null)
      const found = db.prepare('SELECT id FROM stock_groups WHERE name = ?').get(group.name) as { id: number } | undefined
      if (found) {
        db.prepare('UPDATE stock_groups SET parent_id = ? WHERE id = ?').run(parentId, found.id)
        stockGroupId.set(group.name, found.id)
      } else {
        const result = db.prepare('INSERT INTO stock_groups (name, parent_id) VALUES (?, ?)').run(group.name, parentId)
        stockGroupId.set(group.name, Number(result.lastInsertRowid))
      }
    }

    const itemId = new Map<string, number>()
    for (const item of doc.stockItems) {
      const uid = unitId.get(item.unit)
      if (uid === undefined) throw new Error(`Item "${item.name}" uses a unit the file does not define`)
      const gid = item.group === null ? null : (stockGroupId.get(item.group) ?? null)
      const found = db.prepare('SELECT id FROM stock_items WHERE name = ?').get(item.name) as { id: number } | undefined
      if (found) {
        db.prepare(
          `UPDATE stock_items SET group_id = ?, unit_id = ?, hsn = ?, gst_rate = ?, cess_rate = ?,
                                  opening_qty_milli = ?, opening_value = ? WHERE id = ?`
        ).run(gid, uid, item.hsn, item.gstRate, item.cessRate, item.openingQtyMilli, item.openingValue, found.id)
        itemId.set(item.name, found.id)
      } else {
        const result = db
          .prepare(
            `INSERT INTO stock_items (name, group_id, unit_id, hsn, gst_rate, cess_rate, opening_qty_milli, opening_value)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(item.name, gid, uid, item.hsn, item.gstRate, item.cessRate, item.openingQtyMilli, item.openingValue)
        itemId.set(item.name, Number(result.lastInsertRowid))
      }
    }

    const godownId = new Map<string, number>()
    for (const name of doc.godowns) {
      const found = db.prepare('SELECT id FROM godowns WHERE name = ?').get(name) as { id: number } | undefined
      const id = found ? found.id : Number(db.prepare('INSERT INTO godowns (name) VALUES (?)').run(name).lastInsertRowid)
      godownId.set(name, id)
    }

    const insertVoucher = db.prepare(
      `INSERT INTO vouchers (voucher_type_id, date, number, party_ledger_id, narration, reference)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    const insertLine = db.prepare(
      'INSERT INTO voucher_lines (voucher_id, ledger_id, dr_cr, amount, line_order) VALUES (?, ?, ?, ?, ?)'
    )
    const insertInv = db.prepare(
      `INSERT INTO inventory_lines (voucher_id, stock_item_id, godown_id, qty_milli, rate_paise, amount, direction, line_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const voucher of doc.vouchers) {
      const vtId = typeId.get(voucher.type)
      if (vtId === undefined) throw new Error(`Voucher ${voucher.number} has a voucher type the file does not define`)
      const balance = voucher.lines.reduce((sum, l) => sum + (l.drCr === 'dr' ? l.amount : -l.amount), 0)
      if (balance !== 0) throw new Error(`Voucher ${voucher.type} ${voucher.number} does not balance`)

      const partyId = voucher.party === null ? null : (ledgerId.get(voucher.party) ?? null)
      const vid = Number(
        insertVoucher.run(vtId, voucher.date, voucher.number, partyId, voucher.narration, voucher.reference).lastInsertRowid
      )
      voucher.lines.forEach((line, index) => {
        const lid = ledgerId.get(line.ledger)
        if (lid === undefined) throw new Error(`Voucher ${voucher.number} posts to a ledger the file does not define`)
        insertLine.run(vid, lid, line.drCr, line.amount, index)
      })
      voucher.inventory.forEach((line, index) => {
        const sid = itemId.get(line.item)
        if (sid === undefined) throw new Error(`Voucher ${voucher.number} moves an item the file does not define`)
        insertInv.run(
          vid,
          sid,
          line.godown === null ? null : (godownId.get(line.godown) ?? null),
          line.qtyMilli,
          line.ratePaise,
          line.amount,
          line.direction,
          index
        )
      })
    }

    return { vouchers: doc.vouchers.length, ledgers: doc.ledgers.length, stockItems: doc.stockItems.length }
  })

  const result = run()
  writeAudit(db, 'company', 0, 'import', null, { kind: 'portable', ...result })
  return result
}
