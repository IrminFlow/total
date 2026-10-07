// Migrations 024–025 (WP 2.5a) on a populated fixture at the latest pre-024 schema: the
// voucher-kinds rebuild keeps ids, rows, references and the AUTOINCREMENT mark; the Tally
// "Delivery Note" name collision; line uids; moves_stock; the 'delivered' serial status; the
// trade-doc tables and line_links constraints; and the rollback of a broken rebuild.
import { describe, it, expect } from 'vitest'
import type { DB } from './connection'
import { migrate, schemaVersion } from './migrate'
import { MIGRATIONS } from './migrations'
import { freshDb, freshPartialDb, TEST_INFO } from './testdb'
import { seedCompany } from './seed'
import { DEFAULT_VOUCHER_TYPES } from '@shared/seed'
import { STOCK_ONLY_KINDS, VOUCHER_KINDS } from '@shared/domain'

const AT = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE voucher_kinds'))
const AT_DOCS = MIGRATIONS.findIndex((sql) => sql.includes('CREATE TABLE trade_docs'))

interface Fixture {
  db: DB
  types: unknown[]
  seq: number
  lines: number
  tallyDeliveryNote: number
}

/** A company at schema 023-or-whatever-precedes-024, with vouchers, lines, serials, a recurring
 *  template, a Tally-imported "Delivery Note" journal type and a deleted (id-burning) type. */
