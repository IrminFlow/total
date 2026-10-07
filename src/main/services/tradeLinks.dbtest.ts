// WP 2.5a line links (design §2.4): invariants I1–I7, the lifecycle matrix, uid stability.
import { describe, it, expect } from 'vitest'
import { deleteVoucher, getVoucher, purgeVoucher, restoreVoucher, saveVoucher, setLockDate } from './vouchers'
import { linksForVoucher, liveLinkQty, openSourceLines } from './tradeLinks'
import { createBatch } from './masters'
import { getFeatures, setFeatures } from './config'
import { dc, grn, item, resave, trade, tradeBooks, uid, typeId } from './tradeFixture.testutil'

const linkRows = (db: ReturnType<typeof tradeBooks>['db']) =>
  db.prepare('SELECT link_type, from_voucher_id, to_voucher_id, qty_milli, reprices FROM line_links ORDER BY id').all()

describe('line uids', () => {
  it('every saved line gets a 32-hex uid that survives alterations', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const v = trade(b, 'sales', '2025-05-01', [{ item: a, qty: 2, amount: 2000 }, { item: a, qty: 1, amount: 1000 }])
    const uids = v.inventory.map((l) => l.lineUid)
    expect(uids.every((u) => /^[0-9a-f]{32}$/.test(u!))).toBe(true)
    expect(new Set(uids).size).toBe(2)
    const again = resave(b.db, v.id, (p) => ({ ...p, narration: 'altered' }))
    expect(again.inventory.map((l) => l.lineUid)).toEqual(uids)
    // Line ids are re-issued, uids are not.
    expect(again.inventory[0]!.id).not.toBe(v.inventory[0]!.id)
  })

  it("a payload can't adopt another voucher's uid, nor use one twice", () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget')
    const first = trade(b, 'sales', '2025-05-01', [{ item: a, qty: 1, amount: 1000 }])
    const stolen = first.inventory[0]!.lineUid!
    const second = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 1000, uid: stolen }])
    expect(second.inventory[0]!.lineUid).not.toBe(stolen)
    const dup = resave(b.db, first.id, (p) => ({ ...p, inventory: [p.inventory![0]!, { ...p.inventory![0]! }] }))
    expect(dup.inventory[0]!.lineUid).toBe(stolen)
    expect(dup.inventory[1]!.lineUid).not.toBe(stolen)
  })
})

describe('allowed pairs and moves_stock', () => {
  it('an invoice drawn from a challan line is non-moving; one drawn from nothing moves stock', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [10, 10000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 4, amount: 4000 }])
    const inv = trade(b, 'sales', '2025-05-03', [{ item: a, qty: 3, amount: 3600, from: uid(b.db, d.id) }, { item: a, qty: 1, amount: 1200 }])
    expect(inv.inventory.map((l) => l.movesStock)).toEqual([false, true])
    expect(inv.inventory[0]!.source).toEqual({ lineUid: uid(b.db, d.id), linkType: 'fulfil' })
    expect(linkRows(b.db)).toEqual([{ link_type: 'fulfil', from_voucher_id: d.id, to_voucher_id: inv.id, qty_milli: 3000, reprices: 0 }])
    // Integrity: moves_stock = 0 ⇔ a fulfil link from a challan / GRN line.
    const bad = b.db.prepare(
      `SELECT COUNT(*) AS n FROM inventory_lines il
       WHERE (il.moves_stock = 0) <> EXISTS (
         SELECT 1 FROM line_links ll JOIN inventory_lines s ON s.line_uid = ll.from_line_uid
         JOIN vouchers sv ON sv.id = s.voucher_id JOIN voucher_types st ON st.id = sv.voucher_type_id
         WHERE ll.to_line_uid = il.line_uid AND ll.link_type = 'fulfil' AND st.kind IN ('delivery_note', 'receipt_note'))`
    ).get()
    expect(bad).toEqual({ n: 0 })
  })

  it('refuses pairs outside the rules, unknown sources and self-links', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [10, 10000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 4, amount: 4000 }])
    // A purchase can't fulfil a delivery challan.
    expect(() => trade(b, 'purchase', '2025-05-02', [{ item: a, qty: 1, amount: 100, from: uid(b.db, d.id) }], { party: b.buyer })).toThrow(/can't fulfil/)
    // A credit note returns a SALES line, not a challan line.
    expect(() => trade(b, 'credit_note', '2025-05-02', [{ item: a, qty: 1, amount: 100, from: uid(b.db, d.id), link: 'return' }])).toThrow(/can't return/)
    expect(() => trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 100, from: 'f'.repeat(32) }])).toThrow(/no longer exists/)
    const s = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 100 }, { item: a, qty: 1, amount: 100 }])
    expect(() => resave(b.db, s.id, (p) => ({
      ...p, inventory: [p.inventory![0]!, { ...p.inventory![1]!, source: { lineUid: s.inventory[0]!.lineUid!, linkType: 'fulfil' } }]
    }))).toThrow(/own lines/)
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM line_links').get()).toEqual({ n: 0 })
  })
})

