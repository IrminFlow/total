import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { IpcHandle, IpcHandler } from "./types";
import { enqueueSupportPayload, readSupportOutbox } from "../services/supportOutbox";

const electron = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.5.0", getPath: () => tmpdir() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showSaveDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: electron.decryptString,
  },
}));

import { registerSupportHandlers } from "./supportHandlers";

let root: string;
let handlers: Map<string, IpcHandler>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "total-support-handler-"));
  process.env.TOTAL_DATA_DIR = root;
  writeFileSync(join(root, "device-safety.json"), JSON.stringify({
    aiCopilot: false, mcpAccess: false, supportUploads: true, telemetry: false,
  }));
  handlers = new Map();
  const handle: IpcHandle = (channel, handler) => handlers.set(channel, handler);
  registerSupportHandlers(handle, { getCurrentCompany: () => null, hasSession: () => false });
  electron.decryptString.mockImplementation((value: Buffer) => value.toString("utf8"));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TOTAL_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

function queuedCase(hasAttachment: boolean): { caseId: string; outboxId: string } {
  const created = handlers.get("support:case:create")!({
    category: "bug",
    consent: {
      message: true,
      diagnostics: true,
      logs: false,
      companyMetadata: false,
      focusContext: false,
      screenshot: hasAttachment,
    },
  }) as { id: string };
  const delivery = Buffer.from(JSON.stringify({
    caseId: created.id,
    category: "bug",
    source: "app",
  })).toString("base64");
  const queued = enqueueSupportPayload(join(root, "support-outbox.json"), {
    caseId: created.id,
    encryptedPayload: delivery,
    hasAttachment,
    lastError: "offline",
  });
  return { caseId: created.id, outboxId: queued.id };
}

describe("support outbox retry IPC", () => {
  it("requires fresh attachment consent before changing retry state", async () => {
    const queued = queuedCase(true);
    await expect(handlers.get("support:outbox:retry")!({
      id: queued.outboxId,
      approveAttachmentRetry: false,
    })).rejects.toThrow("Confirm the screenshot upload");
    expect(readSupportOutbox(join(root, "support-outbox.json"))[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      attachmentRetryApproved: false,
    });
  });

  it("retains encrypted data and records a bounded failed retry", async () => {
    const queued = queuedCase(false);
    await expect(handlers.get("support:outbox:retry")!({
      id: queued.outboxId,
      approveAttachmentRetry: false,
    })).rejects.toThrow("encrypted submission remains queued");
    const item = readSupportOutbox(join(root, "support-outbox.json"))[0]!;
    expect(item).toMatchObject({ status: "failed", attempts: 1, lastError: "Retry failed" });
    expect(item.encryptedPayload).not.toContain(queued.caseId);
  });

  it("reports device-key corruption without deleting the queued submission", async () => {
    const queued = queuedCase(false);
    electron.decryptString.mockImplementationOnce(() => { throw new Error("decrypt failed"); });
    await expect(handlers.get("support:outbox:retry")!({
      id: queued.outboxId,
      approveAttachmentRetry: false,
    })).rejects.toThrow("can no longer be decrypted");
    expect(readSupportOutbox(join(root, "support-outbox.json"))[0]).toMatchObject({
      id: queued.outboxId,
      status: "failed",
      attempts: 1,
    });
  });
});