function fixture(): Fixture {
  const db = freshPartialDb(AT)
  seedCompany(db, TEST_INFO)
  const tallyDeliveryNote = Number(db.prepare("INSERT INTO voucher_types (name, kind, numbering, prefix, is_system) VALUES ('Delivery Note', 'journal', 'manual', '', 0)").run().lastInsertRowid)
  const burnt = Number(db.prepare("INSERT INTO voucher_types (name, kind) VALUES ('Scratch', 'sales')").run().lastInsertRowid)
  db.prepare('DELETE FROM voucher_types WHERE id = ?').run(burnt)
  const sales = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
  const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const itemId = Number(db.prepare("INSERT INTO stock_items (name, unit_id, track_serials) VALUES ('Phone', ?, 1)").run(unit).lastInsertRowid)
  const v1 = Number(db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-05-01', '1')").run(tallyDeliveryNote).lastInsertRowid)
  const v2 = Number(db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-05-02', '1')").run(sales).lastInsertRowid)
  const ins = db.prepare("INSERT INTO inventory_lines (voucher_id, stock_item_id, qty_milli, rate_paise, amount, direction, serials) VALUES (?, ?, 1000, 100, 100, ?, ?)")
  const inLine = Number(ins.run(v1, itemId, 'in', '["S1"]').lastInsertRowid)
  const outLine = Number(ins.run(v2, itemId, 'out', '["S1"]').lastInsertRowid)
  db.prepare("INSERT INTO serial_numbers (stock_item_id, serial, status, inward_line_id, outward_line_id) VALUES (?, 'S1', 'sold', ?, ?)").run(itemId, inLine, outLine)
  db.prepare("INSERT INTO recurring_templates (name, voucher_json, cadence, next_due, voucher_type_id) VALUES ('Monthly', '{}', 'monthly', '2025-06-01', ?)").run(sales)
  return {
    db,
    types: db.prepare('SELECT * FROM voucher_types ORDER BY id').all(),
    seq: (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'voucher_types'").get() as { seq: number }).seq,
    lines: 2,
    tallyDeliveryNote
  }
}

describe('migration 024 — voucher kinds, line uids, moves_stock, serial status', () => {
  it('is the FK-off rebuild and sits right before 025', () => {
    expect(AT).toBeGreaterThan(0)
    expect(MIGRATIONS[AT]!.startsWith('-- @foreign-keys-off')).toBe(true)
    expect(AT_DOCS).toBe(AT + 1)
  })

  it('preserves every voucher type row, id and reference, and the AUTOINCREMENT high-water mark', () => {
    const f = fixture()
    migrate(f.db)
    expect(schemaVersion(f.db)).toBe(MIGRATIONS.length)
    const after = f.db.prepare('SELECT * FROM voucher_types WHERE id <= ? ORDER BY id').all(f.seq)
    expect(after).toEqual(f.types)
    expect(f.db.pragma('foreign_key_check')).toEqual([])
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1)
    // The deleted type's id is never reissued: new types start above the old mark.
    const added = f.db.prepare("SELECT id, name, kind, is_system FROM voucher_types WHERE kind IN ('delivery_note', 'receipt_note') ORDER BY id").all() as { id: number }[]
    expect(added.every((t) => t.id > f.seq)).toBe(true)
    // The column order is unchanged (SELECT * readers).
    expect((f.db.prepare('PRAGMA table_info(voucher_types)').all() as { name: string }[]).map((c) => c.name)).toEqual(
      ['id', 'name', 'kind', 'numbering', 'prefix', 'is_system', 'suffix', 'pad_width', 'restart_fy']
    )
    // vouchers / recurring_templates still reference the same ids (and the FK is live).
    expect(() => f.db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (9999, '2025-05-01', 'x')").run()).toThrow(/FOREIGN KEY/)
  })

  it('takes the first free name: a Tally "Delivery Note" journal type stays a journal', () => {
    const f = fixture()
    migrate(f.db)
    const added = f.db.prepare("SELECT name, kind, is_system FROM voucher_types WHERE kind IN ('delivery_note', 'receipt_note') ORDER BY id").all()
    expect(added).toEqual([
      { name: 'Delivery Challan', kind: 'delivery_note', is_system: 1 },
      { name: 'Receipt Note', kind: 'receipt_note', is_system: 1 }
    ])
    expect(f.db.prepare('SELECT kind FROM voucher_types WHERE id = ?').get(f.tallyDeliveryNote)).toEqual({ kind: 'journal' })
  })

  it('voucher_kinds equals VOUCHER_KINDS and replaces the CHECK with a foreign key', () => {
    const db = freshDb()
    const rows = db.prepare('SELECT kind, stock_only FROM voucher_kinds').all() as { kind: string; stock_only: number }[]
    expect(rows.map((r) => r.kind).sort()).toEqual([...VOUCHER_KINDS].sort())
    expect(rows.filter((r) => r.stock_only === 1).map((r) => r.kind).sort()).toEqual([...STOCK_ONLY_KINDS].sort())
    expect(() => db.prepare("INSERT INTO voucher_types (name, kind) VALUES ('Bogus', 'bogus')").run()).toThrow(/FOREIGN KEY/)
    db.prepare("INSERT INTO voucher_types (name, kind) VALUES ('Job Work Out', 'delivery_note')").run()
  })

  it('a fresh company: the stock-note types come from the migration, the seed adds the usual ten', () => {
    const db = freshDb()
    seedCompany(db, TEST_INFO)
    expect(DEFAULT_VOUCHER_TYPES.some((t) => t.kind === 'delivery_note' || t.kind === 'receipt_note')).toBe(false)
    const types = db.prepare('SELECT id, name, kind FROM voucher_types ORDER BY id').all() as { id: number; name: string; kind: string }[]
    expect(types.slice(0, 2)).toEqual([
      { id: 1, name: 'Delivery Note', kind: 'delivery_note' },
      { id: 2, name: 'Receipt Note', kind: 'receipt_note' }
    ])
    expect(types).toHaveLength(2 + DEFAULT_VOUCHER_TYPES.length)
  })

  it('backfills a unique 32-hex uid on every line; moves_stock = 1 everywhere', () => {
    const f = fixture()
    migrate(f.db)
    const rows = f.db.prepare('SELECT line_uid, moves_stock FROM inventory_lines').all() as { line_uid: string | null; moves_stock: number }[]
    expect(rows).toHaveLength(f.lines)
    expect(rows.every((r) => r.line_uid !== null && /^[0-9a-f]{32}$/.test(r.line_uid))).toBe(true)
    expect(new Set(rows.map((r) => r.line_uid)).size).toBe(rows.length)
    expect(rows.every((r) => r.moves_stock === 1)).toBe(true)
    const first = rows[0]!.line_uid
    expect(() => f.db.prepare('UPDATE inventory_lines SET line_uid = ? WHERE rowid = (SELECT MAX(rowid) FROM inventory_lines)').run(first)).toThrow(/UNIQUE/)
    expect(() => f.db.prepare('UPDATE inventory_lines SET moves_stock = 2').run()).toThrow(/CHECK/)
  })

  it("carries serial_numbers over and accepts 'delivered'", () => {
    const f = fixture()
    const before = f.db.prepare('SELECT * FROM serial_numbers').all()
    migrate(f.db)
    expect(f.db.prepare('SELECT * FROM serial_numbers').all()).toEqual(before)
    const line = f.db.prepare('SELECT id, stock_item_id FROM inventory_lines LIMIT 1').get() as { id: number; stock_item_id: number }
    f.db.prepare("INSERT INTO serial_numbers (stock_item_id, serial, status, inward_line_id) VALUES (?, 'S2', 'delivered', ?)").run(line.stock_item_id, line.id)
    expect(() => f.db.prepare("INSERT INTO serial_numbers (stock_item_id, serial, status, inward_line_id) VALUES (?, 'S3', 'lost', ?)").run(line.stock_item_id, line.id)).toThrow(/CHECK/)
    expect(() => f.db.prepare("INSERT INTO serial_numbers (stock_item_id, serial, status, inward_line_id) VALUES (?, 'S2', 'in_stock', ?)").run(line.stock_item_id, line.id)).toThrow(/UNIQUE/)
  })

  it('writes one audit row per migration', () => {
    const f = fixture()
    migrate(f.db)
    const rows = f.db.prepare("SELECT entity_id, after_json FROM audit_log WHERE entity = 'migration' AND entity_id IN (24, 25) ORDER BY entity_id").all() as { entity_id: number; after_json: string }[]
    expect(rows.map((r) => r.entity_id)).toEqual([24, 25])
    const a = JSON.parse(rows[0]!.after_json)
    expect(a).toMatchObject({ migration: 24, voucherKinds: VOUCHER_KINDS.length, lineUidsBackfilled: 2, serialsCarried: 1 })
    expect(a.voucherTypesCreated.map((t: { name: string }) => t.name)).toEqual(['Delivery Challan', 'Receipt Note'])
    expect(JSON.parse(rows[1]!.after_json)).toEqual({ migration: 25, tradeDocTypesSeeded: 3 })
  })

  it('a rebuild broken between DROP and RENAME rolls back to the old schema with FKs on', () => {
    const f = fixture()
    const broken = MIGRATIONS[AT]!.replace('DROP TABLE voucher_types;', 'DROP TABLE voucher_types;\n  INSERT INTO no_such_table VALUES (1);')
    expect(broken).not.toBe(MIGRATIONS[AT])
    expect(() => migrate(f.db, [...MIGRATIONS.slice(0, AT), broken])).toThrow(/no such table/)
    expect(schemaVersion(f.db)).toBe(AT)
    expect((f.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'voucher_types'").get() as { sql: string }).sql).toContain("'physical_stock'")
    expect(f.db.prepare('SELECT * FROM voucher_types ORDER BY id').all()).toEqual(f.types)
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('voucher_kinds', 'voucher_types_new')").get()).toEqual({ n: 0 })
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1)
    // And the real migration still applies afterwards.
    migrate(f.db)
    expect(schemaVersion(f.db)).toBe(MIGRATIONS.length)
  })
})

describe('migration 025 — trade documents and line links', () => {
  it('seeds the three order / quotation series', () => {
    const db = freshDb()
    expect(db.prepare('SELECT name, kind, prefix, is_system FROM trade_doc_types ORDER BY id').all()).toEqual([
      { name: 'Quotation', kind: 'quotation', prefix: 'QT-', is_system: 1 },
      { name: 'Sales Order', kind: 'sales_order', prefix: 'SO-', is_system: 1 },
      { name: 'Purchase Order', kind: 'purchase_order', prefix: 'PO-', is_system: 1 }
    ])
  })

  it('line_links: exactly one side each, one source per target line, cascade from the target, blocked from the source', () => {
    const db = freshDb()
    seedCompany(db, TEST_INFO)
    const vt = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'sales'").get() as { id: number }).id
    const v = (n: string): number => Number(db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-05-01', ?)").run(vt, n).lastInsertRowid)
    const a = v('1')
    const b = v('2')
    const ins = db.prepare('INSERT INTO line_links (link_type, from_voucher_id, from_trade_doc_id, from_line_uid, to_voucher_id, to_trade_doc_id, to_line_uid, qty_milli) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    expect(() => ins.run('fulfil', null, null, 'x', b, null, 'y', 1000)).toThrow(/CHECK/)
    expect(() => ins.run('fulfil', a, null, 'x', null, null, 'y', 1000)).toThrow(/CHECK/)
    expect(() => ins.run('fulfil', a, null, 'x', b, null, 'x', 1000)).toThrow(/CHECK/)
    expect(() => ins.run('swap', a, null, 'x', b, null, 'y', 1000)).toThrow(/CHECK/)
    expect(() => ins.run('fulfil', a, null, 'x', b, null, 'y', 0)).toThrow(/CHECK/)
    ins.run('fulfil', a, null, 'x', b, null, 'y', 1000)
    expect(() => ins.run('fulfil', a, null, 'x2', b, null, 'y', 1000)).toThrow(/UNIQUE/)
    expect(() => db.prepare('DELETE FROM vouchers WHERE id = ?').run(a)).toThrow(/FOREIGN KEY/)
    db.prepare('DELETE FROM vouchers WHERE id = ?').run(b)
    expect(db.prepare('SELECT COUNT(*) AS n FROM line_links').get()).toEqual({ n: 0 })
    db.prepare('DELETE FROM vouchers WHERE id = ?').run(a)
  })

  it('trade_doc_lines cascade with their document; trade_voucher_details with its voucher', () => {
    const db = freshDb()
    seedCompany(db, TEST_INFO)
    const party = (db.prepare('SELECT id FROM ledgers LIMIT 1').get() as { id: number }).id
    const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
    const itemId = Number(db.prepare("INSERT INTO stock_items (name, unit_id) VALUES ('W', ?)").run(unit).lastInsertRowid)
    const doc = Number(db.prepare("INSERT INTO trade_docs (doc_type_id, number, date, party_ledger_id) VALUES (2, 'SO-1', '2025-05-01', ?)").run(party).lastInsertRowid)
    db.prepare("INSERT INTO trade_doc_lines (doc_id, line_uid, stock_item_id, qty_milli, rate_paise, amount) VALUES (?, 'u1', ?, 1000, 100, 100)").run(doc, itemId)
    expect(() => db.prepare("UPDATE trade_docs SET status = 'done' WHERE id = ?").run(doc)).toThrow(/CHECK/)
    db.prepare('DELETE FROM trade_docs WHERE id = ?').run(doc)
    expect(db.prepare('SELECT COUNT(*) AS n FROM trade_doc_lines').get()).toEqual({ n: 0 })
    const dn = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'delivery_note'").get() as { id: number }).id
    const v = Number(db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2025-05-01', '1')").run(dn).lastInsertRowid)
    expect(() => db.prepare("INSERT INTO trade_voucher_details (voucher_id, purpose) VALUES (?, 'gift')").run(v)).toThrow(/CHECK/)
    db.prepare("INSERT INTO trade_voucher_details (voucher_id) VALUES (?)").run(v)
    expect(db.prepare('SELECT purpose FROM trade_voucher_details').get()).toEqual({ purpose: 'supply' })
    db.prepare('DELETE FROM vouchers WHERE id = ?').run(v)
    expect(db.prepare('SELECT COUNT(*) AS n FROM trade_voucher_details').get()).toEqual({ n: 0 })
  })
})