describe('invariants', () => {
  it('I1 capacity: fulfilment across documents never exceeds the challan line', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }])
    const src = uid(b.db, d.id)
    trade(b, 'sales', '2025-05-02', [{ item: a, qty: 3, amount: 3000, from: src }])
    expect(() => trade(b, 'sales', '2025-05-03', [{ item: a, qty: 3, amount: 3000, from: src }])).toThrow(/only 5 on the line/)
    trade(b, 'sales', '2025-05-03', [{ item: a, qty: 2, amount: 2000, from: src }])
    expect(liveLinkQty(b.db, [src]).get(src)).toEqual({ fulfilMilli: 5000, returnMilli: 0 })
    // A rejection-in GRN shares the challan's capacity (fulfil + return ≤ qty).
    expect(() => grn(b, '2025-05-04', [{ item: a, qty: 1, amount: 1000, from: src, link: 'return' }], { party: b.buyer })).toThrow(/already linked/)
  })

  it('I1 capacity: an invoice line takes fulfilment and returns separately', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const s = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 3, amount: 3000 }])
    const src = uid(b.db, s.id)
    trade(b, 'credit_note', '2025-05-05', [{ item: a, qty: 2, amount: 2000, from: src, link: 'return' }])
    expect(() => trade(b, 'credit_note', '2025-05-06', [{ item: a, qty: 2, amount: 2000, from: src, link: 'return' }])).toThrow(/would be returned/)
  })

  it('I2 same party and same item', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const c = item(b.db, 'Gadget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }])
    expect(() => trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 100, from: uid(b.db, d.id) }], { party: b.buyer2 })).toThrow(/another party/)
    expect(() => trade(b, 'sales', '2025-05-02', [{ item: c, qty: 1, amount: 100, from: uid(b.db, d.id) }])).toThrow(/different item/)
  })

  it('I3 same goods for a non-moving line: godown, batch, serials ⊆ source', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Phone', { serials: true })
    const lot = createBatch(b.db, { stockItemId: a, name: 'L1', mfgDate: null, expiryDate: null }).id
    grn(b, '2025-04-10', [{ item: a, qty: 3, amount: 30000, godown: b.godown, batch: lot, serials: ['P1', 'P2', 'P3'] }])
    const d = dc(b, '2025-05-01', [{ item: a, qty: 2, amount: 24000, godown: b.godown, batch: lot, serials: ['P1', 'P2'] }])
    const src = uid(b.db, d.id)
    const base = { item: a, qty: 1, amount: 12000, from: src }
    expect(() => trade(b, 'sales', '2025-05-02', [{ ...base, godown: b.godown2, batch: lot, serials: ['P1'] }])).toThrow(/godown must match/)
    expect(() => trade(b, 'sales', '2025-05-02', [{ ...base, godown: b.godown, batch: null, serials: ['P1'] }])).toThrow(/batch must match/)
    expect(() => trade(b, 'sales', '2025-05-02', [{ ...base, godown: b.godown, batch: lot, serials: ['P3'] }])).toThrow(/P3 is not on/)
    const inv = trade(b, 'sales', '2025-05-02', [{ ...base, godown: b.godown, batch: lot, serials: ['P1'] }])
    // Serial statuses: P1 invoiced → sold; P2 still only delivered; P3 in stock.
    const status = Object.fromEntries((b.db.prepare('SELECT serial, status FROM serial_numbers').all() as { serial: string; status: string }[]).map((r) => [r.serial, r.status]))
    expect(status).toEqual({ P1: 'sold', P2: 'delivered', P3: 'in_stock' })
    // The invoice still names (prints) its serial.
    expect(getVoucher(b.db, inv.id)!.inventory[0]!.serials).toEqual(['P1'])
    deleteVoucher(b.db, inv.id)
    expect((b.db.prepare("SELECT status FROM serial_numbers WHERE serial = 'P1'").get() as { status: string }).status).toBe('delivered')
  })

  it('I4 link qty is the target line qty', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }])
    const inv = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 2, amount: 2400, from: uid(b.db, d.id) }])
    resave(b.db, inv.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, qtyMilli: 4000 }] }))
    expect((b.db.prepare('SELECT qty_milli FROM line_links').get() as { qty_milli: number }).qty_milli).toBe(4000)
  })

  it('I5 a binned / optional / short-closed source takes no new links; existing links survive a close', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }])
    const src = uid(b.db, d.id)
    const inv = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 1000, from: src }])
    b.db.prepare("INSERT INTO trade_voucher_details (voucher_id, purpose, closed_at) VALUES (?, 'supply', datetime('now')) ON CONFLICT(voucher_id) DO UPDATE SET closed_at = datetime('now')").run(d.id)
    expect(() => trade(b, 'sales', '2025-05-03', [{ item: a, qty: 1, amount: 1000, from: src }])).toThrow(/is closed/)
    resave(b.db, inv.id, (p) => ({ ...p, narration: 'still fine after the close' }))
    const opt = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }], { optional: true })
    expect(() => trade(b, 'sales', '2025-05-03', [{ item: a, qty: 1, amount: 1000, from: uid(b.db, opt.id) }])).toThrow(/optional/)
    const d2 = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }])
    const src2 = uid(b.db, d2.id)
    deleteVoucher(b.db, d2.id)
    expect(() => trade(b, 'sales', '2025-05-03', [{ item: a, qty: 1, amount: 1000, from: src2 }])).toThrow(/in the bin/)
  })

  it('I6 no links on optional vouchers or stock journals', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }])
    expect(() => trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 1000, from: uid(b.db, d.id) }], { optional: true })).toThrow(/optional/)
    expect(() => saveVoucher(b.db, {
      voucherTypeId: typeId(b.db, 'stock_journal'), date: '2025-05-02', partyLedgerId: null, narration: null, reference: null, lines: [],
      inventory: [{ stockItemId: a, godownId: null, qtyMilli: 1000, ratePaise: 0, amount: 0, direction: 'out', source: { lineUid: uid(b.db, d.id), linkType: 'fulfil' } }]
    })).toThrow(/cannot be linked/)
    // Making a linked invoice optional later is refused too.
    const inv = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 1000, from: uid(b.db, d.id) }])
    expect(() => resave(b.db, inv.id, (p) => ({ ...p, isOptional: true }))).toThrow(/optional/)
  })

  it('I7 a target dated before its source saves with a warning', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-10', [{ item: a, qty: 5, amount: 5000 }])
    const inv = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 1000, from: uid(b.db, d.id) }])
    expect(inv.warnings.linkDates).toEqual([expect.stringMatching(/dated before Delivery Note 1 line 1/)])
    const plain = trade(b, 'sales', '2025-05-12', [{ item: a, qty: 1, amount: 1000 }])
    expect(plain.warnings).toEqual({ negativeStock: [], creditLimitExceeded: null })
  })
})

