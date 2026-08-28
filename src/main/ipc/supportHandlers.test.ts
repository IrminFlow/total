import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { IpcHandle, IpcHandler } from "./types";
import { enqueueSupportPayload, readSupportOutbox } from "../services/supportOutbox";
import { readSupportCases } from "../services/supportCases";

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

function createCaseForSubmission(): string {
  const created = handlers.get("support:case:create")!({
    category: "bug",
    consent: {
      message: true,
      diagnostics: true,
      logs: false,
      companyMetadata: false,
      focusContext: false,
      screenshot: false,
    },
  }) as { id: string };
  return created.id;
}

function submitCase(caseId: string): Promise<unknown> {
  return handlers.get("support:submit")!({
    caseId,
    category: "bug",
    email: "tester@example.com",
    message: "A focused support delivery contract test.",
    includeMessage: true,
    includeDiagnostics: true,
    includeLogs: false,
    includeCompanyMetadata: false,
    focusContext: null,
    screenshotDataUrl: null,
  }) as Promise<unknown>;
}

describe("support delivery response contract", () => {
  it("stores a bounded private tracking token and refreshes case status", async () => {
    const trackingToken = "t".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body)) as { caseId: string };
        return new Response(JSON.stringify({ ok: true, caseId: body.caseId, trackingToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const url = String(input);
      expect(url).toContain(`token=${trackingToken}`);
      const caseId = new URL(url).searchParams.get("caseId");
      return new Response(JSON.stringify({
        caseId,
        status: "in_review",
        receivedAt: "2026-08-28T10:00:00.000Z",
        updatedAt: "2026-08-28T10:01:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const caseId = createCaseForSubmission();

    await expect(submitCase(caseId)).resolves.toMatchObject({ queued: false, caseId });
    expect(readSupportCases(join(root, "support-cases.json"))[0]).toMatchObject({
      id: caseId,
      status: "submitted",
      trackingToken,
    });
    await expect(handlers.get("support:case:status")!({ caseId })).resolves.toMatchObject({
      id: caseId,
      status: "in_review",
      trackingToken,
    });
  });

  it("queues a normal submission when the service returns its HTTP 202 fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      status: "fallback",
      mailto: "mailto:total@example.com",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));
    const caseId = createCaseForSubmission();

    await expect(submitCase(caseId)).resolves.toMatchObject({
      ok: true,
      queued: true,
      caseId,
      status: "queued",
    });
    expect(readSupportOutbox(join(root, "support-outbox.json"))).toHaveLength(1);
    expect(readSupportCases(join(root, "support-cases.json"))[0]).toMatchObject({
      id: caseId,
      status: "queued",
    });
  });

  it("rejects a crash submission on HTTP 202 and keeps the crash stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      status: "fallback",
      mailto: "mailto:total@example.com",
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })));
    const envelope = handlers.get("crash:record")!({
      message: "Renderer crashed while opening a report",
      screen: "reports",
    }) as { id: string };

    await expect(handlers.get("crash:submit")!({ id: envelope.id })).rejects.toThrow(
      `Crash envelope ${envelope.id} remains safely stored on this device.`,
    );
    expect(handlers.get("crash:list")!(undefined)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: envelope.id })]),
    );
    expect(readSupportCases(join(root, "support-cases.json"))[0]).toMatchObject({
      status: "failed",
      lastError: "Crash delivery failed",
    });
  });

  it("queues a normal submission when a successful response exceeds the receipt limit", async () => {
    const oversized = JSON.stringify({ ok: true, padding: "x".repeat(20_000) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(oversized, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(oversized)),
      },
    })));
    const caseId = createCaseForSubmission();

    await expect(submitCase(caseId)).resolves.toMatchObject({
      queued: true,
      caseId,
      status: "queued",
    });
  });
});

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
