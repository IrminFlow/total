import { z } from "zod";
import { bomInputSchema, currencyInputSchema } from "@shared/schemas";
import * as extras from "../services/extras";
import type { CompanyContext, IpcHandle } from "./types";

interface ExtrasHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

const positiveIdSchema = z.object({ id: z.number().int().positive() });
const itemIdSchema = z.object({ itemId: z.number().int().positive() });

export function registerExtrasHandlers({
  handle,
  requireCompany,
}: ExtrasHandlerContext): void {
  handle(
    "currency:list",
    () => extras.listCurrencies(requireCompany().db),
    "viewer",
  );
  handle("currency:create", (payload) =>
    extras.createCurrency(
      requireCompany().db,
      currencyInputSchema.parse(payload),
    ),
  );
  handle("currency:delete", (payload) =>
    extras.deleteCurrency(
      requireCompany().db,
      positiveIdSchema.parse(payload).id,
    ),
  );
  handle(
    "bom:get",
    (payload) =>
      extras.getBom(requireCompany().db, itemIdSchema.parse(payload).itemId),
    "viewer",
  );
  handle("bom:set", (payload) =>
    extras.setBom(requireCompany().db, bomInputSchema.parse(payload)),
  );
  handle("bom:items", () => extras.itemsWithBom(requireCompany().db), "viewer");
}
