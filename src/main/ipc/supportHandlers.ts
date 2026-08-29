import { app, BrowserWindow, dialog, safeStorage } from "electron";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import { passphraseSchema } from "@shared/schemas";
import { dataRoot } from "../paths";
import { encryptFile } from "../db/crypt";
import { log, logsDir } from "../log";
import * as configSvc from "../services/config";
import * as crashReports from "../services/crashReports";
import * as supportCases from "../services/supportCases";
import * as supportOutbox from "../services/supportOutbox";
import { supportInstallationId } from "../services/supportInstallation";
import { requireDeviceSafetyControl } from "../services/deviceSafety";
import type { IpcHandle, OpenCompany } from "./types";
import { desktopServiceUrl } from "@shared/desktopBuildProfile";

interface SupportHandlerDependencies {
  getCurrentCompany: () => OpenCompany | null;
  hasSession: () => boolean;
}

const supportConsentSchema = z.object({
  message: z.boolean(),
  diagnostics: z.boolean(),
  logs: z.boolean(),
  companyMetadata: z.boolean(),
  focusContext: z.boolean(),
  screenshot: z.boolean(),
});

const supportFocusSchema = z
  .object({
    tag: z.string().trim().min(1).max(40),
    role: z.string().trim().max(80).nullable(),
    name: z.string().trim().max(160),
    testId: z.string().trim().max(120).nullable(),
    screen: z.string().trim().max(120).nullable(),
  })
  .nullable()
  .default(null);

const supportPayloadSchema = z.object({
  caseId: z.string().regex(/^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/),
  category: z.enum(["question", "bug", "idea", "accessibility", "privacy"]),
  severity: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  email: z.string().trim().email().max(200).or(z.literal("")),
  message: z.string().trim().min(10).max(5000),
  includeMessage: z.boolean(),
  includeDiagnostics: z.boolean().default(true),
  includeLogs: z.boolean().default(false),
  includeCompanyMetadata: z.boolean().default(false),
  focusContext: supportFocusSchema,
  screenshotDataUrl: z
    .string()
    .max(700_000)
    .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/)
    .nullable()
    .default(null),
});

function safeSupportDiagnostics(): {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  installationId: string;
} {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    installationId: supportInstallationId(),
  };
}

function supportCasePath(): string {
  return join(dataRoot(), "support-cases.json");
}

function supportOutboxPath(): string {
  return join(dataRoot(), "support-outbox.json");
}

const queuedDeliverySchema = z
  .object({
    caseId: z.string().regex(/^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/),
    category: z.enum(["question", "bug", "idea", "accessibility", "privacy"]),
    source: z.literal("app"),
  })
  .passthrough();

const SUPPORT_RESPONSE_LIMIT_BYTES = 16 * 1024;
const supportDeliveryResponseSchema = z
  .object({
    ok: z.literal(true),
    caseId: z.string().regex(/^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/),
    trackingToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/).optional(),
  })
  .passthrough();

const supportRemoteStatusSchema = z.object({
  caseId: z.string().regex(/^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/),
  status: z.enum(["submitted", "in_review", "waiting_for_customer", "resolved"]),
  receivedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

async function readBoundedSupportResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > SUPPORT_RESPONSE_LIMIT_BYTES) {
    throw new Error("Support service returned an oversized response");
  }

  if (!response.body) throw new Error("Support service returned an empty response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > SUPPORT_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error("Support service returned an oversized response");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks, received).toString("utf8")) as unknown;
  } catch {
    throw new Error("Support service returned an invalid response");
  }
}

