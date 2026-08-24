import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { seededDb } from "../db/testdb";
import {
  exportLogisticsBatch,
  listEcommerceReviews,
  listSettlementReviews,
  retainEcommerceReview,
  retainSettlementReview,
} from "./partnerAdapters";

let root: string | null = null;
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("built-in partner adapters", () => {
  it("retains idempotent payout and ecommerce review evidence without posting", () => {
    const db = seededDb();
    retainSettlementReview(
      db,
      {
        provider: "stripe",
        payoutReference: "po_7",
        date: "2026-08-24",
        currency: "INR",
        grossPaise: 200_000,
        feePaise: 4_000,
        feeTaxPaise: 720,
        refundPaise: 0,
        withholdingPaise: 0,
        netPaise: 195_280,
        bankAmountPaise: 195_280,
        transactionReferences: ["ch_1"],
      },
      "Owner",
    );
    retainEcommerceReview(
      db,
      {
        source: "woocommerce",
        orderId: "WC-8",
        orderDate: "2026-08-24",
        status: "fulfilled",
        currency: "INR",
        customerName: "Mira Stores",
        customerGstin: null,
        placeOfSupply: "27",
        settlementReference: "po_7",
        shippingPaise: 0,
        returnPaise: 0,
        totalPaise: 100_000,
        lines: [
          {
            sku: "SKU-1",
            name: "Item",
            quantityMilli: 1000,
            unitPricePaise: 90_000,
            discountPaise: 0,
            taxPaise: 10_000,
          },
        ],
      },
      "Owner",
    );
    expect(listSettlementReviews(db)[0]?.status).toBe("balanced");
    expect(listEcommerceReviews(db)[0]).toMatchObject({ ready: true, totalPaise: 100_000 });
    expect(db.prepare("SELECT COUNT(*) n FROM vouchers").get()).toEqual({ n: 0 });
  });

  it("writes shipment-ready CSV plus a hash manifest", () => {
    root = mkdtempSync(join(tmpdir(), "total-logistics-"));
    process.env.TOTAL_DATA_DIR = root;
    const db = seededDb();
    const receipt = exportLogisticsBatch(
      db,
      "adapter-books",
      "shiprocket",
      [
        {
          shipmentId: "SHIP-1",
          orderReference: "SO-1",
          invoiceNumber: "INV-1",
          invoiceDate: "2026-08-24",
          recipientName: "Asha Shah",
          address: "12 Market Road, Mumbai",
          pincode: "400001",
          phone: "+919999999999",
          gstin: null,
          weightGrams: 500,
          packageCount: 1,
          collectOnDeliveryPaise: 0,
          declaredValuePaise: 125_000,
        },
      ],
      "Owner",
    );
    expect(existsSync(receipt.path)).toBe(true);
    expect(existsSync(receipt.manifestPath)).toBe(true);
    expect(readFileSync(receipt.path, "utf8")).toContain("Billing Customer Name");
    expect(receipt.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
