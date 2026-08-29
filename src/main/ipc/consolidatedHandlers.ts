import { consolidatedRunSchema } from "@shared/schemas";
import * as consolidated from "../services/consolidated";
import type { CompanyContext, IpcHandle } from "./types";

interface ConsolidatedHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerConsolidatedHandlers({
  handle,
  requireCompany,
}: ConsolidatedHandlerContext): void {
  handle(
    "consol:run",
    (payload) => {
      const activeCompany = requireCompany();
      const { slugs, kind, from, to, translationRates, eliminations } =
        consolidatedRunSchema.parse(payload);
      return consolidated.consolidated(
        slugs,
        kind,
        from,
        to,
        { translationRates, eliminations },
        new Set([activeCompany.slug]),
      );
    },
    "viewer",
  );
}
