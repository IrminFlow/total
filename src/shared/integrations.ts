import { z } from "zod";

export const INTEGRATION_CONTRACT_VERSION = 1 as const;

export const integrationPermissionSchema = z.enum([
  "imports:preview",
  "reports:read",
  "exports:write",
  "webhooks:enqueue",
  "filesystem:plugin_storage",
  "network:declared_hosts",
]);
export type IntegrationPermission = z.infer<
  typeof integrationPermissionSchema
>;

export const integrationReportPrimitiveSchema = z.enum([
  "trial_balance",
  "day_book",
  "sales_register",
  "purchase_register",
  "receivables",
  "payables",
]);
export type IntegrationReportPrimitive = z.infer<
  typeof integrationReportPrimitiveSchema
>;

const fieldPath = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,5}$/)
  .max(160);

export const pluginManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/)
      .max(100),
    name: z.string().trim().min(2).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/),
    publisher: z.string().trim().min(2).max(100),
    runtime: z.literal("declarative-v1"),
    compatibility: z
      .object({
        contractVersion: z.literal(INTEGRATION_CONTRACT_VERSION),
        minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        maxAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
      })
      .strict(),
    permissions: z.array(integrationPermissionSchema).max(6).default([]),
    networkHosts: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/),
      )
      .max(20)
      .default([]),
    screens: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
            title: z.string().trim().min(2).max(60),
            description: z.string().trim().max(240),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    importers: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
            label: z.string().trim().min(2).max(80),
            input: z.enum(["json", "csv"]),
            recordKind: z.enum([
              "ledger",
              "item",
              "journal_line",
              "settlement",
              "ecommerce_order",
            ]),
            fieldMap: z.record(z.string().max(80), fieldPath),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    reports: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
            label: z.string().trim().min(2).max(80),
            primitive: integrationReportPrimitiveSchema,
          })
          .strict(),
      )
      .max(16)
      .default([]),
    exports: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
            label: z.string().trim().min(2).max(80),
            format: z.enum(["json", "csv"]),
            primitive: integrationReportPrimitiveSchema,
          })
          .strict(),
      )
      .max(16)
      .default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.networkHosts.length > 0 &&
      !manifest.permissions.includes("network:declared_hosts")
    ) {
      context.addIssue({
        code: "custom",
        path: ["networkHosts"],
        message: "Declared network hosts require network:declared_hosts",
      });
    }
    if (
      manifest.importers.length > 0 &&
      !manifest.permissions.includes("imports:preview")
    ) {
      context.addIssue({
        code: "custom",
        path: ["importers"],
        message: "Importer declarations require imports:preview",
      });
    }
    if (
      (manifest.reports.length > 0 || manifest.exports.length > 0) &&
      !manifest.permissions.includes("reports:read")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reports"],
        message: "Report and export declarations require reports:read",
      });
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  publisher: string;
  enabled: boolean;
  compatible: boolean;
  permissions: IntegrationPermission[];
  screens: number;
  importers: number;
  reports: number;
  exports: number;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
}

export interface IntegrationDrilldown {
  screen: "voucher" | "ledger" | "sales-register" | "purchase-register";
  params: Record<string, string | number>;
}

export interface ExtensionReportResult {
  contractVersion: 1;
  pluginId: string;
  reportId: string;
  primitive: IntegrationReportPrimitive;
  generatedAt: string;
  provenance: { from: string; to: string; basis: "posted voucher lines" };
  rows: Array<Record<string, unknown> & { drilldown?: IntegrationDrilldown }>;
  totals: Record<string, number>;
}

export interface WebhookEndpointSummary {
  id: number;
  name: string;
  endpoint: string;
  eventTypes: string[];
  active: boolean;
  hasSecret: boolean;
  lastError: string | null;
  createdBy: string;
  createdAt: string;
}

export interface WebhookOutboxEvent {
  id: string;
  endpointId: number;
  endpointName: string;
  eventType: string;
  payload: unknown;
  payloadHash: string;
  state: "pending" | "delivered" | "retry" | "dead";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export type AutomationTaskKind = "backup" | "mirror" | "report_pack";
export interface AutomationSchedule {
  id: number;
  name: string;
  taskKind: AutomationTaskKind;
  cadence: "daily" | "weekly" | "monthly";
  localTime: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  enabled: boolean;
  config: Record<string, unknown>;
  nextRunAt: string;
  lastRunAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface AutomationRun {
  id: number;
  scheduleId: number;
  taskKind: AutomationTaskKind;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  output: Record<string, unknown> | null;
  error: string | null;
}
