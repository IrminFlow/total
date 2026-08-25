/**
 * GSTR-1 and GSTR-3B builders. Pure: the main process extracts GstDoc rows from
 * vouchers (SQL) and these functions shape them into on-screen summaries and
 * portal-upload JSON matching the GSTN offline-tool schema.
 *
 * Rounding/bucketing convention (fixes audit D1/D2): tax is computed ONCE per voucher
 * line (see extractOutwardDocs) and every table — invoice tables 4/5/6/7, notes 9B,
 * HSN table 12 — only ever SUMS those line-level paise. Cross-table totals therefore
 * tie to the paisa by construction.
 */
import { toPortalDate } from '../dates'

/** One per-rate tax split on a document. Cess is summed within the rate bucket (D1). */
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

/** A rate-0 (nil-rated) line — feeds Table 8 and GSTR-3B 3.1(c), never b2b/b2cs. */
export interface GstNilLine {
  taxable: number
}

/** GSTR-1 invoice type. R = regular, SEWP/SEWOP = SEZ with/without payment,
 *  DE = deemed export, EXPWP/EXPWOP = export with/without payment (Table 6A). */
export type GstInvTyp = 'R' | 'SEWP' | 'SEWOP' | 'DE' | 'EXPWP' | 'EXPWOP'

/** Pre-export validation payload computed at extraction time (consumed by validate.ts). */
export interface GstDocValidation {
  /** Booked invoice value minus (taxable + computed tax + nil), paise. Non-zero beyond
   *  ±100 paise means hand-edited tax lines or an unexplained round-off. */
  valDiff: number
  /** Lines that carried value but no HSN/SAC — silently absent from Table 12. */
  missingHsnCount: number
  /** SEZ/deemed-export party without a GSTIN (those registrations always have one). */
  missingGstin: boolean
}

export interface GstDoc {
  voucherId: number
  kind: 'sales' | 'credit_note' | 'debit_note'
  date: string
  number: string
  partyName: string | null
  partyGstin: string | null
  /** Two-digit state code of place of supply (pos_override ?? party state ?? company state). */
  pos: string
  invoiceValue: number
  items: GstDocRateItem[]
  hsnLines: GstHsnLine[]
  /** Rate-0 lines. Optional for hand-built docs; defaults to []. */
  nilLines?: GstNilLine[]
  /** Defaults to 'R' for hand-built docs. */
  invTyp?: GstInvTyp
  /** Reverse charge applies (party-level `ledgers.rcm`). Defaults false. */
  rchrg?: boolean
  /** Shipping bill (exports, Table 6A) — from voucher_transport trans_doc_no/date. */
  shippingBill?: { num: string | null; date: string | null } | null
  validation?: GstDocValidation
}

/** Inward (purchase-side) tax totals — one leg of the GSTR-3B ITC table. */
export interface InwardSummary {
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export interface TaxTotals extends InwardSummary {
  taxable: number
}

/**
 * B2CL: inter-state invoices to unregistered parties above this value must be itemised.
 * ₹1,00,000 per Notification No. 12/2024–Central Tax (effective 01-08-2024), which lowered
 * the earlier ₹2,50,000 limit. Verify against the notification if this ever changes.
 */
export const B2CL_THRESHOLD_PAISE = 100_000 * 100

const toRupees = (paise: number): number => Math.round(paise) / 100

/** Quantity thousandths → a 2-decimal number (portal HSN qty precision), integer math. */
const qty2 = (qtyMilli: number): number => Math.round(qtyMilli / 10) / 100

/**
 * Classify a document for GSTR-1 `inv_typ` / e-docs from the party's export flag and state.
 * 'DE' (deemed export) has no data source yet — parties can't be flagged as deemed-export
 * recipients — so it is never produced (documented limitation).
 */
export function classifyDoc(
  exportType: 'sez_wp' | 'sez_wop' | 'exp_wp' | 'exp_wop' | null,
  partyStateCode: string | null
): GstInvTyp {
  switch (exportType) {
    case 'sez_wp': return 'SEWP'
    case 'sez_wop': return 'SEWOP'
    case 'exp_wp': return 'EXPWP'
    case 'exp_wop': return 'EXPWOP'
  }
  // Foreign / other-territory party state codes are export-shaped even without the flag.
  if (partyStateCode === '96' || partyStateCode === '97') return 'EXPWOP'
  return 'R'
}

// ---------- extras fed by the main process (advances, doc series, turnover) ----------

/** Rate-wise advance received (11A) or advance adjusted (11B) aggregate. */
export interface GstAdvanceAgg {
  pos: string
  supply: 'intra' | 'inter'
  rate: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
}

/** One voucher-number series for Table 13 (documents issued). Category codes per the
 *  portal: 1 = invoices for outward supply, 4 = debit note, 5 = credit note. */
export interface GstDocSeries {
  category: 1 | 4 | 5
  from: string
  to: string
  totnum: number
  cancel: number
}

export interface Gstr1Extras {
  /** 11A — tax on advances received in the period (omitted when empty). */
  advances?: GstAdvanceAgg[]
  /** 11B — advances adjusted against invoices this period (omitted when empty). */
  advanceAdjustments?: GstAdvanceAgg[]
  /** Table 13 — documents issued, per numbering series. */
  docSeries?: GstDocSeries[]
  /** Gross turnover of the preceding FY, paise (header `gt`). */
  gt?: number
  /** Aggregate turnover FY-to-date through this period, paise (header `cur_gt`). */
  curGt?: number
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
    /** Exact posted vouchers contributing to this summary row, for books-to-return drill-down. */
    voucherIds: number[]
  }[]
}

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

