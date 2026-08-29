import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^sealed:/, ""),
  },
}));

import { seededDb } from "../db/testdb";
import {
  deliverWebhookEvent,
  enqueueWebhookEvent,
  installPlugin,
  listAutomationSchedules,
  listWebhookOutbox,
  previewPartnerImport,
  runExtensionReport,
  saveAutomationSchedule,
  saveWebhookEndpoint,
  setPluginEnabled,
} from "./integrations";

const manifest = {
  schemaVersion: 1 as const,
  id: "in.total.partner",
  name: "Partner connector",
  version: "1.0.0",
  publisher: "Partner Pvt Ltd",
  runtime: "declarative-v1" as const,
  compatibility: { contractVersion: 1 as const, minAppVersion: "0.5.0" },
  permissions: ["imports:preview" as const, "reports:read" as const],
  networkHosts: [],
  screens: [{ id: "overview", title: "Overview", description: "Partner status" }],
  importers: [
    {
      id: "orders",
      label: "Order JSON",
      input: "json" as const,
      recordKind: "ecommerce_order" as const,
      fieldMap: { orderId: "order.id", totalPaise: "amount.paise" },
    },
  ],
  reports: [
    { id: "books", label: "Trial balance", primitive: "trial_balance" as const },
  ],
  exports: [],
};

describe("partner integration platform", () => {
  it("installs an inert manifest, previews mapped data, and exposes audited report primitives", () => {
    const db = seededDb();
    const installed = installPlugin(db, manifest, "Owner", "0.5.0");
    expect(installed).toMatchObject({ enabled: false, compatible: true, importers: 1 });
    setPluginEnabled(db, manifest.id, true, "Owner");
    const preview = previewPartnerImport(
      db,
      manifest.id,
      "orders",
      JSON.stringify([{ order: { id: "O-1" }, amount: { paise: 125_000 } }]),
      "Owner",
    );
    expect(preview).toMatchObject({
      sourceRows: 1,
      acceptedRows: 1,
      rows: [{ orderId: "O-1", totalPaise: 125_000 }],
    });
    const report = runExtensionReport(
      db,
      manifest.id,
      "books",
      "2026-04-01",
      "2026-08-24",
    );
    expect(report).toMatchObject({
      contractVersion: 1,
      primitive: "trial_balance",
      provenance: { basis: "posted voucher lines" },
    });
  });

  it("retains visible payloads and signs successful webhook delivery", async () => {
    const db = seededDb();
    saveWebhookEndpoint(
      db,
      {
        name: "Local receiver",
        endpoint: "http://localhost:4321/events",
        eventTypes: ["voucher.posted"],
        secret: "a-long-local-secret",
      },
      "Owner",
    );
    const [queued] = enqueueWebhookEvent(db, "voucher.posted", {
      voucherId: 17,
      amountPaise: 250_000,
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-total-signature")).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      return new Response(null, { status: 204 });
    });
    const delivered = await deliverWebhookEvent(db, queued!.id, fetcher as typeof fetch);
    expect(delivered.state).toBe("delivered");
    expect(listWebhookOutbox(db)[0]?.payload).toEqual({
      voucherId: 17,
      amountPaise: 250_000,
    });
  });

  it("creates visible local schedules with deterministic next-run metadata", () => {
    const db = seededDb();
    const schedule = saveAutomationSchedule(
      db,
      {
        name: "Nightly mirror",
        taskKind: "mirror",
        cadence: "daily",
        localTime: "23:30",
      },
      "Owner",
    );
    expect(schedule.nextRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listAutomationSchedules(db)).toMatchObject([
      { name: "Nightly mirror", taskKind: "mirror", enabled: true },
    ]);
  });
});
