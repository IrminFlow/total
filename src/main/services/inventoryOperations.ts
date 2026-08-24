import type { DB } from "../db/connection";
import type {
  DemandOverride,
  InventoryActionItem,
  InventoryPlannerRow,
  InventoryPlanningInput,
  StockCountSession,
  StockReservation,
} from "@shared/inventoryControl";
import { writeAudit } from "./audit";
import { batchStock, stockByGodown, stockSummary } from "./stockAnalysis";
import { saveVoucher } from "./vouchers";

const round = (n: number): number => Math.round(n);
const daysBetween = (from: string, to: string): number =>
  Math.max(
    1,
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1,
  );
function dateDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function planningDashboard(db: DB, asOn: string): InventoryPlannerRow[] {
  const since = dateDaysBefore(asOn, 89);
  const base = stockSummary(db, asOn);
  const demand = new Map(
    (
      db
        .prepare(
          `SELECT il.stock_item_id AS stockItemId,COALESCE(SUM(il.qty_milli),0) AS qtyMilli FROM inventory_lines il JOIN vouchers v ON v.id=il.voucher_id JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE il.direction='out' AND il.is_absolute=0 AND vt.kind='sales' AND v.date BETWEEN ? AND ? AND v.deleted_at IS NULL AND v.post_dated=0 AND v.is_optional=0 GROUP BY il.stock_item_id`,
        )
        .all(since, asOn) as { stockItemId: number; qtyMilli: number }[]
    ).map((r) => [r.stockItemId, r.qtyMilli]),
  );
  const priorYearDemand = new Map(
    (
      db
        .prepare(
          `SELECT il.stock_item_id AS stockItemId,COALESCE(SUM(il.qty_milli),0) AS qtyMilli FROM inventory_lines il JOIN vouchers v ON v.id=il.voucher_id JOIN voucher_types vt ON vt.id=v.voucher_type_id WHERE il.direction='out' AND il.is_absolute=0 AND vt.kind='sales' AND v.date BETWEEN date(?,'-1 year','-29 days') AND date(?,'-1 year') AND v.deleted_at IS NULL AND v.post_dated=0 AND v.is_optional=0 GROUP BY il.stock_item_id`,
        )
        .all(asOn, asOn) as { stockItemId: number; qtyMilli: number }[]
    ).map((r) => [r.stockItemId, r.qtyMilli]),
  );
  const openPo = new Map(
    (
      db
        .prepare(
          `SELECT pol.stock_item_id AS stockItemId,COALESCE(SUM(pol.qty_ordered_milli-COALESCE(receipts.accepted,0)),0) AS qtyMilli FROM purchase_order_lines pol JOIN purchase_orders po ON po.id=pol.purchase_order_id LEFT JOIN (SELECT grl.purchase_order_line_id,SUM(grl.qty_accepted_milli) AS accepted FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id=grl.goods_receipt_id WHERE gr.status='posted' GROUP BY grl.purchase_order_line_id) receipts ON receipts.purchase_order_line_id=pol.id WHERE po.status IN ('issued','part_received') GROUP BY pol.stock_item_id`,
        )
        .all() as { stockItemId: number; qtyMilli: number }[]
    ).map((r) => [r.stockItemId, Math.max(0, r.qtyMilli)]),
  );
  const reserved = new Map(
    (
      db
        .prepare(
          `SELECT stock_item_id AS stockItemId,SUM(qty_milli) AS qtyMilli FROM stock_reservations WHERE status='active' AND required_date<=? GROUP BY stock_item_id`,
        )
        .all(asOn) as { stockItemId: number; qtyMilli: number }[]
    ).map((r) => [r.stockItemId, r.qtyMilli]),
  );
  const policies = new Map(
    (
      db
        .prepare(
          `SELECT p.stock_item_id AS stockItemId,p.lead_time_days AS leadTimeDays,p.safety_stock_milli AS safetyStockMilli,p.reorder_qty_milli AS reorderQtyMilli,p.preferred_supplier_ledger_id AS preferredSupplierLedgerId,l.name AS preferredSupplierName,p.forecast_method AS forecastMethod FROM item_planning p LEFT JOIN ledgers l ON l.id=p.preferred_supplier_ledger_id`,
        )
        .all() as any[]
    ).map((r) => [r.stockItemId, r]),
  );
  const overrides = new Map(
    (
      db
        .prepare(
          "SELECT stock_item_id AS stockItemId,qty_milli AS qtyMilli FROM demand_overrides WHERE month=?",
        )
        .all(asOn.slice(0, 7)) as { stockItemId: number; qtyMilli: number }[]
    ).map((r) => [r.stockItemId, r.qtyMilli]),
  );
  const windowDays = daysBetween(since, asOn);
  return base
    .map((item) => {
      const policy = policies.get(item.stockItemId);
      const method = (policy?.forecastMethod ??
        "velocity") as InventoryPlannerRow["forecastMethod"];
      const averageDailyDemandMilli = round(
        (demand.get(item.stockItemId) ?? 0) / windowDays,
      );
      const forecast30DayMilli =
        method === "manual"
          ? (overrides.get(item.stockItemId) ?? averageDailyDemandMilli * 30)
          : method === "seasonal"
            ? (priorYearDemand.get(item.stockItemId) ??
              averageDailyDemandMilli * 30)
            : averageDailyDemandMilli * 30;
      const reservedQtyMilli = reserved.get(item.stockItemId) ?? 0;
      const availableQtyMilli = item.closingQtyMilli - reservedQtyMilli;
      const openPoQtyMilli = openPo.get(item.stockItemId) ?? 0;
      const leadTimeDays = policy?.leadTimeDays ?? 0;
      const safetyStockMilli = policy?.safetyStockMilli ?? 0;
      const reorderQtyMilli = policy?.reorderQtyMilli ?? 0;
      const shortage = Math.max(
        0,
        round(averageDailyDemandMilli * leadTimeDays) +
          safetyStockMilli -
          availableQtyMilli -
          openPoQtyMilli,
      );
      const suggestedOrderMilli =
        shortage > 0 ? Math.max(shortage, reorderQtyMilli) : 0;
      const daysCover =
        averageDailyDemandMilli > 0
          ? Math.max(0, availableQtyMilli / averageDailyDemandMilli)
          : null;
      const risk: InventoryPlannerRow["risk"] =
        availableQtyMilli < 0
          ? "stockout"
          : suggestedOrderMilli > 0
            ? "reorder"
            : daysCover !== null && daysCover > Math.max(180, leadTimeDays * 4)
              ? "excess"
              : "healthy";
      return {
        stockItemId: item.stockItemId,
        name: item.name,
        unitSymbol: item.unitSymbol,
        decimals: item.decimals,
        closingQtyMilli: item.closingQtyMilli,
        reservedQtyMilli,
        availableQtyMilli,
        openPoQtyMilli,
        averageDailyDemandMilli,
        forecast30DayMilli,
        leadTimeDays,
        safetyStockMilli,
        reorderQtyMilli,
        suggestedOrderMilli,
        daysCover,
        preferredSupplierLedgerId: policy?.preferredSupplierLedgerId ?? null,
        preferredSupplierName: policy?.preferredSupplierName ?? null,
        forecastMethod: method,
        risk,
      };
    })
    .sort(
      (a, b) =>
        ({ stockout: 0, reorder: 1, excess: 2, healthy: 3 })[a.risk] -
          { stockout: 0, reorder: 1, excess: 2, healthy: 3 }[b.risk] ||
        a.name.localeCompare(b.name),
    );
}