/** Zero-rated invoice types (sec 16 IGST Act): exports and supplies to SEZ. */
export function isZeroRatedTyp(typ: GstInvTyp): boolean {
  return typ === 'EXPWP' || typ === 'EXPWOP' || typ === 'SEWP' || typ === 'SEWOP'
}

/** Section summary totals come from the SAME rated buckets the JSON tables are built from —
 *  never the raw d.items (whose rate-0 lines are re-routed to Table 8 and would double-count
 *  against the nil row on screen/CSV). */
function sumItems(docs: NormalizedDoc[]) {
  let taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0
  for (const d of docs) for (const i of d.ratedItems) {
    taxable += i.taxable; igst += i.igst; cgst += i.cgst; sgst += i.sgst; cess += i.cess
  }
  return { taxable, igst, cgst, sgst, cess }
}

interface NormalizedDoc extends GstDoc {
  nil: GstNilLine[]
  typ: GstInvTyp
  ratedItems: GstDocRateItem[]
}

/**
 * Apply defaults and route any rate-0 items into the nil bucket — a rt:0 row must never
 * reach b2b/b2cl/b2cs for DOMESTIC documents (the portal rejects it); it belongs in Table 8.
 *
 * ZERO-RATED documents (exports/SEZ) are the exception: their rate-0 lines stay on the
 * document as a single rt:0 item so the invoice itself is still reported in Table 6A/6B
 * (LUT exports of nil-rated goods legitimately file at rt 0 with iamt 0). Routing them into
 * the nil bucket would drop the export invoice from GSTR-1 entirely and misfile its value
 * as domestic nil-rated in Table 8 — contradicting 3B 3.1(b) and the shipping-bill trail.
 */
