// GST golden fixtures (Phase 2a) — places a fixture's HAND-WORKED figures into the shape of each
// output, by the published table rules. Pure, no app code: this is the "golden model" the app is
// compared with. It never computes tax — it only sums and places the per-line figures the fixture
// states (in integer paise, so no float drift), so an error here can only be a placement error.
//
// Table rules (each from the GSTN / NIC text):
//  - GSTR-1 (FORM GSTR-1, rule 59; GSTN offline-tool JSON): 4A/4B/6B/6C → b2b (SEZ: inv_typ SEWP /
//    SEWOP); 5 → b2cl; 7 → b2cs (one row per POS + rate + supply type; notes net in, credit −);
//    6A → exp (WPAY / WOPAY); 9B → cdnr / cdnur; 8 → nil (INTRB2B / INTRB2C / INTRAB2B / INTRAB2C).
//  - GSTR-3B (FORM GSTR-3B, rule 61): 3.1(a) outward taxable (not zero-rated, not nil); 3.1(b)
//    zero-rated (exports, SEZ); 3.1(c) nil / exempt; 3.1(d) inward under reverse charge; 3.2
//    inter-state supplies to unregistered persons by POS; 4(A)(1) import of goods, 4(A)(3) reverse
//    charge, 4(A)(5) all other ITC; 4(C) net ITC. A credit note reduces its table.
//  - e-invoice (NIC schema 1.1): one ItemList entry per line (AssAmt = TotAmt − Discount, TotItemVal
//    = AssAmt + taxes); ValDtls = the sums + round off; exports: buyer URP, POS / state 96.

import { COMPANIES, ITEMS, LEDGERS, PARTIES, type LedgerSpec } from './masters'
import type { DocIn, ExpectedLine, GoldenFixture, Heads } from './types'

export const P = (rupees: number | undefined): number => Math.round((rupees ?? 0) * 100)
export const R = (paise: number): number => Math.round(paise) / 100 + 0 // + 0: no −0

const party = (f: GoldenFixture): LedgerSpec => PARTIES[f.doc.party]
const companyState = (f: GoldenFixture): string => COMPANIES[f.company ?? 'regular'].stateCode

type InvTyp = 'R' | 'SEWP' | 'SEWOP' | 'EXPWP' | 'EXPWOP'
export function invTypOf(p: LedgerSpec): InvTyp {
  switch (p.exportType) {
    case 'sez_wp': return 'SEWP'
    case 'sez_wop': return 'SEWOP'
    case 'exp_wp': return 'EXPWP'
    case 'exp_wop': return 'EXPWOP'
    default: return 'R'
  }
}
const zeroRated = (t: InvTyp): boolean => t !== 'R'
const isExport = (t: InvTyp): boolean => t === 'EXPWP' || t === 'EXPWOP'

export function posOf(f: GoldenFixture): string {
  const p = party(f)
  return f.doc.posOverride ?? (isExport(invTypOf(p)) ? '96' : p.stateCode ?? companyState(f))
}

/** dd-mm-yyyy (GSTR-1) / dd/mm/yyyy (e-invoice). */
export const portalDate = (iso: string): string => iso.split('-').reverse().join('-')
export const slashDate = (iso: string): string => iso.split('-').reverse().join('/')
/** GSTR-1 / 3B return period MMYYYY of a date. */
export const periodOf = (iso: string): string => `${iso.slice(5, 7)}${iso.slice(0, 4)}`

interface Sum { taxable: number; cgst: number; sgst: number; igst: number; cess: number }
const zero = (): Sum => ({ taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 })
const add = (s: Sum, l: ExpectedLine, sign = 1): void => {
  s.taxable += sign * P(l.taxable); s.cgst += sign * P(l.cgst); s.sgst += sign * P(l.sgst); s.igst += sign * P(l.igst); s.cess += sign * P(l.cess)
}

/** The bill's totals (paise) from its hand-worked lines. */
export function billTotals(lines: ExpectedLine[]): Sum {
  const s = zero()
  for (const l of lines) add(s, l)
  return s
}

/** Per rate, in rate order (rate-0 lines only when `keepZero` — a zero-rated document). */
function byRate(lines: ExpectedLine[], keepZero: boolean): (Sum & { rate: number })[] {
  const m = new Map<number, Sum & { rate: number }>()
  for (const l of lines) {
    if (l.rate === 0 && !keepZero) continue
    const s = m.get(l.rate) ?? { rate: l.rate, ...zero() }
    add(s, l)
    m.set(l.rate, s)
  }
  return [...m.values()].sort((a, b) => a.rate - b.rate)
}

