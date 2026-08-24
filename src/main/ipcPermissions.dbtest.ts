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
});
