import { plainRupees } from './money'

/**
 * Payload builder for the invoice's "Verification QR" block. Pure — no DB, no SVG rendering (that
 * happens in src/main/services/invoice.ts via qrcode-generator, main-process only).
 *
 * IMPORTANT: this is NOT the NIC-signed IRN QR. The real NIC e-invoice QR is a signed JWT minted
 * by the government portal at the time an IRN is generated — we have no private key to forge one,
 * and printing a fake signed-looking QR would be actively misleading. So instead we render OUR OWN
 * QR encoding a plain JSON summary of the invoice: when an IRN exists, the JSON includes it (so a
 * human — or any JSON-aware reader — can see the invoice is e-invoiced and check the IRN by hand
 * on the NIC portal); when there's no IRN, it's just the invoice essentials. The printed invoice
 * MUST label this "Verification QR", never "IRN QR", to avoid implying it's independently signed.
 */
export interface EinvoiceQrInput {
  sellerGstin: string | null
  buyerGstin: string | null
  docNo: string
  docType: string
  /** ISO date (YYYY-MM-DD). */
  docDate: string
  totalPaise: number
  itemCount: number
  mainHsn: string | null
  /** NIC-issued Invoice Reference Number, when this invoice has been e-invoiced. */
  irn: string | null
}

/** Builds the JSON string encoded into the invoice's Verification QR. Field names deliberately
 *  echo the NIC e-invoice schema (SellerGstin/BuyerGstin/DocNo/DocTyp/DocDt/TotInvVal/ItemCnt/
 *  MainHsnCode/Irn) for familiarity, but this JSON is unsigned and self-issued — see module doc. */
export function einvoiceQrPayload(inv: EinvoiceQrInput): string {
  const payload: Record<string, string | number | null> = {
    SellerGstin: inv.sellerGstin,
    BuyerGstin: inv.buyerGstin,
    DocNo: inv.docNo,
    DocTyp: inv.docType,
    DocDt: inv.docDate,
    TotInvVal: plainRupees(inv.totalPaise),
    ItemCnt: inv.itemCount,
    MainHsnCode: inv.mainHsn
  }
  if (inv.irn) payload.Irn = inv.irn
  return JSON.stringify(payload)
}
