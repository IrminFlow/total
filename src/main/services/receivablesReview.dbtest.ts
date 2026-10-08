// WP 4.2 review fixes: stable bill identity for interest (renumbering never re-opens a charged
// period), interest GST following the original invoice's GSTR-1 class (SEZ / export with and
// without payment, place-of-supply override, multi-rate with cess, IGST) and agreeing exactly with
// what GSTR-1 reports for the note, opening-balance bills charged from their true origin across a
// year end, the "creates new credit" credit-hold rule on every path, interest notes immutable,
// output-tax ledgers only, date validation, the SAC setting, ledger-delete audit, and the
// missing coverage (part-paid, leap year, grace across a year end, statement with an opening).
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./pdf', () => ({
  htmlToPdf: async (html: string) => Buffer.from(`%PDF-test ${html.length}`),
  writeExportPdf: async () => '/dev/null'
}))

import type { DB } from '../db/connection'
import { seededDb, TEST_INFO } from '../db/testdb'
import type { CompanyInfo } from '@shared/domain'
import { computeGst } from '@shared/gst/calc'
import { simpleInterest } from '@shared/receivables/interest'
import { createLedger, deleteLedger } from './masters'
import { saveVoucher, getVoucher, CREDIT_HOLD_PREFIX, INTEREST_NOTE_IMMUTABLE } from './vouchers'
import { ledgerStatement } from './reports'
import { extractOutwardDocs } from './gst'
import { counterCheckout } from './counter'
import { pricingFixture } from './pricingFixture.testutil'
import { dc, item, tradeBooks } from './tradeFixture.testutil'
import { inboxDir, processInboxFile } from './agentBridge'
import * as rx from './receivables'

const COMPANY: CompanyInfo = { ...TEST_INFO, gstin: '27AAACT1234K1Z5', gstRegistrationType: 'regular' }

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-rx-review-'))
})

