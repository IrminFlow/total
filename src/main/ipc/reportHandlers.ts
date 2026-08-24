import { randomUUID } from "crypto";
import { z } from "zod";
import { periodSchema } from "@shared/schemas";
import * as reports from "../services/reports";
import { backgroundWork } from "../services/workloadGovernor";
import type { CompanyContext, IpcHandle } from "./types";

interface ReportHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

function reportRequest<T>(
  payload: unknown,
  task: () => T | Promise<T>,
): Promise<T> {
  const requestId =
    z
      .object({ __totalRequestId: z.string().uuid().optional() })
      .passthrough()
      .parse(payload ?? {}).__totalRequestId ?? randomUUID();
  return backgroundWork.run("report", requestId, task);
}

export function registerReportHandlers({
  handle,
  requireCompany,
}: ReportHandlerContext): void {
  handle(
    "report:dayBook",
    (payload) =>
      reportRequest(payload, () => {
        const { from, to, includeOutOfBooks } = periodSchema
          .extend({ includeOutOfBooks: z.boolean().optional() })
          .parse(payload);
        return reports.dayBook(requireCompany().db, from, to, {
          includeOutOfBooks,
        });
      }),
    "viewer",
  );
  handle(
    "report:ledger",
    (payload) =>
      reportRequest(payload, () => {
        const { ledgerId, from, to, groupBy } = periodSchema
          .extend({
            ledgerId: z.number().int().positive(),
            groupBy: z.enum(["month"]).optional(),
          })
          .parse(payload);
        return reports.ledgerStatement(
          requireCompany().db,
          ledgerId,
          from,
          to,
          groupBy,
        );
      }),
    "viewer",
  );
  handle(
    "report:trialBalance",
    (payload) =>
      reportRequest(payload, () => {
        const { asOn } = z.object({ asOn: z.string() }).parse(payload);
        return reports.trialBalance(requireCompany().db, asOn);
      }),
    "viewer",
  );
  handle(
    "report:profitLoss",
    (payload) =>
      reportRequest(payload, () => {
        const { from, to, comparePrior } = periodSchema
          .extend({ comparePrior: z.boolean().optional() })
          .parse(payload);
        return reports.profitAndLoss(
          requireCompany().db,
          from,
          to,
          comparePrior ? { comparePrior } : undefined,
        );
      }),
    "viewer",
  );
  handle(
    "report:balanceSheet",
    (payload) =>
      reportRequest(payload, () => {
        const { asOn, comparePrior } = z
          .object({ asOn: z.string(), comparePrior: z.boolean().optional() })
          .parse(payload);
        const company = requireCompany();
        return reports.balanceSheet(
          company.db,
          `${company.info.booksFrom}-04-01`,
          asOn,
          comparePrior,
        );
      }),
    "viewer",
  );
  handle(
    "report:stockSummary",
    (payload) =>
      reportRequest(payload, () => {
        const { asOn } = z.object({ asOn: z.string() }).parse(payload);
        return reports.stockSummary(requireCompany().db, asOn);
      }),
    "viewer",
  );
  handle(
    "report:dashboard",
    (payload) =>
      reportRequest(payload, () => {
        const { today, fyFrom } = z
          .object({ today: z.string(), fyFrom: z.string() })
          .parse(payload);
        return reports.dashboard(requireCompany().db, today, fyFrom);
      }),
    "viewer",
  );
  handle(
    "report:cashFlow",
    (payload) =>
      reportRequest(payload, () => {
        const { from, to } = periodSchema.parse(payload);
        return reports.cashFlow(requireCompany().db, from, to);
      }),
    "viewer",
  );
  handle(
    "report:stockAgeing",
    (payload) =>
      reportRequest(payload, () => {
        const { asOn } = z.object({ asOn: z.string() }).parse(payload);
        return reports.stockAgeing(requireCompany().db, asOn);
      }),
    "viewer",
  );
  // Preserve the existing accountant default for item profitability.
  handle("report:itemProfitability", (payload) =>
    reportRequest(payload, () => {
      const { from, to } = periodSchema.parse(payload);
      return reports.itemProfitability(requireCompany().db, from, to);
    }),
  );
  handle(
    "report:exceptions",
    (payload) =>
      reportRequest(payload, () => {
        const { from, to } = periodSchema.parse(payload);
        return reports.exceptions(requireCompany().db, from, to);
      }),
    "viewer",
  );
}
