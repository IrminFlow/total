import { z } from "zod";
import * as intel from "../services/intel";
import type { CompanyContext, IpcHandle } from "./types";

interface IntelligenceHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerIntelligenceHandlers({
  handle,
  requireCompany,
}: IntelligenceHandlerContext): void {
  handle(
    "intel:suggestLedgers",
    (payload) => {
      const { kind, query } = z
        .object({ kind: z.string(), query: z.string() })
        .parse(payload);
      return intel.suggestLedgers(requireCompany().db, kind, query);
    },
    "viewer",
  );
  handle(
    "intel:anomaly",
    (payload) => {
      const { ledgerId, amount } = z
        .object({
          ledgerId: z.number().int().positive(),
          amount: z.number().int(),
        })
        .parse(payload);
      return intel.anomalyCheck(requireCompany().db, ledgerId, amount);
    },
    "viewer",
  );
}
