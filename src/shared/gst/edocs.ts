/**
 * e-Invoice (NIC IRP schema 1.1) and e-Way Bill bulk-JSON builders.
 * Output matches the government offline preparation tools: generate here,
 * upload the file on the portal to obtain IRNs / EWB numbers.
 */

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
}

export interface EdocInvoice {
  number: string
  date: string // ISO
  /** Document type for DocDtls.Typ / EWB docType. Defaults to 'INV' (regular invoice) when absent. */
  docType?: 'INV' | 'CRN' | 'DBN'
  /** Supply type for TranDtls.SupTyp. Defaults to 'B2B' when absent. EXPWP/EXPWOP force
   *  BuyerDtls.Pos to '96' and BuyerDtls.Gstin to 'URP' in the e-invoice JSON. */
  supTyp?: 'B2B' | 'SEZWP' | 'SEZWOP' | 'EXPWP' | 'EXPWOP'
  partyName: string | null
  partyGstin: string | null
  partyAddress: string | null
  partyStateCode: string
  pos: string
  items: EdocItem[]
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  roundOff: number
  total: number
  transporterId: string | null
  vehicleNo: string | null
  distanceKm: number | null
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

export function buildEInvoiceJson(invoices: EdocInvoice[], company: EdocCompany): Record<string, unknown>[] {
  return invoices.map((inv) => {
    const docType = inv.docType ?? 'INV'
    const supTyp = inv.supTyp ?? 'B2B'
    // Exports have no Indian buyer GSTIN/POS — NIC schema requires Pos '96' (Other Territory)
    // and Gstin 'URP' for EXPWP/EXPWOP regardless of any party GSTIN captured locally.
    const isExport = supTyp === 'EXPWP' || supTyp === 'EXPWOP'
    return {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: supTyp, RegRev: 'N', IgstOnIntra: 'N' },
      DocDtls: { Typ: docType, No: inv.number, Dt: slashDate(inv.date) },
      SellerDtls: {
        Gstin: company.gstin,
        LglNm: company.name,
        Addr1: company.address || company.name,
        Loc: company.address || company.name,
        Pin: pinFromAddress(company.address),
        Stcd: company.stateCode
      },
      BuyerDtls: {
        Gstin: isExport ? 'URP' : (inv.partyGstin ?? 'URP'),
        LglNm: inv.partyName ?? 'Unregistered buyer',
        Pos: isExport ? '96' : inv.pos,
        Addr1: inv.partyAddress || inv.partyName || 'NA',
        Loc: inv.partyAddress || 'NA',
        Pin: pinFromAddress(inv.partyAddress),
        Stcd: inv.partyStateCode
      },
      ItemList: inv.items.map((item, i) => ({
        SlNo: String(i + 1),
        PrdDesc: item.name,
        IsServc: item.isService ? 'Y' : 'N',
        HsnCd: item.hsn,
        Qty: item.qtyMilli / 1000,
        Unit: item.uqc,
        UnitPrice: toRupees(item.unitPricePaise),
        TotAmt: toRupees(item.taxablePaise),
        Discount: 0,
        AssAmt: toRupees(item.taxablePaise),
        GstRt: item.rate,
        IgstAmt: toRupees(item.igst),
        CgstAmt: toRupees(item.cgst),
        SgstAmt: toRupees(item.sgst),
        CesRt: item.cessRate,
        CesAmt: toRupees(item.cess),
        TotItemVal: toRupees(item.taxablePaise + item.cgst + item.sgst + item.igst + item.cess)
      })),
      ValDtls: {
        AssVal: toRupees(inv.taxable),
        CgstVal: toRupees(inv.cgst),
        SgstVal: toRupees(inv.sgst),
        IgstVal: toRupees(inv.igst),
        CesVal: toRupees(inv.cess),
        RndOffAmt: toRupees(inv.roundOff),
        TotInvVal: toRupees(inv.total)
      }
    }
  })
}

export function buildEwbJson(invoices: EdocInvoice[], company: EdocCompany): Record<string, unknown> {
  return {
    version: '1.0.0421',
    billLists: invoices.map((inv) => ({
      userGstin: company.gstin,
      supplyType: 'O',
      subSupplyType: '1',
      docType: inv.docType ?? 'INV',
      docNo: inv.number,
      docDate: slashDate(inv.date),
      fromGstin: company.gstin,
      fromTrdName: company.name,
      fromAddr1: company.address || '',
      fromStateCode: Number(company.stateCode),
      actualFromStateCode: Number(company.stateCode),
      fromPincode: pinFromAddress(company.address),
      toGstin: inv.partyGstin ?? 'URP',
      toTrdName: inv.partyName ?? 'Unregistered buyer',
      toAddr1: inv.partyAddress ?? '',
      toStateCode: Number(inv.partyStateCode),
      actualToStateCode: Number(inv.pos),
      toPincode: pinFromAddress(inv.partyAddress),
      itemList: inv.items.map((item) => ({
        productName: item.name,
        productDesc: item.name,
        hsnCode: item.hsn,
        quantity: item.qtyMilli / 1000,
        qtyUnit: item.uqc,
        taxableAmount: toRupees(item.taxablePaise),
        cgstRate: item.cgst > 0 ? item.rate / 2 : 0,
        sgstRate: item.sgst > 0 ? item.rate / 2 : 0,
        igstRate: item.igst > 0 ? item.rate : 0,
        cessRate: item.cessRate
      })),
      totalValue: toRupees(inv.taxable),
      cgstValue: toRupees(inv.cgst),
      sgstValue: toRupees(inv.sgst),
      igstValue: toRupees(inv.igst),
      cessValue: toRupees(inv.cess),
      totInvValue: toRupees(inv.total),
      transMode: '1',
      transDistance: String(inv.distanceKm ?? 0),
      transporterId: inv.transporterId ?? '',
      transporterName: '',
      vehicleNo: inv.vehicleNo ?? '',
      vehicleType: 'R'
    }))
  }
}
