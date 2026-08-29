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
      tax: 225_000,
      total: 1_475_000,
      confidenceBps: 9_142,
    });
  });

  it("adds component tax lines but prefers an explicit tax total", () => {
    const components = parseOfflineInvoiceText(`
      Example Supplier
      Invoice No: M-44
      Date: 12-05-2026
      CGST 2.5% 125.00
      SGST 2.5% 125.00
      CGST 9% 450.00
      SGST 9% 450.00
      Grand Total 6,150.00
    `, 88);
    expect(components.tax).toBe(115_000);

    const explicit = parseOfflineInvoiceText(`
      Example Supplier
      Invoice No: M-45
      Date: 12-05-2026
      CGST 9% 450.00
      SGST 9% 450.00
      Total Tax 900.00
      Grand Total 5,900.00
    `, 88);
    expect(explicit.tax).toBe(90_000);
  });

  it("returns a reviewable partial extraction instead of inventing data", () => {
    const result = parseOfflineInvoiceText("Corner Store\nCash memo", 42, "scan.png");
    expect(result.total).toBeNull();
    expect(result.documentNumber).toBeNull();
    expect(result.warnings).toContain("Invoice total was not detected.");
  });
});