export function savePlanningPolicy(
  db: DB,
  input: InventoryPlanningInput,
  author: string,
): void {
  const before =
    db
      .prepare("SELECT * FROM item_planning WHERE stock_item_id=?")
      .get(input.stockItemId) ?? null;
  db.prepare(
    `INSERT INTO item_planning(stock_item_id,lead_time_days,safety_stock_milli,reorder_qty_milli,preferred_supplier_ledger_id,forecast_method,updated_by) VALUES(?,?,?,?,?,?,?) ON CONFLICT(stock_item_id) DO UPDATE SET lead_time_days=excluded.lead_time_days,safety_stock_milli=excluded.safety_stock_milli,reorder_qty_milli=excluded.reorder_qty_milli,preferred_supplier_ledger_id=excluded.preferred_supplier_ledger_id,forecast_method=excluded.forecast_method,updated_by=excluded.updated_by,updated_at=datetime('now')`,
  ).run(
    input.stockItemId,
    input.leadTimeDays,
    input.safetyStockMilli,
    input.reorderQtyMilli,
    input.preferredSupplierLedgerId,
    input.forecastMethod,
    author,
  );
  writeAudit(
    db,
    "item_planning",
    input.stockItemId,
    before ? "update" : "create",
    before,
    input,
  );
}
export function listDemandOverrides(db: DB): DemandOverride[] {
  return db
    .prepare(
      `SELECT id,stock_item_id AS stockItemId,month,qty_milli AS qtyMilli,reason,updated_by AS updatedBy,updated_at AS updatedAt FROM demand_overrides ORDER BY month DESC,stock_item_id`,
    )
    .all() as DemandOverride[];
}
export function saveDemandOverride(
  db: DB,
  input: {
    stockItemId: number;
    month: string;
    qtyMilli: number;
    reason: string;
  },
  author: string,
): DemandOverride {
  const existing = db
    .prepare("SELECT * FROM demand_overrides WHERE stock_item_id=? AND month=?")
    .get(input.stockItemId, input.month) as { id: number } | undefined;
  db.prepare(
    `INSERT INTO demand_overrides(stock_item_id,month,qty_milli,reason,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(stock_item_id,month) DO UPDATE SET qty_milli=excluded.qty_milli,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=datetime('now')`,
  ).run(
    input.stockItemId,
    input.month,
    input.qtyMilli,
    input.reason.trim(),
    author,
  );
  const row = db
    .prepare(
      `SELECT id,stock_item_id AS stockItemId,month,qty_milli AS qtyMilli,reason,updated_by AS updatedBy,updated_at AS updatedAt FROM demand_overrides WHERE stock_item_id=? AND month=?`,
    )
    .get(input.stockItemId, input.month) as DemandOverride;
  writeAudit(
    db,
    "demand_override",
    row.id,
    existing ? "update" : "create",
    existing ?? null,
    row,
  );
  return row;
}

