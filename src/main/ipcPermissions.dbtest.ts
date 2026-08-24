import { describe, expect, it } from "vitest";
import { freshDb } from "./db/testdb";
import {
  DEFAULT_PERMISSION_MATRIX,
  setPermissionMatrix,
} from "./services/permissions";
import { assertIpcPermissionAllowed } from "./ipcPermissions";

describe("IPC permission denial gate", () => {
  it.each([
    "gst:exportGstr1",
    "gst:exportGstr3b",
    "tds:export26q",
    "edoc:exportEInvoice",
    "edoc:exportEwb",
    "edoc:ewbJson",
    "invoice:pdfBatch",
  ])("denies %s when create is allowed but export is disabled", (channel) => {
    const db = freshDb();
    const matrix = structuredClone(DEFAULT_PERMISSION_MATRIX);
    matrix.accountant.create = true;
    matrix.accountant.export = false;
    setPermissionMatrix(db, matrix);
    expect(() =>
      assertIpcPermissionAllowed(db, "accountant", channel, {}, "accountant"),
    ).toThrow("You do not have permission");
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
