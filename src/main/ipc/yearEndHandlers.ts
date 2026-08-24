import { z } from "zod";
import * as yearEnd from "../services/yearEnd";
import type { CompanyContext, IpcHandle } from "./types";

interface YearEndHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

const fyStartYearSchema = z.object({
  fyStartYear: z.number().int().min(1990).max(2100),
});

export function registerYearEndHandlers({
  handle,
  requireCompany,
}: YearEndHandlerContext): void {
  handle(
    "yearend:preview",
    (payload) => {
      const { fyStartYear } = fyStartYearSchema.parse(payload);
      return yearEnd.closePreview(requireCompany().db, fyStartYear);
    },
    "viewer",
  );
  handle(
    "yearend:close",
    (payload) => {
      const { fyStartYear } = fyStartYearSchema.parse(payload);
      const company = requireCompany();
      return yearEnd.postClose(company.db, company.info, fyStartYear);
    },
    "owner",
  );
}
