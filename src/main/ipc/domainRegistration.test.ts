import { describe, expect, it } from "vitest";
import { registerConsolidatedHandlers } from "./consolidatedHandlers";
import { registerYearEndHandlers } from "./yearEndHandlers";
import { registerAnalysisHandlers } from "./analysisHandlers";
import { registerAuditHandlers } from "./auditHandlers";
import { registerConfigHandlers } from "./configHandlers";
import { registerIntelligenceHandlers } from "./intelligenceHandlers";
import { registerSearchHandlers } from "./searchHandlers";
import { registerPlanningHandlers } from "./planningHandlers";
import { registerRecurringHandlers } from "./recurringHandlers";
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
    registerYearEndHandlers({ handle, requireCompany });
    registerAnalysisHandlers({ handle, requireCompany });
    registerAuditHandlers({ handle, requireCompany });
    registerConfigHandlers({ handle, requireCompany });
    registerIntelligenceHandlers({ handle, requireCompany });
    registerSearchHandlers({ handle, requireCompany });
    registerPlanningHandlers({ handle, requireCompany });
    registerRecurringHandlers({
      handle,
      requireCompany,
      getSessionUser: () => null,
    });

    expect(registrations).toEqual([
      ["consol:run", "viewer"],
      ["yearend:preview", "viewer"],
      ["yearend:close", "owner"],
      ["analysis:register", "viewer"],
      ["analysis:outstandings", "viewer"],
      ["audit:list", "viewer"],
      ["audit:verify", "viewer"],
      ["config:audit:get", "viewer"],
      ["config:audit:set", "owner"],
      ["config:features:get", "viewer"],
      ["config:features:set", "owner"],
      ["config:invoice:get", "viewer"],
      ["config:invoice:set", "owner"],
      ["intel:suggestLedgers", "viewer"],
      ["intel:anomaly", "viewer"],
      ["search:global", "viewer"],
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
    ]);
  });
});
