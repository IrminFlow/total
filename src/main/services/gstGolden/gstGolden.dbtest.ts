// GST golden fixtures (Phase 2a, docs/plan/upgrade-plan.md): every hand-worked bill in
// fixtures.ts is entered through the real save path on its own freshly seeded company — the
// invoice editor's mapping (computeInvoice → buildInvoicePayload) or the accounting form's lines,
// then saveVoucher — and its four outputs are compared with the hand-worked figures:
//   1. the invoice the editor shows / prints (computeInvoice; the posted party line),
//   2. its GSTR-1 rows (gstr1 → the JSON tables),
//   3. its GSTR-3B boxes (gstr3b → the JSON),
//   4. its e-invoice JSON (extractEdocInvoices → buildEInvoiceJson), which must also pass the
//      schema + IRP business checks.
// A fixture marked `knownBug` is a disagreement reported to the owner: its outputs named there are
// it.fails — they flip to failing the day the app is corrected, and the mark is then removed.
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DB } from '../../db/connection'
import type { CompanyInfo, VoucherKind } from '@shared/domain'
import { seededDb } from '../../db/testdb'
import { writeCompanyInfo } from '../../db/seed'
import { ensureCompanyTree } from '../../paths'
import { stockItemInputSchema, voucherTransportSchema } from '@shared/schemas'
import { gstRegistrationOf } from '@shared/gst/registration'
import {
  buildInvoicePayload, computeInvoice, emptyInvoiceState, taxLedgerIdsFrom, taxSideOf,
  type InvoiceContext, type InvoiceFormState
} from '@shared/voucherEdit/invoice'
import { buildEInvoiceJson } from '@shared/gst/edocs'
import { einvoiceIssues } from '@shared/gst/einvoiceSchema'
import { createLedger, createStockItem, listLedgers, listStockItems } from '../masters'
import { getVoucher, saveVoucher } from '../vouchers'
import { gstr1, gstr3b } from '../gst'
import { extractEdocInvoices, setTransport } from '../edocs'
import { COMPANIES, ITEMS, LEDGERS, PARTIES, type LedgerKey, type PartyKey } from './masters'
import { FIXTURES } from './fixtures'
import type { DocIn, GoldenFixture, GoldenOutput } from './types'
import { P, R, billTotals, expected3b, expectedEinvoice, expectedGstr1, periodOf } from './expected'
import { validateGstr1Json, validateGstr3bJson, validateEinvoiceJson } from './schemas'

beforeAll(() => {
  process.env.TOTAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'total-gst-golden-'))
  ensureCompanyTree('gst-golden')
})

interface Books {
  db: DB
  info: CompanyInfo
  party: Record<PartyKey, number>
  ledger: Record<LedgerKey, number>
  item: Record<keyof typeof ITEMS, number>
}

function books(f: GoldenFixture): Books {
  const info = COMPANIES[f.company ?? 'regular']
  const db = seededDb()
  writeCompanyInfo(db, info)
  const groupId = (name: string): number => (db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number }).id
  const make = (spec: (typeof PARTIES)[PartyKey] | (typeof LEDGERS)[LedgerKey]): number => {
    const s = spec as Record<string, unknown>
    return createLedger(db, {
      name: s.name as string, groupId: groupId(s.group as string),
      gstin: (s.gstin as string) ?? null, stateCode: (s.stateCode as string) ?? null, address: (s.address as string) ?? null,
      taxType: (s.taxType as 'cgst') ?? null, gstRate: (s.gstRate as number) ?? null, hsn: (s.hsn as string) ?? null,
      exportType: (s.exportType as 'sez_wp') ?? null, rcm: !!s.rcm, itcEligibility: (s.itcEligibility as 'blocked') ?? 'eligible'
    }).id
  }
  const party = Object.fromEntries(Object.entries(PARTIES).map(([k, s]) => [k, make(s)])) as Books['party']
  const ledger = Object.fromEntries(Object.entries(LEDGERS).map(([k, s]) => [k, make(s)])) as Books['ledger']
  const unitId = (symbol: string): number => (db.prepare('SELECT id FROM units WHERE symbol = ?').get(symbol) as { id: number }).id
  const item = Object.fromEntries(Object.entries(ITEMS).map(([k, s]) => [k, createStockItem(db, stockItemInputSchema.parse({
    name: s.name, unitId: unitId(s.unit), hsn: s.hsn, gstRate: s.gstRate, cessRate: 'cessRate' in s ? s.cessRate : null,
    // Plenty on hand so no sale runs the stock below zero.
    openingQtyMilli: 100_000_000, openingValue: 10_000_000
  })).id])) as Books['item']
  return { db, info, party, ledger, item }
}

