import type { Role } from "./services/roles";
import type { DB } from "./db/connection";
import {
  permissionAllows,
  type PermissionAction,
} from "./services/permissions";

/**
 * Channels whose permission does not follow the legacy payload/name heuristic.
 *
 * Keep this list explicit: these operations mutate or decide existing records but
 * deliberately use domain-specific identifiers such as `ids`, `lineId`, or
 * `voucherId`. Treating them as creates would let a role with create=true and
 * edit/approve=false bypass the configured permission matrix.
 */
export const EXPLICIT_PERMISSION_ACTIONS = {
  "voucher:batchTag": "edit",
  "voucher:batchReview": "edit",
  "voucher:batchReverse": "edit",
  "bank:setBankDate": "edit",
  "bank:chequeStatus": "edit",
  "edoc:transportSet": "edit",
  "agent:approveProposal": "approve",
  "agent:discardProposal": "approve",
  "gst:exportGstr1": "export",
  "gst:exportGstr3b": "export",
  "tds:export26q": "export",
  "edoc:exportEInvoice": "export",
  "edoc:exportEwb": "export",
  "edoc:ewbJson": "export",
  "invoice:pdfBatch": "export",
} as const satisfies Record<string, PermissionAction>;

export function permissionActionForChannel(
  channel: string,
  payload: unknown,
  minRole: Role,
): PermissionAction {
  const explicit =
    EXPLICIT_PERMISSION_ACTIONS[
      channel as keyof typeof EXPLICIT_PERMISSION_ACTIONS
    ];
  if (explicit) return explicit;
  if (channel === "approval:list") return "view";
  if (
    channel.startsWith("approval:approve") ||
    channel.startsWith("approval:reject")
  )
    return "approve";
  if (channel.startsWith("backup:") || channel === "company:backup")
    return "backup";
  if (
    channel.startsWith("export:") ||
    channel === "report:pdf" ||
    channel.endsWith(":pdf") ||
    channel.endsWith(":csv")
  )
    return "export";
  if (
    channel.startsWith("config:") ||
    channel.startsWith("users:") ||
    channel.endsWith(":setConfig") ||
    channel === "company:updateInfo" ||
    channel.startsWith("company:lock:")
  )
    return "settings";
  if (minRole === "viewer") return "view";
  if (minRole === "owner") return "settings";
  const hasId =
    !!payload &&
    typeof payload === "object" &&
    "id" in payload &&
    typeof (payload as { id?: unknown }).id === "number";
  if (
    hasId ||
    /:(update|delete|remove|restore|purge|set|deactivate|mature|commit|resolve)$/.test(
      channel,
    ) ||
    channel.endsWith("Resolve")
  )
    return "edit";
  return "create";
}

/** The one permission-matrix gate used by IPC registration and denial tests. */
export function assertIpcPermissionAllowed(
  db: DB,
  role: Role,
  channel: string,
  payload: unknown,
  minRole: Role,
): PermissionAction {
  const action = permissionActionForChannel(channel, payload, minRole);
  if (!permissionAllows(db, role, action))
    throw new Error("You do not have permission to do that");
  return action;
}
