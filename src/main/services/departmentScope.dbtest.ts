import { describe, expect, it } from "vitest";
import type { VoucherInputParsed } from "@shared/schemas";
import { seededDb } from "../db/testdb";
import { saveVoucher, listVouchers } from "./vouchers";
import {
  approvalRequestInDepartmentScope,
  assertApprovalRequestDepartmentScope,
  assertCompanyWideSurfaceAllowed,
  assertVoucherDepartmentScope,
  assertVoucherInputDepartmentScope,
  filterVoucherLinkedRowsByDepartmentScope,
  filterVoucherRowsByDepartmentScope,
  voucherInputInDepartmentScope,
  voucherInDepartmentScope,
} from "./departmentScope";

function id(db: ReturnType<typeof seededDb>, sql: string, value?: string): number {
  return (db.prepare(sql).get(...(value == null ? [] : [value])) as { id: number }).id;
}

function journalInput(
  db: ReturnType<typeof seededDb>,
  voucherTypeId: number,
  date: string,
  costCentreId?: number,
): VoucherInputParsed {
  const cash = id(db, "SELECT id FROM ledgers WHERE name = ?", "Cash");
  const capitalGroup = id(db, "SELECT id FROM groups WHERE name = ?", "Capital Account");
  const capital = Number(
    db.prepare("INSERT INTO ledgers(name,group_id) VALUES(?,?)")
      .run(`Scoped capital ${date}`, capitalGroup).lastInsertRowid,
  );
  return {
    voucherTypeId,
    date,
    partyLedgerId: null,
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
    lines: [
      {
        ledgerId: cash,
        drCr: "dr",
        amount: 10_000,
        costAllocations: costCentreId
          ? [{ costCentreId, amount: 10_000 }]
          : [],
      },
      { ledgerId: capital, drCr: "cr", amount: 10_000, costAllocations: [] },
    ],
    inventory: [],
    billRefs: [],
    tds: null,
  };
}

function allow(
  db: ReturnType<typeof seededDb>,
  kind: "voucher_type" | "godown" | "cost_centre",
  dimensionId: number,
  role: "viewer" | "accountant" = "viewer",
): void {
  db.prepare(
    "INSERT INTO department_boundaries(role,dimension_kind,dimension_id,allowed) VALUES(?,?,?,1)",
  ).run(role, kind, dimensionId);
}

