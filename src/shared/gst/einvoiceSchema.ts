/**
 * e-Invoice (IRN) JSON schema 1.1, encoded as Zod (WP 3.5).
 *
 * SOURCE — every pattern, length and range below is copied from the "JSON Schema" section of the
 * NIC e-Invoice API reference, Generate IRN v1.03:
 *   https://einv-apisandbox.nic.in/version1.03/generate-irn.html#JSONSchema   (read 2026-10-07)
 * The schema file itself is not vendored: the portal publishes no licence for it, so the
 * constraints are re-encoded here with this citation instead. The business rules in
 * `einvoiceBusinessIssues` come from the "Validations" section of the same page (numbered there;
 * the numbers are quoted next to each check).
 *
 * UNVERIFIED (no sandbox credentials): whether the IRP enforces exactly these patterns (the page
 * is the only source); the tolerance arithmetic of the calculation validations is implemented as
 * the page words it ("rupee part minus 1 … next rupee plus 1"), not checked against the IRP.
 */
import { z } from 'zod'

// ---- shared field shapes (generate-irn.html#JSONSchema) ----

/** `"^([^\\\"])*$"` — no backslash, no double quote. */
const NO_BACKSLASH_QUOTE = /^([^\\"])*$/
const text = (min: number, max: number) => z.string().min(min).max(max).regex(NO_BACKSLASH_QUOTE, 'must not contain \\ or "')
const yn = z.enum(['Y', 'N'])
/** SellerDtls.Gstin: `([0-9]{2}[0-9A-Z]{13})`, length 15. */
const gstin = z.string().length(15).regex(/^[0-9]{2}[0-9A-Z]{13}$/, 'invalid GSTIN')
/** BuyerDtls/ShipDtls.Gstin: `^(([0-9]{2}[0-9A-Z]{13})|URP)$`, length 3–15. */
const gstinOrUrp = z.string().min(3).max(15).regex(/^(([0-9]{2}[0-9A-Z]{13})|URP)$/, 'invalid GSTIN (or URP)')
/** Stcd / Pos: `^(?!0+$)([0-9]{1,2})$`. */
const stateCode = z.string().min(1).max(2).regex(/^(?!0+$)([0-9]{1,2})$/, 'invalid state code')
/** Pin: number 100000–999999. */
const pin = z.number().int().min(100000, 'PIN code must be 6 digits').max(999999, 'PIN code must be 6 digits')
/** Dates: `^[0-3][0-9]\/[0-1][0-9]\/[2][0][1-2][0-9]$` (dd/MM/yyyy). */
const nicDate = z.string().length(10).regex(/^[0-3][0-9]\/[0-1][0-9]\/[2][0][1-2][0-9]$/, 'date must be dd/mm/yyyy')
const amt = (max = 999999999999.99) => z.number().min(0).max(max)
const rate = z.number().min(0).max(999.999)

const party = {
  LglNm: text(3, 100),
  TrdNm: text(3, 100).optional(),
  Addr1: text(1, 100),
  Addr2: text(3, 100).optional(),
  Loc: text(3, 50),
  Ph: z.string().min(6).max(12).regex(/^([0-9]{6,12})$/).optional(),
  Em: z.string().min(6).max(100).regex(/^[a-zA-Z0-9+_.-]+@[a-zA-Z0-9.-]+$/).optional()
}

export const einvoiceSchema = z.object({
  Version: z.string().min(1).max(6),
  TranDtls: z.object({
    TaxSch: z.literal('GST'),
    SupTyp: z.enum(['B2B', 'SEZWP', 'SEZWOP', 'EXPWP', 'EXPWOP', 'DEXP']),
    RegRev: yn.optional(),
    EcmGstin: z.string().length(15).regex(/^([0-9]{2}[0-9A-Z]{13})$/).optional().nullable(),
    IgstOnIntra: yn.optional()
  }),
  DocDtls: z.object({
    Typ: z.enum(['INV', 'CRN', 'DBN']),
    /** `^([a-zA-Z1-9]{1}[a-zA-Z0-9\/-]{0,15})$` — 1–16 chars, cannot start with 0, / or -. */
    No: z.string().min(1).max(16).regex(/^([a-zA-Z1-9]{1}[a-zA-Z0-9/-]{0,15})$/,
      'document number: 1–16 letters/digits/"/"/"-", not starting with 0, / or -'),
    Dt: nicDate
  }),
  SellerDtls: z.object({ Gstin: gstin, ...party, Pin: pin, Stcd: stateCode }),
  BuyerDtls: z.object({ Gstin: gstinOrUrp, ...party, Pos: stateCode, Pin: pin.optional(), Stcd: stateCode }),
  DispDtls: z.object({ Nm: text(3, 100), Addr1: text(1, 100), Addr2: text(3, 100).optional(), Loc: text(3, 50), Pin: pin, Stcd: stateCode }).optional(),
  ShipDtls: z.object({
    Gstin: gstinOrUrp.optional(), LglNm: text(3, 100), TrdNm: text(3, 100).optional(), Addr1: text(1, 100),
    Addr2: text(3, 100).optional(), Loc: text(3, 50), Pin: pin, Stcd: stateCode
  }).optional(),
  ItemList: z.array(z.object({
    SlNo: z.string().min(1).max(6).regex(/^([0-9]{1,6})$/),
    PrdDesc: text(3, 300).optional(),
    IsServc: yn,
    /** `^(?!0+$)([0-9]{4}|[0-9]{6}|[0-9]{8})$` */
    HsnCd: z.string().min(4).max(8).regex(/^(?!0+$)([0-9]{4}|[0-9]{6}|[0-9]{8})$/, 'HSN/SAC must be 4, 6 or 8 digits'),
    Barcde: text(3, 30).optional(),
    Qty: z.number().min(0).max(9999999999.999).optional(),
    FreeQty: z.number().min(0).max(9999999999.999).optional(),
    /** `^([A-Z|a-z]{3,8})$` */
    Unit: z.string().min(3).max(8).regex(/^([A-Z|a-z]{3,8})$/, 'unit must be a 3–8 letter UQC').optional(),
    UnitPrice: z.number().min(0).max(999999999999.999),
    TotAmt: amt(),
    Discount: amt().optional(),
    PreTaxVal: amt().optional(),
    AssAmt: amt(),
    GstRt: rate,
    IgstAmt: amt().optional(),
    CgstAmt: amt().optional(),
    SgstAmt: amt().optional(),
    CesRt: rate.optional(),
    CesAmt: amt().optional(),
    CesNonAdvlAmt: amt().optional(),
    StateCesRt: rate.optional(),
    StateCesAmt: amt().optional(),
    StateCesNonAdvlAmt: amt().optional(),
    OthChrg: amt().optional(),
    TotItemVal: amt()
  })).min(1).max(1000),
  ValDtls: z.object({
    AssVal: amt(99999999999999.99),
    CgstVal: amt(99999999999999.99).optional(),
    SgstVal: amt(99999999999999.99).optional(),
    IgstVal: amt(99999999999999.99).optional(),
    CesVal: amt(99999999999999.99).optional(),
    StCesVal: amt(99999999999999.99).optional(),
    Discount: amt(99999999999999.99).optional(),
    OthChrg: amt(99999999999999.99).optional(),
    RndOffAmt: z.number().min(-99.99).max(99.99).optional(),
    TotInvVal: amt(99999999999999.99),
    TotInvValFc: amt(99999999999999.99).optional()
  }),
  ExpDtls: z.object({
    ShipBNo: text(1, 20).optional(),
    ShipBDt: nicDate.optional(),
    Port: z.string().min(2).max(10).regex(/^[0-9|A-Z|a-z]{2,10}$/).optional(),
    RefClm: yn.optional(),
    ForCur: z.string().min(3).max(16).regex(/^[A-Z|a-z]{3,16}$/).optional(),
    CntCode: z.string().length(2).regex(/^([A-Z]{2})$/).optional(),
    ExpDuty: amt().optional()
  }).optional(),
  RefDtls: z.object({
    PrecDocDtls: z.array(z.object({
      InvNo: z.string().min(1).max(16).regex(/^[1-9a-zA-Z]{1}[0-9a-zA-Z/-]{1,15}$/),
      InvDt: nicDate
    })).optional()
  }).optional()
})

export type EInvoiceDoc = z.infer<typeof einvoiceSchema>

/** Tolerance window of the calculation validations (generate-irn.html#validations, "Tolerance
 *  Limits"): calculated 2345.04 allows 2344.00 … 2347.00 — rupee part minus 1, up to the next
 *  rupee plus 1. */
export function withinNicTolerance(passed: number, calculated: number): boolean {
  const lo = Math.floor(calculated) - 1
  const hi = Math.ceil(calculated) + 1
  return passed >= lo - 1e-9 && passed <= hi + 1e-9
}

const r2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Business validations the IRP applies on top of the schema that a builder can get wrong
 * (generate-irn.html#validations; numbers in brackets are the page's own list numbering, or the
 * sub-heading for the item/calculation rules). Returns human-readable problems; [] = clean.
 */
export function einvoiceBusinessIssues(doc: EInvoiceDoc): string[] {
  const issues: string[] = []
  const sup = doc.TranDtls.SupTyp
  const isExport = sup === 'EXPWP' || sup === 'EXPWOP'
  const isSez = sup === 'SEZWP' || sup === 'SEZWOP'
  // [21] Direct export: recipient GSTIN URP, state code 96, PIN 999999, POS 96.
  if (isExport) {
    const b = doc.BuyerDtls
    if (b.Gstin !== 'URP' || b.Stcd !== '96' || b.Pos !== '96' || b.Pin !== 999999) {
      issues.push('Export: buyer GSTIN must be URP, state code and place of supply 96, PIN 999999')
    }
  } else if (doc.BuyerDtls.Gstin === 'URP') {
    // Error 2212 "The recipient GSTIN cannot be URP for supply type {0}" (INV error list).
    issues.push(`Buyer GSTIN cannot be URP for supply type ${sup}`)
  }
  // [23] First two GSTIN digits match the state code.
  if (doc.SellerDtls.Gstin.slice(0, 2) !== doc.SellerDtls.Stcd.padStart(2, '0')) {
    issues.push('Seller GSTIN does not match the seller state code (IRP error 2258)')
  }
  if (!isExport && doc.BuyerDtls.Gstin !== 'URP' && doc.BuyerDtls.Gstin.slice(0, 2) !== doc.BuyerDtls.Stcd.padStart(2, '0')) {
    issues.push('Buyer GSTIN does not match the buyer state code (IRP error 2265)')
  }
  // [31]/[32] intra- vs inter-state from seller state and POS; exports and SEZ always inter-state.
  const intra = !isExport && !isSez && doc.TranDtls.IgstOnIntra !== 'Y' && doc.SellerDtls.Stcd === doc.BuyerDtls.Pos
  const seen = new Set<string>()
  let sumAss = 0, sumCgst = 0, sumSgst = 0, sumIgst = 0, sumCes = 0, sumItems = 0
  for (const it of doc.ItemList) {
    if (seen.has(it.SlNo)) issues.push(`Duplicate item serial number ${it.SlNo} (IRP error 2233)`)
    seen.add(it.SlNo)
    // Item validations: "Quantity and UQC mandatory for goods; optional for services".
    if (it.IsServc === 'N' && (it.Qty === undefined || !it.Unit)) issues.push(`Item ${it.SlNo}: goods need a quantity and unit`)
    // Item validations: service HSN codes must be service-related (SAC chapter 99).
    if (it.IsServc === 'Y' && !it.HsnCd.startsWith('99')) issues.push(`Item ${it.SlNo}: a service needs a SAC (99…) code`)
    if (it.IsServc === 'N' && it.HsnCd.startsWith('99')) issues.push(`Item ${it.SlNo}: goods cannot carry a SAC (99…) code`)
    // "Taxable Value = Gross Amount - Discount".
    if (!withinNicTolerance(it.AssAmt, it.TotAmt - (it.Discount ?? 0))) issues.push(`Item ${it.SlNo}: taxable value ≠ gross amount − discount`)
    const igst = it.IgstAmt ?? 0, cgst = it.CgstAmt ?? 0, sgst = it.SgstAmt ?? 0, ces = it.CesAmt ?? 0
    if (doc.DocDtls.Typ === 'INV') {
      // "Credit/Debit notes: tax values not validated against rates/taxable values."
      if (intra) {
        if (igst !== 0) issues.push(`Item ${it.SlNo}: intra-state supply carries IGST (IRP error 2172)`)
        if (!withinNicTolerance(cgst, (it.AssAmt * it.GstRt) / 200) || !withinNicTolerance(sgst, (it.AssAmt * it.GstRt) / 200)) {
          issues.push(`Item ${it.SlNo}: CGST/SGST do not match taxable value × rate (IRP error 2234)`)
        }
      } else {
        if (cgst !== 0 || sgst !== 0) issues.push(`Item ${it.SlNo}: inter-state supply carries CGST/SGST`)
        // "EXPWOP/SEZWOP: IGST validation skipped if passed value is ZERO".
        const skip = (sup === 'EXPWOP' || sup === 'SEZWOP') && igst === 0
        if (!skip && !withinNicTolerance(igst, (it.AssAmt * it.GstRt) / 100)) issues.push(`Item ${it.SlNo}: IGST does not match taxable value × rate`)
      }
      // Same zero-value allowance for cess on a without-payment (LUT/bond) supply — an assumption:
      // the page states it for IGST only (UNVERIFIED for cess).
      const skipCess = (sup === 'EXPWOP' || sup === 'SEZWOP') && ces === 0
      if (!skipCess && !withinNicTolerance(ces, (it.AssAmt * (it.CesRt ?? 0)) / 100)) issues.push(`Item ${it.SlNo}: cess does not match taxable value × cess rate`)
    }
    // "Total Item Value = Taxable + SGST + CGST + IGST + Cess + State Cess + Non-Advol + Other charges".
    const itemTotal = it.AssAmt + igst + cgst + sgst + ces + (it.CesNonAdvlAmt ?? 0) + (it.StateCesAmt ?? 0) + (it.StateCesNonAdvlAmt ?? 0) + (it.OthChrg ?? 0)
    // Reverse charge: tax may be included or excluded in the total item value.
    const rcmOk = doc.TranDtls.RegRev === 'Y' && withinNicTolerance(it.TotItemVal, it.AssAmt)
    if (!withinNicTolerance(it.TotItemVal, itemTotal) && !rcmOk) issues.push(`Item ${it.SlNo}: total item value does not add up`)
    sumAss += it.AssAmt; sumCgst += cgst; sumSgst += sgst; sumIgst += igst; sumCes += ces; sumItems += it.TotItemVal
  }
  // Invoice level: totals = sums of the item values.
  const v = doc.ValDtls
  const checks: [string, number | undefined, number][] = [
    ['assessable value', v.AssVal, sumAss], ['CGST', v.CgstVal, sumCgst], ['SGST', v.SgstVal, sumSgst],
    ['IGST', v.IgstVal, sumIgst], ['cess', v.CesVal, sumCes]
  ]
  for (const [label, passed, calc] of checks) {
    if (!withinNicTolerance(passed ?? 0, r2(calc))) issues.push(`Invoice ${label} is not the sum of the items`)
  }
  // "Total Invoice Value = sum of item totals - invoice discount + invoice other charges + round-off"
  // (error 2189 "Total Invoice Value is not matching with calculated value").
  const calcTotal = r2(sumItems - (v.Discount ?? 0) + (v.OthChrg ?? 0) + (v.RndOffAmt ?? 0))
  if (!withinNicTolerance(v.TotInvVal, calcTotal)) issues.push('Total invoice value does not match the items + other charges + round-off (IRP error 2189)')
  return issues
}

/** Schema + business validation: [] when the document would pass the IRP's published checks. */
export function einvoiceIssues(doc: unknown): string[] {
  const parsed = einvoiceSchema.safeParse(doc)
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join('.') || 'document'}: ${i.message}`)
  }
  return einvoiceBusinessIssues(parsed.data)
}
