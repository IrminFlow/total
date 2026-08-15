/**
 * GSTR-1 and GSTR-3B builders. Pure: the main process extracts GstDoc rows from
 * vouchers (SQL) and these functions shape them into on-screen summaries and
 * portal-upload JSON matching the GST offline-tool schema.
 */
import { toPortalDate } from '../dates'

/** One outward document (sales invoice / credit note / debit note) with per-rate tax splits. */
export interface GstDocRateItem {
  rate: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
}

export interface GstHsnLine {
  hsn: string
  description: string
  uqc: string
  qtyMilli: number
  rate: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
}

export interface GstDoc {
  voucherId: number
  kind: 'sales' | 'credit_note' | 'debit_note'
  date: string
  number: string
  partyName: string | null
  partyGstin: string | null
  /** Two-digit state code of place of supply. */
  pos: string
  invoiceValue: number
  items: GstDocRateItem[]
  hsnLines: GstHsnLine[]
}

/** Inward (purchase-side) totals for GSTR-3B ITC table. */
export interface InwardSummary {
  igst: number
  cgst: number
  sgst: number
  cess: number
}

/** B2CL: inter-state invoices to unregistered parties above this value must be itemised. */
export const B2CL_THRESHOLD_PAISE = 100_000 * 100

const toRupees = (paise: number): number => Math.round(paise) / 100

function itmDet(item: GstDocRateItem) {
  return {
    rt: item.rate,
    txval: toRupees(item.taxable),
    ...(item.igst ? { iamt: toRupees(item.igst) } : {}),
    ...(item.cgst ? { camt: toRupees(item.cgst) } : {}),
    ...(item.sgst ? { samt: toRupees(item.sgst) } : {}),
    csamt: toRupees(item.cess)
  }
}

function invoiceJson(doc: GstDoc, companyState: string) {
  return {
    inum: doc.number,
    idt: toPortalDate(doc.date),
    val: toRupees(doc.invoiceValue),
    pos: doc.pos,
    rchrg: 'N',
    inv_typ: 'R',
    itms: doc.items.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
  }
}

export interface Gstr1Result {
  period: string
  gstin: string
  json: Record<string, unknown>
  summary: {
    section: string
    label: string
    docs: number
    taxable: number
    igst: number
    cgst: number
    sgst: number
    cess: number
  }[]
}

function sumItems(docs: GstDoc[]) {
  let taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0
  for (const d of docs) for (const i of d.items) {
    taxable += i.taxable; igst += i.igst; cgst += i.cgst; sgst += i.sgst; cess += i.cess
  }
  return { taxable, igst, cgst, sgst, cess }
}

