import { describe, it, expect } from "vitest";
import {
  buildInvoiceHtml,
  hsnSummaryForInvoice,
  INVOICE_ITEMS_PER_PAGE,
  SAMPLE_INVOICE,
  upiPaymentUri,
} from "./invoice";
import { DEFAULT_INVOICE_CONFIG } from "@shared/invoiceConfig";
import type { CompanyInfo } from "@shared/domain";
import type { EdocInvoice, EdocItem } from "@shared/gst/edocs";

const COMPANY: CompanyInfo = {
  name: "Total Traders",
  stateCode: "27",
  gstin: "27AAAAA0000A1Z5",
  gstRegistrationType: "regular",
  address: "1 Market Road, Mumbai",
  booksFrom: 2025,
  email: null,
  phone: null,
  pan: null,
  tan: null,
};

describe("buildInvoiceHtml (pure — invoice print config rendering)", () => {
  it("renders the configured title, declaration, and signatory with defaults (no logo/bank)", () => {
    const html = buildInvoiceHtml(
      COMPANY,
      DEFAULT_INVOICE_CONFIG,
      SAMPLE_INVOICE,
    );
    expect(html).toContain(DEFAULT_INVOICE_CONFIG.title);
    expect(html).toContain(DEFAULT_INVOICE_CONFIG.declaration);
    expect(html).toContain(DEFAULT_INVOICE_CONFIG.signatory);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Bank details");
  });

  it("renders the logo <img> when logoDataUrl is set", () => {
    const html = buildInvoiceHtml(
      COMPANY,
      {
        ...DEFAULT_INVOICE_CONFIG,
        logoDataUrl: "data:image/png;base64,aGVsbG8=",
      },
      SAMPLE_INVOICE,
    );
    expect(html).toContain('<img src="data:image/png;base64,aGVsbG8="');
  });

  it("renders a bank-details block when bankDetails is set, omits it when null", () => {
    const withBank = buildInvoiceHtml(
      COMPANY,
      {
        ...DEFAULT_INVOICE_CONFIG,
        bankDetails: {
          name: "Total Bank",
          account: "12345",
          ifsc: "TOTL0001",
          branch: "HQ",
        },
      },
      SAMPLE_INVOICE,
    );
    expect(withBank).toContain("Bank details");
    expect(withBank).toContain("Total Bank");
    expect(withBank).toContain("TOTL0001");

    const withoutBank = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, bankDetails: null },
      SAMPLE_INVOICE,
    );
    expect(withoutBank).not.toContain("Bank details");
  });

  it("renders an amount-bound UPI payment QR separately from the verification QR", () => {
    const details = { vpa: "accounts@totalbank", payeeName: "Total Traders" };
    const uri = upiPaymentUri(details, SAMPLE_INVOICE);
    expect(uri).toContain("pa=accounts%40totalbank");
    expect(uri).toContain("am=11800.00");
    expect(uri).toContain("tn=Invoice%20SAMPLE-1");
    const html = buildInvoiceHtml(COMPANY, {
      ...DEFAULT_INVOICE_CONFIG,
      upiDetails: details,
      paymentInstructions: "Send the UTR after payment.",
    }, SAMPLE_INVOICE);
    expect(html).toContain("Pay by UPI");
    expect(html).toContain("UPI payment QR");
    expect(html).toContain("Send the UTR after payment.");
  });

  it("renders a terms block only when terms is non-empty", () => {
    const withTerms = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, terms: "Payment due in 30 days" },
      SAMPLE_INVOICE,
    );
    expect(withTerms).toContain("Payment due in 30 days");
    const withoutTerms = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, terms: "" },
      SAMPLE_INVOICE,
    );
    expect(withoutTerms).not.toContain("Terms</div>");
  });

  it("renders selected regional customer-facing labels while preserving accounting acronyms", () => {
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, labelLanguage: "hi" },
      SAMPLE_INVOICE,
    );
    expect(html).toContain("बिल प्राप्तकर्ता");
    expect(html).toContain("कर योग्य मूल्य");
    expect(html).toContain("GSTIN");
    expect(html).toContain("HSN/SAC");
  });

  it("omits the HSN column when showHsn is false, includes it by default", () => {
    const withHsn = buildInvoiceHtml(
      COMPANY,
      DEFAULT_INVOICE_CONFIG,
      SAMPLE_INVOICE,
    );
    expect(withHsn).toContain(">HSN<");
    expect(withHsn).toContain(`>${SAMPLE_INVOICE.items[0]!.hsn}<`);

    const withoutHsn = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, showHsn: false },
      SAMPLE_INVOICE,
    );
    expect(withoutHsn).not.toContain(">HSN<");
  });

  it("adds a Discount column only when showDiscount is true", () => {
    const withDiscount = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, showDiscount: true },
      SAMPLE_INVOICE,
    );
    expect(withDiscount).toContain("Discount");
    const withoutDiscount = buildInvoiceHtml(
      COMPANY,
      DEFAULT_INVOICE_CONFIG,
      SAMPLE_INVOICE,
    );
    expect(withoutDiscount).not.toContain("Discount");
  });

  it("escapes double quotes and apostrophes in text fields, not just & < >", () => {
    const tricky = {
      ...SAMPLE_INVOICE,
      partyName: `Sam's "Best" Traders <India>`,
    };
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, tricky);
    expect(html).not.toContain(`Sam's "Best" Traders <India>`);
    expect(html).toContain("Sam&#39;s &quot;Best&quot; Traders &lt;India&gt;");
  });

  it("renders stably for the default config (snapshot)", () => {
    expect(
      buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, SAMPLE_INVOICE),
    ).toMatchSnapshot();
  });

  it("repeats the table header on every printed page and keeps rows unsplit (print CSS)", () => {
    const html = buildInvoiceHtml(
      COMPANY,
      DEFAULT_INVOICE_CONFIG,
      SAMPLE_INVOICE,
    );
    expect(html).toContain("thead { display: table-header-group; }");
    expect(html).toContain("tr { page-break-inside: avoid; }");
  });

  it("prints the actual per-line discount when showDiscount is on", () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: [{ ...SAMPLE_INVOICE.items[0]!, discountPaise: 5000 }],
    };
    const html = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, showDiscount: true },
      inv,
    );
    expect(html).toContain("50.00"); // ₹50.00 discount, honestly displayed
    // A line without a discount renders a dash, not a fake zero.
    const noDiscount = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, showDiscount: true },
      SAMPLE_INVOICE,
    );
    expect(noDiscount).toContain('<td class="r num">–</td>');
  });

  it("shows an entered-by/altered-by footer only when the toggle is on and audit info exists", () => {
    const audit = { enteredBy: "Priya", alteredBy: "Rahul" };
    const on = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, showEnteredBy: true },
      SAMPLE_INVOICE,
      audit,
    );
    expect(on).toContain("Entered by Priya");
    expect(on).toContain("Altered by Rahul");

    const off = buildInvoiceHtml(
      COMPANY,
      DEFAULT_INVOICE_CONFIG,
      SAMPLE_INVOICE,
      audit,
    );
    expect(off).not.toContain("Entered by");

    const noAudit = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, showEnteredBy: true },
      SAMPLE_INVOICE,
    );
    expect(noAudit).not.toContain("Entered by");
  });

  it("prints one page per copy label, with page-break-after between them", () => {
    const html = buildInvoiceHtml(
      COMPANY,
      {
        ...DEFAULT_INVOICE_CONFIG,
        copyLabels: ["Original for Recipient", "Duplicate for Transporter"],
      },
      SAMPLE_INVOICE,
    );
    expect(html).toContain("Original for Recipient");
    expect(html).toContain("Duplicate for Transporter");
    expect((html.match(/class="copy"/g) ?? []).length).toBe(2);
    expect(html).toContain("page-break-after: always");
  });
});