const groupId = (db: DB, name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
const vtId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id

interface Books { db: DB; s18: number; s28c: number; s5: number; cgst: number; sgst: number; igst: number; cess: number; bank: number }

function books(): Books {
  const db = seededDb()
  const g = (n: string) => groupId(db, n)
  const s18 = createLedger(db, { name: 'Services 18', groupId: g('Sales Accounts'), gstRate: 18 }).id
  const s28c = createLedger(db, { name: 'Services 28 + cess', groupId: g('Sales Accounts'), gstRate: 28 }).id
  db.prepare('UPDATE ledgers SET cess_rate = 12 WHERE id = ?').run(s28c)
  const s5 = createLedger(db, { name: 'Services 5', groupId: g('Sales Accounts'), gstRate: 5 }).id
  return {
    db, s18, s28c, s5,
    cgst: createLedger(db, { name: 'Output CGST', groupId: g('Duties & Taxes'), taxType: 'cgst' }).id,
    sgst: createLedger(db, { name: 'Output SGST', groupId: g('Duties & Taxes'), taxType: 'sgst' }).id,
    igst: createLedger(db, { name: 'Output IGST', groupId: g('Duties & Taxes'), taxType: 'igst' }).id,
    cess: createLedger(db, { name: 'Output Cess', groupId: g('Duties & Taxes'), taxType: 'cess' }).id,
    bank: createLedger(db, { name: 'HDFC Bank', groupId: g('Bank Accounts') }).id
  }
}

function party(b: Books, name: string, opts: { state?: string | null; exportType?: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop' | null; opening?: number; creditDays?: number; graceDays?: number } = {}): number {
  return createLedger(b.db, {
    name, groupId: groupId(b.db, 'Sundry Debtors'), stateCode: opts.state === undefined ? '27' : opts.state, exportType: opts.exportType ?? null,
    openingBalance: opts.opening ?? 0, creditDays: opts.creditDays ?? 30, interestRateBp: 1800, interestGraceDays: opts.graceDays ?? 0
  }).id
}

/** A service invoice: taxable per sales ledger, tax as the GST engine computes it (posted lines
 *  don't drive the interest — the invoice's items and class do). */
function invoice(b: Books, partyId: number, date: string, parts: [ledgerId: number, taxable: number][], opts: { number?: string; posOverride?: string; billRef?: string } = {}): number {
  const total = parts.reduce((s, [, t]) => s + t, 0)
  return saveVoucher(b.db, {
    voucherTypeId: vtId(b.db, 'sales'), date, number: opts.number, partyLedgerId: partyId, posOverride: opts.posOverride ?? null,
    lines: [{ ledgerId: partyId, drCr: 'dr', amount: total }, ...parts.map(([l, t]) => ({ ledgerId: l, drCr: 'cr' as const, amount: t }))],
    billRefs: opts.billRef ? [{ kind: 'new', name: opts.billRef, amount: total, dueDate: null }] : []
  }).id
}

function receipt(b: Books, partyId: number, date: string, amount: number): void {
  saveVoucher(b.db, { voucherTypeId: vtId(b.db, 'receipt'), date, partyLedgerId: partyId, lines: [{ ledgerId: b.bank, drCr: 'dr', amount }, { ledgerId: partyId, drCr: 'cr', amount }] })
}

const taxType = (db: DB, id: number): string | null => (db.prepare('SELECT tax_type AS t FROM ledgers WHERE id = ?').get(id) as { t: string | null }).t

/** The note's tax lines by type, the GSTR-1 document for it, and the stored per-bill GST. */
function noteVsGstr1(db: DB, noteId: number) {
  const v = getVoucher(db, noteId)!
  const lines = { cgst: 0, sgst: 0, igst: 0, cess: 0 }
  for (const l of v.lines) {
    const t = taxType(db, l.ledgerId) as keyof typeof lines | null
    if (t && l.drCr === 'cr') lines[t] += l.amount
  }
  const doc = extractOutwardDocs(db, COMPANY, v.date, v.date).find((d) => d.voucherId === noteId)!
  const reported = { cgst: 0, sgst: 0, igst: 0, cess: 0 }
  for (const i of doc.items) for (const k of ['cgst', 'sgst', 'igst', 'cess'] as const) reported[k] += i[k]
  const stored = (db.prepare('SELECT COALESCE(SUM(gst_paise), 0) AS g FROM interest_charges WHERE debit_note_voucher_id = ?').get(noteId) as { g: number }).g
  const dr = v.lines.filter((l) => l.drCr === 'dr').reduce((s, l) => s + l.amount, 0)
  const cr = v.lines.filter((l) => l.drCr === 'cr').reduce((s, l) => s + l.amount, 0)
  return { lines, reported, stored, doc, v, balanced: dr === cr }
}

const sum4 = (t: { cgst: number; sgst: number; igst: number; cess: number }): number => t.cgst + t.sgst + t.igst + t.cess

describe('1. a bill keeps its identity when renumbered', () => {
  it('charge → renumber the invoice → nothing more to charge for that period', () => {
    const b = books()
    const p = party(b, 'Renumbered Co')
    const inv = invoice(b, p, '2026-04-01', [[b.s18, 100_000]], { number: 'INV-1' })
    rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
    const v = getVoucher(b.db, inv)!
    saveVoucher(b.db, { ...v, number: 'INV-1-RENUMBERED' } as never, inv)
    expect(rx.interestPreview(b.db, COMPANY, '2026-06-05')).toEqual([])
    expect(rx.interestPreview(b.db, COMPANY, '2026-06-10').map((r) => [r.billRef, r.billKey, r.from])).toEqual([['INV-1-RENUMBERED', `v:${inv}`, '2026-06-06']])
  })

  it('charge → rename the bill ref → nothing more to charge', () => {
    const b = books()
    const p = party(b, 'Renamed Ref Co')
    const inv = invoice(b, p, '2026-04-01', [[b.s18, 100_000]], { billRef: 'BILL-A' })
    rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
    const v = getVoucher(b.db, inv)!
    saveVoucher(b.db, { ...v, billRefs: v.billRefs.map((r) => ({ ...r, name: 'BILL-B' })) } as never, inv)
    expect(rx.interestPreview(b.db, COMPANY, '2026-06-05')).toEqual([])
  })

  it('row keys are unique across parties (opening bills of two parties)', () => {
    const b = books()
    party(b, 'Opening One', { opening: 50_000 })
    party(b, 'Opening Two', { opening: 50_000 })
    const rows = rx.interestPreview(b.db, COMPANY, '2026-03-31', undefined, false)
    expect(rows.map((r) => r.billKey)).toEqual(['o:Opening', 'o:Opening'])
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })
})

describe('2. interest GST follows the original invoice and equals what GSTR-1 reports', () => {
  const run = (exportType: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop' | null, state: string | null, opts: { posOverride?: string; parts?: (b: Books) => [number, number][] } = {}) => {
    const b = books()
    const p = party(b, 'Customer', { state, exportType })
    invoice(b, p, '2026-04-01', opts.parts ? opts.parts(b) : [[b.s18, 100_000]], { posOverride: opts.posOverride })
    const res = rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
    expect(res.notes).toHaveLength(1)
    return { b, res, ...noteVsGstr1(b.db, res.voucherId) }
  }

  it('SEZ with payment of tax → IGST, as GSTR-1 reports it', () => {
    const r = run('sez_wp', '27')
    expect(r.lines.cgst + r.lines.sgst).toBe(0)
    expect(r.lines.igst).toBe(computeGst(r.res.interestPaise, 18, 'inter').igst)
    expect(r.reported).toEqual(r.lines)
    expect(r.doc.invTyp).toBe('SEWP')
    expect(r.stored).toBe(sum4(r.lines))
    expect(r.balanced).toBe(true)
  })

  it('SEZ / export without payment of tax → no tax, flagged; GSTR-1 reports none', () => {
    for (const t of ['sez_wop', 'exp_wop'] as const) {
      const b = books()
      const p = party(b, 'Zero', { state: t === 'sez_wop' ? '27' : null, exportType: t })
      invoice(b, p, '2026-04-01', [[b.s18, 100_000]])
      const [row] = rx.interestPreview(b.db, COMPANY, '2026-06-05')
      expect(row!.zeroTax).toBe(true)
      expect(row!.warning).toMatch(/without payment/)
      const res = rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
      const r = noteVsGstr1(b.db, res.voucherId)
      expect(sum4(r.lines)).toBe(0)
      expect(sum4(r.reported)).toBe(0)
      expect(r.stored).toBe(0)
    }
  })

  it('export with payment of tax → IGST', () => {
    const r = run('exp_wp', null)
    expect(r.lines.igst).toBeGreaterThan(0)
    expect(r.reported).toEqual(r.lines)
    expect(r.doc.invTyp).toBe('EXPWP')
  })

  it("the invoice's place-of-supply override carries onto the note (intra party, inter supply)", () => {
    const r = run(null, '27', { posOverride: '29' })
    expect(r.v.posOverride).toBe('29')
    expect(r.lines.igst).toBeGreaterThan(0)
    expect(r.lines.cgst).toBe(0)
    expect(r.doc.pos).toBe('29')
    expect(r.reported).toEqual(r.lines)
  })

  it('multi-rate with cess (intra): one line per class, cess included, equal to GSTR-1 and the stored figures', () => {
    const r = run(null, '27', { parts: (b) => [[b.s18, 60_000], [b.s28c, 30_000], [b.s5, 10_000]] })
    expect(r.lines.cess).toBeGreaterThan(0)
    expect(r.lines.igst).toBe(0)
    expect(r.reported).toEqual(r.lines)
    expect(r.stored).toBe(sum4(r.lines))
    const names = r.v.lines.map((l) => (r.b.db.prepare('SELECT name FROM ledgers WHERE id = ?').get(l.ledgerId) as { name: string }).name)
    expect(names).toEqual(expect.arrayContaining(['Interest on Overdue Bills @ 28% + cess 12%', 'Interest on Overdue Bills @ 18%', 'Interest on Overdue Bills @ 5%']))
  })

  it('IGST for an inter-state party', () => {
    const r = run(null, '29')
    expect(r.lines.igst).toBe(computeGst(r.res.interestPaise, 18, 'inter').igst)
    expect(r.reported).toEqual(r.lines)
  })

  it('stored per-bill GST equals the posted tax exactly on a multi-bill note', () => {
    const b = books()
    const p = party(b, 'Many Bills')
    for (let i = 0; i < 5; i++) invoice(b, p, `2026-04-0${i + 1}`, [[b.s18, 33_333 + i * 7], [b.s5, 11_111 + i]])
    const res = rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
    const r = noteVsGstr1(b.db, res.voucherId)
    expect(res.charges).toBe(5)
    expect(r.stored).toBe(sum4(r.lines))
    expect(r.reported).toEqual(r.lines)
    expect(r.balanced).toBe(true)
  })

  it('never posts output tax to an Input* ledger — creates Output CGST / SGST when only input ones are tagged', () => {
    const b = books()
    b.db.prepare("UPDATE ledgers SET name = 'Input CGST' WHERE id = ?").run(b.cgst)
    b.db.prepare("UPDATE ledgers SET name = 'Input SGST' WHERE id = ?").run(b.sgst)
    const p = party(b, 'Tax Ledger Co')
    invoice(b, p, '2026-04-01', [[b.s18, 100_000]])
    const res = rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
    const used = getVoucher(b.db, res.voucherId)!.lines.map((l) => (b.db.prepare('SELECT name FROM ledgers WHERE id = ?').get(l.ledgerId) as { name: string }).name)
    expect(used).toEqual(expect.arrayContaining(['Output CGST', 'Output SGST']))
    expect(used.some((n) => /input/i.test(n))).toBe(false)
  })

  it('a bill with no invoice: not charged without a default rate (reason shown); charged at the default with a warning', () => {
    const b = books()
    const p = party(b, 'Opening Only', { opening: 100_000 })
    const [blocked] = rx.interestPreview(b.db, COMPANY, '2026-03-31')
    expect(blocked!.blocked).toMatch(/default rate/)
    expect(() => rx.postInterest(b.db, COMPANY, { asOn: '2026-03-31', ledgerId: p })).toThrow(/default rate/)
    rx.setReceivablesConfig(b.db, { ...rx.getReceivablesConfig(b.db), interest: { ...rx.getReceivablesConfig(b.db).interest, defaultGstRate: 18 } })
    const [row] = rx.interestPreview(b.db, COMPANY, '2026-03-31')
    expect(row!.warning).toMatch(/default 18%/)
    const res = rx.postInterest(b.db, COMPANY, { asOn: '2026-03-31', ledgerId: p })
    expect(noteVsGstr1(b.db, res.voucherId).lines.cgst).toBe(computeGst(res.interestPaise, 18, 'intra').cgst)
  })

  it('the SAC setting goes on the interest ledgers and into the GSTR-1 HSN summary', () => {
    const b = books()
    rx.setReceivablesConfig(b.db, { ...rx.getReceivablesConfig(b.db), interest: { ...rx.getReceivablesConfig(b.db).interest, sac: '9971' } })
    const p = party(b, 'SAC Co')
    invoice(b, p, '2026-04-01', [[b.s18, 100_000]])
    const res = rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
    expect(noteVsGstr1(b.db, res.voucherId).doc.hsnLines.map((h) => h.hsn)).toEqual(['9971'])
  })
})

describe('5. opening-balance bills across a year end', () => {
  it('run from the books-begin date (+ credit days), never re-dated; charging resumes after the last charged day', () => {
    const b = books() // books from 2025
    const p = party(b, 'Old Debtor', { opening: 100_000, creditDays: 30 })
    const [first] = rx.interestPreview(b.db, COMPANY, '2026-03-31', p, false)
    expect([first!.billKey, first!.billDate, first!.dueDate, first!.from, first!.days]).toEqual(['o:Opening', '2025-04-01', '2025-05-01', '2025-05-02', 334])
    rx.postInterest(b.db, COMPANY, { asOn: '2026-03-31', ledgerId: p, gstOnInterest: false })
    // The new FY: the ageing re-dates the opening bill to 1 April 2026; interest does not.
    const [next] = rx.interestPreview(b.db, COMPANY, '2026-04-30', p, false)
    expect([next!.billDate, next!.from, next!.to, next!.days]).toEqual(['2025-04-01', '2026-04-01', '2026-04-30', 30])
    expect(next!.interestPaise).toBe(simpleInterest(100_000, 1800, 30))
  })

  it('grace across a year end: due 28 Mar + 5 grace → interest from 3 Apr', () => {
    const b = books()
    const p = party(b, 'Grace Co', { creditDays: 27, graceDays: 5 })
    invoice(b, p, '2026-03-01', [[b.s18, 100_000]])
    const [r] = rx.interestPreview(b.db, COMPANY, '2026-04-10', p)
    expect([r!.dueDate, r!.from, r!.days]).toEqual(['2026-03-28', '2026-04-03', 8])
  })

  it('leap year: 29 Feb counts as a day, the divisor stays 365', () => {
    const b = books()
    const p = party(b, 'Leap Co', { creditDays: 0 })
    invoice(b, p, '2028-02-27', [[b.s18, 36_50_000]])
    const [r] = rx.interestPreview(b.db, COMPANY, '2028-03-01', p, false)
    expect([r!.from, r!.days]).toEqual(['2028-02-28', 3])
    expect(r!.interestPaise).toBe(simpleInterest(36_50_000, 1800, 3))
  })

  it('part-paid bill: interest on the pending amount only; fully paid bill: nothing', () => {
    const b = books()
    const p = party(b, 'Part Payer', { creditDays: 0 })
    invoice(b, p, '2026-04-01', [[b.s18, 100_000]])
    receipt(b, p, '2026-04-10', 40_000)
    const [r] = rx.interestPreview(b.db, COMPANY, '2026-04-30', p, false)
    expect(r!.pendingPaise).toBe(60_000)
    expect(r!.interestPaise).toBe(simpleInterest(60_000, 1800, 29))
    receipt(b, p, '2026-04-20', 60_000)
    expect(rx.interestPreview(b.db, COMPANY, '2026-04-30', p, false)).toEqual([])
  })

  it('statement with a non-zero opening equals the ledger statement', () => {
    const b = books()
    const p = party(b, 'Opening Statement', { opening: 25_000 })
    invoice(b, p, '2026-04-05', [[b.s18, 10_000]])
    receipt(b, p, '2026-05-01', 5_000)
    invoice(b, p, '2026-06-05', [[b.s18, 20_000]])
    const ls = ledgerStatement(b.db, p, '2026-05-01', '2026-06-30')
    const s = rx.statementData(b.db, COMPANY, p, '2026-05-01', '2026-06-30')
    expect(s.opening).toBe(ls.opening)
    expect(s.opening).toBe(25_000 + 10_000)
    expect([s.closing, s.rows.length]).toEqual([ls.closing, ls.rows.length])
    expect(s.openBills.reduce((a, x) => a + x.pending, 0) - s.unapplied).toBe(s.closing)
  })
})

describe('3. credit hold: every save that creates new credit is refused', () => {
  const sale = (b: Books, p: number, amount: number, extra: Record<string, unknown> = {}, id?: number) =>
    saveVoucher(b.db, { voucherTypeId: vtId(b.db, 'sales'), date: '2026-05-01', partyLedgerId: p, lines: [{ ledgerId: p, drCr: 'dr', amount }, { ledgerId: b.s18, drCr: 'cr', amount }], ...extra }, id)

  it('new / increased / moved onto the held party / optional→real / post-dated→dated', () => {
    const b = books()
    const held = party(b, 'Held')
    const other = party(b, 'Other')
    const kept = sale(b, held, 1000)
    const optional = sale(b, held, 1000, { isOptional: true })
    const pdc = sale(b, held, 1000, { postDated: true, date: '2026-12-01' })
    const onOther = sale(b, other, 1000)
    rx.setCreditHold(b.db, held, true, 'Overdue')
    expect(() => sale(b, held, 1000)).toThrow(CREDIT_HOLD_PREFIX)
    expect(() => sale(b, held, 1000, { postDated: true, date: '2026-12-02' })).toThrow(CREDIT_HOLD_PREFIX)
    sale(b, held, 900, {}, kept.id) // lowering passes
    expect(() => sale(b, held, 1500, {}, kept.id)).toThrow(CREDIT_HOLD_PREFIX)
    expect(() => sale(b, held, 1000, {}, onOther.id)).toThrow(CREDIT_HOLD_PREFIX)
    sale(b, held, 1000, { isOptional: true }, optional.id) // still optional: passes
    expect(() => sale(b, held, 1000, { isOptional: false }, optional.id)).toThrow(CREDIT_HOLD_PREFIX)
    expect(() => sale(b, held, 1000, { postDated: false, date: '2026-05-02' }, pdc.id)).toThrow(CREDIT_HOLD_PREFIX)
    // Not a hold kind → turned into a sale = new credit.
    const j = saveVoucher(b.db, { voucherTypeId: vtId(b.db, 'journal'), date: '2026-05-01', partyLedgerId: held, lines: [{ ledgerId: held, drCr: 'dr', amount: 100 }, { ledgerId: b.s18, drCr: 'cr', amount: 100 }] })
    expect(() => sale(b, held, 100, {}, j.id)).toThrow(CREDIT_HOLD_PREFIX)
    // The owner override lets one through.
    saveVoucher(b.db, { voucherTypeId: vtId(b.db, 'sales'), date: '2026-05-01', partyLedgerId: held, lines: [{ ledgerId: held, drCr: 'dr', amount: 10 }, { ledgerId: b.s18, drCr: 'cr', amount: 10 }] }, undefined, { creditHoldOverride: { reason: 'Owner approved' } })
  }, 20000)

  it('delivery challans to a held party are blocked (incl. a trade conversion saved as a challan)', () => {
    const t = tradeBooks()
    const widget = item(t.db, 'Widget', { opening: [100, 100_000] })
    dc(t, '2026-05-01', [{ item: widget, qty: 1, amount: 1000 }])
    rx.setCreditHold(t.db, t.buyer, true, 'Overdue')
    expect(() => dc(t, '2026-05-02', [{ item: widget, qty: 1, amount: 1000 }])).toThrow(CREDIT_HOLD_PREFIX)
  })

  it('counter billing goes through the same check', () => {
    const f = pricingFixture()
    rx.setCreditHold(f.db, f.umbrella, true, 'Overdue')
    expect(() => counterCheckout(f.db, TEST_INFO, { date: '2025-10-07', partyLedgerId: f.umbrella, lines: [{ itemId: f.pen, qtyMilli: 1000, ratePaise: 1000 }] })).toThrow(CREDIT_HOLD_PREFIX)
  })

  it('an inbox voucher drop never posts credit to a held party (legacy posting goes through the same check)', () => {
    const b = books()
    const held = party(b, 'Inbox Held')
    rx.setCreditHold(b.db, held, true, 'Overdue')
    const dir = inboxDir('rx-review')
    mkdirSync(dir, { recursive: true })
    const drop = JSON.stringify({ voucherTypeId: vtId(b.db, 'sales'), date: '2026-05-01', partyLedgerId: held, lines: [{ ledgerId: held, drCr: 'dr', amount: 100 }, { ledgerId: b.s18, drCr: 'cr', amount: 100 }] })
    // WP 5.7: by default a drop only ever becomes a draft (a sales invoice cannot be one yet) …
    writeFileSync(join(dir, 'sale.json'), drop)
    const drafted = processInboxFile(b.db, 'rx-review', join(dir, 'sale.json'))
    expect(drafted.ok).toBe(false)
    // … and the deprecated `--legacy-inbox-post` path still runs saveVoucher's credit-hold check.
    writeFileSync(join(dir, 'sale-legacy.json'), drop)
    const out = processInboxFile(b.db, 'rx-review', join(dir, 'sale-legacy.json'), { legacyPost: true })
    expect(out.ok).toBe(false)
    expect(out.detail).toContain(CREDIT_HOLD_PREFIX)
  })
})

describe('plausible items', () => {
  it('an interest debit note can only be binned, not edited', () => {
    const b = books()
    const p = party(b, 'Immutable Co')
    invoice(b, p, '2026-04-01', [[b.s18, 100_000]])
    const res = rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p })
    const v = getVoucher(b.db, res.voucherId)!
    expect(() => saveVoucher(b.db, { ...v, narration: 'edited' } as never, v.id)).toThrow(INTEREST_NOTE_IMMUTABLE)
  })

  it('validates the dates: as-on not after today, note not before the as-on date nor in the future', () => {
    const b = books()
    const p = party(b, 'Dates Co')
    invoice(b, p, '2026-04-01', [[b.s18, 100_000]])
    expect(() => rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', ledgerId: p }, '2026-06-01')).toThrow(/up to today/)
    expect(() => rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', date: '2026-06-01', ledgerId: p }, '2026-07-01')).toThrow(/before the as-on/)
    expect(() => rx.postInterest(b.db, COMPANY, { asOn: '2026-06-05', date: '2026-07-02', ledgerId: p }, '2026-07-01')).toThrow(/future/)
  })

  it('deleting a ledger records the reminders / follow-ups it took with it', () => {
    const b = books()
    const p = party(b, 'Deleted Co', { opening: 0 })
    rx.addFollowup(b.db, { ledgerId: p, billVoucherId: null, billRef: 'Opening', date: '2026-05-01', note: 'Called' })
    deleteLedger(b.db, p)
    const row = b.db.prepare("SELECT before_json AS b FROM audit_log WHERE entity = 'ledger' AND action = 'delete' AND entity_id = ?").get(p) as { b: string }
    expect(JSON.parse(row.b).cascaded).toEqual({ bill_followups: 1 })
  })
})
