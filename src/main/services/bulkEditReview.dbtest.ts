// WP 6.4 review round (PR #65): a bulk party change never leaves bills, links, TDS or GST wrong;
// voucher numbers never duplicate (renumbered in an auto series, refused in a manual one, undo
// refused when the old number was reissued); an IRN pins the number; the save's warnings reach
// the result; the selection is re-validated against the period; tagged tax ledgers keep their group.
import { describe, expect, it } from 'vitest'
import { seededDb } from '../db/testdb'
import type { DB } from '../db/connection'
import type { VoucherKind } from '@shared/domain'
import { createLedger, createVoucherType } from './masters'
import { getVoucher, saveVoucher } from './vouchers'
import { applyBulk, undoBulk } from './bulkEdit'
import { voucherToPayload } from '@shared/voucherEdit'

const group = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const typeId = (db: DB, kind: VoucherKind): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
const header = {
  partyLedgerId: null, narration: null, reference: null, instrumentNo: null, instrumentDate: null, transporterId: null,
  vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null, inventory: [], billRefs: [], tds: null
}

function books(db: DB) {
  const led = (name: string, g: string, extra: Record<string, unknown> = {}): number => createLedger(db, { name, groupId: group(db, g), ...extra }).id
  const rent = led('Rent', 'Indirect Expenses')
  const cash = (db.prepare("SELECT id FROM ledgers WHERE name = 'Cash'").get() as { id: number }).id
  const sales = led('Sales', 'Sales Accounts')
  const alpha = led('Alpha Traders', 'Sundry Debtors')
  const beta = led('Beta Stores', 'Sundry Debtors')
  const sale = (date: string, party: number, amount = 5000, billRefs: { kind: 'new' | 'against'; name: string; amount: number; dueDate: null }[] = []): number =>
    saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'sales'), date, partyLedgerId: party, narration: 'Sale', billRefs,
      lines: [{ ledgerId: party, drCr: 'dr', amount, costAllocations: [] }, { ledgerId: sales, drCr: 'cr', amount, costAllocations: [] }]
    }).id
  const journal = (date: string, voucherTypeId = typeId(db, 'journal'), number?: string) =>
    saveVoucher(db, {
      ...header, voucherTypeId, date, number, narration: date,
      lines: [{ ledgerId: rent, drCr: 'dr', amount: 100, costAllocations: [] }, { ledgerId: cash, drCr: 'cr', amount: 100, costAllocations: [] }]
    })
  return { led, rent, cash, sales, alpha, beta, sale, journal }
}
const party = (db: DB, ids: number[], to: number) => applyBulk(db, { target: 'voucher', ids, change: { field: 'party', from: null, to } })