function item(overrides: Partial<EdocItem>): EdocItem {
  return { ...SAMPLE_INVOICE.items[0]!, ...overrides };
}

describe("hsnSummaryForInvoice (Q2 #96 — HSN-wise tax summary block)", () => {
  it("aggregates per (hsn, rate) bucket FIRST, then computes tax once on the aggregate", () => {
    // 3 paise @ 18% intra: per-line CGST would round to 0 each (0.27 -> 0); the 6-paise bucket
    // rounds to 1 (0.54 -> 1). Bucket-then-round is the portal semantics the block must follow.
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      igst: 0,
      items: [
        item({
          hsn: "8471",
          rate: 18,
          cessRate: 0,
          taxablePaise: 3,
          qtyMilli: 1000,
          cgst: 0,
          sgst: 0,
        }),
        item({
          hsn: "8471",
          rate: 18,
          cessRate: 0,
          taxablePaise: 3,
          qtyMilli: 1000,
          cgst: 0,
          sgst: 0,
        }),
      ],
    };
    const rows = hsnSummaryForInvoice(inv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hsn: "8471",
      rate: 18,
      taxable: 6,
      qtyMilli: 2000,
      cgst: 1,
      sgst: 1,
      igst: 0,
    });
  });

  it("keeps lines without an HSN as their own bucket instead of dropping them", () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: [
        item({ hsn: "8471", rate: 18, taxablePaise: 100000 }),
        item({ hsn: "", rate: 18, taxablePaise: 50000 }),
      ],
    };
    const rows = hsnSummaryForInvoice(inv);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.hsn)).toEqual(["", "8471"]);
    expect(rows[0]!.taxable).toBe(50000);
  });

  it("splits buckets on rate (same HSN, different rate) and uses IGST for inter-state invoices", () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      igst: 18000,
      cgst: 0,
      sgst: 0,
      items: [
        item({ hsn: "8471", rate: 18, taxablePaise: 100000 }),
        item({ hsn: "8471", rate: 12, taxablePaise: 100000 }),
      ],
    };
    const rows = hsnSummaryForInvoice(inv);
    expect(rows.map((r) => r.rate)).toEqual([12, 18]);
    expect(rows[1]).toMatchObject({ igst: 18000, cgst: 0, sgst: 0 });
  });

  it("uses the IGST column for an inter-state invoice whose lines are all 0%/exempt", () => {
    // All taxes are zero, so the amounts alone cannot reveal the supply type — buildInvoiceHtml
    // must fall back to place-of-supply vs company state ('29' vs COMPANY's '27' here).
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      partyStateCode: "29",
      pos: "29",
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 1000000,
      items: [item({ rate: 0, cgst: 0, sgst: 0, igst: 0 })],
    };
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, inv);
    expect(html).toContain(">IGST<");
    expect(html).not.toContain(">CGST<");

    const rows = hsnSummaryForInvoice(inv, "inter");
    expect(rows[0]).toMatchObject({ rate: 0, cgst: 0, sgst: 0, igst: 0 });
  });

  it("renders the HSN summary block on the invoice when showHsn is on, with — for no-HSN lines", () => {
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: [item({ hsn: "" })],
    };
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, inv);
    expect(html).toContain("HSN/SAC");
    expect(html).toContain("—");

    const off = buildInvoiceHtml(
      COMPANY,
      { ...DEFAULT_INVOICE_CONFIG, showHsn: false },
      inv,
    );
    expect(off).not.toContain("HSN/SAC");
  });
});

