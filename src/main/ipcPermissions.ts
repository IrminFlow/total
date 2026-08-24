import type { Role } from "./services/roles";
import type { DB } from "./db/connection";
import type { ExportFormat } from "@shared/internalControls";
import type { AutomationTaskKind } from "@shared/integrations";
import {
  permissionAllows,
  type PermissionAction,
} from "./services/permissions";
import { exportAllowed } from "./services/internalControls";

export type ExportDepartmentScope =
  | "company_wide"
  | "voucher"
  | "hybrid"
  | "payload_only"
  | "selected_non_voucher"
  | "source_data";

export interface IpcExportContract {
  format: ExportFormat;
  departmentScope: ExportDepartmentScope;
  label: string;
}

/**
 * Exhaustive registry for IPC operations that materialize sensitive data into a
 * user-visible file or full local mirror. The permission action, format gate,
 * department-scope policy, and completeness tests all derive from this table.
 */
export const IPC_EXPORT_CONTRACTS = {
  "company:revealExports": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The company export folder",
  },
  "onboarding:handoff:export": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The accountant setup handoff",
  },
  "inventory:barcodeLabels:pdf": {
    format: "pdf",
    departmentScope: "selected_non_voucher",
    label: "Barcode labels",
  },
  "customerOps:portalBundle": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The customer portal bundle",
  },
  "export:reviewBundle": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The review bundle",
  },
  "gst:exportGstr1": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The GSTR-1 export",
  },
  "gst:exportGstr3b": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The GSTR-3B export",
  },
  "gst:noticePack": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The GST notice evidence pack",
  },
  "paymentRun:fileExport": {
    format: "spreadsheet",
    departmentScope: "company_wide",
    label: "The payment run bank file",
  },
  "paymentRun:filePreview": {
    format: "spreadsheet",
    departmentScope: "company_wide",
    label: "The payment run bank-file preview",
  },
  "tds:export26q": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The TDS 26Q export",
  },
  "banking:brsPdf": {
    format: "pdf",
    departmentScope: "company_wide",
    label: "The bank reconciliation PDF",
  },
  "edoc:exportEInvoice": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The bulk e-invoice export",
  },
  "edoc:exportEwb": {
    format: "full_data",
    departmentScope: "hybrid",
    label: "The e-way bill export",
  },
  "edoc:ewbJson": {
    format: "full_data",
    departmentScope: "voucher",
    label: "The e-way bill JSON",
  },
  "invoice:pdf": {
    format: "pdf",
    departmentScope: "voucher",
    label: "The invoice PDF",
  },
  "invoice:pdfBatch": {
    format: "pdf",
    departmentScope: "voucher",
    label: "The invoice PDF batch",
  },
  "cheque:pdf": {
    format: "pdf",
    departmentScope: "voucher",
    label: "The cheque PDF",
  },
  "cheque:testGrid": {
    format: "pdf",
    departmentScope: "selected_non_voucher",
    label: "The cheque alignment grid",
  },
  "cheque:advice": {
    format: "pdf",
    departmentScope: "voucher",
    label: "The payment advice PDF",
  },
  "payroll:payslip": {
    format: "pdf",
    departmentScope: "company_wide",
    label: "The employee payslip",
  },
  "payroll:payslipPack": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The payslip delivery pack",
  },
  "payroll:ecr": {
    format: "spreadsheet",
    departmentScope: "company_wide",
    label: "The payroll ECR export",
  },
  "payroll:esi": {
    format: "spreadsheet",
    departmentScope: "company_wide",
    label: "The payroll ESI export",
  },
  "payroll:ptCsv": {
    format: "spreadsheet",
    departmentScope: "company_wide",
    label: "The payroll professional-tax export",
  },
  "system:profiler:export": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The performance profiler export",
  },
  "report:pdf": {
    format: "pdf",
    departmentScope: "payload_only",
    label: "The report PDF",
  },
  "export:csv": {
    format: "spreadsheet",
    departmentScope: "payload_only",
    label: "The report spreadsheet",
  },
  "export:caPack": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The CA export pack",
  },
  "export:tallyXml": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The Tally XML export",
  },
  "agent:exportMirror": {
    format: "json_mirror",
    departmentScope: "company_wide",
    label: "The agent data mirror",
  },
  "import:errorWorkbook": {
    format: "spreadsheet",
    departmentScope: "source_data",
    label: "The import error workbook",
  },
  "export:portable": {
    format: "full_data",
    departmentScope: "company_wide",
    label: "The portable company export",
  },
  "export:logisticsAdapter": {
    format: "spreadsheet",
    departmentScope: "payload_only",
    label: "The logistics adapter export",
  },
} as const satisfies Record<string, IpcExportContract>;

/*
 * Deliberate non-registry disclosures:
 * - support submission/offline bundles are recovery paths governed by per-field
 *   consent, session-aware book-context checks, encryption, and redaction;
 * - AI requests are explicit user-initiated provider calls governed by the AI
 *   context preview/provider boundary. They are not local export artifacts.
 * Those policies must remain explicit rather than silently inheriting a file
 * format guess from this registry.
 */

export function ipcExportContractForChannel(
  channel: string,
): IpcExportContract | null {
  return (
    IPC_EXPORT_CONTRACTS[channel as keyof typeof IPC_EXPORT_CONTRACTS] ?? null
  );
}

export function exportFormatForChannel(channel: string): ExportFormat | null {
  return ipcExportContractForChannel(channel)?.format ?? null;
}

export function companyWideExportLabelForChannel(
  channel: string,
): string | null {
  const contract = ipcExportContractForChannel(channel);
  return contract?.departmentScope === "company_wide" ? contract.label : null;
}

export function assertIpcExportFormatAllowed(
  db: DB,
  role: Role,
  channel: string,
): ExportFormat {
  const format = exportFormatForChannel(channel);
  if (!format)
    throw new Error(`Export channel '${channel}' has no explicit format contract`);
  if (!exportAllowed(db, role, format))
    throw new Error("Your role is not allowed to create this export format");
  return format;
}

export function assertAutomationRunAllowed(
  db: DB,
  role: Role,
  taskKind: AutomationTaskKind,
): { action: "backup" | "export"; format: ExportFormat } {
  const action = taskKind === "backup" ? "backup" : "export";
  const format = taskKind === "mirror" ? "json_mirror" : "full_data";
  if (!permissionAllows(db, role, action))
    throw new Error("You do not have permission to run this automation");
  if (!exportAllowed(db, role, format))
    throw new Error("Your role is not allowed to create this automation format");
  return { action, format };
}

/** Channels whose permission depends on a stored record loaded by the handler. */
export function permissionResolvedInsideHandler(channel: string): boolean {
  return channel === "integrations:automation:run";
}

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
  "system:recovery:attempt": "backup",
  "edoc:transportSet": "edit",
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
  if (ipcExportContractForChannel(channel)) return "export";
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
