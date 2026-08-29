import { createHash } from "crypto";
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const paise = z.number().int().min(0);

export const settlementInputSchema = z
  .object({
    provider: z.enum(["generic", "razorpay", "stripe"]),
    payoutReference: z.string().trim().min(1).max(120),
    date: isoDate,
    currency: z.string().regex(/^[A-Z]{3}$/).default("INR"),
    grossPaise: paise,
    feePaise: paise.default(0),
    feeTaxPaise: paise.default(0),
    refundPaise: paise.default(0),
    withholdingPaise: paise.default(0),
    netPaise: paise,
    bankAmountPaise: paise.nullable().default(null),
    transactionReferences: z.array(z.string().max(120)).max(10_000).default([]),
  })
  .strict();
export type SettlementInput = z.infer<typeof settlementInputSchema>;

export interface SettlementReview extends SettlementInput {
  calculatedNetPaise: number;
  providerDifferencePaise: number;
  bankDifferencePaise: number | null;
  status: "balanced" | "provider_mismatch" | "bank_mismatch";
  proposedSplits: Array<{
    kind: "gross" | "fee" | "fee_tax" | "refund" | "withholding" | "bank";
    amountPaise: number;
    direction: "dr" | "cr";
  }>;
}

export function reviewSettlement(input: SettlementInput): SettlementReview {
  const value = settlementInputSchema.parse(input);
  const calculatedNetPaise =
    value.grossPaise -
    value.feePaise -
    value.feeTaxPaise -
    value.refundPaise -
    value.withholdingPaise;
  const providerDifferencePaise = value.netPaise - calculatedNetPaise;
  const bankDifferencePaise =
    value.bankAmountPaise == null ? null : value.bankAmountPaise - value.netPaise;
  const status =
    providerDifferencePaise !== 0
      ? "provider_mismatch"
      : bankDifferencePaise !== null && bankDifferencePaise !== 0
        ? "bank_mismatch"
        : "balanced";
  const proposedSplits: SettlementReview["proposedSplits"] = [
    { kind: "gross", amountPaise: value.grossPaise, direction: "cr" },
    { kind: "fee", amountPaise: value.feePaise, direction: "dr" },
    { kind: "fee_tax", amountPaise: value.feeTaxPaise, direction: "dr" },
    { kind: "refund", amountPaise: value.refundPaise, direction: "dr" },
    { kind: "withholding", amountPaise: value.withholdingPaise, direction: "dr" },
    { kind: "bank", amountPaise: value.netPaise, direction: "dr" },
  ];
  return {
    ...value,
    calculatedNetPaise,
    providerDifferencePaise,
    bankDifferencePaise,
    status,
    proposedSplits: proposedSplits.filter((row) => row.amountPaise > 0),
  };
}

const ecommerceLineSchema = z
  .object({
    sku: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(240),
    quantityMilli: z.number().int().positive(),
    unitPricePaise: paise,
    discountPaise: paise.default(0),
    taxPaise: paise.default(0),
  })
  .strict();

export const ecommerceOrderSchema = z
  .object({
    source: z.enum(["generic", "shopify", "woocommerce"]),
    orderId: z.string().trim().min(1).max(120),
    orderDate: isoDate,
    status: z.enum(["open", "fulfilled", "cancelled", "partially_returned", "returned"]),
    currency: z.string().regex(/^[A-Z]{3}$/).default("INR"),
    customerName: z.string().trim().min(1).max(200),
    customerGstin: z.string().trim().max(15).nullable().default(null),
    placeOfSupply: z.string().regex(/^\d{2}$/).nullable().default(null),
    settlementReference: z.string().trim().max(120).nullable().default(null),
    shippingPaise: paise.default(0),
    returnPaise: paise.default(0),
    totalPaise: paise,
    lines: z.array(ecommerceLineSchema).min(1).max(500),
  })
  .strict();
export type EcommerceOrder = z.infer<typeof ecommerceOrderSchema>;

export interface EcommerceOrderReview extends EcommerceOrder {
  calculatedTotalPaise: number;
  differencePaise: number;
  sourceHash: string;
  ready: boolean;
  issues: string[];
}