function normalize(d: GstDoc): NormalizedDoc {
  const typ = d.invTyp ?? 'R'
  const zeroRated = isZeroRatedTyp(typ)
  const nil: GstNilLine[] = []
  const ratedItems: GstDocRateItem[] = []
  let rate0: GstDocRateItem | null = null
  const addRate0 = (taxable: number, cess: number): void => {
    if (!rate0) {
      rate0 = { rate: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
      ratedItems.push(rate0)
    }
    rate0.taxable += taxable
    rate0.cess += cess
  }
  for (const l of d.nilLines ?? []) {
    if (zeroRated) addRate0(l.taxable, 0)
    else nil.push(l)
  }
  for (const item of d.items) {
    if (item.rate !== 0) ratedItems.push(item)
    else if (zeroRated) addRate0(item.taxable, item.cess)
    else nil.push({ taxable: item.taxable })
  }
  return { ...d, nil, typ, ratedItems }
}

const noteSign = (kind: GstDoc['kind']): number => (kind === 'credit_note' ? -1 : 1)

export function buildGstr1(
  docs: GstDoc[],
  companyGstin: string,
  companyState: string,
  period: string, // MMYYYY
  extras: Gstr1Extras = {}
): Gstr1Result {
  const all = docs.map(normalize)
  const sales = all.filter((d) => d.kind === 'sales')
  const notes = all.filter((d) => d.kind === 'credit_note' || d.kind === 'debit_note')

  const isExport = (d: NormalizedDoc): boolean => d.typ === 'EXPWP' || d.typ === 'EXPWOP'
  // A purely nil-rated document has no rated items — it appears ONLY in Table 8 (and the
  // HSN summary); emitting it into b2b/b2cl/cdnr with an empty itms[] would be rejected.
  const hasRated = (d: NormalizedDoc): boolean => d.ratedItems.length > 0

  const expDocs = sales.filter((d) => isExport(d) && hasRated(d))
  const b2bDocs = sales.filter((d) => !isExport(d) && d.partyGstin && hasRated(d))
  const b2clDocs = sales.filter(
    (d) => !isExport(d) && !d.partyGstin && hasRated(d) && d.pos !== companyState && d.invoiceValue > B2CL_THRESHOLD_PAISE
  )
  const b2csDocs = sales.filter(
    (d) => !isExport(d) && !d.partyGstin && !b2clDocs.includes(d)
  )
  const cdnrDocs = notes.filter((d) => !isExport(d) && d.partyGstin && hasRated(d))
  // CDNUR carries only B2CL-type notes (inter-state, above the B2CL threshold) and export
  // notes; every other unregistered note is netted into the B2CS aggregation below —
  // that is where the portal adjusts small B2C notes.
  const cdnurDocs = notes.filter(
    (d) => !d.partyGstin && hasRated(d) && (isExport(d) || (d.pos !== companyState && d.invoiceValue > B2CL_THRESHOLD_PAISE))
  )
  const b2csNoteDocs = notes.filter((d) => !d.partyGstin && !cdnurDocs.includes(d))

  // ---- 4A/4B/6B/6C — b2b, grouped by counterparty GSTIN ----
  const byCtin = new Map<string, NormalizedDoc[]>()
  for (const d of b2bDocs) {
    const list = byCtin.get(d.partyGstin!) ?? []
    list.push(d)
    byCtin.set(d.partyGstin!, list)
  }
  const b2b = [...byCtin.entries()].map(([ctin, list]) => ({
    ctin,
    inv: list.map((d) => ({
      inum: d.number,
      idt: toPortalDate(d.date),
      val: toRupees(d.invoiceValue),
      pos: d.pos,
      rchrg: d.rchrg ? 'Y' : 'N',
      inv_typ: d.typ,
      itms: d.ratedItems.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
    }))
  }))

  // ---- 5 — b2cl, grouped by POS ----
  const b2cl = (() => {
    const byPos = new Map<string, NormalizedDoc[]>()
    for (const d of b2clDocs) {
      const list = byPos.get(d.pos) ?? []
      list.push(d)
      byPos.set(d.pos, list)
    }
    return [...byPos.entries()].map(([pos, list]) => ({
      pos,
      inv: list.map((d) => ({
        inum: d.number,
        idt: toPortalDate(d.date),
        val: toRupees(d.invoiceValue),
        itms: d.ratedItems.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
      }))
    }))
  })()

  // ---- 7 — b2cs, aggregated by pos + rate + supply type; small unregistered
  //      credit/debit notes net into the same buckets (credit −, debit +) ----
  const b2csAgg = new Map<string, { pos: string; rate: number; typ: string; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>()
  for (const d of [...b2csDocs, ...b2csNoteDocs]) {
    const sign = d.kind === 'sales' ? 1 : noteSign(d.kind)
    for (const item of d.ratedItems) {
      const typ = d.pos === companyState ? 'INTRA' : 'INTER'
      const key = `${d.pos}|${item.rate}|${typ}`
      const agg = b2csAgg.get(key) ?? { pos: d.pos, rate: item.rate, typ, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
      agg.taxable += sign * item.taxable
      agg.igst += sign * item.igst
      agg.cgst += sign * item.cgst
      agg.sgst += sign * item.sgst
      agg.cess += sign * item.cess
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

  // ---- 6A — exports, grouped WPAY/WOPAY ----
  const exp = (() => {
    const groups: { exp_typ: 'WPAY' | 'WOPAY'; docs: NormalizedDoc[] }[] = [
      { exp_typ: 'WPAY', docs: expDocs.filter((d) => d.typ === 'EXPWP') },
      { exp_typ: 'WOPAY', docs: expDocs.filter((d) => d.typ === 'EXPWOP') }
    ]
    return groups
      .filter((g) => g.docs.length)
      .map((g) => ({
        exp_typ: g.exp_typ,
        inv: g.docs.map((d) => ({
          inum: d.number,
          idt: toPortalDate(d.date),
          val: toRupees(d.invoiceValue),
          // Shipping-bill details are optional on the portal (supplied later via Table 6A
          // amendment when not yet available) — null-safe here. sbpcode (port code) has no
          // data source in the books yet, so it is always null.
          sbpcode: null,
          sbnum: d.shippingBill?.num ?? null,
          sbdt: d.shippingBill?.date ? toPortalDate(d.shippingBill.date) : null,
          // Exports item rows are flat (no itm_det wrapper) per the offline-tool schema.
          itms: d.ratedItems.map((item) => ({
            txval: toRupees(item.taxable),
            rt: item.rate,
            iamt: toRupees(item.igst),
            csamt: toRupees(item.cess)
          }))
        }))
      }))
  })()

  // ---- 9B — cdnr (registered), grouped by GSTIN ----
  const cdnrByCtin = new Map<string, NormalizedDoc[]>()
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
      rchrg: d.rchrg ? 'Y' : 'N',
      inv_typ: d.typ,
      val: toRupees(d.invoiceValue),
      itms: d.ratedItems.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
    }))
  }))

  // ---- 9B — cdnur (unregistered, B2CL-type + exports) ----
  const cdnur = cdnurDocs.map((d) => ({
    ntty: d.kind === 'credit_note' ? 'C' : 'D',
    nt_num: d.number,
    nt_dt: toPortalDate(d.date),
    typ: isExport(d) ? d.typ : 'B2CL',
    pos: d.pos,
    val: toRupees(d.invoiceValue),
    itms: d.ratedItems.map((item, i) => ({ num: i + 1, itm_det: itmDet(item) }))
  }))

  // ---- 8 — nil-rated, split by supply/audience. Exempt and non-GST classifications are
  //      not yet representable on ledgers (taxType has no exempt/non-GST values), so those
  //      columns are always 0 — documented limitation. ----
  const nilAgg = new Map<string, number>()
  for (const d of all) {
    const sign = d.kind === 'sales' ? 1 : noteSign(d.kind)
    const total = d.nil.reduce((s, l) => s + l.taxable, 0)
    if (!total) continue
    const inter = d.pos !== companyState
    const reg = !!d.partyGstin
    const key = inter ? (reg ? 'INTRB2B' : 'INTRB2C') : reg ? 'INTRAB2B' : 'INTRAB2C'
    nilAgg.set(key, (nilAgg.get(key) ?? 0) + sign * total)
  }
  const nil = {
    inv: ['INTRB2B', 'INTRB2C', 'INTRAB2B', 'INTRAB2C']
      .filter((k) => nilAgg.get(k))
      .map((k) => ({
        sply_ty: k,
        nil_amt: toRupees(nilAgg.get(k)!),
        expt_amt: 0,
        ngsup_amt: 0
      }))
  }

  // ---- 12 — HSN summary, bifurcated B2B/B2C per the current offline-tool Table 12 format.
  //      Audience: documents to registered counterparties (GSTIN present, incl. SEZ) roll
  //      into hsn_b2b; unregistered + exports into hsn_b2c. Notes net with sign. ----
  const hsnRows = (docsIn: NormalizedDoc[]) => {
    const agg = new Map<string, GstHsnLine>()
    for (const d of docsIn) {
      const sign = d.kind === 'sales' ? 1 : noteSign(d.kind)
      for (const h of d.hsnLines) {
        const key = `${h.hsn}|${h.uqc}|${h.rate}`
        const a = agg.get(key) ?? { ...h, qtyMilli: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 }
        a.qtyMilli += sign * h.qtyMilli
        a.taxable += sign * h.taxable
        a.cgst += sign * h.cgst
        a.sgst += sign * h.sgst
        a.igst += sign * h.igst
        a.cess += sign * h.cess
        agg.set(key, a)
      }
    }
    return [...agg.values()].map((h, i) => ({
      num: i + 1,
      hsn_sc: h.hsn,
      desc: h.description.slice(0, 30),
      uqc: h.uqc,
      qty: qty2(h.qtyMilli),
      txval: toRupees(h.taxable),
      ...(h.igst ? { iamt: toRupees(h.igst) } : {}),
      ...(h.cgst ? { camt: toRupees(h.cgst) } : {}),
      ...(h.sgst ? { samt: toRupees(h.sgst) } : {}),
      csamt: toRupees(h.cess),
      rt: h.rate
    }))
  }
  const hsnB2b = hsnRows(all.filter((d) => d.partyGstin))
  const hsnB2c = hsnRows(all.filter((d) => !d.partyGstin))
  const hsn = { hsn_b2b: hsnB2b, hsn_b2c: hsnB2c }

  // ---- 11A/11B — advances received / adjusted, grouped by pos ----
  const advTable = (aggs: GstAdvanceAgg[]) => {
    const byPos = new Map<string, GstAdvanceAgg[]>()
    for (const a of aggs) {
      const list = byPos.get(`${a.pos}|${a.supply}`) ?? []
      list.push(a)
      byPos.set(`${a.pos}|${a.supply}`, list)
    }
    return [...byPos.values()].map((list) => ({
      pos: list[0]!.pos,
      sply_ty: list[0]!.supply === 'intra' ? 'INTRA' : 'INTER',
      itms: list.map((a) => ({
        rt: a.rate,
        ad_amt: toRupees(a.taxable),
        iamt: toRupees(a.igst),
        camt: toRupees(a.cgst),
        samt: toRupees(a.sgst),
        csamt: toRupees(a.cess)
      }))
    }))
  }
  const at = advTable(extras.advances ?? [])
  const txpd = advTable(extras.advanceAdjustments ?? [])

  // ---- 13 — documents issued, per numbering series ----
  const docIssue = (() => {
    const series = extras.docSeries ?? []
    if (!series.length) return null
    const byCat = new Map<number, GstDocSeries[]>()
    for (const s of series) {
      const list = byCat.get(s.category) ?? []
      list.push(s)
      byCat.set(s.category, list)
    }
    return {
      doc_det: [...byCat.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cat, list]) => ({
          doc_num: cat,
          docs: list.map((s, i) => ({
            num: i + 1,
            from: s.from,
            to: s.to,
            totnum: s.totnum,
            cancel: s.cancel,
            net_issue: s.totnum - s.cancel
          }))
        }))
    }
  })()

  const json: Record<string, unknown> = {
    gstin: companyGstin,
    fp: period,
    gt: toRupees(extras.gt ?? 0),
    cur_gt: toRupees(extras.curGt ?? 0),
    version: 'GST3.2.1',
    hash: 'hash'
  }
  if (b2b.length) json.b2b = b2b
  if (b2cl.length) json.b2cl = b2cl
  if (b2cs.length) json.b2cs = b2cs
  if (cdnr.length) json.cdnr = cdnr
  if (cdnur.length) json.cdnur = cdnur
  if (exp.length) json.exp = exp
  if (nil.inv.length) json.nil = nil
  if (at.length) json.at = at
  if (txpd.length) json.txpd = txpd
  if (docIssue) json.doc_issue = docIssue
  if (hsnB2b.length || hsnB2c.length) json.hsn = hsn

  const s = (label: string, section: string, list: NormalizedDoc[]) => {
    const t = sumItems(list)
    return { section, label, docs: list.length, ...t, voucherIds: [...new Set(list.map((doc) => doc.voucherId))] }
  }
  const nilTotal = all.reduce(
    (sum, d) => sum + (d.kind === 'sales' ? 1 : noteSign(d.kind)) * d.nil.reduce((s2, l) => s2 + l.taxable, 0),
    0
  )

  // Paise totals for the summary's HSN rows (the json rows above are already in rupees).
  const hsnTotals = (docsIn: NormalizedDoc[]) => {
    let taxable = 0, igst2 = 0, cgst2 = 0, sgst2 = 0, cess2 = 0
    for (const d of docsIn) {
      const sign = d.kind === 'sales' ? 1 : noteSign(d.kind)
      for (const h of d.hsnLines) {
        taxable += sign * h.taxable
        igst2 += sign * h.igst
        cgst2 += sign * h.cgst
        sgst2 += sign * h.sgst
        cess2 += sign * h.cess
      }
    }
    return { taxable, igst: igst2, cgst: cgst2, sgst: sgst2, cess: cess2 }
  }
  const advTotals = (aggs: GstAdvanceAgg[]) =>
    aggs.reduce(
      (t, a) => ({ taxable: t.taxable + a.taxable, igst: t.igst + a.igst, cgst: t.cgst + a.cgst, sgst: t.sgst + a.sgst, cess: t.cess + a.cess }),
      { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
    )
  const docIssueNet = (extras.docSeries ?? []).reduce((n, ser) => n + ser.totnum - ser.cancel, 0)

  return {
    period,
    gstin: companyGstin,
    json,
    summary: [
      s('B2B — registered buyers', 'b2b', b2bDocs),
      s('B2C (Large) — inter-state > ₹1,00,000', 'b2cl', b2clDocs),
      s('B2C (Small) — consolidated', 'b2cs', [...b2csDocs, ...b2csNoteDocs]),
      s('Exports (Table 6A)', 'exp', expDocs),
      s('Credit/Debit Notes (registered)', 'cdnr', cdnrDocs),
      s('Credit/Debit Notes (unregistered)', 'cdnur', cdnurDocs),
      { section: 'nil', label: 'Nil-rated (Table 8)', docs: 0, taxable: nilTotal, igst: 0, cgst: 0, sgst: 0, cess: 0, voucherIds: all.filter((d) => d.nil.length > 0).map((d) => d.voucherId) },
      { section: 'hsn_b2b', label: 'HSN summary — B2B (Table 12)', docs: hsnB2b.length, ...hsnTotals(all.filter((d) => d.partyGstin)), voucherIds: all.filter((d) => d.partyGstin && d.hsnLines.length > 0).map((d) => d.voucherId) },
      { section: 'hsn_b2c', label: 'HSN summary — B2C (Table 12)', docs: hsnB2c.length, ...hsnTotals(all.filter((d) => !d.partyGstin)), voucherIds: all.filter((d) => !d.partyGstin && d.hsnLines.length > 0).map((d) => d.voucherId) },
      { section: 'at', label: 'Advances received (11A)', docs: at.length, ...advTotals(extras.advances ?? []), voucherIds: [] },
      { section: 'txpd', label: 'Advances adjusted (11B)', docs: txpd.length, ...advTotals(extras.advanceAdjustments ?? []), voucherIds: [] },
      { section: 'doc_issue', label: 'Documents issued (Table 13)', docs: docIssueNet, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, voucherIds: all.map((d) => d.voucherId) }
    ]
  }
}

