import { searchGlobalSchema } from "@shared/schemas";
import { globalSearch } from "../services/search";
import type { CompanyContext, IpcHandle } from "./types";

interface SearchHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerSearchHandlers({
  handle,
  requireCompany,
}: SearchHandlerContext): void {
  handle(
    "search:global",
    (payload) =>
      globalSearch(requireCompany().db, searchGlobalSchema.parse(payload).q),
    "viewer",
  );
}
