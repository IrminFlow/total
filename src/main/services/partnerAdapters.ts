import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { DB } from "../db/connection";
import { companyExportsDir } from "../paths";
import { rowsToCsv } from "@shared/csv";
import {
  ecommerceOrderSchema,
  logisticsRows,
  reviewEcommerceOrder,
  reviewSettlement,
  settlementInputSchema,
  shipmentInputSchema,
  type EcommerceOrder,
  type EcommerceOrderReview,
  type LogisticsFormat,
  type SettlementInput,
  type SettlementReview,
  type ShipmentInput,
} from "@shared/integrationAdapters";
import { writeAudit } from "./audit";
import { signExportIfEnabled } from "./exportSigning";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function listSettlementReviews(db: DB): SettlementReview[] {
  return (
    db
      .prepare(
        "SELECT review_json AS reviewJson FROM settlement_adapter_reviews ORDER BY id DESC LIMIT 500",
      )
      .all() as { reviewJson: string }[]
  ).map((row) => JSON.parse(row.reviewJson) as SettlementReview);
}

export function retainSettlementReview(
  db: DB,
  input: SettlementInput,
  actor: string,
): SettlementReview {
  const parsed = settlementInputSchema.parse(input);
  const review = reviewSettlement(parsed);
  const before = listSettlementReviews(db).find(
    (row) =>
      row.provider === review.provider &&
      row.payoutReference === review.payoutReference,
  );
  db.prepare(
    `INSERT INTO settlement_adapter_reviews(provider,payout_reference,review_json,status,created_by)
     VALUES(?,?,?,?,?) ON CONFLICT(provider,payout_reference) DO UPDATE SET
       review_json=excluded.review_json,status=excluded.status,created_by=excluded.created_by,created_at=datetime('now')`,
  ).run(
    review.provider,
    review.payoutReference,
    JSON.stringify(review),
    review.status,
    actor,
  );
  writeAudit(
    db,
    "settlement_adapter",
    0,
    before ? "update" : "create",
    before ?? null,
    review,
  );
  return review;
}

export function listEcommerceReviews(db: DB): EcommerceOrderReview[] {
  return (
    db
      .prepare(
        "SELECT review_json AS reviewJson FROM ecommerce_adapter_reviews ORDER BY id DESC LIMIT 500",
      )
      .all() as { reviewJson: string }[]
  ).map((row) => JSON.parse(row.reviewJson) as EcommerceOrderReview);
}

export function retainEcommerceReview(
  db: DB,
  input: EcommerceOrder,
  actor: string,
): EcommerceOrderReview {
  const parsed = ecommerceOrderSchema.parse(input);
  const review = reviewEcommerceOrder(parsed);
  const before = listEcommerceReviews(db).find(
    (row) => row.source === review.source && row.orderId === review.orderId,
  );
  db.prepare(
    `INSERT INTO ecommerce_adapter_reviews(source,order_id,review_json,ready,created_by)
     VALUES(?,?,?,?,?) ON CONFLICT(source,order_id) DO UPDATE SET
       review_json=excluded.review_json,ready=excluded.ready,created_by=excluded.created_by,created_at=datetime('now')`,
  ).run(
    review.source,
    review.orderId,
    JSON.stringify(review),
    review.ready ? 1 : 0,
    actor,
  );
  writeAudit(
    db,
    "ecommerce_adapter",
    0,
    before ? "update" : "create",
    before ?? null,
    review,
  );
  return review;
}

export interface LogisticsExportResult {
  id: number;
  path: string;
  manifestPath: string;
  shipmentCount: number;
  manifestHash: string;
  signaturePath?: string;
}

export function exportLogisticsBatch(
  db: DB,
  slug: string,
  format: LogisticsFormat,
  input: ShipmentInput[],
  actor: string,
): LogisticsExportResult {
  const shipments = input.map((row) => shipmentInputSchema.parse(row));
  const output = logisticsRows(format, shipments);
  const dir = join(companyExportsDir(slug), "logistics");
  mkdirSync(dir, { recursive: true });
  const base = `${stamp()}-${format}-shipments`;
  const path = join(dir, `${base}.csv`);
  const manifestPath = join(dir, `${base}.manifest.json`);
  const csv = rowsToCsv(output.headers, output.rows);
  const manifest = {
    schemaVersion: 1,
    format,
    generatedAt: new Date().toISOString(),
    shipmentCount: shipments.length,
    sourceHash: createHash("sha256")
      .update(JSON.stringify(shipments))
      .digest("hex"),
    csvHash: createHash("sha256").update(csv).digest("hex"),
    units: { money: "integer paise", weight: "integer grams" },
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  const manifestHash = createHash("sha256").update(manifestText).digest("hex");
  writeFileSync(path, csv, { mode: 0o600 });
  writeFileSync(manifestPath, manifestText, { mode: 0o600 });
  const signed = signExportIfEnabled(slug, manifestPath);
  const result = db
    .prepare(
      `INSERT INTO logistics_adapter_exports(format,path,shipment_count,manifest_hash,created_by)
       VALUES(?,?,?,?,?)`,
    )
    .run(format, path, shipments.length, manifestHash, actor);
  const receipt: LogisticsExportResult = {
    id: Number(result.lastInsertRowid),
    path,
    manifestPath,
    shipmentCount: shipments.length,
    manifestHash,
    ...(signed ? { signaturePath: signed.signaturePath } : {}),
  };
  writeAudit(db, "logistics_adapter", receipt.id, "export", null, receipt);
  return receipt;
}