export function listActions(db: DB): InventoryActionItem[] {
  return db
    .prepare(
      `SELECT a.id,a.stock_item_id AS stockItemId,si.name AS itemName,a.action,a.due_date AS dueDate,a.owner,a.note,a.status,a.created_by AS createdBy,a.created_at AS createdAt,a.resolved_at AS resolvedAt FROM inventory_action_items a JOIN stock_items si ON si.id=a.stock_item_id ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END,a.due_date,a.id DESC`,
    )
    .all() as InventoryActionItem[];
}
export function createAction(
  db: DB,
  input: {
    stockItemId: number;
    action: InventoryActionItem["action"];
    dueDate: string | null;
    owner: string | null;
    note: string | null;
  },
  author: string,
): InventoryActionItem {
  const id = Number(
    db
      .prepare(
        `INSERT INTO inventory_action_items(stock_item_id,action,due_date,owner,note,created_by) VALUES(?,?,?,?,?,?)`,
      )
      .run(
        input.stockItemId,
        input.action,
        input.dueDate,
        input.owner?.trim() || null,
        input.note?.trim() || null,
        author,
      ).lastInsertRowid,
  );
  const row = listActions(db).find((r) => r.id === id)!;
  writeAudit(db, "inventory_action", id, "create", null, row);
  return row;
}
export function setActionStatus(
  db: DB,
  id: number,
  status: InventoryActionItem["status"],
): InventoryActionItem {
  const before = listActions(db).find((r) => r.id === id);
  if (!before) throw new Error("Inventory action was not found");
  db.prepare(
    `UPDATE inventory_action_items SET status=?,resolved_at=CASE WHEN ?='open' THEN NULL ELSE datetime('now') END WHERE id=?`,
  ).run(status, status, id);
  const row = listActions(db).find((r) => r.id === id)!;
  writeAudit(db, "inventory_action", id, "update", before, row);
  return row;
}

