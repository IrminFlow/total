import type { Role } from "./services/roles";
import type { PermissionAction } from "./services/permissions";

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
  "agent:approveProposal": "approve",
  "agent:discardProposal": "approve",
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
