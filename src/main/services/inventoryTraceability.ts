import type { DB } from "../db/connection";
import type {
  BomVersion,
  InventorySerial,
  LandedCostAllocation,
  ManufacturingOrder,
  StockTransfer,
} from "@shared/inventoryControl";
import { writeAudit } from "./audit";
import { stockSummary } from "./stockAnalysis";
import { saveVoucher } from "./vouchers";

function stockJournalType(db: DB): number {
  const row = db
    .prepare(
      "SELECT id FROM voucher_types WHERE kind='stock_journal' ORDER BY is_system DESC,id LIMIT 1",
    )
    .get() as { id: number } | undefined;
  if (!row) throw new Error("Stock Journal voucher type was not found");
  return row.id;
}
function nextNumber(
  db: DB,
  table: "stock_transfers" | "manufacturing_orders",
  prefix: string,
): string {
  const row = db
    .prepare(`SELECT COALESCE(MAX(id),0)+1 AS n FROM ${table}`)
    .get() as { n: number };
  return `${prefix}-${String(row.n).padStart(5, "0")}`;
}

export function listSerials(db: DB, stockItemId?: number): InventorySerial[] {
  return db
    .prepare(
      `SELECT s.id,s.stock_item_id AS stockItemId,si.name AS itemName,s.serial_no AS serialNo,s.batch_id AS batchId,b.name AS batchName,s.warranty_until AS warrantyUntil,s.note,CASE last.direction WHEN 'in' THEN 'in_stock' WHEN 'out' THEN 'issued' ELSE 'unmoved' END AS state,last.godownName,last.movementDate AS lastMovementDate,last.voucherId AS lastVoucherId FROM inventory_serials s JOIN stock_items si ON si.id=s.stock_item_id LEFT JOIN batches b ON b.id=s.batch_id LEFT JOIN (SELECT sm.serial_id,sm.direction,v.date AS movementDate,v.id AS voucherId,g.name AS godownName FROM inventory_serial_movements sm JOIN inventory_lines il ON il.id=sm.inventory_line_id JOIN vouchers v ON v.id=il.voucher_id LEFT JOIN godowns g ON g.id=il.godown_id WHERE sm.id=(SELECT sm2.id FROM inventory_serial_movements sm2 WHERE sm2.serial_id=sm.serial_id ORDER BY sm2.id DESC LIMIT 1)) last ON last.serial_id=s.id WHERE (? IS NULL OR s.stock_item_id=?) ORDER BY si.name,s.serial_no`,
    )
    .all(stockItemId ?? null, stockItemId ?? null) as InventorySerial[];
}

