import { describe, expect, it, vi } from "vitest";
import type { CompanyContext, IpcHandle, IpcHandler } from "./types";
import type { Role } from "../services/roles";

const mocks = vi.hoisted(() => ({
  ask: vi.fn((_prompt: string, _context: unknown, signal: AbortSignal) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
  ),
}));

vi.mock("electron", () => ({ dialog: { showOpenDialog: vi.fn() } }));
vi.mock("../services/deviceSafety", () => ({ requireDeviceSafetyControl: vi.fn() }));
vi.mock("../services/ai", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/ai")>(),
  ask: mocks.ask,
}));

import { registerAiHandlers } from "./aiHandlers";

function setup() {
  const rows: Array<{ channel: string; role: Role | undefined; handler: IpcHandler }> = [];
  const handle: IpcHandle = (channel, handler, role) => rows.push({ channel, handler, role });
  let slug = "books-a";
  let companyReads = 0;
  registerAiHandlers({
    handle,
    requireCompany: () => {
      companyReads += 1;
      return { slug, db: {}, info: {} } as CompanyContext;
    },
    actor: () => "Asha",
  });
  return {
    byChannel: new Map(rows.map((row) => [row.channel, row.handler])),
    roles: new Map(rows.map((row) => [row.channel, row.role])),
    companyReads: () => companyReads,
    setSlug: (value: string) => { slug = value; },
  };
}

describe("AI IPC validation and request ownership", () => {
  it("keeps provider configuration owner-only and conversation access accountant-only", () => {
    const { roles } = setup();
    expect(roles.get("ai:setConfig")).toBe("owner");
    expect(roles.get("ai:testConnection")).toBe("owner");
    expect(roles.get("ai:ask")).toBe("accountant");
    expect(roles.get("ai:cancel")).toBe("accountant");
    expect(roles.get("ai:conversations:deleteAll")).toBe("owner");
  });

  it("rejects malformed identifiers and status values before company state is read", () => {
    const state = setup();
    expect(() => state.byChannel.get("ai:cancel")!({ requestId: "not-a-uuid" })).toThrow();
    expect(() => state.byChannel.get("ai:conversations:create")!({ title: "" })).toThrow();
    expect(() => state.byChannel.get("ai:documents:review")!({ id: -1, status: "posted" })).toThrow();
    expect(() => state.byChannel.get("search:natural")!({ query: "" })).toThrow();
    expect(state.companyReads()).toBe(0);
  });

  it("does not let another active company cancel an in-flight request", async () => {
    const state = setup();
    const requestId = "00000000-0000-4000-8000-000000000099";
    const running = state.byChannel.get("ai:ask")!({
      requestId,
      prompt: "Explain cash",
      from: "2026-04-01",
      to: "2027-03-31",
      includeContext: false,
    });
    await vi.waitFor(() => expect(mocks.ask).toHaveBeenCalled());
    state.setSlug("books-b");
    expect(state.byChannel.get("ai:cancel")!({ requestId })).toEqual({ cancelled: false });
    state.setSlug("books-a");
    expect(state.byChannel.get("ai:cancel")!({ requestId })).toEqual({ cancelled: true });
    await expect(running).rejects.toThrow("AI request cancelled");
  });
});
