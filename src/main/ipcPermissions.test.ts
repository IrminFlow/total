import { describe, expect, it } from "vitest";
import {
  EXPLICIT_PERMISSION_ACTIONS,
  permissionActionForChannel,
} from "./ipcPermissions";

describe("IPC permission contracts", () => {
  it.each([
    ["voucher:batchTag", { ids: [1, 2], tag: "review" }],
    ["voucher:batchReview", { ids: [1, 2] }],
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

  it("keeps the explicit contract table synchronized with the protected channels", () => {
    expect(EXPLICIT_PERMISSION_ACTIONS).toEqual({
      "voucher:batchTag": "edit",
      "voucher:batchReview": "edit",
      "bank:setBankDate": "edit",
      "bank:chequeStatus": "edit",
      "agent:approveProposal": "approve",
      "agent:discardProposal": "approve",
    });
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