export function listReservations(db: DB): StockReservation[] {
  return db
    .prepare(
      `SELECT r.id,r.stock_item_id AS stockItemId,si.name AS itemName,u.symbol AS unitSymbol,r.godown_id AS godownId,g.name AS godownName,r.batch_id AS batchId,b.name AS batchName,r.qty_milli AS qtyMilli,r.required_date AS requiredDate,r.reference,r.customer_ledger_id AS customerLedgerId,l.name AS customerName,r.status,r.created_by AS createdBy,r.created_at AS createdAt,r.resolved_at AS resolvedAt FROM stock_reservations r JOIN stock_items si ON si.id=r.stock_item_id JOIN units u ON u.id=si.unit_id LEFT JOIN godowns g ON g.id=r.godown_id LEFT JOIN batches b ON b.id=r.batch_id LEFT JOIN ledgers l ON l.id=r.customer_ledger_id ORDER BY CASE r.status WHEN 'active' THEN 0 ELSE 1 END,r.required_date,r.id DESC`,
    )
    .all() as StockReservation[];
}
export function createReservation(
  db: DB,
  input: {
    stockItemId: number;
    godownId: number | null;
    batchId: number | null;
    qtyMilli: number;
    requiredDate: string;
    reference: string;
    customerLedgerId: number | null;
  },
  author: string,
): StockReservation {
  const existing = (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty_milli),0) AS qty FROM stock_reservations WHERE stock_item_id=? AND godown_id IS ? AND status='active'`,
      )
      .get(input.stockItemId, input.godownId) as { qty: number }
  ).qty;
  const onHand = input.batchId
    ? (batchStock(db, input.requiredDate, input.stockItemId).find(
        (r) => r.batchId === input.batchId,
      )?.closingQtyMilli ?? 0)
    : (stockSummary(db, input.requiredDate, {
        godownId: input.godownId ?? undefined,
      }).find((r) => r.stockItemId === input.stockItemId)?.closingQtyMilli ??
      0);
  if (input.qtyMilli + existing > onHand)
    throw new Error("Reservation exceeds available stock for this location");
  const id = Number(
    db
      .prepare(
        `INSERT INTO stock_reservations(stock_item_id,godown_id,batch_id,qty_milli,required_date,reference,customer_ledger_id,created_by) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.stockItemId,
        input.godownId,
        input.batchId,
        input.qtyMilli,
        input.requiredDate,
        input.reference.trim(),
        input.customerLedgerId,
        author,
      ).lastInsertRowid,
  );
  const row = listReservations(db).find((r) => r.id === id)!;
  writeAudit(db, "stock_reservation", id, "create", null, row);
  return row;
}
export function setReservationStatus(
  db: DB,
  id: number,
  status: "fulfilled" | "released" | "expired",
): StockReservation {
  const before = listReservations(db).find((r) => r.id === id);
  if (!before) throw new Error("Reservation was not found");
  if (before.status !== "active")
    throw new Error("Only an active reservation can be resolved");
  db.prepare(
    `UPDATE stock_reservations SET status=?,resolved_at=datetime('now') WHERE id=?`,
  ).run(status, id);
  const row = listReservations(db).find((r) => r.id === id)!;
  writeAudit(db, "stock_reservation", id, "update", before, row);
  return row;
}

