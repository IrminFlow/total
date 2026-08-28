import { randomBytes } from "crypto";
import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { atomicWriteFile } from "../atomicFile";

export type SupportCaseStatus =
  | "draft"
  | "sending"
  | "queued"
  | "submitted"
  | "in_review"
  | "waiting_for_customer"
  | "resolved"
  | "failed"
  | "saved_offline";

export interface SupportCaseRecord {
  id: string;
  category: "question" | "bug" | "idea" | "accessibility" | "privacy";
  severity: "low" | "normal" | "high" | "critical";
  status: SupportCaseStatus;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  consent: {
    message: boolean;
    diagnostics: boolean;
    logs: boolean;
    companyMetadata: boolean;
    focusContext: boolean;
    screenshot: boolean;
  };
  lastError: string | null;
  trackingToken: string | null;
}

export interface SupportPayloadSelection {
  category: SupportCaseRecord["category"];
  severity: SupportCaseRecord["severity"];
  message: boolean;
  diagnostics: boolean;
  logs: boolean;
  companyMetadata: boolean;
  focusContext: boolean;
  screenshot: boolean;
}

export function assertSupportCaseConsent(
  record: SupportCaseRecord,
  selection: SupportPayloadSelection,
): void {
  if (record.category !== selection.category)
    throw new Error("Support category does not match the saved case");
  if (record.severity !== selection.severity)
    throw new Error("Support severity does not match the saved case");
  for (const field of [
    "message",
    "diagnostics",
    "logs",
    "companyMetadata",
    "focusContext",
    "screenshot",
  ] as const) {
    if (selection[field] && !record.consent[field])
      throw new Error(`Support case did not approve ${field}`);
  }
}

interface SupportCaseFile {
  version: 1;
  cases: SupportCaseRecord[];
}

const EMPTY: SupportCaseFile = { version: 1, cases: [] };

function validCase(value: unknown): value is SupportCaseRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    /^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/.test(item.id) &&
    ["question", "bug", "idea", "accessibility", "privacy"].includes(
      String(item.category),
    ) &&
    (item.severity === undefined || ["low", "normal", "high", "critical"].includes(String(item.severity))) &&
    ["draft", "sending", "queued", "submitted", "in_review", "waiting_for_customer", "resolved", "failed", "saved_offline"].includes(
      String(item.status),
    ) &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}

export function readSupportCases(path: string): SupportCaseRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SupportCaseFile>;
    return parsed.version === 1 && Array.isArray(parsed.cases)
      ? parsed.cases.filter(validCase).slice(0, 100).map((record) => ({
          ...record,
          severity: record.severity ?? "normal",
          trackingToken: record.trackingToken ?? null,
        }))
      : [];
  } catch {
    return [];
  }
}

function writeCases(path: string, cases: SupportCaseRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(
    path,
    JSON.stringify({ ...EMPTY, cases: cases.slice(0, 100) }, null, 2) + "\n",
  );
}

export function newSupportCaseId(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `TOT-${date}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

export function createSupportCase(
  path: string,
  input: Pick<SupportCaseRecord, "category" | "severity" | "consent">,
  now = new Date(),
): SupportCaseRecord {
  const timestamp = now.toISOString();
  const record: SupportCaseRecord = {
    id: newSupportCaseId(now),
    category: input.category,
    severity: input.severity,
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    submittedAt: null,
    consent: input.consent,
    lastError: null,
    trackingToken: null,
  };
  writeCases(path, [record, ...readSupportCases(path)]);
  return record;
}

export function updateSupportCase(
  path: string,
  id: string,
  patch: Pick<SupportCaseRecord, "status"> & {
    lastError?: string | null;
    trackingToken?: string | null;
  },
  now = new Date(),
): SupportCaseRecord {
  const cases = readSupportCases(path);
  const index = cases.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("Support case not found");
  const previous = cases[index]!;
  const next: SupportCaseRecord = {
    ...previous,
    status: patch.status,
    updatedAt: now.toISOString(),
    submittedAt:
      patch.status === "submitted" ? now.toISOString() : previous.submittedAt,
    lastError:
      patch.lastError === undefined ? previous.lastError : patch.lastError,
    trackingToken:
      patch.trackingToken === undefined
        ? (previous.trackingToken ?? null)
        : patch.trackingToken,
  };
  cases[index] = next;
  writeCases(path, cases);
  return next;
}

// CRC-32 for ZIP's stored-entry headers. Kept local so support bundles need no runtime archive
// dependency and remain readable by standard ZIP tools after decrypting the outer container.
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Minimal UTF-8 ZIP writer using the store method. Names are fixed by the caller, not user input. */
export function createStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name))
      throw new Error("Unsafe support bundle entry name");
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