export function assignSerials(
  db: DB,
  input: {
    inventoryLineId: number;
    serials: {
      serialNo: string;
      warrantyUntil: string | null;
      note: string | null;
    }[];
  },
  author: string,
): InventorySerial[] {
  return db.transaction(() => {
    const line = db
      .prepare(
        `SELECT il.id,il.stock_item_id AS stockItemId,il.batch_id AS batchId,il.qty_milli AS qtyMilli,il.direction FROM inventory_lines il JOIN vouchers v ON v.id=il.voucher_id WHERE il.id=? AND v.deleted_at IS NULL`,
      )
      .get(input.inventoryLineId) as
      | {
          id: number;
          stockItemId: number;
          batchId: number | null;
          qtyMilli: number;
          direction: "in" | "out";
        }
      | undefined;
    if (!line) throw new Error("Inventory line was not found");
    const existingAssignments = db
      .prepare("SELECT COUNT(*) AS n FROM inventory_serial_movements WHERE inventory_line_id = ?")
      .get(line.id) as { n: number };
    if (existingAssignments.n > 0) throw new Error("Serials are already assigned to this inventory line");
    if (line.qtyMilli % 1000 !== 0)
      throw new Error("Serialized inventory must move in whole units");
    if (input.serials.length !== line.qtyMilli / 1000)
      throw new Error("Enter one serial number for every whole unit");
    const normalized = input.serials.map((s) => s.serialNo.trim());
    if (
      new Set(normalized.map((s) => s.toLowerCase())).size !== normalized.length
    )
      throw new Error("Serial numbers must be unique in this movement");
    for (let i = 0; i < normalized.length; i++) {
      const serialNo = normalized[i]!;
      let serial = db
        .prepare(
          "SELECT id,stock_item_id AS stockItemId,batch_id AS batchId FROM inventory_serials WHERE stock_item_id=? AND serial_no=? COLLATE NOCASE",
        )
        .get(line.stockItemId, serialNo) as
        { id: number; stockItemId: number; batchId: number | null } | undefined;
      if (line.direction === "out") {
        if (!serial) throw new Error(`${serialNo} has never been received`);
        const last = db
          .prepare(
            "SELECT direction FROM inventory_serial_movements WHERE serial_id=? ORDER BY id DESC LIMIT 1",
          )
          .get(serial.id) as { direction: "in" | "out" } | undefined;
        if (last?.direction !== "in")
          throw new Error(`${serialNo} is not in stock`);
      } else {
        if (serial) {
          const last = db
            .prepare(
              "SELECT direction FROM inventory_serial_movements WHERE serial_id=? ORDER BY id DESC LIMIT 1",
            )
            .get(serial.id) as { direction: "in" | "out" } | undefined;
          if (last?.direction === "in")
            throw new Error(`${serialNo} is already in stock`);
          db.prepare(
            "UPDATE inventory_serials SET warranty_until=?,note=? WHERE id=?",
          ).run(
            input.serials[i]!.warrantyUntil,
            input.serials[i]!.note?.trim() || null,
            serial.id,
          );
        } else {
          const id = Number(
            db
              .prepare(
                "INSERT INTO inventory_serials(stock_item_id,serial_no,batch_id,warranty_until,note) VALUES(?,?,?,?,?)",
              )
              .run(
                line.stockItemId,
                serialNo,
                line.batchId,
                input.serials[i]!.warrantyUntil,
                input.serials[i]!.note?.trim() || null,
              ).lastInsertRowid,
          );
          serial = { id, stockItemId: line.stockItemId, batchId: line.batchId };
        }
      }
      db.prepare(
        "INSERT INTO inventory_serial_movements(serial_id,inventory_line_id,direction) VALUES(?,?,?)",
      ).run(serial.id, line.id, line.direction);
      writeAudit(db, "inventory_serial", serial.id, "update", null, {
        inventoryLineId: line.id,
        direction: line.direction,
        by: author,
      });
    }
    return listSerials(db, line.stockItemId);
  })();
}