export function listCountSessions(db: DB): StockCountSession[] {
  const heads = db
    .prepare(
      `SELECT s.id,s.name,s.count_date AS countDate,s.godown_id AS godownId,g.name AS godownName,s.status,s.blind_count AS blindCount,s.posted_voucher_id AS postedVoucherId,s.created_by AS createdBy,s.created_at AS createdAt,s.updated_at AS updatedAt FROM stock_count_sessions s JOIN godowns g ON g.id=s.godown_id ORDER BY s.count_date DESC,s.id DESC`,
    )
    .all() as any[];
  const lines = db.prepare(
    `SELECT l.id,l.stock_item_id AS stockItemId,si.name AS itemName,u.symbol AS unitSymbol,u.decimals,l.batch_id AS batchId,b.name AS batchName,l.expected_qty_milli AS expectedQtyMilli,l.counted_qty_milli AS countedQtyMilli,CASE WHEN l.counted_qty_milli IS NULL THEN NULL ELSE l.counted_qty_milli-l.expected_qty_milli END AS varianceQtyMilli,l.note,l.counted_by AS countedBy,l.counted_at AS countedAt FROM stock_count_lines l JOIN stock_items si ON si.id=l.stock_item_id JOIN units u ON u.id=si.unit_id LEFT JOIN batches b ON b.id=l.batch_id WHERE l.session_id=? ORDER BY si.name`,
  );
  return heads.map((h) => ({
    ...h,
    blindCount: !!h.blindCount,
    lines: lines.all(h.id),
  })) as StockCountSession[];
}
export function createCountSession(
  db: DB,
  input: {
    name: string;
    countDate: string;
    godownId: number;
    blindCount: boolean;
  },
  author: string,
): StockCountSession {
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO stock_count_sessions(name,count_date,godown_id,blind_count,created_by) VALUES(?,?,?,?,?)`,
        )
        .run(
          input.name.trim(),
          input.countDate,
          input.godownId,
          input.blindCount ? 1 : 0,
          author,
        ).lastInsertRowid,
    );
    const positions = new Map(
      stockByGodown(db, input.countDate)
        .filter((r) => r.godownId === input.godownId)
        .map((r) => [r.stockItemId, r.closingQtyMilli]),
    );
    const items = db
      .prepare("SELECT id FROM stock_items ORDER BY id")
      .all() as { id: number }[];
    const ins = db.prepare(
      "INSERT INTO stock_count_lines(session_id,stock_item_id,batch_id,expected_qty_milli) VALUES(?,?,NULL,?)",
    );
    for (const item of items) ins.run(id, item.id, positions.get(item.id) ?? 0);
    const row = listCountSessions(db).find((r) => r.id === id)!;
    writeAudit(db, "stock_count_session", id, "create", null, {
      name: row.name,
      countDate: row.countDate,
      godownId: row.godownId,
      lineCount: row.lines.length,
    });
    return row;
  })();
}
export function saveCountLine(
  db: DB,
  input: {
    sessionId: number;
    lineId: number;
    countedQtyMilli: number;
    note: string | null;
  },
  author: string,
): StockCountSession {
  const session = listCountSessions(db).find((r) => r.id === input.sessionId);
  if (!session) throw new Error("Count session was not found");
  if (!["draft", "counting", "review"].includes(session.status))
    throw new Error("This count is no longer editable");
  if (!session.lines.some((l) => l.id === input.lineId))
    throw new Error("Count line does not belong to this session");
  db.prepare(
    `UPDATE stock_count_lines SET counted_qty_milli=?,note=?,counted_by=?,counted_at=datetime('now') WHERE id=?`,
  ).run(
    input.countedQtyMilli,
    input.note?.trim() || null,
    author,
    input.lineId,
  );
  db.prepare(
    `UPDATE stock_count_sessions SET status='counting',updated_at=datetime('now') WHERE id=? AND status='draft'`,
  ).run(input.sessionId);
  return listCountSessions(db).find((r) => r.id === input.sessionId)!;
}
export function setCountStatus(
  db: DB,
  id: number,
  status: "review" | "cancelled" | "posted",
  author: string,
): StockCountSession {
  const before = listCountSessions(db).find((r) => r.id === id);
  if (!before) throw new Error("Count session was not found");
  if (status === "review") {
    if (!["draft", "counting"].includes(before.status))
      throw new Error("Only an open count can be submitted for review");
    if (before.lines.some((l) => l.countedQtyMilli === null))
      throw new Error("Count every item before review");
    db.prepare(
      `UPDATE stock_count_sessions SET status='review',updated_at=datetime('now') WHERE id=?`,
    ).run(id);
  } else if (status === "cancelled") {
    if (before.status === "posted")
      throw new Error("A posted count cannot be cancelled");
    db.prepare(
      `UPDATE stock_count_sessions SET status='cancelled',updated_at=datetime('now') WHERE id=?`,
    ).run(id);
  } else {
    if (before.status !== "review")
      throw new Error("Submit the count for review before posting");
    const type = db
      .prepare(
        "SELECT id FROM voucher_types WHERE kind='physical_stock' ORDER BY is_system DESC,id LIMIT 1",
      )
      .get() as { id: number } | undefined;
    if (!type) throw new Error("Physical Stock voucher type was not found");
    const result = saveVoucher(db, {
      voucherTypeId: type.id,
      date: before.countDate,
      partyLedgerId: null,
      narration: `Physical count — ${before.name}`,
      reference: `COUNT-${before.id}`,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      posOverride: null,
      currencyCode: null,
      exchangeRate: null,
      lines: [],
      inventory: before.lines.map((l) => ({
        stockItemId: l.stockItemId,
        godownId: before.godownId,
        batchId: l.batchId,
        qtyMilli: l.countedQtyMilli!,
        ratePaise: 0,
        amount: 0,
        direction: "in" as const,
        isAbsolute: true,
      })),
      billRefs: [],
      tds: null,
    });
    db.prepare(
      `UPDATE stock_count_sessions SET status='posted',posted_voucher_id=?,updated_at=datetime('now') WHERE id=?`,
    ).run(result.id, id);
  }
  const row = listCountSessions(db).find((r) => r.id === id)!;
  writeAudit(
    db,
    "stock_count_session",
    id,
    "update",
    { status: before.status },
    { status: row.status, by: author, postedVoucherId: row.postedVoucherId },
  );
  return row;
}
