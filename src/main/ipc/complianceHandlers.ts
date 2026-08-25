import { z } from "zod";
import { isoDate } from "@shared/schemas";
import * as complianceOps from "../services/complianceOps";
import * as configSvc from "../services/config";
import type { CompanyContext, IpcHandle } from "./types";

interface ComplianceHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
  actor: () => string;
}

const complianceInputSchema = z.object({
  id: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(180),
  dueDate: isoDate,
  kind: z.enum(["gst", "tds", "pf", "esi", "advance-tax", "state", "custom"]),
  status: z.enum(["open", "in_progress", "filed", "paid", "not_applicable"]),
  owner: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

export function registerComplianceHandlers({
  handle,
  requireCompany,
  actor,
}: ComplianceHandlerContext): void {
  handle(
    "compliance:list",
    (payload) => {
      const data = z
        .object({ from: isoDate.optional(), to: isoDate.optional() })
        .parse(payload ?? {});
      return complianceOps.listComplianceObligations(
        requireCompany().db,
        data.from,
        data.to,
      );
    },
    "viewer",
  );
  handle("compliance:sync", (payload) => {
    const { today } = z.object({ today: isoDate }).parse(payload);
    const company = requireCompany();
    return complianceOps.syncComplianceCalendar(
      company.db,
      company.info,
      today,
      configSvc.getFeatures(company.db).payroll,
      actor(),
    );
  });
  handle("compliance:save", (payload) =>
    complianceOps.saveComplianceObligation(
      requireCompany().db,
      complianceInputSchema.parse(payload),
      actor(),
    ),
  );
}