describe('lifecycle', () => {
  function chain() {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 5, amount: 5000 }, { item: a, qty: 2, amount: 2000 }])
    const src = uid(b.db, d.id)
    const inv = trade(b, 'sales', '2025-05-02', [{ item: a, qty: 3, amount: 3600, from: src }])
    return { b, a, d, src, inv }
  }

  it('edit target: its links are rebuilt from the input', () => {
    const { b, d, inv } = chain()
    resave(b.db, inv.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, source: { lineUid: uid(b.db, d.id, 1), linkType: 'fulfil' }, qtyMilli: 2000 }] }))
    expect(linksForVoucher(b.db, inv.id).upstream.map((r) => [r.otherLabel, r.qtyMilli])).toEqual([['Delivery Note 1 line 2', 2000]])
    resave(b.db, inv.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, source: null }] }))
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM line_links').get()).toEqual({ n: 0 })
    expect(getVoucher(b.db, inv.id)!.inventory[0]!.movesStock).toBe(true)
  })

  it('edit source: linked lines must stay (item, qty ≥ linked; godown/batch for non-moving targets)', () => {
    const { b, d, inv, src } = chain()
    expect(() => resave(b.db, d.id, (p) => ({ ...p, inventory: [p.inventory![1]!] }))).toThrow(/line 1 is linked to Sales 1 — it can't be removed; bin that first/)
    expect(() => resave(b.db, d.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, qtyMilli: 2000 }, p.inventory![1]!] }))).toThrow(/linked to Sales 1/)
    expect(() => resave(b.db, d.id, (p) => ({ ...p, inventory: [{ ...p.inventory![0]!, godownId: b.godown }, p.inventory![1]!] }))).toThrow(/godown can't change/)
    expect(() => resave(b.db, d.id, (p) => ({ ...p, partyLedgerId: b.buyer2 }))).toThrow(/party can't change/)
    // A uid-dropping editor makes the line look new — refused, the safe failure.
    expect(() => resave(b.db, d.id, (p) => ({ ...p, inventory: p.inventory!.map(({ lineUid: _u, ...l }) => l) }))).toThrow(/can't be removed/)
    // Fine: more quantity, a new rate, a narration.
    resave(b.db, d.id, (p) => ({ ...p, narration: 'n', inventory: [{ ...p.inventory![0]!, qtyMilli: 6000, amount: 6000 }, p.inventory![1]!] }))
    expect(uid(b.db, d.id)).toBe(src)
    expect(getVoucher(b.db, inv.id)!.inventory[0]!.source?.lineUid).toBe(src)
  })

  it('bin source refused while live; bin target makes the quantity pending again; restore re-checks', () => {
    const { b, a, d, src, inv } = chain()
    expect(() => deleteVoucher(b.db, d.id)).toThrow(/is linked to Sales 1; bin that first/)
    deleteVoucher(b.db, inv.id)
    expect(liveLinkQty(b.db, [src]).get(src)).toEqual({ fulfilMilli: 0, returnMilli: 0 })
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales', linkType: 'fulfil' }).map((l) => l.pendingMilli)).toEqual([5000, 2000])
    // Capacity taken meanwhile → restore refused.
    const other = trade(b, 'sales', '2025-05-03', [{ item: a, qty: 4, amount: 4000, from: src }])
    expect(() => restoreVoucher(b.db, inv.id)).toThrow(/taken that quantity/)
    expect(getVoucher(b.db, inv.id)!.deletedAt).not.toBeNull()
    deleteVoucher(b.db, other.id)
    restoreVoucher(b.db, inv.id)
    expect(liveLinkQty(b.db, [src]).get(src)!.fulfilMilli).toBe(3000)
    // Bin the target, then the source (now allowed), then restoring the target is refused.
    deleteVoucher(b.db, inv.id)
    deleteVoucher(b.db, d.id)
    expect(() => restoreVoucher(b.db, inv.id)).toThrow(/is in the bin — restore it first/)
    restoreVoucher(b.db, d.id) // restoring a source is always allowed
    restoreVoucher(b.db, inv.id)
  })

  it('purge: a target purge cascades its links; a source purge is blocked by any link', () => {
    const { b, d, inv } = chain()
    deleteVoucher(b.db, inv.id)
    deleteVoucher(b.db, d.id)
    expect(() => purgeVoucher(b.db, d.id)).toThrow(/purge those first/)
    purgeVoucher(b.db, inv.id)
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM line_links').get()).toEqual({ n: 0 })
    purgeVoucher(b.db, d.id)
  })

  it('post-dated targets count against capacity', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 2, amount: 2000 }])
    trade(b, 'sales', '2025-05-20', [{ item: a, qty: 2, amount: 2000, from: uid(b.db, d.id) }], { postDated: true })
    expect(() => trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 1000, from: uid(b.db, d.id) }])).toThrow(/only 2 on the line/)
  })

  it('links:forVoucher shows both directions', () => {
    const { b, d, inv } = chain()
    const up = linksForVoucher(b.db, inv.id)
    expect(up.upstream).toHaveLength(1)
    expect(up.upstream[0]).toMatchObject({ otherVoucherId: d.id, otherLabel: 'Delivery Note 1 line 1', qtyMilli: 3000, live: true, linkType: 'fulfil' })
    const down = linksForVoucher(b.db, d.id)
    expect(down.downstream[0]).toMatchObject({ otherVoucherId: inv.id, otherLabel: 'Sales 1 line 1', live: true })
    deleteVoucher(b.db, inv.id)
    expect(linksForVoucher(b.db, d.id).downstream[0]!.live).toBe(false)
  })

  it('links:openSourceLines lists a party\'s open lines for the target kind, minus what is linked', () => {
    const { b, d, src } = chain()
    const lines = openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales', linkType: 'fulfil' })
    expect(lines.map((l) => [l.lineUid === src, l.qtyMilli, l.doneMilli, l.pendingMilli])).toEqual([[true, 5000, 3000, 2000], [false, 2000, 0, 2000]])
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer2, targetKind: 'sales', linkType: 'fulfil' })).toEqual([])
    // Altering the invoice: its own links don't count against it.
    const inv = (b.db.prepare('SELECT to_voucher_id AS id FROM line_links').get() as { id: number }).id
    expect(openSourceLines(b.db, { partyLedgerId: b.buyer, targetKind: 'sales', linkType: 'fulfil', excludeVoucherId: inv })[0]!.pendingMilli).toBe(5000)
    expect(lines[0]!.voucherId).toBe(d.id)
  })

  it('the lock date: a target in the locked period is refused as usual', () => {
    const { b, inv } = chain()
    setLockDate(b.db, '2025-05-31')
    expect(() => deleteVoucher(b.db, inv.id)).toThrow(/locked/)
  })
})

