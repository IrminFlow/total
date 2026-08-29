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
  let sessionReads = 0;
  const destinationRequests: string[] = [];
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
    getSessionUser: () => {
      sessionReads += 1;
      return null;
    },
    chooseEmlDestination: async (suggestedFileName) => {
      destinationRequests.push(suggestedFileName);
      return null;
    },
  });
  return {
    rows,
    destinationRequests,
    reads: () => ({ companyReads, actorReads, sessionReads }),
  };
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
      ["communications:batches:list", "viewer"],
      ["communications:batches:get", "viewer"],
      ["communications:batches:events", "viewer"],
      ["communications:batches:create", undefined],
      ["communications:batches:approve", undefined],
      ["communications:batches:reject", undefined],
      ["communications:batches:enqueue", undefined],
      ["communications:batches:cancel", undefined],
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
    expect(() =>
      byChannel.get("communications:batches:create")!({
        name: "Batch",
        items: Array.from({ length: 101 }, (_, index) => ({
          messageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          documentKind: "invoice",
          documentLabel: `Invoice ${index}`,
          amountPaise: 100,
          exclusionReason: null,
        })),
      }),
    ).toThrow();
    expect(() =>
      byChannel.get("communications:batches:enqueue")!({
        id: "not-a-uuid",
        smtpProfileId: 1,
      }),
    ).toThrow();
    expect(state.reads()).toEqual({
      companyReads: 0,
      actorReads: 0,
      sessionReads: 0,
    });
  });

  it("chooses the export destination in the main process and returns null on cancel", async () => {
    const state = registrations();
    const handler = state.rows.find(
      (row) => row.channel === "communications:messages:exportEml",
    )!.handler;
    const id = "00000000-0000-4000-8000-000000000001";
    await expect(handler({ id })).resolves.toBeNull();
    expect(state.destinationRequests).toEqual([`Total-message-${id}.eml`]);
    expect(state.reads()).toEqual({
      companyReads: 0,
      actorReads: 0,
      sessionReads: 0,
    });
    await expect(
      handler({ id, destinationPath: "/tmp/renderer-controlled.eml" }),
    ).rejects.toThrow();
  });
});