export function listTransfers(db: DB): StockTransfer[] {
  const heads = db
    .prepare(
      `SELECT t.id,t.transfer_no AS transferNo,t.transfer_date AS transferDate,t.from_godown_id AS fromGodownId,fg.name AS fromGodownName,t.to_godown_id AS toGodownId,tg.name AS toGodownName,t.status,t.dispatch_voucher_id AS dispatchVoucherId,t.receipt_voucher_id AS receiptVoucherId,t.expected_arrival AS expectedArrival,t.note,t.created_by AS createdBy,t.created_at AS createdAt,t.updated_at AS updatedAt FROM stock_transfers t JOIN godowns fg ON fg.id=t.from_godown_id JOIN godowns tg ON tg.id=t.to_godown_id ORDER BY t.transfer_date DESC,t.id DESC`,
    )
    .all() as any[];
  const lines = db.prepare(
    `SELECT l.id,l.stock_item_id AS stockItemId,si.name AS itemName,u.symbol AS unitSymbol,l.batch_id AS batchId,b.name AS batchName,l.qty_milli AS qtyMilli,l.received_qty_milli AS receivedQtyMilli,l.unit_cost_paise AS unitCostPaise FROM stock_transfer_lines l JOIN stock_items si ON si.id=l.stock_item_id JOIN units u ON u.id=si.unit_id LEFT JOIN batches b ON b.id=l.batch_id WHERE l.transfer_id=? ORDER BY l.id`,
  );
  return heads.map((h) => ({
    ...h,
    lines: lines.all(h.id),
  })) as StockTransfer[];
}
export function createTransfer(
  db: DB,
  input: {
    transferDate: string;
    fromGodownId: number;
    toGodownId: number;
    expectedArrival: string | null;
    note: string | null;
    lines: { stockItemId: number; batchId: number | null; qtyMilli: number }[];
  },
  author: string,
): StockTransfer {
  return db.transaction(() => {
    if (input.fromGodownId === input.toGodownId)
      throw new Error("Choose different source and destination godowns");
    if (!input.lines.length) throw new Error("Add at least one transfer item");
    const id = Number(
      db
        .prepare(
          `INSERT INTO stock_transfers(transfer_no,transfer_date,from_godown_id,to_godown_id,expected_arrival,note,created_by) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          nextNumber(db, "stock_transfers", "TRF"),
          input.transferDate,
          input.fromGodownId,
          input.toGodownId,
          input.expectedArrival,
          input.note?.trim() || null,
          author,
        ).lastInsertRowid,
    );
    const ins = db.prepare(
      "INSERT INTO stock_transfer_lines(transfer_id,stock_item_id,batch_id,qty_milli) VALUES(?,?,?,?)",
    );
    for (const l of input.lines)
      ins.run(id, l.stockItemId, l.batchId, l.qtyMilli);
    const row = listTransfers(db).find((r) => r.id === id)!;
    writeAudit(db, "stock_transfer", id, "create", null, row);
    return row;
  })();
}
export function setTransferStatus(
  db: DB,
  id: number,
  status: "dispatched" | "received" | "cancelled",
  author: string,
): StockTransfer {
  return db.transaction(() => {
    const before = listTransfers(db).find((r) => r.id === id);
    if (!before) throw new Error("Stock transfer was not found");
    if (status === "cancelled") {
      if (before.status !== "draft")
        throw new Error("Only a draft transfer can be cancelled");
      db.prepare(
        "UPDATE stock_transfers SET status='cancelled',updated_at=datetime('now') WHERE id=?",
      ).run(id);
    } else if (status === "dispatched") {
      if (before.status !== "draft")
        throw new Error("Only a draft transfer can be dispatched");
      const positions = new Map(
        stockSummary(db, before.transferDate, {
          godownId: before.fromGodownId,
        }).map((r) => [r.stockItemId, r]),
      );
      const company = new Map(
        stockSummary(db, before.transferDate).map((r) => [r.stockItemId, r]),
      );
      for (const line of before.lines) {
        if (
          (positions.get(line.stockItemId)?.closingQtyMilli ?? 0) <
          line.qtyMilli
        )
          throw new Error(
            `${line.itemName} is short at ${before.fromGodownName}`,
          );
        const item = company.get(line.stockItemId);
        const rate =
          item && item.closingQtyMilli > 0
            ? Math.round((item.closingValue * 1000) / item.closingQtyMilli)
            : 0;
        db.prepare(
          "UPDATE stock_transfer_lines SET unit_cost_paise=? WHERE id=?",
        ).run(rate, line.id);
      }
      const refreshed = listTransfers(db).find((r) => r.id === id)!;
      const voucher = saveVoucher(db, {
        voucherTypeId: stockJournalType(db),
        date: before.transferDate,
        partyLedgerId: null,
        narration: `Dispatched ${before.transferNo}: ${before.fromGodownName} to ${before.toGodownName}`,
        reference: before.transferNo,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [],
        inventory: refreshed.lines.map((l) => ({
          stockItemId: l.stockItemId,
          godownId: before.fromGodownId,
          batchId: l.batchId,
          qtyMilli: l.qtyMilli,
          ratePaise: l.unitCostPaise ?? 0,
          amount: Math.round((l.qtyMilli * (l.unitCostPaise ?? 0)) / 1000),
          direction: "out" as const,
        })),
        billRefs: [],
        tds: null,
      });
      db.prepare(
        "UPDATE stock_transfers SET status='dispatched',dispatch_voucher_id=?,updated_at=datetime('now') WHERE id=?",
      ).run(voucher.id, id);
    } else {
      if (before.status !== "dispatched")
        throw new Error("Only a dispatched transfer can be received");
      const voucher = saveVoucher(db, {
        voucherTypeId: stockJournalType(db),
        date: before.expectedArrival ?? before.transferDate,
        partyLedgerId: null,
        narration: `Received ${before.transferNo} at ${before.toGodownName}`,
        reference: before.transferNo,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [],
        inventory: before.lines.map((l) => ({
          stockItemId: l.stockItemId,
          godownId: before.toGodownId,
          batchId: l.batchId,
          qtyMilli: l.qtyMilli,
          ratePaise: l.unitCostPaise ?? 0,
          amount: Math.round((l.qtyMilli * (l.unitCostPaise ?? 0)) / 1000),
          direction: "in" as const,
        })),
        billRefs: [],
        tds: null,
      });
      db.prepare(
        "UPDATE stock_transfer_lines SET received_qty_milli=qty_milli WHERE transfer_id=?",
      ).run(id);
      db.prepare(
        "UPDATE stock_transfers SET status='received',receipt_voucher_id=?,updated_at=datetime('now') WHERE id=?",
      ).run(voucher.id, id);
    }
    const row = listTransfers(db).find((r) => r.id === id)!;
    writeAudit(
      db,
      "stock_transfer",
      id,
      "update",
      { status: before.status },
      { status: row.status, by: author },
    );
    return row;
  })();
}

export function listBomVersions(db: DB, itemId?: number): BomVersion[] {
  const heads = db
    .prepare(
      `SELECT b.id,b.item_id AS itemId,si.name AS itemName,b.version,b.effective_from AS effectiveFrom,b.effective_to AS effectiveTo,b.status,b.note,b.created_by AS createdBy,b.created_at AS createdAt FROM bom_versions b JOIN stock_items si ON si.id=b.item_id WHERE (? IS NULL OR b.item_id=?) ORDER BY si.name,b.effective_from DESC,b.id DESC`,
    )
    .all(itemId ?? null, itemId ?? null) as any[];
  const lines = db.prepare(
    `SELECT l.id,l.component_id AS componentId,si.name AS componentName,u.symbol AS unitSymbol,l.qty_milli_per_unit AS qtyMilliPerUnit,l.scrap_pct AS scrapPct FROM bom_version_lines l JOIN stock_items si ON si.id=l.component_id JOIN units u ON u.id=si.unit_id WHERE l.bom_version_id=? ORDER BY l.id`,
  );
  return heads.map((h) => ({ ...h, lines: lines.all(h.id) })) as BomVersion[];
}
function assertBomCycle(db: DB, itemId: number, components: number[]): void {
  const graph = new Map<number, number[]>();
  for (const row of listBomVersions(db).filter((b) => b.status === "active"))
    graph.set(
      row.itemId,
      row.lines.map((l) => l.componentId),
    );
  graph.set(itemId, components);
  const walk = (id: number, path: Set<number>): boolean => {
    if (path.has(id)) return true;
    const next = new Set(path).add(id);
    return (graph.get(id) ?? []).some((child) => walk(child, next));
  };
  if (walk(itemId, new Set()))
    throw new Error("BOM version creates a circular dependency");
}
export function createBomVersion(
  db: DB,
  input: {
    itemId: number;
    version: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    note: string | null;
    lines: { componentId: number; qtyMilliPerUnit: number; scrapPct: number }[];
  },
  author: string,
): BomVersion {
  return db.transaction(() => {
    if (input.lines.some((l) => l.componentId === input.itemId))
      throw new Error("An item cannot consume itself");
    assertBomCycle(
      db,
      input.itemId,
      input.lines.map((l) => l.componentId),
    );
    const id = Number(
      db
        .prepare(
          `INSERT INTO bom_versions(item_id,version,effective_from,effective_to,note,created_by) VALUES(?,?,?,?,?,?)`,
        )
        .run(
          input.itemId,
          input.version.trim(),
          input.effectiveFrom,
          input.effectiveTo,
          input.note?.trim() || null,
          author,
        ).lastInsertRowid,
    );
    const ins = db.prepare(
      "INSERT INTO bom_version_lines(bom_version_id,component_id,qty_milli_per_unit,scrap_pct) VALUES(?,?,?,?)",
    );
    for (const l of input.lines)
      ins.run(id, l.componentId, l.qtyMilliPerUnit, l.scrapPct);
    const row = listBomVersions(db).find((r) => r.id === id)!;
    writeAudit(db, "bom_version", id, "create", null, row);
    return row;
  })();
}
export function activateBomVersion(
  db: DB,
  id: number,
  author: string,
): BomVersion {
  return db.transaction(() => {
    const row = listBomVersions(db).find((r) => r.id === id);
    if (!row) throw new Error("BOM version was not found");
    assertBomCycle(
      db,
      row.itemId,
      row.lines.map((l) => l.componentId),
    );
    db.prepare(
      "UPDATE bom_versions SET status='retired',effective_to=CASE WHEN effective_to IS NULL THEN date(?,'-1 day') ELSE effective_to END WHERE item_id=? AND status='active' AND id<>?",
    ).run(row.effectiveFrom, row.itemId, id);
    db.prepare("UPDATE bom_versions SET status='active' WHERE id=?").run(id);
    const result = listBomVersions(db).find((r) => r.id === id)!;
    writeAudit(
      db,
      "bom_version",
      id,
      "update",
      { status: row.status },
      { status: "active", by: author },
    );
    return result;
  })();
}

export function listManufacturingOrders(db: DB): ManufacturingOrder[] {
  return db
    .prepare(
      `SELECT m.id,m.order_no AS orderNo,m.stock_item_id AS stockItemId,si.name AS itemName,u.symbol AS unitSymbol,m.planned_qty_milli AS plannedQtyMilli,m.due_date AS dueDate,m.godown_id AS godownId,g.name AS godownName,m.bom_version_id AS bomVersionId,b.version AS bomVersion,m.status,m.completed_qty_milli AS completedQtyMilli,m.production_voucher_id AS productionVoucherId,m.note,m.created_by AS createdBy,m.created_at AS createdAt,m.updated_at AS updatedAt FROM manufacturing_orders m JOIN stock_items si ON si.id=m.stock_item_id JOIN units u ON u.id=si.unit_id LEFT JOIN godowns g ON g.id=m.godown_id LEFT JOIN bom_versions b ON b.id=m.bom_version_id ORDER BY m.due_date,m.id DESC`,
    )
    .all() as ManufacturingOrder[];
}
export function createManufacturingOrder(
  db: DB,
  input: {
    stockItemId: number;
    plannedQtyMilli: number;
    dueDate: string;
    godownId: number | null;
    bomVersionId: number | null;
    note: string | null;
  },
  author: string,
): ManufacturingOrder {
  let bomId = input.bomVersionId;
  if (!bomId)
    bomId =
      (
        db
          .prepare(
            "SELECT id FROM bom_versions WHERE item_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1",
          )
          .get(input.stockItemId, input.dueDate, input.dueDate) as
          { id: number } | undefined
      )?.id ?? null;
  if (!bomId) throw new Error("No active BOM version covers the due date");
  const id = Number(
    db
      .prepare(
        `INSERT INTO manufacturing_orders(order_no,stock_item_id,planned_qty_milli,due_date,godown_id,bom_version_id,note,created_by) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        nextNumber(db, "manufacturing_orders", "MO"),
        input.stockItemId,
        input.plannedQtyMilli,
        input.dueDate,
        input.godownId,
        bomId,
        input.note?.trim() || null,
        author,
      ).lastInsertRowid,
  );
  const row = listManufacturingOrders(db).find((r) => r.id === id)!;
  writeAudit(db, "manufacturing_order", id, "create", null, row);
  return row;
}
export function setManufacturingStatus(
  db: DB,
  id: number,
  status: "released" | "completed" | "cancelled",
  author: string,
): ManufacturingOrder {
  return db.transaction(() => {
    const before = listManufacturingOrders(db).find((r) => r.id === id);
    if (!before) throw new Error("Manufacturing order was not found");
    if (status === "released") {
      if (before.status !== "planned")
        throw new Error("Only a planned order can be released");
      db.prepare(
        "UPDATE manufacturing_orders SET status='released',updated_at=datetime('now') WHERE id=?",
      ).run(id);
    } else if (status === "cancelled") {
      if (before.status === "completed")
        throw new Error("A completed order cannot be cancelled");
      db.prepare(
        "UPDATE manufacturing_orders SET status='cancelled',updated_at=datetime('now') WHERE id=?",
      ).run(id);
    } else {
      if (!["released", "in_progress"].includes(before.status))
        throw new Error("Release the order before completion");
      const bom = listBomVersions(db).find((b) => b.id === before.bomVersionId);
      if (!bom) throw new Error("The selected BOM version is unavailable");
      const positions = new Map(
        stockSummary(db, before.dueDate, {
          godownId: before.godownId ?? undefined,
        }).map((r) => [r.stockItemId, r]),
      );
      const inventory: any[] = [];
      let total = 0;
      for (const line of bom.lines) {
        const required = Math.ceil(
          ((before.plannedQtyMilli * line.qtyMilliPerUnit) / 1000) *
            (1 + line.scrapPct / 100),
        );
        const pos = positions.get(line.componentId);
        if ((pos?.closingQtyMilli ?? 0) < required)
          throw new Error(`${line.componentName} is short for production`);
        const rate =
          pos && pos.closingQtyMilli > 0
            ? Math.round((pos.closingValue * 1000) / pos.closingQtyMilli)
            : 0;
        total += Math.round((required * rate) / 1000);
        inventory.push({
          stockItemId: line.componentId,
          godownId: before.godownId,
          batchId: null,
          qtyMilli: required,
          ratePaise: rate,
          amount: Math.round((required * rate) / 1000),
          direction: "out" as const,
        });
      }
      inventory.push({
        stockItemId: before.stockItemId,
        godownId: before.godownId,
        batchId: null,
        qtyMilli: before.plannedQtyMilli,
        ratePaise: Math.round((total * 1000) / before.plannedQtyMilli),
        amount: total,
        direction: "in" as const,
      });
      const voucher = saveVoucher(db, {
        voucherTypeId: stockJournalType(db),
        date: before.dueDate,
        partyLedgerId: null,
        narration: `Production completion ${before.orderNo}`,
        reference: before.orderNo,
        instrumentNo: null,
        instrumentDate: null,
        transporterId: null,
        vehicleNo: null,
        transportDistanceKm: null,
        currencyCode: null,
        exchangeRate: null,
        lines: [],
        inventory,
        billRefs: [],
        tds: null,
      });
      db.prepare(
        "UPDATE manufacturing_orders SET status='completed',completed_qty_milli=planned_qty_milli,production_voucher_id=?,updated_at=datetime('now') WHERE id=?",
      ).run(voucher.id, id);
    }
    const row = listManufacturingOrders(db).find((r) => r.id === id)!;
    writeAudit(
      db,
      "manufacturing_order",
      id,
      "update",
      { status: before.status },
      { status: row.status, by: author },
    );
    return row;
  })();
}

export function listLandedCosts(db: DB): LandedCostAllocation[] {
  return db
    .prepare(
      `SELECT a.id,a.source_voucher_id AS sourceVoucherId,sv.number AS sourceNumber,a.inventory_line_id AS inventoryLineId,il.stock_item_id AS stockItemId,si.name AS itemName,a.cost_ledger_id AS costLedgerId,l.name AS costLedgerName,a.amount,a.method,a.note,a.created_by AS createdBy,a.created_at AS createdAt FROM landed_cost_allocations a JOIN vouchers sv ON sv.id=a.source_voucher_id JOIN inventory_lines il ON il.id=a.inventory_line_id JOIN stock_items si ON si.id=il.stock_item_id LEFT JOIN ledgers l ON l.id=a.cost_ledger_id ORDER BY a.id DESC`,
    )
    .all() as LandedCostAllocation[];
}
export function addLandedCost(
  db: DB,
  input: {
    sourceVoucherId: number;
    inventoryLineId: number;
    costLedgerId: number | null;
    amount: number;
    method: LandedCostAllocation["method"];
    note: string | null;
  },
  author: string,
): LandedCostAllocation {
  const line = db
    .prepare("SELECT direction FROM inventory_lines WHERE id=?")
    .get(input.inventoryLineId) as { direction: string } | undefined;
  if (!line || line.direction !== "in")
    throw new Error(
      "Landed cost can only be attached to an inward inventory line",
    );
  const source = db
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN dr_cr='dr' THEN amount ELSE 0 END),0) AS total FROM voucher_lines WHERE voucher_id=?",
    )
    .get(input.sourceVoucherId) as { total: number };
  const used = (
    db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) AS total FROM landed_cost_allocations WHERE source_voucher_id=?",
      )
      .get(input.sourceVoucherId) as { total: number }
  ).total;
  if (source.total > 0 && used + input.amount > source.total)
    throw new Error("Allocations exceed the source voucher debit value");
  const id = Number(
    db
      .prepare(
        `INSERT INTO landed_cost_allocations(source_voucher_id,inventory_line_id,cost_ledger_id,amount,method,note,created_by) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        input.sourceVoucherId,
        input.inventoryLineId,
        input.costLedgerId,
        input.amount,
        input.method,
        input.note?.trim() || null,
        author,
      ).lastInsertRowid,
  );
  const row = listLandedCosts(db).find((r) => r.id === id)!;
  writeAudit(db, "landed_cost", id, "create", null, row);
  return row;
}