// ---------- GSTR-3B ----------

/** One row of the 3B ITC table. */
export type ItcPart = InwardSummary

const ZERO_ITC: ItcPart = { igst: 0, cgst: 0, sgst: 0, cess: 0 }

/** ITC availed, itemised for Table 4(A) + blocked credit for 4(D). */
export interface ItcBreakdown {
  /** 4(A)(1) — import of goods (party state 96/97). */
  impg: ItcPart
  /** 4(A)(3) — inward supplies liable to reverse charge (mirrors 3.1(d) tax). */
  isrc: ItcPart
  /** 4(A)(5) — all other ITC. */
  oth: ItcPart
  /** 4(D)(1) — ineligible ITC (party itc_eligibility = 'blocked'). */
  blocked: ItcPart
}

/** Manual per-period adjustments persisted in meta `gst3b.manual.<period>`. */
export interface Gst3bManual {
  /** 4(B)(1) — ITC reversed per rules 38/42/43. */
  itcRevRul: ItcPart
  /** 4(B)(2) — other ITC reversals. */
  itcRevOth: ItcPart
  /** 5.1 — interest payable. */
  interest: ItcPart
  /** 5.1 — late fee (CGST/SGST only on the portal). */
  lateFee: { camt: number; samt: number }
}

export const EMPTY_GST3B_MANUAL: Gst3bManual = {
  itcRevRul: { ...ZERO_ITC },
  itcRevOth: { ...ZERO_ITC },
  interest: { ...ZERO_ITC },
  lateFee: { camt: 0, samt: 0 }
}