export function reviewEcommerceOrder(input: EcommerceOrder): EcommerceOrderReview {
  const value = ecommerceOrderSchema.parse(input);
  const calculatedTotalPaise =
    value.lines.reduce(
      (sum, line) =>
        sum +
        Math.round((line.quantityMilli * line.unitPricePaise) / 1000) -
        line.discountPaise +
        line.taxPaise,
      0,
    ) +
    value.shippingPaise -
    value.returnPaise;
  const differencePaise = value.totalPaise - calculatedTotalPaise;
  const issues: string[] = [];
  if (differencePaise !== 0)
    issues.push(`Order total differs from line calculation by ${differencePaise} paise`);
  if (value.currency !== "INR")
    issues.push("Foreign-currency order needs a reviewed exchange rate before posting");
  if (value.status === "cancelled")
    issues.push("Cancelled order is retained as evidence and must not create an invoice");
  if (value.status === "returned" || value.status === "partially_returned")
    issues.push("Return requires original invoice-line matching before a credit note");
  return {
    ...value,
    calculatedTotalPaise,
    differencePaise,
    sourceHash: createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex"),
    ready: issues.length === 0,
    issues,
  };
}

export const shipmentInputSchema = z
  .object({
    shipmentId: z.string().trim().min(1).max(120),
    orderReference: z.string().trim().min(1).max(120),
    invoiceNumber: z.string().trim().min(1).max(120),
    invoiceDate: isoDate,
    recipientName: z.string().trim().min(1).max(200),
    address: z.string().trim().min(5).max(1000),
    pincode: z.string().regex(/^\d{6}$/),
    phone: z.string().regex(/^\+?[0-9]{8,15}$/),
    gstin: z.string().trim().max(15).nullable().default(null),
    weightGrams: z.number().int().positive().max(1_000_000),
    packageCount: z.number().int().positive().max(999),
    collectOnDeliveryPaise: paise.default(0),
    declaredValuePaise: paise,
  })
  .strict();
export type ShipmentInput = z.infer<typeof shipmentInputSchema>;
export type LogisticsFormat = "generic" | "delhivery" | "shiprocket";

export function logisticsRows(
  format: LogisticsFormat,
  shipments: ShipmentInput[],
): { headers: string[]; rows: string[][] } {
  const values = z.array(shipmentInputSchema).min(1).max(10_000).parse(shipments);
  if (format === "delhivery") {
    return {
      headers: [
        "waybill",
        "order",
        "name",
        "address",
        "pin",
        "phone",
        "invoice",
        "invoice_date",
        "weight_g",
        "pieces",
        "cod_paise",
        "declared_value_paise",
      ],
      rows: values.map((row) => [
        row.shipmentId,
        row.orderReference,
        row.recipientName,
        row.address,
        row.pincode,
        row.phone,
        row.invoiceNumber,
        row.invoiceDate,
        String(row.weightGrams),
        String(row.packageCount),
        String(row.collectOnDeliveryPaise),
        String(row.declaredValuePaise),
      ]),
    };
  }
  if (format === "shiprocket") {
    return {
      headers: [
        "Order ID",
        "Invoice No",
        "Invoice Date",
        "Billing Customer Name",
        "Billing Address",
        "Billing Pincode",
        "Billing Phone",
        "GSTIN",
        "Weight (g)",
        "Quantity",
        "COD Amount (paise)",
        "Declared Value (paise)",
      ],
      rows: values.map((row) => [
        row.orderReference,
        row.invoiceNumber,
        row.invoiceDate,
        row.recipientName,
        row.address,
        row.pincode,
        row.phone,
        row.gstin ?? "",
        String(row.weightGrams),
        String(row.packageCount),
        String(row.collectOnDeliveryPaise),
        String(row.declaredValuePaise),
      ]),
    };
  }
  return {
    headers: [
      "shipment_id",
      "order_reference",
      "invoice_number",
      "invoice_date",
      "recipient_name",
      "address",
      "pincode",
      "phone",
      "gstin",
      "weight_grams",
      "package_count",
      "cod_paise",
      "declared_value_paise",
    ],
    rows: values.map((row) => [
      row.shipmentId,
      row.orderReference,
      row.invoiceNumber,
      row.invoiceDate,
      row.recipientName,
      row.address,
      row.pincode,
      row.phone,
      row.gstin ?? "",
      String(row.weightGrams),
      String(row.packageCount),
      String(row.collectOnDeliveryPaise),
      String(row.declaredValuePaise),
    ]),
  };
}
