import { writeFileSync } from "fs";
import { join } from "path";
import type { DB } from "../db/connection";
import { backupStamp } from "../db/backup";
import { companyExportsDir } from "../paths";
import { writeAudit } from "./audit";
import { signExportIfEnabled } from "./exportSigning";
import { backgroundWork } from "./workloadGovernor";
import { systemHealth } from "./systemHealth";

function count(db: DB, table: string): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

function plan(db: DB, sql: string, ...params: unknown[]): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  ).map((row) => row.detail);
}

/** An allow-listed support artifact: counts, timings and query plans, never rows or business names. */
export function writePerformanceProfilerPack(
  db: DB,
  slug: string,
  appVersion: string,
  actor: string,
): { path: string; fields: string[] } {
  const payload = {
    schema: "total.performance-profile.v1",
    createdAt: new Date().toISOString(),
    runtime: {
      appVersion,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      memory: process.memoryUsage(),
    },
    storage: systemHealth(db, slug),
    cardinality: {
      vouchers: count(db, "vouchers"),
      voucherLines: count(db, "voucher_lines"),
      inventoryEntries: count(db, "inventory_lines"),
      ledgers: count(db, "ledgers"),
      stockItems: count(db, "stock_items"),
    },
    workload: backgroundWork.snapshot(),
    queryPlans: {
      dayBook: plan(
        db,
        "SELECT id FROM vouchers WHERE date BETWEEN ? AND ? ORDER BY date,id",
        "2000-01-01",
        "2099-12-31",
      ),
      ledger: plan(
        db,
        "SELECT vl.id FROM voucher_lines vl JOIN vouchers v ON v.id=vl.voucher_id WHERE vl.ledger_id=? AND v.date BETWEEN ? AND ? ORDER BY v.date,v.id,vl.id",
        1,
        "2000-01-01",
        "2099-12-31",
      ),
      stock: plan(
        db,
        "SELECT ie.id FROM inventory_lines ie JOIN vouchers v ON v.id=ie.voucher_id WHERE v.date<=? ORDER BY v.date,v.id,ie.id",
        "2099-12-31",
      ),
    },
  };
  const path = join(
    companyExportsDir(slug),
    `performance-profile-${backupStamp()}.json`,
  );
  writeFileSync(path, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  signExportIfEnabled(slug, path);
  const fields = Object.keys(payload);
  writeAudit(db, "performance_profile", 0, "export", null, { actor, fields });
  return { path, fields };
}
