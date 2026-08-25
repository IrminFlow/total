import { randomUUID } from "crypto";
import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { atomicWriteFile } from "../atomicFile";

export type SupportOutboxStatus = "queued" | "retrying" | "failed";

export interface SupportOutboxItem {
  id: string;
  caseId: string;
  status: SupportOutboxStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  hasAttachment: boolean;
  attachmentRetryApproved: boolean;
  encryptedPayload: string;
  lastError: string | null;
}

export type SupportOutboxSummary = Omit<SupportOutboxItem, "encryptedPayload">;

interface SupportOutboxFile {
  schema: 1;
  items: SupportOutboxItem[];
}

const EMPTY: SupportOutboxFile = { schema: 1, items: [] };
const MAX_ITEMS = 50;

function validItem(value: unknown): value is SupportOutboxItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(item.id) &&
    typeof item.caseId === "string" &&
    /^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/.test(item.caseId) &&
    ["queued", "retrying", "failed"].includes(String(item.status)) &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" &&
    Number.isInteger(item.attempts) &&
    Number(item.attempts) >= 0 &&
    typeof item.hasAttachment === "boolean" &&
    typeof item.attachmentRetryApproved === "boolean" &&
    typeof item.encryptedPayload === "string" &&
    /^[A-Za-z0-9+/=]+$/.test(item.encryptedPayload)
  );
}

export function readSupportOutbox(path: string): SupportOutboxItem[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SupportOutboxFile>;
    return parsed.schema === 1 && Array.isArray(parsed.items)
      ? parsed.items.filter(validItem).slice(0, MAX_ITEMS)
      : [];
  } catch {
    return [];
  }
}

function writeSupportOutbox(path: string, items: SupportOutboxItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(
    path,
    `${JSON.stringify({ ...EMPTY, items: items.slice(0, MAX_ITEMS) }, null, 2)}\n`,
  );
}

export function summarizeSupportOutbox(items: SupportOutboxItem[]): SupportOutboxSummary[] {
  return items.map(({ encryptedPayload: _encryptedPayload, ...summary }) => summary);
}

export function enqueueSupportPayload(
  path: string,
  input: {
    caseId: string;
    encryptedPayload: string;
    hasAttachment: boolean;
    lastError: string;
  },
  now = new Date(),
): SupportOutboxSummary {
  const timestamp = now.toISOString();
  const existing = readSupportOutbox(path).filter((item) => item.caseId !== input.caseId);
  const item: SupportOutboxItem = {
    id: randomUUID(),
    caseId: input.caseId,
    status: "queued",
    createdAt: timestamp,
    updatedAt: timestamp,
    attempts: 0,
    nextAttemptAt: null,
    hasAttachment: input.hasAttachment,
    attachmentRetryApproved: false,
    encryptedPayload: input.encryptedPayload,
    lastError: input.lastError.slice(0, 240),
  };
  writeSupportOutbox(path, [item, ...existing]);
  return summarizeSupportOutbox([item])[0]!;
}

export function getSupportOutboxItem(path: string, id: string): SupportOutboxItem {
  const item = readSupportOutbox(path).find((candidate) => candidate.id === id);
  if (!item) throw new Error("Queued support submission not found");
  return item;
}

export function updateSupportOutboxItem(
  path: string,
  id: string,
  patch: Partial<Pick<SupportOutboxItem, "status" | "attempts" | "nextAttemptAt" | "attachmentRetryApproved" | "lastError">>,
  now = new Date(),
): SupportOutboxSummary {
  const items = readSupportOutbox(path);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("Queued support submission not found");
  items[index] = { ...items[index]!, ...patch, updatedAt: now.toISOString() };
  writeSupportOutbox(path, items);
  return summarizeSupportOutbox([items[index]!])[0]!;
}

export function removeSupportOutboxItem(path: string, id: string): boolean {
  const items = readSupportOutbox(path);
  const remaining = items.filter((item) => item.id !== id);
  if (remaining.length === items.length) return false;
  writeSupportOutbox(path, remaining);
  return true;
}