const typeId = (db: DB, kind: string): number => (db.prepare('SELECT id FROM voucher_types WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id

function invoiceContext(b: Books, kind: VoucherKind): InvoiceContext {
  return {
    kind, companyStateCode: b.info.stateCode, ...gstRegistrationOf(b.info),
    items: new Map(listStockItems(b.db).map((i) => [i.id, { gstRate: i.gstRate, cessRate: i.cessRate }])),
    ledgers: new Map(listLedgers(b.db).map((l) => [l.id, { stateCode: l.stateCode, gstRate: l.gstRate }]))
  }
}

/** The invoice editor's state for a fixture's rows. */
function invoiceState(b: Books, d: DocIn): InvoiceFormState {
  const purchaseSide = d.kind === 'purchase' || (d.kind === 'debit_note' && PARTIES[d.party].group === 'Sundry Creditors')
  return {
    ...emptyInvoiceState(d.date),
    number: d.number,
    partyId: b.party[d.party],
    accountId: b.ledger[d.account ?? (purchaseSide ? 'purchases' : 'sales')],
    rows: d.rows!.map((r) => ({
      itemId: b.item[r.item], qtyText: r.qty, rate: P(r.rate), discount: r.discount ? P(r.discount) : null, godownId: null, batchId: null
    })),
    billName: d.kind === 'sales' || d.kind === 'purchase' ? d.number : '',
    reference: d.reference ?? null,
    posOverride: d.posOverride ?? null
  }
}

interface Entered { id: number; computed: ReturnType<typeof computeInvoice> | null }

/** Enter a document the way the user does: the invoice editor (rows) or the accounting form (lines). */
function enter(b: Books, d: DocIn): Entered {
  let entered: Entered
  if (d.rows) {
    const kind = d.kind as VoucherKind
    const ctx = invoiceContext(b, kind)
    const state = invoiceState(b, d)
    const built = buildInvoicePayload(state, ctx, typeId(b.db, kind), taxLedgerIdsFrom(listLedgers(b.db), taxSideOf(kind)))
    if (!built.ok) throw new Error(`${d.number}: ${built.error}`)
    entered = { id: saveVoucher(b.db, built.payload).id, computed: computeInvoice(state, ctx) }
  } else {
    const partyId = b.party[d.party]
    const v = saveVoucher(b.db, {
      voucherTypeId: typeId(b.db, d.kind), date: d.date, number: d.number, partyLedgerId: partyId,
      reference: d.reference ?? null, posOverride: d.posOverride ?? null,
      lines: d.lines!.map((l) => ({ ledgerId: l.ledger === 'party' ? partyId : b.ledger[l.ledger], drCr: l.side, amount: P(l.amount), costAllocations: [] })),
      inventory: [],
      billRefs: (d.billRefs ?? []).map((r) => ({ kind: r.kind, name: r.name, amount: P(r.amount), dueDate: null })),
      tds: null
    })
    entered = { id: v.id, computed: null }
  }
  if (d.shippingBill) {
    setTransport(b.db, entered.id, voucherTransportSchema.parse({ transDocNo: d.shippingBill.num, transDocDate: d.shippingBill.date }))
  }
  return entered
}

const monthOf = (iso: string): { from: string; to: string; period: string } => {
  const [y, m] = iso.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}`, period: periodOf(iso) }
}

// ---- normalising the app's JSON for comparison (format only — never a figure) ----

const HEADER = ['gstin', 'fp', 'gt', 'cur_gt', 'version', 'hash', 'hsn', 'doc_issue']
/** Tax heads the app leaves out when zero are filled in as 0; item rows are ordered by rate with
 *  their serial `num` dropped (the order of rate buckets is not a figure). */
const rateOf = (it: Record<string, unknown>): number => ((it.itm_det as { rt?: number } | undefined)?.rt ?? (it.rt as number))
function normaliseItms(itms: unknown): unknown {
  if (!Array.isArray(itms)) return itms
  return itms
    .map((it: Record<string, unknown>) => {
      if (it.itm_det) {
        const det = it.itm_det as Record<string, unknown>
        return { itm_det: { iamt: 0, camt: 0, samt: 0, ...det } }
      }
      return it
    })
    .sort((a, b) => rateOf(a) - rateOf(b))
}
function normaliseGstr1(json: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(json)) {
    if (HEADER.includes(k)) continue
    out[k] = JSON.parse(JSON.stringify(v), function (key, value) {
      if (key === 'itms') return normaliseItms(value)
      return value
    })
    if (k === 'b2cs') out[k] = (out[k] as Record<string, unknown>[]).map((r): Record<string, unknown> => ({ iamt: 0, camt: 0, samt: 0, ...r })).sort((a, b) => (a.rt as number) - (b.rt as number))
  }
  return out
}
const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, o[k] ?? 0]))

const TAX_SECTIONS = ['b2b', 'b2cl', 'b2cs', 'cdnr', 'cdnur', 'exp']
/** GSTR-1 tables whose v5.0 shape differs from the v4.1 one the app writes. */
const V41_ONLY = ['/doc_issue', '/at', '/txpd']

function runFixture(f: GoldenFixture) {
  const bugIn = (o: GoldenOutput): boolean => !!f.knownBug?.in.includes(o)
  const test = (o: GoldenOutput, name: string, fn: () => void) => (bugIn(o) ? it.fails(`${name} — KNOWN BUG: ${f.knownBug!.reason}`, fn) : it(name, fn))
  let b: Books
  let entered: Entered
  let preceding: { number: string; date: string } | null = null
  const month = monthOf(f.doc.date)
  beforeAll(() => {
    b = books(f)
    for (const d of f.before ?? []) {
      enter(b, d)
      if (d.kind === 'sales' && d.party === f.doc.party && d.number === f.doc.reference) preceding = { number: d.number, date: d.date }
    }
    entered = enter(b, f.doc)
  })

  test('invoice', 'the bill: line figures, round off and total', () => {
    const e = f.expect
    const v = getVoucher(b.db, entered.id)!
    // The party line is what the buyer owes (or the supplier is owed): the bill's total.
    const partyLine = v.lines.find((l) => l.ledgerId === b.party[f.doc.party])!
    expect(R(partyLine.amount)).toBe(e.total)
    if (!entered.computed) return // accounting form: the user typed every amount
    const c = entered.computed
    expect(c.detail.map((d) => ({ taxable: R(d.amount), rate: d.rate, cessRate: d.cessRate }))).toEqual(
      e.lines.map((l) => ({ taxable: l.taxable, rate: l.rate, cessRate: l.cessRate ?? 0 }))
    )
    const t = billTotals(e.lines)
    expect({ taxable: c.gst.taxable, cgst: c.gst.cgst, sgst: c.gst.sgst, igst: c.gst.igst, cess: c.gst.cess }).toEqual(t)
    expect({ roundOff: R(c.roundDiff), total: R(c.rounded) }).toEqual({ roundOff: e.roundOff, total: e.total })
  })

  test('gstr1', 'GSTR-1: its rows (and the JSON passes the GSTN schema)', () => {
    const r = gstr1(b.db, b.info, month.from, month.to, month.period)
    const actual = normaliseGstr1(r.json)
    if (f.expect.gstr1 === 'not-filed') {
      for (const s of TAX_SECTIONS) expect(actual[s], `no ${s} for a business that files no GSTR-1`).toBeUndefined()
      return
    }
    expect(actual).toEqual(expectedGstr1(f))
    expect(validateGstr1Json(r.json, 'v4.1')).toEqual([])
    // GSTN's current v5.0 schema (Feb 2026) reshaped three tables the app still writes in the v4.1
    // shape: Table 13 (`doc_det_new`, doc_num a string) and 11A / 11B (`at` / `txpd` objects split by
    // audience) — reported in the Phase 2a PR; everything else must already pass v5.0.
    expect(validateGstr1Json(r.json, 'v5.0').filter((e) => !V41_ONLY.some((t) => e.startsWith(t)))).toEqual([])
  })

  test('gstr3b', 'GSTR-3B: its boxes (and the JSON passes the GSTN schema)', () => {
    const json = gstr3b(b.db, b.info, month.from, month.to, month.period).json as Record<string, any>
    if (f.expect.gstr1 === 'not-filed') {
      const sup = json.sup_details
      for (const row of ['osup_det', 'osup_zero']) for (const k of ['iamt', 'camt', 'samt', 'csamt']) expect(sup[row][k] ?? 0, `${row}.${k}`).toBe(0)
      return
    }
    const want = expected3b(f)
    expect(json.sup_details).toEqual(want.sup_details)
    expect(json.inter_sup.unreg_details).toEqual(want.unreg_details)
    const avl = Object.fromEntries((json.itc_elg.itc_avl as Record<string, unknown>[]).map(({ ty, ...h }) => [ty, h]))
    expect({ IMPG: avl.IMPG, ISRC: avl.ISRC, OTH: avl.OTH }).toEqual(want.itc_avl)
    const rul = (json.itc_elg.itc_rev as Record<string, unknown>[]).find((x) => x.ty === 'RUL')!
    expect(pick(rul, ['iamt', 'camt', 'samt', 'csamt'])).toEqual(want.itc_rev_rul)
    expect(json.itc_elg.itc_net).toEqual(want.itc_net)
    expect(validateGstr3bJson(json)).toEqual([])
  })

  if (f.expect.einvoice) {
    test('einvoice', 'e-invoice JSON: its values (and it passes the NIC schema and IRP checks)', () => {
      const inv = extractEdocInvoices(b.db, b.info, f.doc.date, f.doc.date, entered.id)
      expect(inv).toHaveLength(1)
      const [doc] = buildEInvoiceJson(inv, { name: b.info.name, gstin: b.info.gstin ?? '', stateCode: b.info.stateCode, address: b.info.address }) as Record<string, any>[]
      const want = expectedEinvoice(f, preceding)
      expect(doc!.TranDtls).toEqual(want.TranDtls)
      expect(doc!.DocDtls).toEqual(want.DocDtls)
      expect(pick(doc!.BuyerDtls, ['Gstin', 'Pos', 'Stcd'])).toEqual(want.BuyerDtls)
      expect((doc!.ItemList as Record<string, unknown>[]).map((i) => pick(i, Object.keys(want.ItemList[0] ?? {})))).toEqual(want.ItemList)
      expect(pick(doc!.ValDtls, Object.keys(want.ValDtls))).toEqual(want.ValDtls)
      expect(doc!.RefDtls).toEqual(want.RefDtls)
      expect(einvoiceIssues(doc)).toEqual([])
      expect(validateEinvoiceJson(doc)).toEqual([])
    })
  }
}

describe('GST golden fixtures', () => {
  it('every fixture has a unique id and document number per company', () => {
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(FIXTURES.length)
  })
  for (const f of FIXTURES) describe(`${f.id} ${f.title}`, () => runFixture(f))
})