export interface Gstr3bInputs {
  docs: GstDoc[]
  itc: ItcBreakdown
  /** 3.1(d) — inward supplies liable to reverse charge (taxable + tax payable). */
  rcmInward: TaxTotals
  manual?: Gst3bManual | null
  sourceVoucherIds?: Gstr3bResult['voucherIds']
}

export interface Gstr3bResult {
  period: string
  gstin: string
  /** 3.1(a) — outward taxable (rated, non-zero-rated). */
  outward: TaxTotals
  /** 3.1(b) — zero-rated (exports + SEZ). */
  zeroRated: { taxable: number; igst: number; cess: number }
  /** 3.1(c). */
  nilExempt: { taxable: number }
  /** 3.1(d). */
  rcm: TaxTotals
  /** Net eligible ITC (4A − 4B) — what the renderer shows as "Eligible ITC". */
  itc: InwardSummary
  /** Liability after ITC set-off (cash payable on the normal counters). */
  netPayable: InwardSummary
  /** RCM liability — payable in cash only, never settled from ITC. */
  rcmPayable: InwardSummary
  /** 3.2 — inter-state supplies to unregistered persons by POS, paise (json holds rupees). */
  interState: { pos: string; taxable: number; igst: number }[]
  /** 4(A) availed split (IMPG/ISRC/OTH) + 4(D) blocked, paise — mirrors itc_elg. */
  itcParts: ItcBreakdown
  /** Manual adjustments applied to this build (4(B) reversals + 5.1 interest/late fee). */
  manual: Gst3bManual
  voucherIds: {
    outward: number[]
    zeroRated: number[]
    nilExempt: number[]
    rcm: number[]
    impg: number[]
    isrc: number[]
    oth: number[]
    blocked: number[]
    netItc: number[]
  }
  json: Record<string, unknown>
}

