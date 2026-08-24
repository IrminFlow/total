import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import type { DB } from "../db/connection";
import { createGodown, createStockItem } from "./masters";
import { saveVoucher } from "./vouchers";
import { stockSummary } from "./stockAnalysis";
import * as trace from "./inventoryTraceability";

function item(db: DB, name: string): number {
  const unit = (
    db.prepare("SELECT id FROM units ORDER BY id LIMIT 1").get() as {
      id: number;
    }
  ).id;
  return createStockItem(db, {
    name,
    groupId: null,
    unitId: unit,
    hsn: null,
    gstRate: null,
    cessRate: null,
    openingQtyMilli: 0,
    openingValue: 0,
    barcode: null,
    reorderLevelMilli: null,
    valuationMethod: "weighted_avg",
  }).id;
}
function move(
  db: DB,
  date: string,
  itemId: number,
  godownId: number,
  qtyMilli: number,
  direction: "in" | "out",
  amount = 0,
): { voucherId: number; lineId: number } {
  const type = (
    db
      .prepare("SELECT id FROM voucher_types WHERE kind='stock_journal'")
      .get() as { id: number }
  ).id;
  const saved = saveVoucher(db, {
    voucherTypeId: type,
    date,
    partyLedgerId: null,
    narration: null,
    reference: null,
    instrumentNo: null,
    instrumentDate: null,
    transporterId: null,
    vehicleNo: null,
    transportDistanceKm: null,
    currencyCode: null,
    exchangeRate: null,
    lines: [],
    inventory: [
      {
        stockItemId: itemId,
        godownId,
        batchId: null,
        qtyMilli,
        ratePaise: qtyMilli ? Math.round((amount * 1000) / qtyMilli) : 0,
        amount,
        direction,
      },
    ],
    billRefs: [],
    tds: null,
  });
  const line = (
    db
      .prepare("SELECT id FROM inventory_lines WHERE voucher_id=?")
      .get(saved.id) as { id: number }
  ).id;
  return { voucherId: saved.id, lineId: line };
}

describe("inventory traceability and production", () => {
  it("tracks dispatch in transit and conserves value on receipt", () => {
    const db = seededDb();
    const id = item(db, "Transfer item");
    const from = createGodown(db, {
      name: "Plant",
      address: null,
      gstRegistrationId: null,
    }).id;
    const to = createGodown(db, {
      name: "Depot",
      address: null,
      gstRegistrationId: null,
    }).id;
    move(db, "2025-07-01", id, from, 10000, "in", 100000);
    let transfer = trace.createTransfer(
      db,
      {
        transferDate: "2025-07-10",
        fromGodownId: from,
        toGodownId: to,
        expectedArrival: "2025-07-12",
        note: null,
        lines: [{ stockItemId: id, batchId: null, qtyMilli: 10000 }],
      },
      "owner",
    );
    transfer = trace.setTransferStatus(db, transfer.id, "dispatched", "owner");
    expect(transfer.status).toBe("dispatched");
    expect(
      stockSummary(db, "2025-07-11", { godownId: from }).find(
        (r) => r.stockItemId === id,
      )?.closingQtyMilli,
    ).toBe(0);
    transfer = trace.setTransferStatus(db, transfer.id, "received", "owner");
    const depot = stockSummary(db, "2025-07-12", { godownId: to }).find(
      (r) => r.stockItemId === id,
    )!;
    expect(depot.closingQtyMilli).toBe(10000);
    expect(
      stockSummary(db, "2025-07-12").find((r) => r.stockItemId === id)
        ?.closingValue,
    ).toBe(100000);
  });
  it("enforces one live lifecycle per serial number", () => {
    const db = seededDb();
    const id = item(db, "Serialized item");
    const godown = createGodown(db, {
      name: "Serial store",
      address: null,
      gstRegistrationId: null,
    }).id;
    const incoming = move(db, "2025-07-01", id, godown, 2000, "in", 20000);
    trace.assignSerials(
      db,
      {
        inventoryLineId: incoming.lineId,
        serials: [
          { serialNo: "SN-001", warrantyUntil: "2026-07-01", note: null },
          { serialNo: "SN-002", warrantyUntil: null, note: null },
        ],
      },
      "owner",
    );
    expect(trace.listSerials(db, id).every((s) => s.state === "in_stock")).toBe(
      true,
    );
    const outgoing = move(db, "2025-07-02", id, godown, 1000, "out");
    trace.assignSerials(
      db,
      {
        inventoryLineId: outgoing.lineId,
        serials: [{ serialNo: "SN-001", warrantyUntil: null, note: null }],
      },
      "owner",
    );
    expect(
      trace.listSerials(db, id).find((s) => s.serialNo === "SN-001")?.state,
    ).toBe("issued");
    expect(() =>
      trace.assignSerials(
        db,
        {
          inventoryLineId: outgoing.lineId,
          serials: [{ serialNo: "SN-002", warrantyUntil: null, note: null }],
        },
        "owner",
      ),
    ).toThrow();
  });
  it("versions a BOM and completes a manufacturing order from available components", () => {
    const db = seededDb();
    const raw = item(db, "Raw material");
    const finished = item(db, "Finished good");
    const godown = createGodown(db, {
      name: "Factory",
      address: null,
      gstRegistrationId: null,
    }).id;
    move(db, "2025-07-01", raw, godown, 100000, "in", 500000);
    let bom = trace.createBomVersion(
      db,
      {
        itemId: finished,
        version: "1.0",
        effectiveFrom: "2025-07-01",
        effectiveTo: null,
        note: "Initial formula",
        lines: [{ componentId: raw, qtyMilliPerUnit: 2000, scrapPct: 0 }],
      },
      "engineer",
    );
    bom = trace.activateBomVersion(db, bom.id, "owner");
    expect(bom.status).toBe("active");
    let order = trace.createManufacturingOrder(
      db,
      {
        stockItemId: finished,
        plannedQtyMilli: 10000,
        dueDate: "2025-07-20",
        godownId: godown,
        bomVersionId: null,
        note: null,
      },
      "planner",
    );
    order = trace.setManufacturingStatus(db, order.id, "released", "owner");
    order = trace.setManufacturingStatus(db, order.id, "completed", "owner");
    expect(order.productionVoucherId).toBeTypeOf("number");
    expect(
      stockSummary(db, "2025-07-20").find((r) => r.stockItemId === finished)
        ?.closingQtyMilli,
    ).toBe(10000);
    expect(
      stockSummary(db, "2025-07-20").find((r) => r.stockItemId === raw)
        ?.closingQtyMilli,
    ).toBe(80000);
  });
  it("loads reviewed landed costs into the original inward layer", () => {
    const db = seededDb();
    const id = item(db, "Imported item");
    const godown = createGodown(db, {
      name: "Import store",
      address: null,
      gstRegistrationId: null,
    }).id;
    const inward = move(db, "2025-07-01", id, godown, 10000, "in", 100000);
    trace.addLandedCost(
      db,
      {
        sourceVoucherId: inward.voucherId,
        inventoryLineId: inward.lineId,
        costLedgerId: null,
        amount: 25000,
        method: "value",
        note: "Ocean freight",
      },
      "owner",
    );
    expect(
      stockSummary(db, "2025-07-31").find((r) => r.stockItemId === id)
        ?.closingValue,
    ).toBe(125000);
  });
});
