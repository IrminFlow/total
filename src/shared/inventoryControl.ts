export type ForecastMethod = "velocity" | "manual" | "seasonal";
export type InventoryActionKind =
  "reorder" | "discount" | "transfer" | "return" | "dispose" | "review";
export type InventoryActionStatus = "open" | "done" | "dismissed";

export interface ItemPlanningPolicy {
  stockItemId: number;
  leadTimeDays: number;
  safetyStockMilli: number;
  reorderQtyMilli: number;
  preferredSupplierLedgerId: number | null;
  preferredSupplierName: string | null;
  forecastMethod: ForecastMethod;
  updatedBy: string;
  updatedAt: string;
}

export interface InventoryPlanningInput {
  stockItemId: number;
  leadTimeDays: number;
  safetyStockMilli: number;
  reorderQtyMilli: number;
  preferredSupplierLedgerId: number | null;
  forecastMethod: ForecastMethod;
}

export interface InventoryPlannerRow {
  stockItemId: number;
  name: string;
  unitSymbol: string;
  decimals: number;
  closingQtyMilli: number;
  reservedQtyMilli: number;
  availableQtyMilli: number;
  openPoQtyMilli: number;
  averageDailyDemandMilli: number;
  forecast30DayMilli: number;
  leadTimeDays: number;
  safetyStockMilli: number;
  reorderQtyMilli: number;
  suggestedOrderMilli: number;
  daysCover: number | null;
  preferredSupplierLedgerId: number | null;
  preferredSupplierName: string | null;
  forecastMethod: ForecastMethod;
  risk: "stockout" | "reorder" | "healthy" | "excess";
}

export interface DemandOverride {
  id: number;
  stockItemId: number;
  month: string;
  qtyMilli: number;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

export interface InventoryActionItem {
  id: number;
  stockItemId: number;
  itemName: string;
  action: InventoryActionKind;
  dueDate: string | null;
  owner: string | null;
  note: string | null;
  status: InventoryActionStatus;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface StockReservation {
  id: number;
  stockItemId: number;
  itemName: string;
  unitSymbol: string;
  godownId: number | null;
  godownName: string | null;
  batchId: number | null;
  batchName: string | null;
  qtyMilli: number;
  requiredDate: string;
  reference: string;
  customerLedgerId: number | null;
  customerName: string | null;
  status: "active" | "fulfilled" | "released" | "expired";
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface StockCountLine {
  id: number;
  stockItemId: number;
  itemName: string;
  unitSymbol: string;
  decimals: number;
  batchId: number | null;
  batchName: string | null;
  expectedQtyMilli: number;
  countedQtyMilli: number | null;
  varianceQtyMilli: number | null;
  note: string | null;
  countedBy: string | null;
  countedAt: string | null;
}

export interface StockCountSession {
  id: number;
  name: string;
  countDate: string;
  godownId: number;
  godownName: string;
  status: "draft" | "counting" | "review" | "posted" | "cancelled";
  blindCount: boolean;
  postedVoucherId: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lines: StockCountLine[];
}

export interface InventorySerial {
  id: number;
  stockItemId: number;
  itemName: string;
  serialNo: string;
  batchId: number | null;
  batchName: string | null;
  warrantyUntil: string | null;
  note: string | null;
  state: "in_stock" | "issued" | "unmoved";
  godownName: string | null;
  lastMovementDate: string | null;
  lastVoucherId: number | null;
}

export interface StockTransferLine {
  id: number;
  stockItemId: number;
  itemName: string;
  unitSymbol: string;
  batchId: number | null;
  batchName: string | null;
  qtyMilli: number;
  receivedQtyMilli: number | null;
  unitCostPaise: number | null;
}
export interface StockTransfer {
  id: number;
  transferNo: string;
  transferDate: string;
  fromGodownId: number;
  fromGodownName: string;
  toGodownId: number;
  toGodownName: string;
  status: "draft" | "dispatched" | "received" | "cancelled";
  dispatchVoucherId: number | null;
  receiptVoucherId: number | null;
  expectedArrival: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lines: StockTransferLine[];
}

export interface BomVersionLine {
  id: number;
  componentId: number;
  componentName: string;
  unitSymbol: string;
  qtyMilliPerUnit: number;
  scrapPct: number;
}
export interface BomVersion {
  id: number;
  itemId: number;
  itemName: string;
  version: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "draft" | "active" | "retired";
  note: string | null;
  createdBy: string;
  createdAt: string;
  lines: BomVersionLine[];
}
export interface ManufacturingOrder {
  id: number;
  orderNo: string;
  stockItemId: number;
  itemName: string;
  unitSymbol: string;
  plannedQtyMilli: number;
  dueDate: string;
  godownId: number | null;
  godownName: string | null;
  bomVersionId: number | null;
  bomVersion: string | null;
  status: "planned" | "released" | "in_progress" | "completed" | "cancelled";
  completedQtyMilli: number;
  productionVoucherId: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface LandedCostAllocation {
  id: number;
  sourceVoucherId: number;
  sourceNumber: string;
  inventoryLineId: number;
  stockItemId: number;
  itemName: string;
  costLedgerId: number | null;
  costLedgerName: string | null;
  amount: number;
  method: "value" | "quantity" | "weight" | "manual";
  note: string | null;
  createdBy: string;
  createdAt: string;
}