const itmDet = (s: Sum & { rate: number }, sign = 1) => ({
  rt: s.rate, txval: R(sign * s.taxable), iamt: R(sign * s.igst), camt: R(sign * s.cgst), samt: R(sign * s.sgst), csamt: R(sign * s.cess)
})

const isNote = (d: DocIn): boolean => d.kind === 'credit_note' || d.kind === 'debit_note'
const outward = (d: DocIn): boolean => d.kind === 'sales' || ((d.kind === 'credit_note' || d.kind === 'debit_note') && PARTIES[d.party].group === 'Sundry Debtors')

/** The GSTR-1 tables (without header, hsn, doc_issue) the fixture's document produces. */
export function expectedGstr1(f: GoldenFixture): Record<string, unknown> {
  const d = f.doc
  const e = f.expect
  const p = party(f)
  const typ = invTypOf(p)
  const pos = posOf(f)
  const items = byRate(e.lines, zeroRated(typ)).map((s) => ({ itm_det: itmDet(s) }))
  const out: Record<string, unknown> = {}
  switch (e.gstr1) {
    case 'b2b':
      out.b2b = [{ ctin: p.gstin, inv: [{ inum: d.number, idt: portalDate(d.date), val: e.total, pos, rchrg: 'N', inv_typ: typ, itms: items }] }]
      break
    case 'b2cl':
      out.b2cl = [{ pos, inv: [{ inum: d.number, idt: portalDate(d.date), val: e.total, itms: items }] }]
      break
    case 'b2cs': {
      const sign = d.kind === 'credit_note' ? -1 : 1
      out.b2cs = byRate(e.lines, false).map((s) => ({ sply_ty: pos === companyState(f) ? 'INTRA' : 'INTER', pos, typ: 'OE', ...itmDet(s, sign) }))
      break
    }
    case 'exp':
      out.exp = [{
        exp_typ: typ === 'EXPWP' ? 'WPAY' : 'WOPAY',
        inv: [{
          // Shipping bill no. / date when known; no port code is captured (schema: strings, optional).
          inum: d.number, idt: portalDate(d.date), val: e.total,
          ...(d.shippingBill ? { sbnum: d.shippingBill.num, sbdt: portalDate(d.shippingBill.date) } : {}),
          itms: byRate(e.lines, true).map((s) => ({ txval: R(s.taxable), rt: s.rate, iamt: R(s.igst), csamt: R(s.cess) }))
        }]
      }]
      break
    case 'cdnr':
      out.cdnr = [{ ctin: p.gstin, nt: [{ ntty: d.kind === 'credit_note' ? 'C' : 'D', nt_num: d.number, nt_dt: portalDate(d.date), pos, rchrg: 'N', inv_typ: typ, val: e.total, itms: items }] }]
      break
    case 'cdnur':
      // Export notes carry no POS (GSTN save schema: pos only with typ B2CL).
      out.cdnur = [{ ntty: d.kind === 'credit_note' ? 'C' : 'D', nt_num: d.number, nt_dt: portalDate(d.date), typ: e.cdnurTyp, ...(e.cdnurTyp === 'B2CL' ? { pos } : {}), val: e.total, itms: items }]
      break
    default:
      break
  }
  // Table 8: nil-rated lines of a domestic outward document, by supply type and audience.
  if (outward(d) && !zeroRated(typ) && e.gstr1 !== 'not-filed') {
    const sign = d.kind === 'credit_note' ? -1 : 1
    const nil = e.lines.filter((l) => l.rate === 0).reduce((s, l) => s + P(l.taxable), 0)
    if (nil) {
      const inter = pos !== companyState(f)
      const reg = !!p.gstin
      out.nil = { inv: [{ sply_ty: inter ? (reg ? 'INTRB2B' : 'INTRB2C') : reg ? 'INTRAB2B' : 'INTRAB2C', nil_amt: R(sign * nil), expt_amt: 0, ngsup_amt: 0 }] }
    }
  }
  // Table 12: every line of an outward document by HSN + UQC + rate, B2B (buyer has a GSTIN) or B2C;
  // a line without an HSN / SAC is not in the table. Credit notes reduce it.
  if (outward(d) && e.gstr1 !== 'not-filed' && e.lines.length) {
    const sign = d.kind === 'credit_note' ? -1 : 1
    const sales = salesSideLedgers(d)
    const rows = new Map<string, { hsn_sc: string; uqc: string; qty: number; rt: number } & Sum>()
    e.lines.forEach((l, i) => {
      const row = d.rows?.[i]
      const item = row ? ITEMS[row.item] : null
      const hsn = item ? item.hsn : sales[i]?.hsn
      // UNVERIFIED (GST_UNVERIFIED 'hsn-sac-uqc'): a line without an HSN is left out of Table 12, and a
      // service (SAC) line is reported with UQC OTH and quantity 0 — GSTN's Table 12 advisories may
      // require HSN on every line and UQC "NA" for services (not read in an official text yet).
      if (!hsn) return
      const uqc = item ? item.uqc : 'OTH'
      const key = `${hsn}|${uqc}|${l.rate}`
      const r = rows.get(key) ?? { hsn_sc: hsn, uqc, qty: 0, rt: l.rate, ...zero() }
      r.qty += sign * Math.round(Number(row?.qty ?? 0) * 1000)
      add(r, l, sign)
      rows.set(key, r)
    })
    const list = [...rows.values()]
      .map((r) => ({ hsn_sc: r.hsn_sc, uqc: r.uqc, qty: r.qty / 1000 + 0, txval: R(r.taxable), iamt: R(r.igst), camt: R(r.cgst), samt: R(r.sgst), csamt: R(r.cess), rt: r.rt }))
      .sort((a, b) => `${a.hsn_sc}|${a.rt}`.localeCompare(`${b.hsn_sc}|${b.rt}`))
    if (list.length) out.hsn = p.gstin ? { hsn_b2b: list, hsn_b2c: [] } : { hsn_b2b: [], hsn_b2c: list }
  }
  return { ...out, ...(e.gstr1Tables ?? {}) }
}

