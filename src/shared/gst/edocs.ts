/**
 * e-Invoice (NIC IRP schema 1.1) and e-Way Bill bulk-JSON builders.
 * Output matches the government offline preparation tools: generate here,
 * upload the file on the portal to obtain IRNs / EWB numbers.
 */

import type { TradePurpose } from '../domain'

export interface EdocItem {
  name: string
  hsn: string
  /** Quantity in thousandths of the unit. Zero for service lines. */
  qtyMilli: number
  uqc: string
  unitPricePaise: number
  taxablePaise: number
  rate: number
  cessRate: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  isService: boolean
  /** Scannable barcode/SKU stored on the stock item, if any — printed on the invoice's optional
   *  Barcode column (see invoiceConfig.showItemBarcode). */
  barcode?: string | null
  /** Per-line trade discount in paise (inventory_lines.discount_paise, lane Q #97). Display
   *  only: `taxablePaise` is already the post-discount value, so GST math never touches this. */
  discountPaise?: number | null
  /** Free-text line description for the printed invoice's optional Details column (print
   *  templates). The books don't capture one yet — samples set it; extraction leaves it unset. */
  description?: string | null
}

/** Per-voucher transport details (voucher_transport row), consumed by the EWB/e-invoice builders. */
export interface EdocTransport {
  /** NIC transport mode: '1' road, '2' rail, '3' air, '4' ship. */
  mode: string | null
  docNo: string | null
  /** ISO date. */
  docDate: string | null
  transporterName: string | null
  /** 'R' regular / 'O' over-dimensional cargo. */
  vehicleType: string | null
}

/** Ship-to (Bill To – Ship To) block from voucher_transport. */
export interface EdocShipTo {
  name: string | null
  gstin: string | null
  addr1: string | null
  addr2: string | null
  place: string | null
  pincode: string | null
  /** Two-digit state code. */
  state: string | null
}

export interface EdocInvoice {
  /** Books voucher id, when extracted from the database (absent on hand-built samples). */
  voucherId?: number
  number: string
  date: string // ISO
  /** Document type for DocDtls.Typ / EWB docType. Defaults to 'INV' (regular invoice) when absent.
   *  'CHL' = a delivery challan (WP 2.5b) — e-way bill only, never an e-invoice. */
  docType?: 'INV' | 'CRN' | 'DBN' | 'CHL'
  /** Delivery challan / GRN purpose (WP 2.5b) — drives the EWB sub-supply type of a 'CHL'. */
  purpose?: TradePurpose | null
  /** Stock notes only (WP 2.5b): the party ledger and any EWB number already recorded. */
  partyLedgerId?: number | null
  ewbNo?: string | null
  /** Supply type for TranDtls.SupTyp. Defaults to 'B2B' when absent. EXPWP/EXPWOP force
   *  BuyerDtls.Pos to '96' and BuyerDtls.Gstin to 'URP' in the e-invoice JSON. */
  supTyp?: 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP'
  partyName: string | null
  partyGstin: string | null
  partyAddress: string | null
  partyStateCode: string
  pos: string
  /** Reverse charge applies (party ledger rcm flag) — drives TranDtls.RegRev. Defaults false. */
  rchrg?: boolean
  items: EdocItem[]
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  roundOff: number
  /** Invoice total INCLUDING any TCS (what the buyer owes). */
  total: number
  /** Income-tax TCS collected on the invoice (WP 3.3) — a line after GST in the totals, reported
   *  in the e-invoice's ValDtls.OthChrg (part of TotInvVal, not of AssVal / the GST). Absent = none. */
  tcs?: { amountPaise: number; rateBp: number | null; reference: string } | null
  transporterId: string | null
  vehicleNo: string | null
  distanceKm: number | null
  /** Extended transport details (voucher_transport); null when never captured. */
  transport?: EdocTransport | null
  /** Ship-to block when goods go somewhere other than the buyer's billing address. */
  shipTo?: EdocShipTo | null
  /** Original invoice (RefDtls.PrecDocDtls) for CRN/DBN, when the reference resolves. */
  precedingDoc?: { invNo: string; invDate: string } | null
  /** NIC-issued Invoice Reference Number, once this invoice has been e-invoiced. Drives which
   *  QR payload buildInvoiceHtml prints — see src/shared/einvoiceQr.ts. */
  irn?: string | null
}

