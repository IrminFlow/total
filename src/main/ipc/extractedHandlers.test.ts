import { describe, expect, it } from "vitest";
import { registerComplianceHandlers } from "./complianceHandlers";
import { registerExtrasHandlers } from "./extrasHandlers";
import { registerOutstandingBillsHandlers } from "./outstandingBillsHandlers";
import type { CompanyContext, IpcHandle, IpcHandler } from "./types";

function handlerMap(
  register: (handle: IpcHandle) => void,
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  register((channel, handler) => handlers.set(channel, handler));
  return handlers;
}

const unavailableCompany = { db: {} } as CompanyContext;

describe("extracted IPC handler validation", () => {
  it("validates outstanding-bill input before accessing company state", () => {
    let companyReads = 0;
    const handlers = handlerMap((handle) =>
      registerOutstandingBillsHandlers({
        handle,
        requireCompany: () => {
          companyReads += 1;
          return unavailableCompany;
        },
      }),
    );

    expect(() =>
      handlers.get("bills:open")!({
        partyLedgerId: 0,
        asOn: "24-08-2026",
      }),
    ).toThrow();
    expect(companyReads).toBe(0);
  });

  it("rejects invalid compliance payloads without resolving the actor", () => {
    let actorReads = 0;
    const handlers = handlerMap((handle) =>
      registerComplianceHandlers({
        handle,
        requireCompany: () => unavailableCompany,
        actor: () => {
          actorReads += 1;
          return "Asha";
        },
      }),
    );

    expect(() =>
      handlers.get("compliance:list")!({ from: "not-a-date" }),
    ).toThrow();
    expect(() =>
      handlers.get("compliance:sync")!({ today: "2026/08/24" }),
    ).toThrow();
    expect(() =>
      handlers.get("compliance:save")!({
        title: "",
        dueDate: "2026-08-31",
        kind: "state",
        status: "open",
      }),
    ).toThrow();
    expect(actorReads).toBe(0);
  });

  it("retains strict currency and BOM payload validation", () => {
    const handlers = handlerMap((handle) =>
      registerExtrasHandlers({
        handle,
        requireCompany: () => unavailableCompany,
      }),
    );

    expect(() =>
      handlers.get("currency:create")!({
        code: "US",
        symbol: "$",
        name: "US Dollar",
        decimals: 2,
      }),
    ).toThrow();
    expect(() => handlers.get("currency:delete")!({ id: 0 })).toThrow();
    expect(() => handlers.get("bom:get")!({ itemId: -1 })).toThrow();
    expect(() =>
      handlers.get("bom:set")!({
        itemId: 1,
        lines: [{ componentId: 2, qtyMilliPerUnit: 0 }],
      }),
    ).toThrow();
  });
});
