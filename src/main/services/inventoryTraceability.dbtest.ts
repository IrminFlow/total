import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import type { DB } from "../db/connection";
import { createBatch, createGodown, createStockItem } from "./masters";
import { deleteVoucher, saveVoucher } from "./vouchers";
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
  batchId: number | null = null,
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
        batchId,
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
  it("blocks batch dispatch above the selected lot held at the source godown", () => {
    const db = seededDb();
    const id = item(db, "Godown batch item");
    const from = createGodown(db, {
      name: "Batch source",
      address: null,
      gstRegistrationId: null,
    }).id;
    const other = createGodown(db, {
      name: "Other batch store",
      address: null,
      gstRegistrationId: null,
    }).id;
    const to = createGodown(db, {
      name: "Batch destination",
      address: null,
      gstRegistrationId: null,
    }).id;
    const batch = createBatch(db, {
      stockItemId: id,
      name: "LOT-SOURCE",
      mfgDate: null,
      expiryDate: null,
    });
    move(db, "2025-07-01", id, from, 1000, "in", 10000, batch.id);
    move(db, "2025-07-01", id, from, 2000, "in", 20000);
    move(db, "2025-07-01", id, other, 5000, "in", 50000, batch.id);
    const transfer = trace.createTransfer(
      db,
      {
        transferDate: "2025-07-10",
        fromGodownId: from,
        toGodownId: to,
        expectedArrival: null,
        note: null,
        lines: [{ stockItemId: id, batchId: batch.id, qtyMilli: 1200 }],
      },
      "owner",
    );
    const voucherCount = db.prepare("SELECT COUNT(*) AS n FROM vouchers").get();

    expect(() =>
      trace.setTransferStatus(db, transfer.id, "dispatched", "owner"),
    ).toThrow(/Batch LOT-SOURCE is short at Batch source/);

    expect(
      db
        .prepare(
          "SELECT status,dispatch_voucher_id AS dispatchVoucherId FROM stock_transfers WHERE id=?",
        )
        .get(transfer.id),
    ).toEqual({ status: "draft", dispatchVoucherId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM vouchers").get()).toEqual(
      voucherCount,
    );
    expect(
      db
        .prepare(
          "SELECT unit_cost_paise AS unitCostPaise FROM stock_transfer_lines WHERE transfer_id=? ORDER BY id",
        )
        .all(transfer.id),
    ).toEqual([{ unitCostPaise: null }]);
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
    deleteVoucher(db, outgoing.voucherId);
    expect(
      trace.listSerials(db, id).find((s) => s.serialNo === "SN-001")?.state,
    ).toBe("in_stock");
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

  it("refuses serial assignment after the inventory voucher is moved to the bin", () => {
    const db = seededDb();
    const id = item(db, "Binned serialized item");
    const godown = createGodown(db, {
      name: "Quarantine store",
      address: null,
      gstRegistrationId: null,
    }).id;
    const incoming = move(db, "2025-07-01", id, godown, 1000, "in", 10000);
    deleteVoucher(db, incoming.voucherId);
    expect(() =>
      trace.assignSerials(
        db,
        {
          inventoryLineId: incoming.lineId,
          serials: [{ serialNo: "BIN-001", warrantyUntil: null, note: null }],
        },
        "owner",
      ),
    ).toThrow("Inventory line was not found");
  });

  it("hides and refuses landed-cost evidence after either backing voucher is binned", () => {
    const db = seededDb();
    const id = item(db, "Binned landed-cost item");
    const godown = createGodown(db, {
      name: "Import quarantine",
      address: null,
      gstRegistrationId: null,
    }).id;
    const inward = move(db, "2025-07-01", id, godown, 1000, "in", 10000);
    trace.addLandedCost(db, {
      sourceVoucherId: inward.voucherId,
      inventoryLineId: inward.lineId,
      costLedgerId: null,
      amount: 1000,
      method: "value",
      note: null,
    }, "owner");
    deleteVoucher(db, inward.voucherId);
    expect(trace.listLandedCosts(db)).toHaveLength(0);
    expect(() => trace.addLandedCost(db, {
      sourceVoucherId: inward.voucherId,
      inventoryLineId: inward.lineId,
      costLedgerId: null,
      amount: 500,
      method: "value",
      note: null,
    }, "owner")).toThrow("Voucher is not active in the books");
  });
});