describe('party change safety', () => {
  it('refuses when the new party changes the GST supply type; allows a same-state party', () => {
    const db = seededDb()
    const b = books(db)
    const cgst = b.led('CGST', 'Duties & Taxes', { taxType: 'cgst' })
    const sgst = b.led('SGST', 'Duties & Taxes', { taxType: 'sgst' })
    const mh = b.led('Mumbai Stores', 'Sundry Debtors', { stateCode: '27' })
    const mh2 = b.led('Pune Stores', 'Sundry Debtors', { stateCode: '27' })
    const ka = b.led('Bengaluru Stores', 'Sundry Debtors', { stateCode: '29' })
    const taxed = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'sales'), date: '2025-06-01', partyLedgerId: mh, narration: 'GST sale',
      lines: [
        { ledgerId: mh, drCr: 'dr', amount: 11800, costAllocations: [] },
        { ledgerId: b.sales, drCr: 'cr', amount: 10000, costAllocations: [] },
        { ledgerId: cgst, drCr: 'cr', amount: 900, costAllocations: [] },
        { ledgerId: sgst, drCr: 'cr', amount: 900, costAllocations: [] }
      ]
    }).id
    expect(party(db, [taxed], ka).records[0]!.reason).toMatch(/changes the GST supply type/)
    expect(party(db, [taxed], mh2).records[0]!.status).toBe('applied')
    expect(getVoucher(db, taxed)!.partyLedgerId).toBe(mh2)
  })

  it('refuses a voucher settling bills, a bill another voucher settles; moves its own unsettled bills', () => {
    const db = seededDb()
    const b = books(db)
    const inv = b.sale('2025-06-01', b.alpha, 5000, [{ kind: 'new', name: 'INV-9', amount: 5000, dueDate: null }])
    const inv2 = b.sale('2025-06-02', b.alpha, 3000, [{ kind: 'new', name: 'INV-10', amount: 3000, dueDate: null }])
    const rcpt = saveVoucher(db, {
      ...header, voucherTypeId: typeId(db, 'receipt'), date: '2025-06-05', partyLedgerId: b.alpha, narration: 'Paid',
      lines: [{ ledgerId: b.cash, drCr: 'dr', amount: 5000, costAllocations: [] }, { ledgerId: b.alpha, drCr: 'cr', amount: 5000, costAllocations: [] }],
      billRefs: [{ kind: 'against', name: 'INV-9', amount: 5000, dueDate: null }]
    }).id
    const r = party(db, [rcpt, inv, inv2], b.beta).records
    expect(r.find((x) => x.id === rcpt)!.reason).toMatch(/settles bills of the current party/)
    expect(r.find((x) => x.id === inv)!.reason).toBe('Bill INV-9 already has payments or notes against it — move those first')
    expect(r.find((x) => x.id === inv2)!.status).toBe('applied')
    expect(db.prepare('SELECT party_ledger_id AS p FROM bill_refs WHERE voucher_id = ?').get(inv2)).toEqual({ p: b.beta })
  })

  it('refuses vouchers with trade links or a TDS entry', () => {
    const db = seededDb()
    const b = books(db)
    const source = b.sale('2025-05-01', b.alpha)
    const linked = b.sale('2025-06-01', b.alpha)
    db.prepare("INSERT INTO line_links (link_type, from_voucher_id, from_line_uid, to_voucher_id, to_line_uid, qty_milli) VALUES ('fulfil', ?, 'src-1', ?, 'dst-1', 1000)").run(source, linked)
    const tds = b.sale('2025-06-02', b.alpha)
    const section = (db.prepare("SELECT id FROM tds_sections WHERE kind = 'tds' ORDER BY id LIMIT 1").get() as { id: number }).id
    db.prepare('INSERT INTO tds_entries (voucher_id, section_id, party_ledger_id, base_amount, tds_amount) VALUES (?, ?, ?, 50000, 500)').run(tds, section, b.alpha)
    const r = party(db, [linked, tds], b.beta).records
    expect(r.find((x) => x.id === linked)!.reason).toMatch(/linked to orders \/ challans/)
    expect(r.find((x) => x.id === tds)!.reason).toBe('It carries a TDS entry for the current party')
  })

  it('surfaces the save warnings (credit limit) on the record', () => {
    const db = seededDb()
    const b = books(db)
    const inv = b.sale('2025-06-01', b.alpha, 50000)
    db.prepare('UPDATE ledgers SET credit_limit = 1000 WHERE id = ?').run(b.beta)
    const r = party(db, [inv], b.beta).records[0]!
    expect(r.status).toBe('applied')
    expect(r.warnings).toEqual(['Over the credit limit of Beta Stores'])
  })
})

