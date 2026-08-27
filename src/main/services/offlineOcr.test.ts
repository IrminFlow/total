import { describe, expect, it } from "vitest";
import { parseOfflineInvoiceText } from "./offlineOcr";

describe("offline OCR invoice parser", () => {
  it("extracts Indian invoice identifiers and integer-paise totals", () => {
    const result = parseOfflineInvoiceText(`
      Acme Components Private Limited
      TAX INVOICE
      Invoice No: AC/2026/1042
      Invoice Date: 27/08/2026
      GSTIN 27ABCDE1234F1Z5
      Taxable Value 12,500.00
      CGST 1,125.00
      SGST 1,125.00
      Grand Total ₹14,750.00
    `, 91.42);
    expect(result).toMatchObject({
      supplierOrMerchant: "Acme Components Private Limited",
      documentNumber: "AC/2026/1042",
      date: "2026-08-27",
      gstin: "27ABCDE1234F1Z5",
      subtotal: 1_250_000,
      total: 1_475_000,
      confidenceBps: 9_142,
    });
  });

  it("returns a reviewable partial extraction instead of inventing data", () => {
    const result = parseOfflineInvoiceText("Corner Store\nCash memo", 42, "scan.png");
    expect(result.total).toBeNull();
    expect(result.documentNumber).toBeNull();
    expect(result.warnings).toContain("Invoice total was not detected.");
  });
});