async function deliverSupportPayload(body: Record<string, unknown>): Promise<z.infer<typeof supportDeliveryResponseSchema>> {
  const response = await fetch(desktopServiceUrl("/api/support"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": `Total/${app.getVersion()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Support service unavailable");
  const receipt = supportDeliveryResponseSchema.safeParse(
    await readBoundedSupportResponse(response),
  );
  if (!receipt.success) throw new Error("Support service did not accept the case");
  if (receipt.data.caseId !== body.caseId)
    throw new Error("Support service returned a mismatched case receipt");
  return receipt.data;
}

async function fetchSupportStatus(caseId: string, trackingToken: string): Promise<z.infer<typeof supportRemoteStatusSchema>> {
  const query = new URLSearchParams({ caseId, token: trackingToken });
  const response = await fetch(`${desktopServiceUrl("/api/support")}?${query.toString()}`, {
    headers: { "user-agent": `Total/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Support case status is unavailable");
  return supportRemoteStatusSchema.parse(await readBoundedSupportResponse(response));
}

function safeSupportContext(current: OpenCompany | null): {
  logs: { ts: string; level: string; event: string; version: string }[];
  company: {
    name: string;
    stateCode: string;
    gstRegistrationType: string;
    schemaVersion: number;
    voucherCount: number;
    enabledFeatures: string[];
  } | null;
} {
  const rows: { ts: string; level: string; event: string; version: string }[] = [];
  try {
    const files = readdirSync(logsDir())
      .filter((name) => /^total-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort()
      .slice(-3);
    for (const file of files) {
      const lines = readFileSync(join(logsDir(), file), "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-50);
      for (const line of lines) {
        try {
          const item = JSON.parse(line) as Record<string, unknown>;
          if (
            typeof item.ts === "string" &&
            typeof item.level === "string" &&
            typeof item.event === "string"
          ) {
            rows.push({
              ts: item.ts.slice(0, 30),
              level: item.level.slice(0, 12),
              event: item.event.slice(0, 80),
              version: typeof item.v === "string" ? item.v.slice(0, 30) : "",
            });
          }
        } catch {
          // Malformed lines are excluded rather than forwarded raw.
        }
      }
    }
  } catch {
    // Logs are optional; an absent/unreadable directory produces an empty preview.
  }
  const features = current ? configSvc.getFeatures(current.db) : null;
  return {
    logs: rows.slice(-50),
    company: current
      ? {
          name: current.info.name,
          stateCode: current.info.stateCode,
          gstRegistrationType: current.info.gstRegistrationType,
          schemaVersion: Number(current.db.pragma("user_version", { simple: true })),
          voucherCount: Number(
            (
              current.db
                .prepare("SELECT COUNT(*) AS count FROM vouchers WHERE deleted_at IS NULL")
                .get() as { count: number }
            ).count,
          ),
          enabledFeatures: Object.entries(features ?? {})
            .filter(([, enabled]) => enabled)
            .map(([name]) => name)
            .sort(),
        }
      : null,
  };
}

export function registerSupportHandlers(
  handle: IpcHandle,
  dependencies: SupportHandlerDependencies,
): void {
  const assertBookContextAllowed = (input: {
    includeLogs: boolean;
    includeCompanyMetadata: boolean;
  }): void => {
    const current = dependencies.getCurrentCompany();
    if (
      current?.usersExist &&
      !dependencies.hasSession() &&
      (input.includeLogs || input.includeCompanyMetadata)
    ) {
      throw new Error("Sign in before attaching activity logs or company metadata.");
    }
  };
  const assertStoredConsent = (input: z.infer<typeof supportPayloadSchema>): void => {
    const record = supportCases
      .readSupportCases(supportCasePath())
      .find((candidate) => candidate.id === input.caseId);
    if (!record) throw new Error("Support case not found");
    supportCases.assertSupportCaseConsent(record, {
      category: input.category,
      severity: input.severity,
      message: input.includeMessage,
      diagnostics: input.includeDiagnostics,
      logs: input.includeLogs,
      companyMetadata: input.includeCompanyMetadata,
      focusContext: input.focusContext !== null,
      screenshot: input.screenshotDataUrl !== null,
    });
  };

  handle("support:diagnostics", () => safeSupportDiagnostics());
  handle("crash:list", () => crashReports.listCrashEnvelopes(), "viewer");
  handle("crash:record", (payload) => {
    const input = z
      .object({
        message: z.string().min(1).max(2_000),
        stack: z.string().max(20_000).optional(),
        screen: z.string().max(80).optional(),
      })
      .parse(payload);
    const diagnostics = safeSupportDiagnostics();
    return crashReports.writeCrashEnvelope({
      kind: "renderer",
      appVersion: diagnostics.version,
      platform: diagnostics.platform,
      arch: diagnostics.arch,
      screen: input.screen ?? null,
      message: input.message,
      stack: input.stack,
    });
  }, "viewer");
  handle("crash:submit", async (payload) => {
    const { id } = z
      .object({ id: z.string().regex(/^CR-\d{8}-[A-F0-9]{6}$/) })
      .parse(payload);
    const envelope = crashReports
      .listCrashEnvelopes()
      .find((candidate) => candidate.id === id);
    if (!envelope) throw new Error("Crash envelope not found");
    const supportCase = supportCases.createSupportCase(supportCasePath(), {
      category: "bug",
      severity: "high",
      consent: {
        message: true,
        diagnostics: true,
        logs: false,
        companyMetadata: false,
        focusContext: false,
        screenshot: false,
      },
    });
    supportCases.updateSupportCase(supportCasePath(), supportCase.id, {
      status: "sending",
    });
    try {
      const receipt = await deliverSupportPayload({
        caseId: supportCase.id,
        category: "bug",
        severity: "high",
        email: "",
        message: `Opt-in crash envelope ${envelope.id}`,
        source: "app",
        diagnostics: safeSupportDiagnostics(),
        crashEnvelope: envelope,
      });
      supportCases.updateSupportCase(supportCasePath(), supportCase.id, {
        status: "submitted",
        trackingToken: receipt.trackingToken ?? null,
      });
      return { ok: true, caseId: supportCase.id };
    } catch {
      supportCases.updateSupportCase(supportCasePath(), supportCase.id, {
        status: "failed",
        lastError: "Crash delivery failed",
      });
      throw new Error(`Crash envelope ${envelope.id} remains safely stored on this device.`);
    }
  }, "viewer");
  handle("support:case:list", () => supportCases.readSupportCases(supportCasePath()));
  handle("support:case:status", async (payload) => {
    const { caseId } = z.object({
      caseId: z.string().regex(/^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/),
    }).parse(payload);
    const record = supportCases.readSupportCases(supportCasePath()).find((candidate) => candidate.id === caseId);
    if (!record?.trackingToken) throw new Error("This case has no private tracking token on this device");
    const remote = await fetchSupportStatus(caseId, record.trackingToken);
    return supportCases.updateSupportCase(supportCasePath(), caseId, {
      status: remote.status,
      lastError: null,
    });
  });
  handle("support:outbox:list", () =>
    supportOutbox.summarizeSupportOutbox(
      supportOutbox.readSupportOutbox(supportOutboxPath()),
    ),
  );
  handle("support:case:create", (payload) => {
    const input = z
      .object({
        category: z.enum(["question", "bug", "idea", "accessibility", "privacy"]),
        severity: z.enum(["low", "normal", "high", "critical"]).default("normal"),
        consent: supportConsentSchema,
      })
      .parse(payload);
    return supportCases.createSupportCase(supportCasePath(), input);
  });
  handle(
    "support:contextPreview",
    () => safeSupportContext(dependencies.getCurrentCompany()),
    "viewer",
  );
  handle("support:captureScreenshot", async () => {
    requireDeviceSafetyControl("supportUploads", "Support attachments are disabled on this device");
    const win =
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && candidate.isVisible(),
      );
    if (!win || win.isDestroyed()) throw new Error("The app window is not available");
    const captured = await win.webContents.capturePage();
    const size = captured.getSize();
    const image = size.width > 960 ? captured.resize({ width: 960, quality: "good" }) : captured;
    const dataUrl = `data:image/jpeg;base64,${image.toJPEG(55).toString("base64")}`;
    if (dataUrl.length > 700_000) throw new Error("The screenshot is too large to attach");
    return {
      dataUrl,
      width: image.getSize().width,
      height: image.getSize().height,
    };
  });
  handle("support:submit", async (payload) => {
    const input = supportPayloadSchema.parse(payload);
    if (!input.includeMessage) throw new Error("Confirm message consent before sending");
    assertStoredConsent(input);
    assertBookContextAllowed(input);
    supportCases.updateSupportCase(supportCasePath(), input.caseId, {
      status: "sending",
      lastError: null,
    });
    if (input.screenshotDataUrl !== null)
      requireDeviceSafetyControl("supportUploads", "Support attachments are disabled on this device");
    const context = safeSupportContext(dependencies.getCurrentCompany());
    const delivery = {
      caseId: input.caseId,
      category: input.category,
      severity: input.severity,
      email: input.email,
      message: input.message,
      source: "app" as const,
      diagnostics: input.includeDiagnostics ? safeSupportDiagnostics() : null,
      logs: input.includeLogs ? context.logs : null,
      companyMetadata: input.includeCompanyMetadata ? context.company : null,
      focusContext: input.focusContext,
      screenshotDataUrl: input.screenshotDataUrl,
    };
    try {
      const receipt = await deliverSupportPayload(delivery);
      const record = supportCases.updateSupportCase(supportCasePath(), input.caseId, {
        status: "submitted",
        lastError: null,
        trackingToken: receipt.trackingToken ?? null,
      });
      log("info", "support-case-submitted", { caseId: input.caseId });
      return { ok: true, queued: false, caseId: input.caseId, status: record.status };
    } catch {
      if (!safeStorage.isEncryptionAvailable()) {
        supportCases.updateSupportCase(supportCasePath(), input.caseId, {
          status: "failed",
          lastError: "Network delivery failed",
        });
        throw new Error(
          "Support could not be reached and secure device storage is unavailable. Save an encrypted offline bundle or use email.",
        );
      }
      const encryptedPayload = safeStorage
        .encryptString(JSON.stringify(delivery))
        .toString("base64");
      const queued = supportOutbox.enqueueSupportPayload(supportOutboxPath(), {
        caseId: input.caseId,
        encryptedPayload,
        hasAttachment: input.screenshotDataUrl !== null,
        lastError: "Network delivery failed",
      });
      const record = supportCases.updateSupportCase(supportCasePath(), input.caseId, {
        status: "queued",
        lastError: "Waiting for a manual retry",
      });
      log("info", "support-case-queued", { caseId: input.caseId });
      return {
        ok: true,
        queued: true,
        outboxId: queued.id,
        caseId: input.caseId,
        status: record.status,
      };
    }
  });
  handle("support:outbox:retry", async (payload) => {
    const input = z
      .object({
        id: z.string().uuid(),
        approveAttachmentRetry: z.boolean().default(false),
      })
      .parse(payload);
    const item = supportOutbox.getSupportOutboxItem(supportOutboxPath(), input.id);
    if (item.hasAttachment)
      requireDeviceSafetyControl("supportUploads", "Support attachments are disabled on this device");
    if (item.hasAttachment && !input.approveAttachmentRetry) {
      throw new Error("Confirm the screenshot upload before retrying this submission");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure device storage is unavailable");
    }
    supportOutbox.updateSupportOutboxItem(supportOutboxPath(), input.id, {
      status: "retrying",
      attempts: item.attempts + 1,
      attachmentRetryApproved: item.hasAttachment && input.approveAttachmentRetry,
      lastError: null,
    });
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(item.encryptedPayload, "base64"));
      const delivery = queuedDeliverySchema.parse(JSON.parse(plaintext));
      const receipt = await deliverSupportPayload(delivery);
      supportOutbox.removeSupportOutboxItem(supportOutboxPath(), input.id);
      const record = supportCases.updateSupportCase(supportCasePath(), item.caseId, {
        status: "submitted",
        lastError: null,
        trackingToken: receipt.trackingToken ?? null,
      });
      log("info", "support-case-retry-submitted", { caseId: item.caseId });
      return { ok: true, caseId: item.caseId, status: record.status };
    } catch (error) {
      supportOutbox.updateSupportOutboxItem(supportOutboxPath(), input.id, {
        status: "failed",
        attachmentRetryApproved: false,
        lastError: "Retry failed",
      });
      supportCases.updateSupportCase(supportCasePath(), item.caseId, {
        status: "queued",
        lastError: "Retry failed",
      });
      throw new Error(error instanceof Error && error.message.includes("decrypt")
        ? "The queued submission can no longer be decrypted on this device"
        : "Support is still unavailable. The encrypted submission remains queued.");
    }
  });
  handle("support:outbox:discard", (payload) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(payload);
    const item = supportOutbox.getSupportOutboxItem(supportOutboxPath(), id);
    supportOutbox.removeSupportOutboxItem(supportOutboxPath(), id);
    supportCases.updateSupportCase(supportCasePath(), item.caseId, {
      status: "failed",
      lastError: "Queued submission discarded on this device",
    });
    log("info", "support-case-queue-discarded", { caseId: item.caseId });
    return { ok: true };
  });
  handle("support:bundleOffline", async (payload) => {
    const input = supportPayloadSchema.extend({ passphrase: passphraseSchema }).parse(payload);
    if (!input.includeMessage) {
      throw new Error("Confirm message consent before saving the bundle");
    }
    assertStoredConsent(input);
    assertBookContextAllowed(input);
    const context = safeSupportContext(dependencies.getCurrentCompany());
    const consent = {
      message: input.includeMessage,
      diagnostics: input.includeDiagnostics,
      logs: input.includeLogs,
      companyMetadata: input.includeCompanyMetadata,
      focusContext: input.focusContext !== null,
      screenshot: input.screenshotDataUrl !== null,
    };
    const entries: supportCases.ZipEntry[] = [
      {
        name: "case.json",
        data: Buffer.from(JSON.stringify({
          caseId: input.caseId,
          category: input.category,
          severity: input.severity,
          email: input.email,
          createdAt: new Date().toISOString(),
          consent,
        }, null, 2)),
      },
    ];
    if (input.includeMessage) {
      entries.push({ name: "message.txt", data: Buffer.from(input.message) });
    }
    if (input.includeDiagnostics) {
      entries.push({
        name: "diagnostics.json",
        data: Buffer.from(JSON.stringify(safeSupportDiagnostics(), null, 2)),
      });
    }
    if (input.includeLogs) {
      entries.push({
        name: "logs.json",
        data: Buffer.from(JSON.stringify(context.logs, null, 2)),
      });
    }
    if (input.includeCompanyMetadata && context.company) {
      entries.push({
        name: "company.json",
        data: Buffer.from(JSON.stringify(context.company, null, 2)),
      });
    }
    if (input.focusContext) {
      entries.push({
        name: "focus.json",
        data: Buffer.from(JSON.stringify(input.focusContext, null, 2)),
      });
    }
    if (input.screenshotDataUrl) {
      entries.push({
        name: "screenshot.jpg",
        data: Buffer.from(input.screenshotDataUrl.split(",")[1]!, "base64"),
      });
    }

    const target = await dialog.showSaveDialog({
      title: "Save encrypted support bundle",
      defaultPath: `Total-support-${input.caseId}.zip.enc`,
      filters: [{ name: "Encrypted support bundle", extensions: ["enc"] }],
    });
    if (target.canceled || !target.filePath) return null;
    const temporary = mkdtempSync(join(tmpdir(), "total-support-bundle-"));
    const zipPath = join(temporary, `${input.caseId}.zip`);
    try {
      writeFileSync(zipPath, supportCases.createStoredZip(entries), { mode: 0o600 });
      await encryptFile(zipPath, target.filePath, input.passphrase);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    const record = supportCases.updateSupportCase(supportCasePath(), input.caseId, {
      status: "saved_offline",
      lastError: null,
    });
    log("info", "support-bundle-saved", { caseId: input.caseId });
    return { path: target.filePath, caseId: input.caseId, status: record.status };
  });
}
