import { z } from "zod";
import { periodSchema } from "@shared/schemas";
import * as analysis from "../services/analysis";
import type { CompanyContext, IpcHandle } from "./types";

interface AnalysisHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerAnalysisHandlers({
  handle,
  requireCompany,
}: AnalysisHandlerContext): void {
  handle(
    "analysis:register",
    (payload) => {
      const { kind, from, to, granularity } = periodSchema
        .extend({
          kind: z.enum(["sales", "purchase"]),
          granularity: z.enum(["month", "quarter"]).default("month"),
        })
        .parse(payload);
      return analysis.registerByPeriod(
        requireCompany().db,
        kind,
        from,
        to,
        granularity,
      );
    },
    "viewer",
  );
  handle(
    "analysis:outstandings",
    (payload) => {
      const { side, asOn } = z
        .object({ side: z.enum(["receivable", "payable"]), asOn: z.string() })
        .parse(payload);
      return analysis.outstandings(requireCompany().db, side, asOn);
    },
    "viewer",
  );
}
