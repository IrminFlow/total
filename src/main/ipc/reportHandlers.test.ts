import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReportHandlers } from "./reportHandlers";
import type { IpcHandle, IpcHandler } from "./types";
import type { Role } from "../services/roles";
import { backgroundWork } from "../services/workloadGovernor";

afterEach(() => vi.restoreAllMocks());

describe("report IPC registration", () => {
  it("preserves every channel and its role boundary", () => {
    const registrations: Array<{
      channel: string;
      handler: IpcHandler;
      role: Role | undefined;
    }> = [];
    const handle: IpcHandle = (channel, handler, role) => {
      registrations.push({ channel, handler, role });
    };

    registerReportHandlers({
      handle,
      requireCompany: () => {
        throw new Error("handlers must not open a company during registration");
      },
    });

    expect(registrations.map(({ channel, role }) => [channel, role])).toEqual([
      ["report:dayBook", "viewer"],
      ["report:ledger", "viewer"],
      ["report:ledgerPage", "viewer"],
      ["report:trialBalance", "viewer"],
      ["report:profitLoss", "viewer"],
      ["report:balanceSheet", "viewer"],
      ["report:stockSummary", "viewer"],
      ["report:dashboard", "viewer"],
      ["report:cashFlow", "viewer"],
      ["report:stockAgeing", "viewer"],
      ["report:itemProfitability", undefined],
      ["report:exceptions", "viewer"],
    ]);
    expect(new Set(registrations.map(({ channel }) => channel)).size).toBe(12);
  });

  it("keeps caller request IDs and generates IDs when absent", async () => {
    const handlers = new Map<string, IpcHandler>();
    const handle: IpcHandle = (channel, handler) => {
      handlers.set(channel, handler);
    };
    registerReportHandlers({
      handle,
      requireCompany: () => {
        throw new Error("the queued report task should not run in this test");
      },
    });
    const run = vi
      .spyOn(backgroundWork, "run")
      .mockResolvedValue("queued" as never);
    const dayBook = handlers.get("report:dayBook")!;
    const suppliedId = "4b3d50de-f2d9-49ab-9f57-f1490492e462";

    await dayBook({
      from: "2026-04-01",
      to: "2026-06-30",
      __totalRequestId: suppliedId,
    });
    await dayBook({ from: "2026-04-01", to: "2026-06-30" });

    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(["report", suppliedId]);
    expect(run.mock.calls[1]?.[0]).toBe("report");
    expect(run.mock.calls[1]?.[1]).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
