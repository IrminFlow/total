import { describe, expect, it } from "vitest";
import {
  logisticsRows,
  reviewEcommerceOrder,
  reviewSettlement,
} from "./integrationAdapters";

describe("review-first integration adapters", () => {
  it("reconciles payout gross, fees, fee tax, refunds and withholding to bank", () => {
    expect(
      reviewSettlement({
        provider: "razorpay",
        payoutReference: "setl_123",
        date: "2026-08-24",
        currency: "INR",
        grossPaise: 100_000,
        feePaise: 2_000,
        feeTaxPaise: 360,
        refundPaise: 10_000,
        withholdingPaise: 1_000,
        netPaise: 86_640,
        bankAmountPaise: 86_640,
        transactionReferences: ["pay_1"],
      }),
    ).toMatchObject({ status: "balanced", calculatedNetPaise: 86_640 });
  });

  it("retains order cancellation and return semantics outside posting", () => {
    const result = reviewEcommerceOrder({
      source: "shopify",
      orderId: "#1001",
      orderDate: "2026-08-24",
      status: "partially_returned",
      currency: "INR",
      customerName: "Mira Stores",
      customerGstin: null,
      placeOfSupply: "27",
      settlementReference: "payout-4",
      shippingPaise: 5_000,
      returnPaise: 10_000,
      totalPaise: 105_000,
      lines: [
        {
          sku: "TS-1",
          name: "Total shirt",
          quantityMilli: 1000,
          unitPricePaise: 100_000,
          discountPaise: 0,
          taxPaise: 10_000,
        },
      ],
    });
    expect(result.differencePaise).toBe(0);
    expect(result.ready).toBe(false);
    expect(result.issues.join(" ")).toMatch(/original invoice-line/);
  });

  it("generates carrier-specific shipment columns without any network dependency", () => {
    const result = logisticsRows("delhivery", [
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
        weightGrams: 750,
        packageCount: 1,
        collectOnDeliveryPaise: 0,
        declaredValuePaise: 125_000,
      },
    ]);
    expect(result.headers).toContain("declared_value_paise");
    expect(result.rows[0]).toContain("INV-1");
  });
});