describe("carried-forward subtotals on long invoices (Q2 #95)", () => {
  it("short invoices render one unbroken table with no carried-forward rows", () => {
    const html = buildInvoiceHtml(
      COMPANY,
      DEFAULT_INVOICE_CONFIG,
      SAMPLE_INVOICE,
    );
    expect(html).not.toContain("Carried forward");
    expect(html).not.toContain("Brought forward");
  });

  it("long invoices split into pages with matching carried-forward/brought-forward subtotals", () => {
    const count = INVOICE_ITEMS_PER_PAGE + 4;
    const inv: EdocInvoice = {
      ...SAMPLE_INVOICE,
      items: Array.from({ length: count }, (_, i) =>
        item({ name: `Line ${i + 1}`, taxablePaise: 1000 }),
      ),
    };
    const html = buildInvoiceHtml(COMPANY, DEFAULT_INVOICE_CONFIG, inv);
    // One copy label -> exactly one page split, one carried-forward, one brought-forward.
    expect((html.match(/Carried forward/g) ?? []).length).toBe(1);
    expect((html.match(/Brought forward/g) ?? []).length).toBe(1);
    expect(html).toContain("page-split");
    // Both subtotal rows carry the same cumulative figure: 16 x 10.00 = 160.00.
    expect((html.match(/160\.00/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Every line item is still present across the pages.
    expect(html).toContain(`Line ${count}`);
  });
});
