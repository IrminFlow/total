import { z } from "zod";
import { isoDate, recurringInputSchema } from "@shared/schemas";
import * as recurring from "../services/recurring";
import type { OpenCompany, IpcHandle } from "./types";
import type { VoucherPostingActor } from "../services/voucherPostingControls";

interface RecurringHandlerContext {
  handle: IpcHandle;
  requireCompany: () => OpenCompany;
  getSessionUser: () => VoucherPostingActor | null;
}

const positiveIdSchema = z.object({ id: z.number().int().positive() });

export function registerRecurringHandlers({
  handle,
  requireCompany,
  getSessionUser,
}: RecurringHandlerContext): void {
  handle(
    "recurring:list",
    () => {
      const company = requireCompany();
      return recurring.listTemplatesInScope(
        company.db,
        getSessionUser()?.role ?? "owner",
      );
    },
    "viewer",
  );
  handle("recurring:save", (payload) => {
    const { id, data } = z
      .object({
        id: z.number().int().positive().optional(),
        data: recurringInputSchema,
      })
      .parse(payload);
    const company = requireCompany();
    return recurring.saveTemplateInScope(
      company.db,
      data,
      id,
      getSessionUser()?.role ?? "owner",
    );
  });
  handle("recurring:delete", (payload) =>
    recurring.deleteTemplateInScope(
      requireCompany().db,
      positiveIdSchema.parse(payload).id,
      getSessionUser()?.role ?? "owner",
    ),
  );
  handle(
    "recurring:due",
    (payload) => {
      const { today } = z.object({ today: isoDate }).parse(payload);
      const company = requireCompany();
      return recurring.dueInScope(
        company.db,
        today,
        getSessionUser()?.role ?? "owner",
      );
    },
    "viewer",
  );
  handle("recurring:post", (payload) => {
    const { id, date } = z
      .object({ id: z.number().int().positive(), date: isoDate })
      .parse(payload);
    const company = requireCompany();
    return recurring.postFromTemplateControlled(
      company.db,
      id,
      date,
      company.usersExist ? getSessionUser() : null,
    );
  });
  handle("recurring:skip", (payload) =>
    recurring.skipInScope(
      requireCompany().db,
      positiveIdSchema.parse(payload).id,
      getSessionUser()?.role ?? "owner",
    ),
  );
}