export function buildGstr1(
  docs: GstDoc[],
  companyGstin: string,
  companyState: string,
  period: string // MMYYYY
): Gstr1Result {
  const sales = docs.filter((d) => d.kind === 'sales')
  const notes = docs.filter((d) => d.kind === 'credit_note' || d.kind === 'debit_note')

  const b2bDocs = sales.filter((d) => d.partyGstin)
  const b2clDocs = sales.filter(
    (d) => !d.partyGstin && d.pos !== companyState && d.invoiceValue > B2CL_THRESHOLD_PAISE
  )
  const b2csDocs = sales.filter((d) => !b2bDocs.includes(d) && !b2clDocs.includes(d))
  const cdnrDocs = notes.filter((d) => d.partyGstin)
  const cdnurDocs = notes.filter((d) => !d.partyGstin)

  // b2b: grouped by counterparty GSTIN
  const byCtin = new Map<string, GstDoc[]>()
  for (const d of b2bDocs) {
    const list = byCtin.get(d.partyGstin!) ?? []
    list.push(d)
    byCtin.set(d.partyGstin!, list)
  }
  const b2b = [...byCtin.entries()].map(([ctin, list]) => ({
    ctin,
    inv: list.map((d) => invoiceJson(d, companyState))
  }))

  const b2cl = (() => {
    const byPos = new Map<string, GstDoc[]>()
    for (const d of b2clDocs) {
      const list = byPos.get(d.pos) ?? []
      list.push(d)
      byPos.set(d.pos, list)
    }
    return [...byPos.entries()].map(([pos, list]) => ({
      pos,
      inv: list.map((d) => {
        const j = invoiceJson(d, companyState) as Record<string, unknown>
        delete j.pos
        delete j.rchrg
        delete j.inv_typ
        return j
      })
    }))
  })()

  // b2cs: aggregated by pos + rate + supply type
  const b2csAgg = new Map<string, { pos: string; rate: number; typ: string; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>()
  for (const d of b2csDocs) {
    for (const item of d.items) {
      const typ = d.pos === companyState ? 'INTRA' : 'INTER'
      const key = `${d.pos}|${item.rate}|${typ}`
      const agg = b2csAgg.get(key) ?? { pos: d.pos, rate: item.rate, typ, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
      agg.taxable += item.taxable
      agg.igst += item.igst
      agg.cgst += item.cgst
      agg.sgst += item.sgst
      agg.cess += item.cess
      b2csAgg.set(key, agg)
    }
  }
  const b2cs = [...b2csAgg.values()].map((a) => ({
    sply_ty: a.typ,
    pos: a.pos,
    typ: 'OE',
    rt: a.rate,
    txval: toRupees(a.taxable),
    ...(a.igst ? { iamt: toRupees(a.igst) } : {}),
    ...(a.cgst ? { camt: toRupees(a.cgst) } : {}),
    ...(a.sgst ? { samt: toRupees(a.sgst) } : {}),
    csamt: toRupees(a.cess)
  }))

  // cdnr: credit/debit notes to registered parties, grouped by GSTIN
  const cdnrByCtin = new Map<string, GstDoc[]>()
  for (const d of cdnrDocs) {
    const list = cdnrByCtin.get(d.partyGstin!) ?? []
    list.push(d)
    cdnrByCtin.set(d.partyGstin!, list)
  }
  const cdnr = [...cdnrByCtin.entries()].map(([ctin, list]) => ({
    ctin,
    nt: list.map((d) => ({
      ntty: d.kind === 'credit_note' ? 'C' : 'D',
      nt_num: d.number,
      nt_dt: toPortalDate(d.date),
      pos: d.pos,
      rchrg: 'N',
      inv_typ: 'R',
      val: toRupees(d.invoiceValue),
      itms: d.items.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
    }))
  }))

  // hsn summary across all outward docs (notes contribute negatively)
  const hsnAgg = new Map<string, GstHsnLine & { sign: number }>()
  for (const d of [...sales, ...notes]) {
    const sign = d.kind === 'credit_note' ? -1 : 1
    for (const h of d.hsnLines) {
      const key = `${h.hsn}|${h.uqc}|${h.rate}`
      const agg = hsnAgg.get(key) ?? { ...h, qtyMilli: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, sign: 1 }
      agg.qtyMilli += sign * h.qtyMilli
      agg.taxable += sign * h.taxable
      agg.cgst += sign * h.cgst
      agg.sgst += sign * h.sgst
      agg.igst += sign * h.igst
      agg.cess += sign * h.cess
      hsnAgg.set(key, agg)
    }
  }
  const hsn = {
    data: [...hsnAgg.values()].map((h, i) => ({
      num: i + 1,
      hsn_sc: h.hsn,
      desc: h.description.slice(0, 30),
      uqc: h.uqc,
      qty: h.qtyMilli / 1000,
      txval: toRupees(h.taxable),
      ...(h.igst ? { iamt: toRupees(h.igst) } : {}),
      ...(h.cgst ? { camt: toRupees(h.cgst) } : {}),
      ...(h.sgst ? { samt: toRupees(h.sgst) } : {}),
      csamt: toRupees(h.cess),
      rt: h.rate
    }))
  }

  const json: Record<string, unknown> = {
    gstin: companyGstin,
    fp: period,
    version: 'GST3.2.1',
    hash: 'hash'
  }
  if (b2b.length) json.b2b = b2b
  if (b2cl.length) json.b2cl = b2cl
  if (b2cs.length) json.b2cs = b2cs
  if (cdnr.length) json.cdnr = cdnr
  if (hsn.data.length) json.hsn = hsn

  const s = (label: string, section: string, list: GstDoc[]) => {
    const t = sumItems(list)
    return { section, label, docs: list.length, ...t }
  }
  return {
    period,
    gstin: companyGstin,
    json,
    summary: [
      s('B2B — registered buyers', 'b2b', b2bDocs),
      s('B2C (Large) — inter-state > ₹1,00,000', 'b2cl', b2clDocs),
      s('B2C (Small) — consolidated', 'b2cs', b2csDocs),
      s('Credit/Debit Notes (registered)', 'cdnr', cdnrDocs),
      s('Credit/Debit Notes (unregistered)', 'cdnur', cdnurDocs)
    ]
  }
}

export interface Gstr3bResult {
  period: string
  gstin: string
  outward: { taxable: number; igst: number; cgst: number; sgst: number; cess: number }
  nilExempt: { taxable: number }
  itc: InwardSummary
  netPayable: { igst: number; cgst: number; sgst: number; cess: number }
  json: Record<string, unknown>
}

export function buildGstr3b(
  outwardDocs: GstDoc[],
  inward: InwardSummary,
  companyGstin: string,
  period: string
): Gstr3bResult {
  let taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0, nilTaxable = 0
  for (const d of outwardDocs) {
    const sign = d.kind === 'credit_note' ? -1 : 1
    for (const item of d.items) {
      if (item.rate === 0) {
        nilTaxable += sign * item.taxable
      } else {
        taxable += sign * item.taxable
        igst += sign * item.igst
        cgst += sign * item.cgst
        sgst += sign * item.sgst
        cess += sign * item.cess
      }
    }
  }
  const net = {
    igst: Math.max(0, igst - inward.igst),
    cgst: Math.max(0, cgst - inward.cgst),
    sgst: Math.max(0, sgst - inward.sgst),
    cess: Math.max(0, cess - inward.cess)
  }
  const json = {
    gstin: companyGstin,
    ret_period: period,
    sup_details: {
      osup_det: { txval: toRupees(taxable), iamt: toRupees(igst), camt: toRupees(cgst), samt: toRupees(sgst), csamt: toRupees(cess) },
      osup_zero: { txval: 0, iamt: 0, csamt: 0 },
      osup_nil_exmp: { txval: toRupees(nilTaxable) },
      isup_rev: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
      osup_nongst: { txval: 0 }
    },
    itc_elg: {
      itc_avl: [
        { ty: 'OTH', iamt: toRupees(inward.igst), camt: toRupees(inward.cgst), samt: toRupees(inward.sgst), csamt: toRupees(inward.cess) }
      ],
      itc_net: { iamt: toRupees(inward.igst), camt: toRupees(inward.cgst), samt: toRupees(inward.sgst), csamt: toRupees(inward.cess) }
    }
  }
  return {
    period,
    gstin: companyGstin,
    outward: { taxable, igst, cgst, sgst, cess },
    nilExempt: { taxable: nilTaxable },
    itc: inward,
    netPayable: net,
    json
  }
}
