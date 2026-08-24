import { describe, expect, it } from "vitest";
import { seededDb } from "../db/testdb";
import { saveVoucher } from "./vouchers";
import { assignSerials } from "./inventoryTraceability";
import {
  assignCustomer,
  createSalesReturnDraft,
  createSubscription,
  listSubscriptions,
  openWarrantyClaim,
  recordSalesReturn,
  resolveWarrantyClaim,
  salesReturnCandidates,
  saveCustomField,
  saveTerritory,
  setSubscriptionStatus,
  territorySales,
  validateCustomFields,
  warrantyRegister,
} from "./customerOperations";
import { saveSalesRecurringSchedule } from "./salesRecurring";

function fixtures() {
  const db = seededDb(),
    group = (name: string) =>
      (
        db.prepare("SELECT id FROM groups WHERE name=?").get(name) as {
          id: number;
        }
      ).id,
    unit = (db.prepare("SELECT id FROM units LIMIT 1").get() as { id: number })
      .id;
  const customerId = Number(
      db
        .prepare("INSERT INTO ledgers(name,group_id) VALUES('Atlas Retail',?)")
        .run(group("Sundry Debtors")).lastInsertRowid,
    ),
    salesLedgerId = Number(
      db
        .prepare("INSERT INTO ledgers(name,group_id) VALUES('Product Sales',?)")
        .run(group("Sales Accounts")).lastInsertRowid,
    ),
    itemId = Number(
      db
        .prepare(
          "INSERT INTO stock_items(name,unit_id,gst_rate) VALUES('Control Unit',?,0)",
        )
        .run(unit).lastInsertRowid,
    );
  const post = (
    kind: "sales" | "credit_note",
    qtyMilli: number,
    direction: "out" | "in",
  ) => {
    const type = (
        db
          .prepare("SELECT id FROM voucher_types WHERE kind=? LIMIT 1")
          .get(kind) as { id: number }
      ).id,
      amount = (qtyMilli / 1000) * 100_000;
    return saveVoucher(db, {
      voucherTypeId: type,
      date: "2026-08-24",
      partyLedgerId: customerId,
      narration: null,
      reference: null,
      instrumentNo: null,
      instrumentDate: null,
      transporterId: null,
      vehicleNo: null,
      transportDistanceKm: null,
      posOverride: null,
      currencyCode: null,
      exchangeRate: null,
      lines:
        kind === "sales"
          ? [
              { ledgerId: customerId, drCr: "dr", amount },
              { ledgerId: salesLedgerId, drCr: "cr", amount },
            ]
          : [
              { ledgerId: salesLedgerId, drCr: "dr", amount },
              { ledgerId: customerId, drCr: "cr", amount },
            ],
      inventory: [
        {
          stockItemId: itemId,
          godownId: null,
          batchId: null,
          qtyMilli,
          ratePaise: 100_000,
          discountPaise: 0,
          amount,
          direction,
        },
      ],
      billRefs: [],
      tds: null,
    });
  };
  return { db, customerId, salesLedgerId, itemId, post };
}

