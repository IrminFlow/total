import { describe, expect, it } from "vitest";
import { registerConsolidatedHandlers } from "./consolidatedHandlers";
import { registerYearEndHandlers } from "./yearEndHandlers";
import { registerBackupHandlers } from "./backupHandlers";
import { registerAnalysisHandlers } from "./analysisHandlers";
import { registerAuditHandlers } from "./auditHandlers";
import { registerAuthHandlers } from "./authHandlers";
import { registerApplicationHandlers } from "./applicationHandlers";
import { registerConfigHandlers } from "./configHandlers";
import { registerIntelligenceHandlers } from "./intelligenceHandlers";
import { registerSearchHandlers } from "./searchHandlers";
import { registerPlanningHandlers } from "./planningHandlers";
import { registerRecurringHandlers } from "./recurringHandlers";
import { registerOutstandingBillsHandlers } from "./outstandingBillsHandlers";
import { registerComplianceHandlers } from "./complianceHandlers";
import { registerExtrasHandlers } from "./extrasHandlers";
import type { IpcHandle } from "./types";
import type { Role } from "../services/roles";

describe("extracted IPC domain registration", () => {
  it("preserves exact channel and role boundaries", () => {
    const registrations: Array<[string, Role | undefined]> = [];
    const handle: IpcHandle = (channel, _handler, role) => {
      registrations.push([channel, role]);
    };
    const requireCompany = () => {
      throw new Error("registration must not access a company");
    };

    registerConsolidatedHandlers({ handle, requireCompany });
    registerYearEndHandlers({
      handle,
      requireCompany,
      prepareClose: () => {
        throw new Error("registration must not prepare a close");
      },
    });
    registerBackupHandlers({
      handle,
      requireCompany,
      actor: () => {
        throw new Error("registration must not resolve an actor");
      },
      chooseDestination: async () => {
        throw new Error("registration must not open a chooser");
      },
      backupCompany: (() => {
        throw new Error("registration must not create a backup");
      }) as never,
      companyBackupsDir: (() => {
        throw new Error("registration must not resolve paths");
      }) as never,
      inspectBackup: (() => {
        throw new Error("registration must not inspect backups");
      }) as never,
      listBackupsIn: (() => {
        throw new Error("registration must not list backups");
      }) as never,
      resilience: {} as never,
    });
    registerAnalysisHandlers({ handle, requireCompany });
    registerAuditHandlers({ handle, requireCompany });
    registerAuthHandlers({
      handle,
      requireCompany: requireCompany as never,
      getCurrentCompany: () => null,
      getSessionUser: () => null,
      getSessionToken: () => null,
      setSessionUser: () => undefined,
      setSessionToken: () => undefined,
    });
    registerApplicationHandlers({
      handle,
      writeRendererError: () => undefined,
      revealLogs: () => undefined,
      getVersion: () => "0.5.0",
      platform: "darwin",
      checkForUpdates: () => undefined,
    });
    registerConfigHandlers({ handle, requireCompany });
    registerIntelligenceHandlers({ handle, requireCompany });
    registerSearchHandlers({ handle, requireCompany });
    registerOutstandingBillsHandlers({ handle, requireCompany });
    registerComplianceHandlers({
      handle,
      requireCompany,
      actor: () => {
        throw new Error("registration must not resolve an actor");
      },
    });
    registerPlanningHandlers({ handle, requireCompany });
    registerRecurringHandlers({
      handle,
      requireCompany,
      getSessionUser: () => null,
    });
    registerExtrasHandlers({ handle, requireCompany });

    expect(registrations).toEqual([
      ["consol:run", "viewer"],
      ["yearend:preview", "viewer"],
      ["yearend:close", "owner"],
      ["company:backup", undefined],
      ["backup:run", undefined],
      ["backup:list", "viewer"],
      ["backup:destinations:list", "viewer"],
      ["backup:destinations:add", "owner"],
      ["backup:destinations:setActive", "owner"],
      ["backup:drills:list", "viewer"],
      ["backup:drills:run", "owner"],
      ["backup:rotation:get", "viewer"],
      ["backup:rotation:set", "owner"],
      ["backup:preview", "owner"],
      ["analysis:register", "viewer"],
      ["analysis:outstandings", "viewer"],
      ["audit:list", "viewer"],
      ["audit:verify", "viewer"],
      ["config:audit:get", "viewer"],
      ["config:audit:set", "owner"],
      ["auth:users", undefined],
      ["auth:login", undefined],
      ["auth:logout", undefined],
      ["auth:current", undefined],
      ["users:list", "owner"],
      ["users:save", "owner"],
      ["users:deactivate", "owner"],
      ["log:renderer", undefined],
      ["log:reveal", undefined],
      ["app:info", undefined],
      ["app:checkUpdates", "viewer"],
      ["config:features:get", "viewer"],
      ["config:features:set", "owner"],
      ["config:invoice:get", "viewer"],
      ["config:invoice:set", "owner"],
      ["intel:suggestLedgers", "viewer"],
      ["intel:anomaly", "viewer"],
      ["search:global", "viewer"],
      ["bills:open", "viewer"],
      ["compliance:list", "viewer"],
      ["compliance:sync", undefined],
      ["compliance:save", undefined],
      ["cc:list", "viewer"],
      ["cc:save", undefined],
      ["cc:delete", undefined],
      ["cc:report", "viewer"],
      ["cc:statement", "viewer"],
      ["budget:list", "viewer"],
      ["budget:save", undefined],
      ["budget:delete", undefined],
      ["budget:variance", "viewer"],
      ["recurring:list", "viewer"],
      ["recurring:save", undefined],
      ["recurring:delete", undefined],
      ["recurring:due", "viewer"],
      ["recurring:post", undefined],
      ["recurring:skip", undefined],
      ["currency:list", "viewer"],
      ["currency:create", undefined],
      ["currency:delete", undefined],
      ["bom:get", "viewer"],
      ["bom:set", undefined],
      ["bom:items", "viewer"],
    ]);
  });
});