export interface EdocCompany {
  name: string
  gstin: string
  stateCode: string
  address: string
}

/**
 * EWB sub-supply type of a delivery challan by purpose (WP 2.5b, design §4.2). Codes from the
 * EWB master list — 1 Supply, 4 Job Work, 8 Others (subSupplyDesc ≤ 20 chars) —
 * https://docs.ewaybillgst.gov.in/apidocs/master-codes-list.html (read 2026-10-07).
 *
 * WP 3.5: the published supply-type × document-type mapping
 * (https://docs.ewaybillgst.gov.in/apidocs/sub-docType-mapping.html, read 2026-10-07) allows an
 * outward "Supply" only on a Tax Invoice or Bill of Supply — a Delivery Challan (CHL) is allowed
 * under Job Work, SKD/CKD/Lots, Recipient not known, For own use, Exhibition, Line Sales and
 * Others. A supply-purpose challan used to go out as 1/CHL, which the EWB system rejects (error
 * 205 "Document type does not match with transaction & Sub trans type"); it now goes as Others.
 * UNVERIFIED on the NIC sandbox: whether 'Others' + "Supply on challan" is what the officers expect.
 */
export function challanSubSupply(purpose: TradePurpose | null | undefined): { type: string; desc: string } {
  switch (purpose ?? 'supply') {
    case 'supply': return { type: '8', desc: 'Supply on challan' }
    case 'job_work': return { type: '4', desc: '' }
    case 'approval': return { type: '8', desc: 'Supply on approval' }
    case 'liquid_gas': return { type: '8', desc: 'Liquid gas' }
    default: return { type: '8', desc: 'Not a supply' }
  }
}

/** E-way bills are mandatory for goods movements above ₹50,000 invoice value. */
export const EWB_THRESHOLD_PAISE = 50_000 * 100

const toRupees = (paise: number): number => Math.round(paise) / 100

/** '2026-08-15' -> '15/08/2026' (NIC document date format). */
function slashDate(iso: string): string {
  const [y, m, d] = iso.split('-') as [string, string, string]
  return `${d}/${m}/${y}`
}

/** Best-effort PIN code: last standalone 6-digit number in the address. */
export function pinFromAddress(address: string | null): number {
  const match = address?.match(/\b(\d{6})\b(?!.*\b\d{6}\b)/)
  return match ? Number(match[1]) : 0
}

export interface AddressParts {
  addr1: string
  addr2: string
  /** City/place heuristic: the last address segment with any trailing PIN code stripped. */
  place: string
}

/**
 * Split a one-string address into the addr1/addr2/place shape the NIC schemas want.
 * Segments are newline-separated (or comma-separated when single-line); the place is the
 * last segment minus its PIN code — editable per-voucher via the Transport modal.
 */