const heads = (h: Heads | undefined, keys: (keyof Heads)[]): Record<string, number> =>
  Object.fromEntries(keys.map((k) => [k, h?.[k] ?? 0]))
const ALL: (keyof Heads)[] = ['txval', 'iamt', 'camt', 'samt', 'csamt']
const TAX: (keyof Heads)[] = ['iamt', 'camt', 'samt', 'csamt']

export interface Expected3b {
  sup_details: Record<string, Record<string, number>>
  unreg_details: { pos: string; txval: number; iamt: number }[]
  itc_avl: Record<'IMPG' | 'ISRC' | 'OTH', Record<string, number>>
  itc_rev_rul: Record<string, number>
  itc_net: Record<string, number>
}

/** The GSTR-3B figures of the fixture's month (only its document is in that month). */
export function expected3b(f: GoldenFixture): Expected3b {
  const d = f.doc
  const e = f.expect
  const p = party(f)
  const typ = invTypOf(p)
  const pos = posOf(f)
  const det = zero(), zr = zero(), nil = zero(), rev = zero(), isrc = zero(), oth = zero()
  const unreg = new Map<string, { txval: number; iamt: number }>()
  if (outward(d)) {
    const sign = d.kind === 'credit_note' ? -1 : 1
    for (const l of e.lines) {
      if (zeroRated(typ)) add(zr, l, sign)
      else if (l.rate === 0) add(nil, l, sign)
      else {
        add(det, l, sign)
        if (!p.gstin && P(l.igst) !== 0) {
          const u = unreg.get(pos) ?? { txval: 0, iamt: 0 }
          u.txval += sign * P(l.taxable)
          u.iamt += sign * P(l.igst)
          unreg.set(pos, u)
        }
      }
    }
  } else if (d.kind === 'purchase' || (d.kind === 'debit_note' && p.group === 'Sundry Creditors')) {
    const sign = d.kind === 'debit_note' ? -1 : 1
    for (const l of e.lines) {
      if (p.rcm) { add(rev, l, sign); add(isrc, l, sign) } else add(oth, l, sign)
    }
  }
  const h = (s: Sum, keys: (keyof Heads)[]): Record<string, number> => {
    const all: Record<keyof Heads, number> = { txval: R(s.taxable), iamt: R(s.igst), camt: R(s.cgst), samt: R(s.sgst), csamt: R(s.cess) }
    return Object.fromEntries(keys.map((k) => [k, all[k]]))
  }
  const o = e.gstr3b ?? {}
  // 4(C) net ITC = 4(A) availed (IMPG + ISRC + OTH) − 4(B)(1) reversed, from the figures placed above.
  const avl = {
    IMPG: heads(o.itc_avl?.IMPG, TAX),
    ISRC: o.itc_avl?.ISRC ? heads(o.itc_avl.ISRC, TAX) : h(isrc, TAX),
    OTH: o.itc_avl?.OTH ? heads(o.itc_avl.OTH, TAX) : o.itc_avl?.IMPG ? heads(undefined, TAX) : h(oth, TAX)
  }
  const rul = heads(o.itc_rev_rul, TAX)
  const net = Object.fromEntries(TAX.map((k) => [k, R(P(avl.IMPG[k]) + P(avl.ISRC[k]) + P(avl.OTH[k]) - P(rul[k]))]))
  return {
    sup_details: {
      osup_det: o.osup_det ? heads(o.osup_det, ALL) : h(det, ALL),
      osup_zero: o.osup_zero ? heads(o.osup_zero, ['txval', 'iamt', 'csamt']) : h(zr, ['txval', 'iamt', 'csamt']),
      osup_nil_exmp: o.osup_nil_exmp ? heads(o.osup_nil_exmp, ['txval']) : h(nil, ['txval']),
      isup_rev: o.isup_rev ? heads(o.isup_rev, ALL) : h(rev, ALL),
      osup_nongst: { txval: 0 }
    },
    unreg_details: o.unreg_details ?? [...unreg.entries()].map(([pos2, u]) => ({ pos: pos2, txval: R(u.txval), iamt: R(u.iamt) })),
    itc_avl: avl,
    itc_rev_rul: rul,
    itc_net: o.itc_net ? heads(o.itc_net, TAX) : net
  }
}