describe("customer operations", () => {
  it("creates a source-linked sales return and prevents returning the same quantity twice", () => {
    const { db, post } = fixtures(),
      invoice = post("sales", 5000, "out"),
      candidates = salesReturnCandidates(db);
    const source = candidates[0]!;
    expect(source.lines[0]).toMatchObject({
      qtySoldMilli: 5000,
      openQtyMilli: 5000,
    });
    const draft = createSalesReturnDraft(
      db,
      {
        invoiceVoucherId: invoice.id,
        date: "2026-08-25",
        reason: "Damaged in transit",
        lines: [
          {
            invoiceInventoryLineId: source.lines[0]!.inventoryLineId,
            qtyMilli: 2000,
          },
        ],
      },
      "Meera",
    );
    expect(draft.payload).toMatchObject({
      salesReturnLinks: [{ invoiceVoucherId: invoice.id, qtyMilli: 2000 }],
    });
    const returned = post("credit_note", 2000, "in");
    recordSalesReturn(
      db,
      returned.id,
      draft.payload.salesReturnLinks as any,
      "Meera",
    );
    expect(salesReturnCandidates(db)[0]?.lines[0]).toMatchObject({
      qtyReturnedMilli: 2000,
      openQtyMilli: 3000,
    });
    expect(() =>
      recordSalesReturn(
        db,
        returned.id,
        draft.payload.salesReturnLinks as any,
        "Meera",
      ),
    ).toThrow();
  });
  it("links sold serial warranty coverage and retains service outcome", () => {
    const { db, post } = fixtures();
    const receipt = post("credit_note", 1000, "in"),
      inLine = (
        db
          .prepare("SELECT id FROM inventory_lines WHERE voucher_id=?")
          .get(receipt.id) as { id: number }
      ).id;
    const serial = assignSerials(
      db,
      {
        inventoryLineId: inLine,
        serials: [
          { serialNo: "CU-001", warrantyUntil: "2027-08-24", note: null },
        ],
      },
      "Stores",
    )[0]!;
    const sale = post("sales", 1000, "out"),
      outLine = (
        db
          .prepare("SELECT id FROM inventory_lines WHERE voucher_id=?")
          .get(sale.id) as { id: number }
      ).id;
    assignSerials(
      db,
      {
        inventoryLineId: outLine,
        serials: [
          { serialNo: "CU-001", warrantyUntil: "2027-08-24", note: null },
        ],
      },
      "Stores",
    );
    const claim = openWarrantyClaim(
      db,
      serial.id,
      "2026-09-01",
      "Display failure",
      "Support",
    );
    expect(claim).toMatchObject({
      invoiceVoucherId: sale.id,
      invoiceNumber: sale.number,
      status: "open",
    });
    expect(
      resolveWarrantyClaim(
        db,
        claim.id,
        "resolved",
        "Controller replaced",
        25_000,
        "2026-09-03",
      ),
    ).toMatchObject({ status: "resolved", serviceCost: 25_000 });
    expect(warrantyRegister(db)).toHaveLength(1);
  });
  it("validates typed custom document fields without changing accounting semantics", () => {
    const { db } = fixtures();
    saveCustomField(
      db,
      {
        fieldKey: "po_reference",
        label: "Customer PO",
        documentKind: "order",
        dataType: "text",
        required: true,
        options: [],
        active: true,
      },
      "Owner",
    );
    saveCustomField(
      db,
      {
        fieldKey: "delivery_slot",
        label: "Delivery slot",
        documentKind: null,
        dataType: "choice",
        required: false,
        options: ["Morning", "Evening"],
        active: true,
      },
      "Owner",
    );
    expect(() => validateCustomFields(db, "order", {})).toThrow(
      "Customer PO is required",
    );
    expect(() =>
      validateCustomFields(db, "order", {
        po_reference: "PO-8",
        delivery_slot: "Night",
      }),
    ).toThrow("must be one of");
    expect(() =>
      validateCustomFields(db, "order", {
        po_reference: "PO-8",
        delivery_slot: "Morning",
      }),
    ).not.toThrow();
  });
  it("attributes sales and returns to effective territory ownership", () => {
    const { db, customerId, post } = fixtures(),
      territory = saveTerritory(db, "West", null);
    assignCustomer(db, customerId, territory.id, "Meera", "2026-04-01", null);
    post("sales", 5000, "out");
    post("credit_note", 1000, "in");
    expect(territorySales(db, "2026-08-01", "2026-08-31")).toMatchObject([
      {
        territoryName: "West",
        salesperson: "Meera",
        invoiceCount: 1,
        salesAmount: 500000,
        returnAmount: 100000,
        netSales: 400000,
      },
    ]);
  });
  it("pauses and resumes a subscription together with its invoice schedule", () => {
    const { db, customerId, itemId } = fixtures(),
      type = (
        db
          .prepare("SELECT id FROM voucher_types WHERE kind='sales' LIMIT 1")
          .get() as { id: number }
      ).id,
      schedule = saveSalesRecurringSchedule(
        db,
        {
          name: "Annual support",
          partyLedgerId: customerId,
          voucherTypeId: type,
          cadence: "yearly",
          nextDue: "2026-09-01",
          endDate: null,
          dueDays: 30,
          lines: [
            {
              stockItemId: itemId,
              description: "Support",
              qtyMilli: 1000,
              rateMode: "fixed",
              fixedRate: 100000,
              discountBps: 0,
            },
          ],
          narration: null,
          active: true,
        },
        "Meera",
      ),
      contract = createSubscription(
        db,
        {
          recurringScheduleId: schedule.id,
          planName: "Gold",
          startDate: "2026-09-01",
          endDate: "2027-08-31",
          escalationBps: 500,
          nextEscalationDate: "2027-09-01",
          note: null,
        },
        "Meera",
      );
    expect(contract).toMatchObject({
      status: "active",
      scheduleName: "Annual support",
    });
    expect(setSubscriptionStatus(db, contract.id, "paused").status).toBe(
      "paused",
    );
    expect(
      (
        db
          .prepare("SELECT active FROM sales_recurring_schedules WHERE id=?")
          .get(schedule.id) as { active: number }
      ).active,
    ).toBe(0);
    expect(setSubscriptionStatus(db, contract.id, "active").status).toBe(
      "active",
    );
    expect(listSubscriptions(db)).toHaveLength(1);
  });
});
