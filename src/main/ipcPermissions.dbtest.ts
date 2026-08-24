import { describe, expect, it } from "vitest";
import { freshDb } from "./db/testdb";
import {
  DEFAULT_PERMISSION_MATRIX,
  setPermissionMatrix,
} from "./services/permissions";
import {
  getExportPermissions,
  setExportPermissions,
} from "./services/internalControls";
import {
  IPC_EXPORT_CONTRACTS,
  assertAutomationRunAllowed,
  assertIpcExportFormatAllowed,
  assertIpcPermissionAllowed,
} from "./ipcPermissions";

describe("IPC permission denial gate", () => {
  it.each(Object.keys(IPC_EXPORT_CONTRACTS))(
    "denies %s when create is allowed but export is disabled",
    (channel) => {
      const db = freshDb();
      const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
      matrix.accountant.create = true;
      matrix.accountant.export = false;
      setPermissionMatrix(db, matrix);
      expect(() =>
        assertIpcPermissionAllowed(db, "accountant", channel, {}, "accountant"),
      ).toThrow("You do not have permission");
    },
  );

  it("applies the default-denied JSON mirror format gate after export permission", () => {
    const db = freshDb();
    const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
    matrix.accountant.create = true;
    matrix.accountant.export = true;
    setPermissionMatrix(db, matrix);
    expect(
      assertIpcPermissionAllowed(
        db,
        "accountant",
        "agent:exportMirror",
        {},
        "accountant",
      ),
    ).toBe("export");
    expect(() =>
      assertIpcExportFormatAllowed(db, "accountant", "agent:exportMirror"),
    ).toThrow("not allowed to create this export format");
  });

  it("fails closed when an inferred export lacks a format contract", () => {
    const db = freshDb();
    expect(
      assertIpcPermissionAllowed(
        db,
        "owner",
        "export:unregistered",
        {},
        "accountant",
      ),
    ).toBe("export");
    expect(() =>
      assertIpcExportFormatAllowed(db, "owner", "export:unregistered"),
    ).toThrow("no explicit format contract");
  });

  it.each([
    "export:portable",
    "export:reviewBundle",
    "payroll:payslipPack",
    "company:revealExports",
  ])("applies the default-denied full-data gate to %s", (channel) => {
    const db = freshDb();
    expect(
      assertIpcPermissionAllowed(db, "accountant", channel, {}, "accountant"),
    ).toBe("export");
    expect(() =>
      assertIpcExportFormatAllowed(db, "accountant", channel),
    ).toThrow("not allowed to create this export format");
  });

  it("enforces the actual action and format for dynamic automation runs", () => {
    const db = freshDb();
    const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
    matrix.accountant.backup = true;
    matrix.accountant.export = true;
    setPermissionMatrix(db, matrix);

    expect(() =>
      assertAutomationRunAllowed(db, "accountant", "backup"),
    ).toThrow("automation format");
    expect(() =>
      assertAutomationRunAllowed(db, "accountant", "mirror"),
    ).toThrow("automation format");
    expect(() =>
      assertAutomationRunAllowed(db, "accountant", "report_pack"),
    ).toThrow("automation format");
    expect(assertAutomationRunAllowed(db, "owner", "backup")).toEqual({
      action: "backup",
      format: "full_data",
    });
    expect(assertAutomationRunAllowed(db, "owner", "mirror")).toEqual({
      action: "export",
      format: "json_mirror",
    });
  });

  it("allows dynamic automation from exact permissions without settings access", () => {
    const db = freshDb();
    const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
    matrix.accountant.settings = false;
    matrix.accountant.backup = true;
    matrix.accountant.export = true;
    setPermissionMatrix(db, matrix);
    const formats = getExportPermissions(db);
    formats.accountant.full_data = true;
    formats.accountant.json_mirror = true;
    setExportPermissions(db, formats);

    expect(assertAutomationRunAllowed(db, "accountant", "backup")).toEqual({
      action: "backup",
      format: "full_data",
    });
    expect(assertAutomationRunAllowed(db, "accountant", "mirror")).toEqual({
      action: "export",
      format: "json_mirror",
    });
    expect(
      assertAutomationRunAllowed(db, "accountant", "report_pack"),
    ).toEqual({ action: "export", format: "full_data" });
  });

  it("denies dynamic automation when settings is allowed but its exact action is denied", () => {
    const db = freshDb();
    const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
    matrix.accountant.settings = true;
    matrix.accountant.backup = false;
    matrix.accountant.export = false;
    setPermissionMatrix(db, matrix);
    const formats = getExportPermissions(db);
    formats.accountant.full_data = true;
    formats.accountant.json_mirror = true;
    setExportPermissions(db, formats);

    expect(() =>
      assertAutomationRunAllowed(db, "accountant", "backup"),
    ).toThrow("permission to run this automation");
    expect(() =>
      assertAutomationRunAllowed(db, "accountant", "mirror"),
    ).toThrow("permission to run this automation");
  });

  it("denies transport mutation when create is allowed but edit is disabled", () => {
    const db = freshDb();
    const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
    matrix.accountant.create = true;
    matrix.accountant.edit = false;
    setPermissionMatrix(db, matrix);
    expect(() =>
      assertIpcPermissionAllowed(
        db,
        "accountant",
        "edoc:transportSet",
        { voucherId: 7, data: {} },
        "accountant",
      ),
    ).toThrow("You do not have permission");
  });

  it.each([
    ["payroll:attendance:approveMonth", { month: "2026-08" }],
    [
      "payroll:reimbursements:decide",
      { id: 7, decision: "approved" },
    ],
    ["communications:messages:review", { id: "00000000-0000-4000-8000-000000000001" }],
    ["communications:messages:queue", { id: "00000000-0000-4000-8000-000000000001" }],
    ["communications:messages:deliver", { id: "00000000-0000-4000-8000-000000000001" }],
    ["communications:messages:resolveAcceptance", { id: "00000000-0000-4000-8000-000000000001" }],
  ])(
    "denies a default accountant invocation of %s",
    (channel, payload) => {
      const db = freshDb();
      expect(DEFAULT_PERMISSION_MATRIX.accountant.create).toBe(true);
      expect(DEFAULT_PERMISSION_MATRIX.accountant.edit).toBe(true);
      expect(DEFAULT_PERMISSION_MATRIX.accountant.approve).toBe(false);
      expect(() =>
        assertIpcPermissionAllowed(
          db,
          "accountant",
          channel,
          payload,
          "accountant",
        ),
      ).toThrow("You do not have permission");
    },
  );

  it.each([
    ["payroll:attendance:approveMonth", { month: "2026-08" }],
    [
      "payroll:reimbursements:decide",
      { id: 7, decision: "rejected" },
    ],
    ["communications:messages:review", { id: "00000000-0000-4000-8000-000000000001" }],
    ["communications:messages:queue", { id: "00000000-0000-4000-8000-000000000001" }],
    ["communications:messages:deliver", { id: "00000000-0000-4000-8000-000000000001" }],
    ["communications:messages:resolveAcceptance", { id: "00000000-0000-4000-8000-000000000001" }],
  ])(
    "allows an owner and a configured approver to invoke %s",
    (channel, payload) => {
      const db = freshDb();
      expect(
        assertIpcPermissionAllowed(
          db,
          "owner",
          channel,
          payload,
          "accountant",
        ),
      ).toBe("approve");

      const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
      matrix.accountant.approve = true;
      setPermissionMatrix(db, matrix);
      expect(
        assertIpcPermissionAllowed(
          db,
          "accountant",
          channel,
          payload,
          "accountant",
        ),
      ).toBe("approve");
    },
  );

  it.each([
    ["payroll:attendance:save", { status: "approved" }],
    ["payroll:leave:record", { status: "approved" }],
    ["payroll:leave:record", { status: "rejected" }],
    ["payroll:salaryRevisions:save", { status: "approved" }],
    ["ai:documents:review", { id: 7, status: "approved" }],
    ["ai:documents:review", { id: 7, status: "dismissed" }],
  ])(
    "denies a default accountant decision through %s",
    (channel, payload) => {
      const db = freshDb();
      expect(() =>
        assertIpcPermissionAllowed(
          db,
          "accountant",
          channel,
          payload,
          "accountant",
        ),
      ).toThrow("You do not have permission");
    },
  );

  it.each([
    ["payroll:attendance:save", { status: "review" }],
    ["payroll:attendance:save", { status: "exception" }],
    ["payroll:leave:record", { status: "requested" }],
    ["payroll:salaryRevisions:save", { status: "draft" }],
  ])(
    "retains create authority for the non-decision path through %s",
    (channel, payload) => {
      const db = freshDb();
      expect(
        assertIpcPermissionAllowed(
          db,
          "accountant",
          channel,
          payload,
          "accountant",
        ),
      ).toBe("create");
    },
  );

  it.each([
    ["payroll:attendance:save", { status: "approved" }],
    ["payroll:leave:record", { status: "rejected" }],
    ["payroll:salaryRevisions:save", { status: "approved" }],
    ["ai:documents:review", { id: 7, status: "dismissed" }],
  ])(
    "allows an owner and a configured approver to decide through %s",
    (channel, payload) => {
      const db = freshDb();
      expect(
        assertIpcPermissionAllowed(
          db,
          "owner",
          channel,
          payload,
          "accountant",
        ),
      ).toBe("approve");

      const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
      matrix.accountant.approve = true;
      setPermissionMatrix(db, matrix);
      expect(
        assertIpcPermissionAllowed(
          db,
          "accountant",
          channel,
          payload,
          "accountant",
        ),
      ).toBe("approve");
    },
  );
});