/**
 * ITC set-off order (sec 49/49A + rule 88A, per plan ruling): IGST credit first against
 * IGST, then CGST, then SGST; CGST credit against CGST then IGST; SGST credit against
 * SGST then IGST; cess credit only against cess. Pure — returns the residual liability.
 */
export function applySetOff(payable: InwardSummary, credit: InwardSummary): InwardSummary {
  let { igst: pi, cgst: pc, sgst: ps, cess: px } = payable
  let { igst: ci, cgst: cc, sgst: cs, cess: cx } = credit

  const use = (avail: number, need: number): [number, number] => {
    const used = Math.min(avail, need)
    return [avail - used, need - used]
  }

  // IGST credit: IGST → CGST → SGST
  ;[ci, pi] = use(ci, pi)
  ;[ci, pc] = use(ci, pc)
  ;[ci, ps] = use(ci, ps)
  // CGST credit: CGST → IGST
  ;[cc, pc] = use(cc, pc)
  ;[cc, pi] = use(cc, pi)
  // SGST credit: SGST → IGST
  ;[cs, ps] = use(cs, ps)
  ;[cs, pi] = use(cs, pi)
  // Cess credit: cess only
  ;[cx, px] = use(cx, px)

  return { igst: pi, cgst: pc, sgst: ps, cess: px }
}