describe('voucher numbers', () => {
  it('a date moved into another financial year where its number is taken is renumbered (reported)', () => {
    const db = seededDb()
    const b = books(db)
    const series = createVoucherType(db, { name: 'Yearly journal', kind: 'journal', numbering: 'auto', prefix: '', suffix: '', padWidth: 0, restartFy: true })
    const old = b.journal('2025-05-01', series.id)
    const next = b.journal('2026-05-01', series.id)
    expect([old.number, next.number]).toEqual(['1', '1'])
    const res = applyBulk(db, { target: 'voucher', ids: [old.id], change: { field: 'date', date: '2026-06-01' } })
    expect(res.records[0]).toMatchObject({ status: 'applied', warnings: ['Renumbered 1 → 2'] })
    expect(getVoucher(db, old.id)!.number).toBe('2')
    const keep = applyBulk(db, { target: 'voucher', ids: [next.id], change: { field: 'date', date: '2026-05-15' } })
    expect(keep.records[0]!.warnings).toEqual([])
    expect(getVoucher(db, next.id)!.number).toBe('1')
  })

  it('a manual series refuses a clashing number', () => {
    const db = seededDb()
    const b = books(db)
    const a = createVoucherType(db, { name: 'Manual A', kind: 'journal', numbering: 'manual', prefix: '', suffix: '', padWidth: 0, restartFy: false })
    const m = createVoucherType(db, { name: 'Manual B', kind: 'journal', numbering: 'manual', prefix: '', suffix: '', padWidth: 0, restartFy: false })
    const ja = b.journal('2025-06-01', a.id, 'M-1').id
    b.journal('2025-06-01', m.id, 'M-1')
    const res = applyBulk(db, { target: 'voucher', ids: [ja], change: { field: 'voucherType', voucherTypeId: m.id } })
    expect(res.records[0]).toMatchObject({ status: 'refused', reason: 'Number M-1 is already used by another Manual B voucher' })
  })

  it('undo after a type change refuses when the vacated number has been reissued', () => {
    const db = seededDb()
    const b = books(db)
    const a = createVoucherType(db, { name: 'Series A', kind: 'journal', numbering: 'auto', prefix: 'A/', suffix: '', padWidth: 0, restartFy: false })
    const z = createVoucherType(db, { name: 'Series Z', kind: 'journal', numbering: 'auto', prefix: 'Z/', suffix: '', padWidth: 0, restartFy: false })
    const first = b.journal('2025-06-01', a.id)
    expect(first.number).toBe('A/1')
    const res = applyBulk(db, { target: 'voucher', ids: [first.id], change: { field: 'voucherType', voucherTypeId: z.id } })
    expect(res.records[0]!.warnings).toEqual(['Renumbered A/1 → Z/1'])
    expect(b.journal('2025-06-02', a.id).number).toBe('A/1')
    const undo = undoBulk(db, res.batchId!)
    expect(undo.records[0]!.status).toBe('undo_refused')
    expect(undo.records[0]!.reason).toMatch(/old number A\/1 \(Series A\) has been used by another voucher since/)
    expect(getVoucher(db, first.id)!.number).toBe('Z/1')
  })

  it('an invoice with an IRN keeps its number and type — bulk and single edit', () => {
    const db = seededDb()
    const b = books(db)
    const inv = b.sale('2025-06-01', b.alpha)
    db.prepare("UPDATE vouchers SET irn = 'abc123def4567890' WHERE id = ?").run(inv)
    const series = createVoucherType(db, { name: 'Export sales', kind: 'sales', numbering: 'auto', prefix: 'EX/', suffix: '', padWidth: 0, restartFy: true })
    const res = applyBulk(db, { target: 'voucher', ids: [inv], change: { field: 'voucherType', voucherTypeId: series.id } })
    expect(res.records[0]!.reason).toMatch(/has an e-invoice IRN/)
    const v = getVoucher(db, inv)!
    expect(() => saveVoucher(db, { ...voucherToPayload(v), number: '99' }, inv)).toThrow(/has an e-invoice IRN/)
    expect(applyBulk(db, { target: 'voucher', ids: [inv], change: { field: 'narration', mode: 'replace', text: 'ok' } }).applied).toBe(1)
  })
})

describe('selection re-validated, tagged ledgers', () => {
  it('refuses vouchers no longer in the period the list showed', () => {
    const db = seededDb()
    const b = books(db)
    const inside = b.journal('2025-06-01').id
    const outside = b.journal('2025-08-01').id
    const res = applyBulk(db, {
      target: 'voucher', ids: [inside, outside], change: { field: 'narration', mode: 'replace', text: 'x' }, scope: { from: '2025-06-01', to: '2025-06-30' }
    })
    expect(res.records.find((r) => r.id === outside)!.reason).toBe('No longer in the period shown (2025-06-01 to 2025-06-30)')
    expect(res.applied).toBe(1)
  })

  it('a GST component ledger keeps its group', () => {
    const db = seededDb()
    const b = books(db)
    const cgst = b.led('CGST Out', 'Duties & Taxes', { taxType: 'cgst' })
    const res = applyBulk(db, { target: 'ledger', ids: [cgst], change: { field: 'group', groupId: group(db, 'Indirect Expenses') } })
    expect(res.records[0]!.reason).toBe('It is a CGST ledger — change its group in the ledger itself')
  })
})