describe('stock notes', () => {
  it('a challan / GRN keeps its purpose; DC purposes and GRN purposes differ', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    const d = dc(b, '2025-05-01', [{ item: a, qty: 1, amount: 100 }])
    expect(getVoucher(b.db, d.id)!.trade).toEqual({ purpose: 'supply' })
    const j = dc(b, '2025-05-01', [{ item: a, qty: 1, amount: 100 }], { purpose: 'job_work' })
    expect(resave(b.db, j.id, (p) => ({ ...p, trade: undefined })).trade).toEqual({ purpose: 'job_work' })
    expect(grn(b, '2025-05-01', [{ item: a, qty: 1, amount: 100 }]).trade).toEqual({ purpose: 'purchase' })
    expect(() => grn(b, '2025-05-01', [{ item: a, qty: 1, amount: 100 }], { purpose: 'approval' })).toThrow(/purpose/)
    expect(trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 100 }]).trade).toBeNull()
  })

  it('a challan never touches the party outstanding or the credit limit', () => {
    const b = tradeBooks()
    const a = item(b.db, 'Widget', { opening: [20, 20000] })
    trade(b, 'sales', '2025-05-01', [{ item: a, qty: 1, amount: 100 }])
    // The buyer is now over its limit and the limit is enforced: a sale would be refused…
    b.db.prepare('UPDATE ledgers SET credit_limit = 1 WHERE id = ?').run(b.buyer)
    setFeatures(b.db, { ...getFeatures(b.db), enforceCreditLimit: true })
    expect(() => trade(b, 'sales', '2025-05-02', [{ item: a, qty: 1, amount: 100 }])).toThrow(/Credit limit/)
    // …but a challan posts nothing, so it goes through without a warning.
    const d = dc(b, '2025-05-02', [{ item: a, qty: 1, amount: 50000 }])
    expect(d.warnings.creditLimitExceeded).toBeNull()
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM voucher_lines WHERE voucher_id = ?').get(d.id)).toEqual({ n: 0 })
  })
})