const addItc = (...parts: ItcPart[]): ItcPart =>
  parts.reduce(
    (a, b) => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst, cess: a.cess + b.cess }),
    { ...ZERO_ITC }
  )
const subItc = (a: ItcPart, b: ItcPart): ItcPart => ({
  igst: a.igst - b.igst, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst, cess: a.cess - b.cess
})
const itcJson = (p: ItcPart) => ({
  iamt: toRupees(p.igst), camt: toRupees(p.cgst), samt: toRupees(p.sgst), csamt: toRupees(p.cess)
})

export function buildGstr3b(
  inputs: Gstr3bInputs,
  companyGstin: string,
  period: string
): Gstr3bResult {
  const all = inputs.docs.map(normalize)
  const manual = inputs.manual ?? EMPTY_GST3B_MANUAL

  // 3.1(a) rated domestic vs 3.1(b) zero-rated (exports + SEZ, D6 fix) vs 3.1(c) nil.
  let taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0
  let zrTaxable = 0, zrIgst = 0, zrCess = 0
  let nilTaxable = 0
  for (const d of all) {
    const sign = d.kind === 'sales' ? 1 : noteSign(d.kind)
    const zeroRated = isZeroRatedTyp(d.typ)
    // Outward reverse-charge supplies (rchrg='Y'): per the GSTN GSTR-1→3B auto-population
    // rules only the TAXABLE VALUE enters 3.1(a) — the tax is payable by the RECIPIENT via
    // their 3.1(d), so it must not enter osup_det amounts or this supplier's liability.
    const taxPayableBySupplier = !d.rchrg
    for (const item of d.ratedItems) {
      if (zeroRated) {
        zrTaxable += sign * item.taxable
        if (taxPayableBySupplier) {
          zrIgst += sign * item.igst
          zrCess += sign * item.cess
        }
      } else {
        taxable += sign * item.taxable
        if (taxPayableBySupplier) {
          igst += sign * item.igst
          cgst += sign * item.cgst
          sgst += sign * item.sgst
          cess += sign * item.cess
        }
      }
    }
    const nilSum = d.nil.reduce((s, l) => s + l.taxable, 0)
    if (zeroRated) zrTaxable += sign * nilSum
    else nilTaxable += sign * nilSum
  }

  // 3.2 — inter-state supplies to unregistered persons, by POS (composition/UIN splits
  // need flags the ledger master doesn't carry yet — emitted as empty arrays).
  const unregByPos = new Map<string, { txval: number; iamt: number }>()
  for (const d of all) {
    if (d.partyGstin || d.typ !== 'R') continue
    const sign = d.kind === 'sales' ? 1 : noteSign(d.kind)
    for (const item of d.ratedItems) {
      if (!item.igst) continue // intra-state (or zero-tax) — 3.2 is inter-state only
      const agg = unregByPos.get(d.pos) ?? { txval: 0, iamt: 0 }
      agg.txval += sign * item.taxable
      agg.iamt += sign * item.igst
      unregByPos.set(d.pos, agg)
    }
  }
  const interState = [...unregByPos.entries()]
    .filter(([, v]) => v.txval !== 0 || v.iamt !== 0)
    .map(([pos, v]) => ({ pos, taxable: v.txval, igst: v.iamt }))
  const unregDetails = interState.map((r) => ({ pos: r.pos, txval: toRupees(r.taxable), iamt: toRupees(r.igst) }))

  // ITC: 4(A) availed − 4(B) reversed = 4(C) net; 4(D) ineligible reported separately.
  const itcAvailed = addItc(inputs.itc.impg, inputs.itc.isrc, inputs.itc.oth)
  const itcReversed = addItc(manual.itcRevRul, manual.itcRevOth)
  const itcNet = subItc(itcAvailed, itcReversed)

  const liability: InwardSummary = { igst: igst + zrIgst, cgst, sgst, cess: cess + zrCess }
  const netPayable = applySetOff(liability, itcNet)
  const rcmPayable: InwardSummary = {
    igst: inputs.rcmInward.igst, cgst: inputs.rcmInward.cgst, sgst: inputs.rcmInward.sgst, cess: inputs.rcmInward.cess
  }

  const json = {
    gstin: companyGstin,
    ret_period: period,
    sup_details: {
      osup_det: { txval: toRupees(taxable), iamt: toRupees(igst), camt: toRupees(cgst), samt: toRupees(sgst), csamt: toRupees(cess) },
      osup_zero: { txval: toRupees(zrTaxable), iamt: toRupees(zrIgst), csamt: toRupees(zrCess) },
      osup_nil_exmp: { txval: toRupees(nilTaxable) },
      isup_rev: { txval: toRupees(inputs.rcmInward.taxable), ...itcJson(inputs.rcmInward) },
      osup_nongst: { txval: 0 }
    },
    inter_sup: {
      unreg_details: unregDetails,
      comp_details: [],
      uin_details: []
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...itcJson(inputs.itc.impg) },
        { ty: 'IMPS', ...itcJson(ZERO_ITC) },
        { ty: 'ISRC', ...itcJson(inputs.itc.isrc) },
        { ty: 'ISD', ...itcJson(ZERO_ITC) },
        { ty: 'OTH', ...itcJson(inputs.itc.oth) }
      ],
      itc_rev: [
        { ty: 'RUL', ...itcJson(manual.itcRevRul) },
        { ty: 'OTH', ...itcJson(manual.itcRevOth) }
      ],
      itc_net: itcJson(itcNet),
      itc_inelg: [
        { ty: 'RUL', ...itcJson(inputs.itc.blocked) },
        { ty: 'OTH', ...itcJson(ZERO_ITC) }
      ]
    },
    intr_ltfee: {
      intr_details: itcJson(manual.interest),
      ltfee_details: { camt: toRupees(manual.lateFee.camt), samt: toRupees(manual.lateFee.samt) }
    }
  }

  return {
    period,
    gstin: companyGstin,
    outward: { taxable, igst, cgst, sgst, cess },
    zeroRated: { taxable: zrTaxable, igst: zrIgst, cess: zrCess },
    nilExempt: { taxable: nilTaxable },
    rcm: inputs.rcmInward,
    itc: itcNet,
    netPayable,
    rcmPayable,
    interState,
    itcParts: inputs.itc,
    manual,
    voucherIds: inputs.sourceVoucherIds ?? {
      outward: [], zeroRated: [], nilExempt: [], rcm: [], impg: [], isrc: [], oth: [], blocked: [], netItc: []
    },
    json
  }
}
