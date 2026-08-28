import { describe, expect, it } from "vitest";
import type { ExtractedDocument } from "@shared/assistiveAutomation";
import { parseOfflineInvoiceText } from "./offlineOcr";

type ReviewedField = keyof Pick<
  ExtractedDocument,
  "supplierOrMerchant" | "documentNumber" | "date" | "gstin" | "subtotal" | "tax" | "total"
>;

interface ReviewedTextFixture {
  id: string;
  captureCondition: "clean" | "phone-like" | "rotated" | "low-contrast" | "multiple-tax-rates" | "unreadable";
  recognizedText: string;
  confidence: number;
  expected: Pick<ExtractedDocument, ReviewedField>;
}

const fields: ReviewedField[] = [
  "supplierOrMerchant",
  "documentNumber",
  "date",
  "gstin",
  "subtotal",
  "tax",
  "total",
];

// These fixtures exercise the deterministic parser against reviewed recognition output. They do
// not claim camera/image recognition accuracy; binary image acceptance remains a human release gate.
const fixtures: ReviewedTextFixture[] = [
  {
    id: "clean-tax-invoice",
    captureCondition: "clean",
    recognizedText: `Aster Tools Private Limited\nTAX INVOICE\nInvoice No: AT/204\nInvoice Date: 04/06/2026\nGSTIN 29ABCDE1234F1Z5\nTaxable Value 10,000.00\nIGST 1,800.00\nGrand Total 11,800.00`,
    confidence: 96,
    expected: { supplierOrMerchant: "Aster Tools Private Limited", documentNumber: "AT/204", date: "2026-06-04", gstin: "29ABCDE1234F1Z5", subtotal: 1_000_000, tax: 180_000, total: 1_180_000 },
  },
  {
    id: "phone-whitespace",
    captureCondition: "phone-like",
    recognizedText: `  Metro   Packaging  \nTAX INVOICE\nInvoice   No : MP-881\nDate : 9-7-2026\nGSTIN 27ABCDE1234F1Z5\nTaxable Amount Rs. 2,500.00\nCGST 225.00\nSGST 225.00\nAmount Payable Rs. 2,950.00`,
    confidence: 82,
    expected: { supplierOrMerchant: "Metro Packaging", documentNumber: "MP-881", date: "2026-07-09", gstin: "27ABCDE1234F1Z5", subtotal: 250_000, tax: 45_000, total: 295_000 },
  },
  {
    id: "rotated-recognition-order",
    captureCondition: "rotated",
    recognizedText: `Grand Total 944.00\nSGST 72.00\nCGST 72.00\nTaxable Value 800.00\nGSTIN 07ABCDE1234F1Z5\nBill Date: 18.08.2026\nBill No: R/18\nNorth Paper House`,
    confidence: 78,
    expected: { supplierOrMerchant: "North Paper House", documentNumber: "R/18", date: "2026-08-18", gstin: "07ABCDE1234F1Z5", subtotal: 80_000, tax: 14_400, total: 94_400 },
  },
  {
    id: "low-contrast-partial",
    captureCondition: "low-contrast",
    recognizedText: `Faint Office Mart\nReceipt No: FM_98\nDated 2/8/26\nNet Amount 1,275.50`,
    confidence: 61,
    expected: { supplierOrMerchant: "Faint Office Mart", documentNumber: "FM_98", date: "2026-08-02", gstin: null, subtotal: null, tax: null, total: 127_550 },
  },
  {
    id: "mixed-gst-rates",
    captureCondition: "multiple-tax-rates",
    recognizedText: `Delta Distributors\nInvoice Number DD-440\nInvoice Date 21-08-2026\nGSTIN 24ABCDE1234F1Z5\nTaxable Value 5,000.00\nCGST 2.5% 50.00\nSGST 2.5% 50.00\nCGST 9% 360.00\nSGST 9% 360.00\nInvoice Total 5,820.00`,
    confidence: 90,
    expected: { supplierOrMerchant: "Delta Distributors", documentNumber: "DD-440", date: "2026-08-21", gstin: "24ABCDE1234F1Z5", subtotal: 500_000, tax: 82_000, total: 582_000 },
  },
  {
    id: "unreadable-fields",
    captureCondition: "unreadable",
    recognizedText: `Local Supplies\nTAX INVOICE\nInvoice No: ???\nDate: --/--/----\nGrand Total unreadable`,
    confidence: 28,
    expected: { supplierOrMerchant: "Local Supplies", documentNumber: null, date: null, gstin: null, subtotal: null, tax: null, total: null },
  },
];

describe("bundled offline OCR reviewed text corpus", () => {
  it.each(fixtures)("extracts $id without inventing unreadable values", (fixture) => {
    const actual = parseOfflineInvoiceText(fixture.recognizedText, fixture.confidence, `${fixture.id}.png`);
    for (const field of fields) expect(actual[field], `${fixture.id}:${field}`).toEqual(fixture.expected[field]);
    if (fixture.confidence < 70) expect(actual.warnings).toContain("OCR confidence is low; manual entry may be faster.");
  });

  it("records parser accuracy independently under the offline route", () => {
    let passed = 0;
    let tested = 0;
    const cases = fixtures.map((fixture) => {
      const actual = parseOfflineInvoiceText(fixture.recognizedText, fixture.confidence, `${fixture.id}.png`);
      const fieldResults = fields.map((field) => ({ field, passed: Object.is(actual[field], fixture.expected[field]) }));
      tested += fieldResults.length;
      passed += fieldResults.filter((result) => result.passed).length;
      return { id: fixture.id, captureCondition: fixture.captureCondition, fieldResults };
    });
    const report = {
      fixtureSet: "offline-ocr-reviewed-text-v1",
      route: "offline" as const,
      engine: "bundled-tesseract" as const,
      stage: "post-recognition-parser" as const,
      extractionAccuracyBps: Math.round((passed / tested) * 10_000),
      passed,
      tested,
      cases,
    };
    expect(report).toMatchObject({ route: "offline", extractionAccuracyBps: 10_000, passed: 42, tested: 42 });
  });
});