describe("record-backed department scope", () => {
  it("preserves owner and unconfigured role access", () => {
    const db = seededDb();
    const journal = id(db, "SELECT id FROM voucher_types WHERE kind='journal'");
    const saved = saveVoucher(db, journalInput(db, journal, "2026-08-01"));
    expect(voucherInDepartmentScope(db, "viewer", saved.id)).toBe(true);
    expect(() => assertVoucherDepartmentScope(db, "owner", saved.id)).not.toThrow();
    expect(() =>
      assertCompanyWideSurfaceAllowed(db, "viewer", "Reports"),
    ).not.toThrow();
  });

  it("filters voucher rows and rejects direct targets outside voucher-type scope", () => {
    const db = seededDb();
    const journal = id(db, "SELECT id FROM voucher_types WHERE kind='journal'");
    const receipt = id(db, "SELECT id FROM voucher_types WHERE kind='receipt'");
    const allowed = saveVoucher(db, journalInput(db, journal, "2026-08-01"));
    const denied = saveVoucher(db, journalInput(db, receipt, "2026-08-02"));
    allow(db, "voucher_type", journal);

    const rows = listVouchers(db, "2026-08-01", "2026-08-31");
    expect(
      filterVoucherRowsByDepartmentScope(db, "viewer", rows).map((row) => row.id),
    ).toEqual([allowed.id]);
    expect(() =>
      assertVoucherDepartmentScope(db, "viewer", denied.id),
    ).toThrow("outside your configured department boundaries");
    expect(() =>
      assertVoucherInputDepartmentScope(
        db,
        "viewer",
        journalInput(db, receipt, "2026-08-03"),
      ),
    ).toThrow("outside your configured department boundaries");
  });

  it("requires actual allowed godown and cost-centre relationships", () => {
    const db = seededDb();
    const journal = id(db, "SELECT id FROM voucher_types WHERE kind='journal'");
    const allowedCostCentre = Number(
      db.prepare("INSERT INTO cost_centres(name) VALUES('Allowed team')").run()
        .lastInsertRowid,
    );
    const deniedCostCentre = Number(
      db.prepare("INSERT INTO cost_centres(name) VALUES('Other team')").run()
        .lastInsertRowid,
    );
    const allowed = saveVoucher(
      db,
      journalInput(db, journal, "2026-08-01", allowedCostCentre),
    );
    const denied = saveVoucher(
      db,
      journalInput(db, journal, "2026-08-02", deniedCostCentre),
    );
    const unassigned = saveVoucher(db, journalInput(db, journal, "2026-08-03"));
    allow(db, "cost_centre", allowedCostCentre);

    expect(voucherInDepartmentScope(db, "viewer", allowed.id)).toBe(true);
    expect(voucherInDepartmentScope(db, "viewer", denied.id)).toBe(false);
    expect(voucherInDepartmentScope(db, "viewer", unassigned.id)).toBe(false);
    expect(() =>
      assertCompanyWideSurfaceAllowed(db, "viewer", "Reports"),
    ).toThrow("would expose company-wide data");
  });

  it("rejects vouchers stored in another or unassigned godown", () => {
    const db = seededDb();
    const stockJournal = id(
      db,
      "SELECT id FROM voucher_types WHERE kind='stock_journal'",
    );
    const unit = id(db, "SELECT id FROM units ORDER BY id LIMIT 1");
    const item = Number(
      db.prepare("INSERT INTO stock_items(name,unit_id) VALUES('Scoped stock',?)")
        .run(unit).lastInsertRowid,
    );
    const allowedGodown = Number(
      db.prepare("INSERT INTO godowns(name) VALUES('Allowed depot')").run()
        .lastInsertRowid,
    );
    const deniedGodown = Number(
      db.prepare("INSERT INTO godowns(name) VALUES('Other depot')").run()
        .lastInsertRowid,
    );
    const stockInput = (date: string, godownId: number | null): VoucherInputParsed => ({
      voucherTypeId: stockJournal,
      date,
      partyLedgerId: null,
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
      lines: [],
      inventory: [{
        stockItemId: item,
        godownId,
        qtyMilli: 1_000,
        ratePaise: 10_000,
        amount: 10_000,
        direction: "in",
      }],
      billRefs: [],
      tds: null,
    });
    const allowed = saveVoucher(db, stockInput("2026-08-01", allowedGodown));
    const denied = saveVoucher(db, stockInput("2026-08-02", deniedGodown));
    const unassigned = saveVoucher(db, stockInput("2026-08-03", null));
    allow(db, "godown", allowedGodown);

    expect(voucherInDepartmentScope(db, "viewer", allowed.id)).toBe(true);
    expect(voucherInDepartmentScope(db, "viewer", denied.id)).toBe(false);
    expect(voucherInDepartmentScope(db, "viewer", unassigned.id)).toBe(false);
    expect(() =>
      assertVoucherInputDepartmentScope(
        db,
        "viewer",
        stockInput("2026-08-04", deniedGodown),
      ),
    ).toThrow("outside your configured department boundaries");
  });

  it("filters voucher-linked output rows without exposing out-of-scope records", () => {
    const db = seededDb();
    const journal = id(db, "SELECT id FROM voucher_types WHERE kind='journal'");
    const receipt = id(db, "SELECT id FROM voucher_types WHERE kind='receipt'");
    const allowed = saveVoucher(db, journalInput(db, journal, "2026-08-01"));
    const denied = saveVoucher(db, journalInput(db, receipt, "2026-08-02"));
    allow(db, "voucher_type", journal);

    const rows = [
      { eventId: 1, voucherId: allowed.id },
      { eventId: 2, voucherId: denied.id },
      { eventId: 3, voucherId: 999_999 },
    ];
    expect(
      filterVoucherLinkedRowsByDepartmentScope(
        db,
        "viewer",
        rows,
        (row) => row.voucherId,
      ),
    ).toEqual([{ eventId: 1, voucherId: allowed.id }]);
  });

  it("filters approval payloads and checks both target and posted voucher records", () => {
    const db = seededDb();
    const journal = id(db, "SELECT id FROM voucher_types WHERE kind='journal'");
    const receipt = id(db, "SELECT id FROM voucher_types WHERE kind='receipt'");
    const allowedInput = journalInput(db, journal, "2026-08-01");
    const deniedInput = journalInput(db, receipt, "2026-08-02");
    const allowed = saveVoucher(db, allowedInput);
    const denied = saveVoucher(db, deniedInput);
    allow(db, "voucher_type", journal, "accountant");

    const allowedRequest = {
      payload: allowedInput,
      targetVoucherId: allowed.id,
      postedVoucherId: null,
    };
    const deniedPayloadRequest = {
      payload: deniedInput,
      targetVoucherId: null,
      postedVoucherId: null,
    };
    const deniedTargetRequest = {
      payload: allowedInput,
      targetVoucherId: allowed.id,
      postedVoucherId: denied.id,
    };

    expect(
      approvalRequestInDepartmentScope(db, "accountant", allowedRequest),
    ).toBe(true);
    expect(
      approvalRequestInDepartmentScope(db, "accountant", deniedPayloadRequest),
    ).toBe(false);
    expect(
      approvalRequestInDepartmentScope(db, "accountant", deniedTargetRequest),
    ).toBe(false);
    expect(() =>
      assertApprovalRequestDepartmentScope(
        db,
        "accountant",
        deniedTargetRequest,
      ),
    ).toThrow("outside your configured department boundaries");
    expect(
      approvalRequestInDepartmentScope(db, "owner", deniedTargetRequest),
    ).toBe(true);
  });

  it("rejects out-of-scope agent proposal voucher inputs but preserves owner access", () => {
    const db = seededDb();
    const journal = id(db, "SELECT id FROM voucher_types WHERE kind='journal'");
    const receipt = id(db, "SELECT id FROM voucher_types WHERE kind='receipt'");
    const allowedInput = journalInput(db, journal, "2026-08-01");
    const deniedInput = journalInput(db, receipt, "2026-08-02");
    allow(db, "voucher_type", journal, "accountant");

    expect(voucherInputInDepartmentScope(db, "accountant", allowedInput)).toBe(
      true,
    );
    expect(voucherInputInDepartmentScope(db, "accountant", deniedInput)).toBe(
      false,
    );
    expect(voucherInputInDepartmentScope(db, "owner", deniedInput)).toBe(true);
  });
});
