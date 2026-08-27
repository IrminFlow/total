import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import { homedir } from "os";
import { z } from "zod";
import type { DB } from "../db/connection";
import { atomicWriteFile } from "../atomicFile";
import { dataRoot } from "../paths";
import type { CompanyInfo } from "@shared/domain";
import type { AiOperatorAction, AiOperatorActionResult, AiOperatorConfig } from "@shared/aiOperator";
import { aiOperatorActionSchema } from "@shared/aiOperator";
import { constrainedNaturalSearch } from "./assistiveAutomation";
import * as ai from "./ai";

const configSchema = z.object({
  enabled: z.boolean(),
  approvalMode: z.enum(["every_change", "accounting_only"]),
  workspaceRoots: z.array(z.string()).max(20),
});

const DEFAULT_CONFIG: AiOperatorConfig = { enabled: false, approvalMode: "every_change", workspaceRoots: [] };
const MAX_READ_BYTES = 2 * 1024 * 1024;

function configPath(): string { return resolve(dataRoot(), "ai-operator.json"); }

export function getOperatorConfig(): AiOperatorConfig {
  try { return configSchema.parse(JSON.parse(readFileSync(configPath(), "utf8"))); }
  catch { return { ...DEFAULT_CONFIG }; }
}

function unsafeRoot(path: string): boolean {
  const normalized = resolve(path);
  return normalized === resolve("/") || normalized === resolve(homedir()) || normalized === resolve(dataRoot());
}

export function setOperatorConfig(input: AiOperatorConfig): AiOperatorConfig {
  const parsed = configSchema.parse(input);
  const roots = [...new Set(parsed.workspaceRoots.map((root) => realpathSync(root)))];
  for (const root of roots) {
    if (!lstatSync(root).isDirectory()) throw new Error("An AI workspace root is not a directory");
    if (unsafeRoot(root)) throw new Error("Choose a specific project folder, not the home, data, or filesystem root");
  }
  const next = { ...parsed, workspaceRoots: roots };
  mkdirSync(dataRoot(), { recursive: true });
  atomicWriteFile(configPath(), JSON.stringify(next, null, 2), 0o600);
  return next;
}

function insideRoot(path: string, roots: string[], writing: boolean): string {
  if (!isAbsolute(path)) throw new Error("AI file paths must be absolute");
  const target = resolve(path);
  const checked = existsSync(target) ? realpathSync(target) : realpathSync(dirname(target));
  const allowed = roots.some((root) => {
    const rel = relative(root, checked);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!allowed) throw new Error("The file is outside the user-approved AI workspace folders");
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("AI file access does not follow symbolic links");
  if (!writing && !existsSync(target)) throw new Error("The requested file does not exist");
  return target;
}

export async function executeOperatorAction(
  db: DB,
  slug: string,
  _info: CompanyInfo,
  rawAction: AiOperatorAction,
  approved: boolean,
): Promise<AiOperatorActionResult> {
  const action = aiOperatorActionSchema.parse(rawAction);
  const config = getOperatorConfig();
  if (!config.enabled) throw new Error("AI operator is disabled in Settings");
  if (action.kind === "navigate") return { kind: action.kind, status: "completed", message: `Open ${action.screen}`, data: { screen: action.screen } };
  if (action.kind === "search_books") {
    const rows = constrainedNaturalSearch(db, action.query);
    return { kind: action.kind, status: "completed", message: `${rows.length} book result(s) found`, data: rows };
  }
  if (action.kind === "draft_voucher") {
    const proposal = await ai.draftVoucher(db, slug, action.instruction, true);
    return { kind: action.kind, status: "proposal_created", message: "Voucher proposal created for review", data: proposal };
  }
  if (action.kind === "read_file") {
    const path = insideRoot(action.path, config.workspaceRoots, false);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.size > MAX_READ_BYTES) throw new Error("AI can read regular text files up to 2 MB");
    const content = readFileSync(path, "utf8");
    if (content.includes("\0")) throw new Error("Binary files are not exposed to the AI operator");
    return { kind: action.kind, status: "completed", message: `Read ${entry.size} bytes`, data: { path, content } };
  }
  const path = insideRoot(action.path, config.workspaceRoots, true);
  const needsApproval = config.approvalMode === "every_change";
  if (needsApproval && !approved) return { kind: action.kind, status: "approval_required", message: `Approve writing ${path}` };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, action.content, 0o600);
  return { kind: action.kind, status: "completed", message: `Wrote ${Buffer.byteLength(action.content)} bytes`, data: { path } };
}

export function operatorContext(config = getOperatorConfig()): string {
  return JSON.stringify({
    policy: "Posted accounting changes always become proposals and require review inside Total.",
    approvalMode: config.approvalMode,
    workspaceRoots: config.workspaceRoots,
  });
}