export function splitAddress(address: string | null): AddressParts {
  const raw = (address ?? '').trim()
  if (!raw) return { addr1: '', addr2: '', place: '' }
  const segments = (raw.includes('\n') ? raw.split('\n') : raw.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  const addr1 = segments[0] ?? ''
  const last = segments.length > 1 ? segments[segments.length - 1]! : ''
  const middle = segments.slice(1, -1).join(', ')
  const place = last.replace(/\b\d{6}\b/g, '').trim().replace(/[,\s]+$/, '')
  return { addr1, addr2: middle, place }
}

/** Text field for the IRN schema: the pattern `^([^\\\"])*$` (generate-irn.html#JSONSchema) bars
 *  backslash and double quote — a `"` (inches: Laptop 14") becomes two single quotes, `\\` a slash —
 *  then clipped to the field's max length (Addr1/LglNm 100, Loc 50, PrdDesc 300, …). */
const clip = (raw: string, max: number): string => {
  const s = raw.replace(/"/g, "''").replace(/\\/g, '/')
  return s.length > max ? s.slice(0, max).trimEnd() : s
}

/**
 * NIC SellerDtls/BuyerDtls address fields from one free-text address: Addr1 (1–100), Addr2
 * (3–100, omitted when shorter), Loc (3–50 — splitAddress's place, else the first line). Lengths
 * from https://einv-apisandbox.nic.in/version1.03/generate-irn.html#JSONSchema (read 2026-10-07).
 * The whole address used to go into Addr1 and Loc, which any address over 50 chars overflows.
 */
function nicAddress(address: string | null, fallback: string): { Addr1: string; Addr2?: string; Loc: string } {
  const parts = splitAddress(address)
  const addr1 = clip(parts.addr1 || fallback, 100)
  const addr2 = clip(parts.addr2, 100)
  const loc = clip(parts.place || addr1, 50)
  return { Addr1: addr1, ...(addr2.length >= 3 ? { Addr2: addr2 } : {}), Loc: loc }
}

/** Drop null/undefined/'' members — the NIC schemas type these fields as strings/numbers, so an
 *  explicit null fails validation where an absent optional field passes. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''))
}

export function buildEInvoiceJson(invoices: EdocInvoice[], company: EdocCompany): Record<string, unknown>[] {
  return invoices.map((inv) => {
    const docType = inv.docType ?? 'INV'
    const supTyp = inv.supTyp ?? 'B2B'
    // Exports have no Indian buyer GSTIN/POS — Generate IRN validation 21: "Direct export:
    // recipient GSTIN as URP, state code 96, PIN 999999, POS 96", regardless of any party
    // GSTIN/state captured locally.
    const isExport = supTyp === 'EXPWP' || supTyp === 'EXPWOP'
    const shipTo = inv.shipTo
    const buyerPin = isExport ? 999999 : pinFromAddress(inv.partyAddress)
    const shipPin = shipTo?.pincode && /^\d{6}$/.test(shipTo.pincode) ? Number(shipTo.pincode) : 0
    return {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: supTyp, RegRev: inv.rchrg ? 'Y' : 'N', IgstOnIntra: 'N' },
      DocDtls: { Typ: docType, No: inv.number, Dt: slashDate(inv.date) },
      SellerDtls: {
        Gstin: company.gstin,
        LglNm: clip(company.name, 100),
        ...nicAddress(company.address, company.name),
        Pin: pinFromAddress(company.address),
        Stcd: company.stateCode
      },
      BuyerDtls: {
        Gstin: isExport ? 'URP' : (inv.partyGstin ?? 'URP'),
        LglNm: clip(inv.partyName ?? 'Unregistered buyer', 100),
        Pos: isExport ? '96' : inv.pos,
        ...nicAddress(inv.partyAddress, inv.partyName || 'NA'),
        // Pin is not in BuyerDtls' "required" list but must be 100000–999999 when present —
        // omitted rather than sent as 0 when the address carries none.
        ...(buyerPin ? { Pin: buyerPin } : {}),
        Stcd: isExport ? '96' : inv.partyStateCode
      },
      // Ship-to block (Bill To – Ship To) when goods are delivered elsewhere. DispDtls
      // (dispatch-from) needs a dispatch address the books don't capture — not emitted.
      ...(shipTo && (shipTo.name || shipTo.addr1)
        ? {
            ShipDtls: {
              ...(shipTo.gstin ? { Gstin: shipTo.gstin } : {}),
              LglNm: clip(shipTo.name ?? inv.partyName ?? 'NA', 100),
              Addr1: clip(shipTo.addr1 || 'NA', 100),
              ...(shipTo.addr2 && shipTo.addr2.length >= 3 ? { Addr2: clip(shipTo.addr2, 100) } : {}),
              Loc: clip(shipTo.place || 'NA', 50),
              Pin: shipPin,
              Stcd: shipTo.state ?? inv.partyStateCode
            }
          }
        : {}),
      ItemList: inv.items.map((item, i) => {
        // TotAmt is the GROSS amount and AssAmt = TotAmt − Discount (generate-irn.html
        // "Calculation Validations": "Taxable Value = Gross Amount - Discount"). taxablePaise is
        // already post-discount, so the line discount is added back for the gross.
        const discount = item.isService ? 0 : Math.max(0, item.discountPaise ?? 0)
        return {
          SlNo: String(i + 1),
          // PrdDesc is optional, but 3–300 chars when present.
          ...(item.name.trim().length >= 3 ? { PrdDesc: clip(item.name, 300) } : {}),
          IsServc: item.isService ? 'Y' : 'N',
          HsnCd: item.hsn,
          Qty: item.isService ? 1 : item.qtyMilli / 1000,
          Unit: item.isService ? 'OTH' : item.uqc,
          UnitPrice: toRupees(item.isService ? item.taxablePaise : item.unitPricePaise),
          TotAmt: toRupees(item.taxablePaise + discount),
          Discount: toRupees(discount),
          AssAmt: toRupees(item.taxablePaise),
          GstRt: item.rate,
          IgstAmt: toRupees(item.igst),
          CgstAmt: toRupees(item.cgst),
          SgstAmt: toRupees(item.sgst),
          CesRt: item.cessRate,
          CesAmt: toRupees(item.cess),
          TotItemVal: toRupees(item.taxablePaise + item.cgst + item.sgst + item.igst + item.cess)
        }
      }),
      ValDtls: {
        AssVal: toRupees(inv.taxable),
        CgstVal: toRupees(inv.cgst),
        SgstVal: toRupees(inv.sgst),
        IgstVal: toRupees(inv.igst),
        CesVal: toRupees(inv.cess),
        RndOffAmt: toRupees(inv.roundOff),
        // Income-tax TCS goes in "other charges" (included in TotInvVal, outside AssVal): the
        // practice the NIC e-invoice schema's OthChrg field is used for — UNVERIFIED against an
        // NIC FAQ (WP 3.3 report). Emitted only when the invoice carries TCS.
        ...(inv.tcs && inv.tcs.amountPaise > 0 ? { OthChrg: toRupees(inv.tcs.amountPaise) } : {}),
        TotInvVal: toRupees(inv.total)
      },
      // Export details for EXPWP/EXPWOP. Shipping bill no/date come from voucher_transport
      // (docNo/docDate); port/currency/country are not captured — omitted, never sent as null
      // (the schema types them as strings).
      ...(isExport
        ? {
            ExpDtls: compact({
              ShipBNo: inv.transport?.docNo ? clip(inv.transport.docNo, 20) : null,
              ShipBDt: inv.transport?.docDate ? slashDate(inv.transport.docDate) : null
            })
          }
        : {}),
      // Preceding-document reference for credit/debit notes, when voucher.reference resolved
      // to an actual invoice in the books (null-safe: omitted otherwise).
      ...((docType === 'CRN' || docType === 'DBN') && inv.precedingDoc
        ? {
            RefDtls: {
              PrecDocDtls: [{ InvNo: inv.precedingDoc.invNo, InvDt: slashDate(inv.precedingDoc.invDate) }]
            }
          }
        : {})
    }
  })
}

/**
 * Payload of the "Generate e-Way Bill by IRN" API, from the invoice's transport details. Fields,
 * lengths and rules from https://einv-apisandbox.nic.in/version1.03/ewaybill-generation-irn.html
 * (read 2026-10-07): Distance 0–4000 (0 = the IRP computes PIN-to-PIN, validation 10); TransMode
 * 1 road / 2 rail / 3 air / 4 ship; "If only Transporter Id is provided, then only Part-A is
 * generated … Transportation document number and date should be null" (validation 4); "If mode
 * of transportation is Road, then Vehicle number and vehicle type should be passed. If
 * Ship/Air/Rail, transport document number and date should be passed" (validation 5). Absent
 * values are left out rather than sent as null.
 */
export function buildEwbByIrnPayload(irn: string, inv: EdocInvoice): Record<string, unknown> {
  const t = inv.transport
  const vehicleNo = inv.vehicleNo ? inv.vehicleNo.replace(/[\s-]/g, '').toUpperCase() : null
  const mode = t?.mode ?? (vehicleNo ? '1' : null)
  const partAOnly = !vehicleNo && !t?.docNo && !!inv.transporterId
  const roadOrShip = mode === '1' || mode === '4'
  return compact({
    Irn: irn,
    Distance: Math.max(0, Math.min(4000, inv.distanceKm ?? 0)),
    TransMode: partAOnly ? null : mode,
    TransId: inv.transporterId || null,
    TransName: t?.transporterName && t.transporterName.trim().length >= 3 ? clip(t.transporterName, 100) : null,
    TransDocNo: partAOnly ? null : (t?.docNo ? clip(t.docNo, 15) : null),
    TransDocDt: partAOnly || !t?.docDate ? null : slashDate(t.docDate),
    VehNo: !partAOnly && roadOrShip ? vehicleNo : null,
    VehType: !partAOnly && roadOrShip && vehicleNo ? (t?.vehicleType ?? 'R') : null
  })
}

/** EWB state-code field: NIC's e-way bill system uses 99 for "Other Country" where the GST
 *  masters use 96/97 (other territory / foreign buyer). */
function ewbStateCode(code: string): number {
  return code === '96' || code === '97' ? 99 : Number(code)
}

/**
 * Build one EWB bulk-tool bill entry. `transactionType` (mandatory): 1 = regular,
 * 2 = Bill To – Ship To (goods delivered somewhere other than the buyer's address — derived
 * from the voucher_transport ship-to block). 3/4 (Bill From – Dispatch From / combination)
 * need a dispatch-from address the books don't capture, so they are never derived.
 */
function buildEwbBill(inv: EdocInvoice, company: EdocCompany): Record<string, unknown> {
  const from = splitAddress(company.address)
  const partyParts = splitAddress(inv.partyAddress)
  const rawShipTo = inv.shipTo
  const st = rawShipTo && (rawShipTo.addr1 || rawShipTo.pincode || rawShipTo.state) ? rawShipTo : null
  const shipping = st !== null
  const isExport = inv.supTyp === 'EXPWP' || inv.supTyp === 'EXPWOP'

  // Destination: ship-to when present, else the buyer's billing address.
  const toAddr1 = st ? (st.addr1 ?? '') : partyParts.addr1
  const toAddr2 = st ? (st.addr2 ?? '') : partyParts.addr2
  const toPlace = st ? (st.place ?? '') : partyParts.place
  const toPincode = st?.pincode ? Number(st.pincode) : pinFromAddress(inv.partyAddress)
  const toState = st?.state ? st.state : inv.partyStateCode

  // Rates come straight from the item's master rate + supply type — never back-derived
  // from rounded tax amounts (audit D9: a tax amount rounding to 0 must not zero the rate).
  // SEZ/export supplies are ALWAYS inter-state (sec 7(5)(b) IGST Act) even when the SEZ
  // unit sits in the company's own state — IGST rates, never a CGST/SGST split.
  const isSez = inv.supTyp === 'SEZWP' || inv.supTyp === 'SEZWOP'
  const intra = !isExport && !isSez && inv.pos === company.stateCode

  // Highest-value item's HSN leads the bill (mainHsnCode).
  const mainItem = [...inv.items].sort((a, b) => b.taxablePaise - a.taxablePaise)[0]

  return {
    userGstin: company.gstin,
    supplyType: 'O',
    // A challan (rule 55(3) CGST Rules: declared for the e-way bill) carries its purpose.
    subSupplyType: inv.docType === 'CHL' ? challanSubSupply(inv.purpose).type : '1',
    subSupplyDesc: inv.docType === 'CHL' ? challanSubSupply(inv.purpose).desc : '',
    docType: inv.docType ?? 'INV',
    docNo: inv.number,
    docDate: slashDate(inv.date),
    transactionType: shipping ? 2 : 1,
    fromGstin: company.gstin,
    fromTrdName: company.name,
    fromAddr1: from.addr1,
    fromAddr2: from.addr2,
    fromPlace: from.place,
    fromStateCode: Number(company.stateCode),
    actualFromStateCode: Number(company.stateCode),
    fromPincode: pinFromAddress(company.address),
    toGstin: isExport ? 'URP' : (inv.partyGstin ?? 'URP'),
    toTrdName: inv.partyName ?? 'Unregistered buyer',
    toAddr1,
    toAddr2,
    toPlace,
    // 99 = Other Country (exports); actual movement state comes from pos/ship-to.
    toStateCode: isExport ? 99 : ewbStateCode(toState),
    actualToStateCode: isExport ? 99 : ewbStateCode(shipping ? toState : inv.pos),
    toPincode: isExport && !toPincode ? 999999 : toPincode,
    mainHsnCode: mainItem?.hsn ?? '',
    itemList: inv.items.map((item) => ({
      productName: item.name,
      productDesc: item.name,
      hsnCode: item.hsn,
      quantity: item.qtyMilli / 1000,
      qtyUnit: item.uqc,
      taxableAmount: toRupees(item.taxablePaise),
      cgstRate: intra ? item.rate / 2 : 0,
      sgstRate: intra ? item.rate / 2 : 0,
      igstRate: intra ? 0 : item.rate,
      cessRate: item.cessRate
    })),
    totalValue: toRupees(inv.taxable),
    cgstValue: toRupees(inv.cgst),
    sgstValue: toRupees(inv.sgst),
    igstValue: toRupees(inv.igst),
    cessValue: toRupees(inv.cess),
    totInvValue: toRupees(inv.total),
    transMode: inv.transport?.mode ?? '1',
    transDistance: String(inv.distanceKm ?? 0),
    transporterId: inv.transporterId ?? '',
    transporterName: inv.transport?.transporterName ?? '',
    transDocNo: inv.transport?.docNo ?? '',
    transDocDate: inv.transport?.docDate ? slashDate(inv.transport.docDate) : '',
    vehicleNo: inv.vehicleNo ?? '',
    vehicleType: inv.transport?.vehicleType ?? 'R'
  }
}

export function buildEwbJson(invoices: EdocInvoice[], company: EdocCompany): Record<string, unknown> {
  return {
    version: '1.0.0421',
    billLists: invoices.map((inv) => buildEwbBill(inv, company))
  }
}

/**
 * Blocking problems that would make the NIC bulk tool (or the live API) reject this bill —
 * chiefly the mandatory pincode/place/state fields that used to silently export as 0/''.
 */
export function ewbIssues(inv: EdocInvoice, company: EdocCompany): string[] {
  const issues: string[] = []
  const bill = buildEwbBill(inv, company) as {
    fromPincode: number; toPincode: number; fromPlace: string; toPlace: string
    fromStateCode: number; toStateCode: number
  }
  if (!/^\d{6}$/.test(String(bill.fromPincode))) issues.push('Company address has no 6-digit PIN code')
  if (!/^\d{6}$/.test(String(bill.toPincode))) issues.push('Destination has no 6-digit PIN code')
  if (!bill.fromPlace) issues.push('Dispatch place (city) missing — set it in the company address or Transport details')
  if (!bill.toPlace) issues.push('Destination place (city) missing — set it on the party address or Transport details')
  if (!Number.isFinite(bill.fromStateCode) || bill.fromStateCode <= 0) issues.push('Company state code invalid')
  if (!Number.isFinite(bill.toStateCode) || bill.toStateCode <= 0) issues.push('Destination state code invalid')
  for (const item of inv.items) {
    if (!item.hsn) {
      issues.push(`Item "${item.name}" has no HSN code`)
      break
    }
  }
  return issues
}

/** Why a voucher is (in)eligible for an e-way bill. */
export interface EwbEligibility {
  eligible: boolean
  reason: string | null
}

/**
 * E-way bills accompany goods movement: services-only invoices are excluded, and bills at or
 * under ₹50,000 are excluded unless the caller opts in (`includeBelowThreshold`).
 */
export function ewbEligibility(inv: EdocInvoice, includeBelowThreshold = false): EwbEligibility {
  const hasGoods = inv.items.some((i) => !i.isService && i.qtyMilli !== 0)
  if (!hasGoods) return { eligible: false, reason: 'Services only — no goods movement' }
  if (!includeBelowThreshold && inv.total <= EWB_THRESHOLD_PAISE) {
    return { eligible: false, reason: `${inv.docType === 'CHL' ? 'Challan' : 'Invoice'} value at or below ₹50,000` }
  }
  return { eligible: true, reason: null }
}