/** The e-invoice figures (NIC schema 1.1 field names) the fixture's document must carry. */
export function expectedEinvoice(f: GoldenFixture, preceding: { number: string; date: string } | null) {
  const d = f.doc
  const e = f.expect
  const p = party(f)
  const typ = invTypOf(p)
  const exp = isExport(typ)
  const supTyp = typ === 'R' ? 'B2B' : typ === 'SEWP' ? 'SEZWP' : typ === 'SEWOP' ? 'SEZWOP' : typ
  const items = e.lines.map((l, i) => {
    const row = d.rows?.[i]
    const item = row ? ITEMS[row.item] : null
    const serviceLedger = !row ? salesSideLedgers(d)[i] : null
    const taxes = P(l.cgst) + P(l.sgst) + P(l.igst) + P(l.cess)
    return {
      SlNo: String(i + 1),
      IsServc: row ? 'N' : 'Y',
      HsnCd: item ? item.hsn : serviceLedger?.hsn,
      Qty: row ? Number(row.qty) : 1,
      Unit: item ? item.uqc : 'OTH',
      UnitPrice: row ? row.rate : l.taxable,
      TotAmt: l.gross ?? l.taxable,
      Discount: l.discount ?? 0,
      AssAmt: l.taxable,
      GstRt: l.rate,
      IgstAmt: l.igst ?? 0,
      CgstAmt: l.cgst ?? 0,
      SgstAmt: l.sgst ?? 0,
      CesRt: l.cessRate ?? 0,
      CesAmt: l.cess ?? 0,
      TotItemVal: R(P(l.taxable) + taxes)
    }
  })
  const t = billTotals(e.lines)
  return {
    TranDtls: { TaxSch: 'GST', SupTyp: supTyp, RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: d.kind === 'credit_note' ? 'CRN' : d.kind === 'debit_note' ? 'DBN' : 'INV', No: d.number, Dt: slashDate(d.date) },
    BuyerDtls: { Gstin: exp ? 'URP' : (p.gstin ?? 'URP'), Pos: exp ? '96' : posOf(f), Stcd: exp ? '96' : p.stateCode },
    ItemList: items,
    ValDtls: {
      AssVal: R(t.taxable), CgstVal: R(t.cgst), SgstVal: R(t.sgst), IgstVal: R(t.igst), CesVal: R(t.cess),
      RndOffAmt: e.roundOff, TotInvVal: e.total
    },
    // Exports: the shipping bill no. / date when known (no port, currency or country is captured).
    ExpDtls: exp ? { ...(d.shippingBill ? { ShipBNo: d.shippingBill.num, ShipBDt: slashDate(d.shippingBill.date) } : {}) } : undefined,
    ...(isNote(d) && preceding ? { RefDtls: { PrecDocDtls: [{ InvNo: preceding.number, InvDt: slashDate(preceding.date) }] } } : {})
  }
}

/** The income-side ledgers of an accounting-form sale / note, in line order. */
function salesSideLedgers(d: DocIn): LedgerSpec[] {
  const side = d.kind === 'credit_note' ? 'dr' : 'cr'
  return (d.lines ?? [])
    .filter((l) => l.ledger !== 'party' && l.side === side && LEDGERS[l.ledger].group === 'Sales Accounts')
    .map((l) => LEDGERS[l.ledger as keyof typeof LEDGERS])
}
