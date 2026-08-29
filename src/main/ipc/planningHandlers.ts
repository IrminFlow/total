import { z } from "zod";
import {
  budgetInputSchema,
  budgetVarianceSchema,
  ccStatementSchema,
  costCentreInputSchema,
  periodSchema,
} from "@shared/schemas";
import * as budgets from "../services/budgets";
import * as costCentres from "../services/costCentres";
import type { CompanyContext, IpcHandle } from "./types";

interface PlanningHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

const positiveIdSchema = z.object({ id: z.number().int().positive() });

export function registerPlanningHandlers({
  handle,
  requireCompany,
}: PlanningHandlerContext): void {
  handle(
    "cc:list",
    () => costCentres.listCostCentres(requireCompany().db),
    "viewer",
  );
  handle("cc:save", (payload) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: costCentreInputSchema,
      })
      .parse(payload);
    return costCentres.saveCostCentre(requireCompany().db, data, id);
  });
  handle("cc:delete", (payload) =>
    costCentres.deleteCostCentre(
      requireCompany().db,
      positiveIdSchema.parse(payload).id,
    ),
  );
  handle(
    "cc:report",
    (payload) => {
      const { from, to } = periodSchema.parse(payload);
      return costCentres.ccReport(requireCompany().db, from, to);
    },
    "viewer",
  );
  handle(
    "cc:statement",
    (payload) => {
      const { ccId, from, to } = ccStatementSchema.parse(payload);
      return costCentres.ccStatement(requireCompany().db, ccId, from, to);
    },
    "viewer",
  );

  handle(
    "budget:list",
    () => budgets.listBudgets(requireCompany().db),
    "viewer",
  );
  handle("budget:save", (payload) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: budgetInputSchema,
      })
      .parse(payload);
    return budgets.saveBudget(requireCompany().db, data, id);
  });
  handle("budget:delete", (payload) =>
    budgets.deleteBudget(
      requireCompany().db,
      positiveIdSchema.parse(payload).id,
    ),
  );
  handle(
    "budget:variance",
    (payload) => {
      const { budgetId, upToMonth } = budgetVarianceSchema.parse(payload);
      return budgets.budgetVarianceReport(
        requireCompany().db,
        budgetId,
        upToMonth,
      );
    },
    "viewer",
  );
}
