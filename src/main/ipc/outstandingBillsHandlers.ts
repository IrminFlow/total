import { billsOpenSchema } from "@shared/schemas";
import * as analysis from "../services/analysis";
import type { CompanyContext, IpcHandle } from "./types";

interface OutstandingBillsHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerOutstandingBillsHandlers({
  handle,
  requireCompany,
}: OutstandingBillsHandlerContext): void {
  handle(
    "bills:open",
    (payload) => {
      const { partyLedgerId, asOn } = billsOpenSchema.parse(payload);
      return analysis.openBills(requireCompany().db, partyLedgerId, asOn);
    },
    "viewer",
  );
}
