import { describe, expect, it } from "vitest";
import { registerCommunicationsHandlers } from "./communicationsHandlers";
import type { CompanyContext, IpcHandle, IpcHandler } from "./types";
import type { Role } from "../services/roles";

function registrations() {
  const rows: Array<{
    channel: string;
    role: Role | undefined;
    handler: IpcHandler;
  }> = [];
  const handle: IpcHandle = (channel, handler, role) =>
    rows.push({ channel, handler, role });
  let companyReads = 0;
  let actorReads = 0;
  registerCommunicationsHandlers({
    handle,
    requireCompany: () => {
      companyReads += 1;
      return { db: {} } as CompanyContext;
    },
    actor: () => {
      actorReads += 1;
      return "Asha";
    },
  });
  return { rows, reads: () => ({ companyReads, actorReads }) };
}

describe("communications IPC handlers", () => {
  it("registers the complete surface with deliberate role boundaries", () => {
    const { rows } = registrations();
    expect(rows.map(({ channel, role }) => [channel, role])).toEqual([
      ["communications:contacts:list", "viewer"],
      ["communications:contacts:save", undefined],
      ["communications:contacts:delete", undefined],
      ["communications:smtp:list", "owner"],
      ["communications:smtp:create", "owner"],
      ["communications:smtp:update", "owner"],
      ["communications:smtp:delete", "owner"],
      ["communications:smtp:test", "owner"],
      ["communications:messages:list", "viewer"],
      ["communications:messages:get", "viewer"],
      ["communications:messages:events", "viewer"],
      ["communications:messages:createDraft", undefined],
      ["communications:messages:updateDraft", undefined],
      ["communications:messages:review", undefined],
      ["communications:messages:queue", undefined],
      ["communications:messages:deliver", undefined],
      ["communications:messages:resolveAcceptance", undefined],
      ["communications:messages:cancel", undefined],
      ["communications:messages:exportEml", undefined],
    ]);
  });

  it("rejects invalid payloads before reading company or actor state", () => {
    const state = registrations();
    const byChannel = new Map(
      state.rows.map((row) => [row.channel, row.handler]),
    );
    expect(() =>
      byChannel.get("communications:contacts:list")!({ ledgerId: 0 }),
    ).toThrow();
    expect(() =>
      byChannel.get("communications:smtp:create")!({
        host: "smtp.example.com",
      }),
    ).toThrow();
    expect(() =>
      byChannel.get("communications:messages:createDraft")!({
        idempotencyKey: "short",
        to: ["not-an-email"],
        subject: "Hello\r\nBcc: thief@example.com",
        bodyText: "Hi",
      }),
    ).toThrow();
    expect(() =>
      byChannel.get("communications:messages:deliver")!({ id: "not-a-uuid" }),
    ).toThrow();
    expect(state.reads()).toEqual({ companyReads: 0, actorReads: 0 });
  });
});
