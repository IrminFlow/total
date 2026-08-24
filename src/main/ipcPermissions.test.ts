import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXPLICIT_PERMISSION_ACTIONS,
  permissionActionForChannel,
} from "./ipcPermissions";

describe("IPC permission contracts", () => {
  it.each([
    ["voucher:batchTag", { ids: [1, 2], tag: "review" }],
    ["voucher:batchReview", { ids: [1, 2] }],
    [
      "voucher:batchReverse",
      { ids: [1, 2], date: "2026-08-24", reason: "Correction" },
    ],
    ["bank:setBankDate", { lineId: 12, bankDate: "2026-08-24" }],
    [
      "bank:chequeStatus",
      { voucherId: 7, status: "cleared", statusDate: "2026-08-24" },
    ],
  ])("classifies %s as an edit even without a top-level id", (channel, payload) => {
    expect(permissionActionForChannel(channel, payload, "accountant")).toBe(
      "edit",
    );
  });

  it.each(["agent:approveProposal", "agent:discardProposal"])(
    "classifies %s as an approval decision",
    (channel) => {
      expect(
        permissionActionForChannel(
          channel,
          { file: "proposal.json" },
          "accountant",
        ),
      ).toBe("approve");
    },
  );

  it.each([
    "gst:exportGstr1",
    "gst:exportGstr3b",
    "tds:export26q",
    "edoc:exportEInvoice",
    "edoc:exportEwb",
    "edoc:ewbJson",
    "invoice:pdfBatch",
  ])("classifies %s as an export", (channel) => {
    expect(permissionActionForChannel(channel, {}, "accountant")).toBe(
      "export",
    );
  });

  it("classifies transport updates as edits", () => {
    expect(
      permissionActionForChannel(
        "edoc:transportSet",
        { voucherId: 7, data: {} },
        "accountant",
      ),
    ).toBe("edit");
  });

  it("keeps the explicit contract table synchronized with the protected channels", () => {
    expect(EXPLICIT_PERMISSION_ACTIONS).toEqual({
      "voucher:batchTag": "edit",
      "voucher:batchReview": "edit",
      "voucher:batchReverse": "edit",
      "bank:setBankDate": "edit",
      "bank:chequeStatus": "edit",
      "edoc:transportSet": "edit",
      "agent:approveProposal": "approve",
      "agent:discardProposal": "approve",
      "gst:exportGstr1": "export",
      "gst:exportGstr3b": "export",
      "tds:export26q": "export",
      "edoc:exportEInvoice": "export",
      "edoc:exportEwb": "export",
      "edoc:ewbJson": "export",
      "invoice:pdfBatch": "export",
    });
  });

  it("keeps every explicit contract attached to a registered IPC channel", () => {
    const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
    const registered = new Set(
      [...source.matchAll(/handle\(\s*["']([^"']+)["']/g)].map(
        (match) => match[1],
      ),
    );
    expect(
      Object.keys(EXPLICIT_PERMISSION_ACTIONS).filter(
        (channel) => !registered.has(channel),
      ),
    ).toEqual([]);
  });

  it("preserves ordinary create, id-based edit, view, and settings inference", () => {
    expect(
      permissionActionForChannel("master:ledgers:create", {}, "accountant"),
    ).toBe("create");
    expect(
      permissionActionForChannel(
        "master:ledgers:update",
        { id: 1 },
        "accountant",
      ),
    ).toBe("edit");
    expect(permissionActionForChannel("voucher:list", {}, "viewer")).toBe(
      "view",
    );
    expect(permissionActionForChannel("company:updateInfo", {}, "owner")).toBe(
      "settings",
    );
  });
});
