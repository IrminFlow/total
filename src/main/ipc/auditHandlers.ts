import { auditListSchema, auditRetentionSchema } from "@shared/schemas";
import { listAudit, verifyAuditChain } from "../services/audit";
import * as configSvc from "../services/config";
import type { CompanyContext, IpcHandle } from "./types";

interface AuditHandlerContext {
  handle: IpcHandle;
  requireCompany: () => CompanyContext;
}

export function registerAuditHandlers({
  handle,
  requireCompany,
}: AuditHandlerContext): void {
  handle(
    "audit:list",
    (payload) => {
      const { entity, from, to, page } = auditListSchema.parse(payload);
      return listAudit(requireCompany().db, { entity, from, to, page });
    },
    "viewer",
  );
  handle("audit:verify", () => verifyAuditChain(requireCompany().db), "viewer");
  handle(
    "config:audit:get",
    () => ({ keepDays: configSvc.getAuditKeepDays(requireCompany().db) }),
    "viewer",
  );
  handle(
    "config:audit:set",
    (payload) => {
      const { keepDays } = auditRetentionSchema.parse(payload);
      return {
        keepDays: configSvc.setAuditKeepDays(requireCompany().db, keepDays),
      };
    },
    "owner",
  );
}
