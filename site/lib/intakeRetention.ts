import { deleteJson, deleteJsonPrefix, jsonExists, readJson, storeJson } from "./intakeStore";

export const SUPPORT_RETENTION_DAYS = 90;
export const FEEDBACK_RETENTION_MONTHS = 24;

export interface RetentionIndex {
  entity: "support" | "feedback";
  id: string;
  objectPath: string;
  deleteAfter: string;
}

export interface RetentionPointer {
  indexPath: string;
}

export interface RetentionHold {
  entity: RetentionIndex["entity"];
  id: string;
  holdUntil: string;
  reasonCode: "legal" | "security";
  createdAt: string;
  originalDeleteAfter: string;
}

function monthPath(prefix: string, date: Date, id: string): string {
  return `${prefix}/${date.toISOString().slice(0, 7)}/${id}.json`;
}

function addUtcMonths(value: Date, months: number): Date {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function supportDeleteAfter(resolvedAt: string): string {
  return new Date(Date.parse(resolvedAt) + SUPPORT_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
}

export function feedbackDeleteAfter(lastActivityAt: string): string {
  return addUtcMonths(new Date(lastActivityAt), FEEDBACK_RETENTION_MONTHS).toISOString();
}

function pointerPath(entity: RetentionIndex["entity"], id: string): string {
  return `retention-pointers/${entity}/${id}.json`;
}

export function holdPath(entity: RetentionIndex["entity"], id: string): string {
  return `retention-holds/${entity}/${id}.json`;
}

export async function retentionIndexFor(entity: RetentionIndex["entity"], id: string): Promise<RetentionIndex | null> {
  const pointer = await readJson<RetentionPointer>(pointerPath(entity, id));
  return pointer?.indexPath ? await readJson<RetentionIndex>(pointer.indexPath) : null;
}

export async function retentionHoldFor(entity: RetentionIndex["entity"], id: string, now = new Date()): Promise<RetentionHold | null> {
  const hold = await readJson<RetentionHold>(holdPath(entity, id));
  return hold && Date.parse(hold.holdUntil) > now.getTime() ? hold : null;
}

export async function indexForRetention(index: RetentionIndex): Promise<void> {
  const deleteAt = new Date(index.deleteAfter);
  const indexPath = monthPath(`retention-index/${index.entity}`, deleteAt, index.id);
  const previous = await readJson<RetentionPointer>(pointerPath(index.entity, index.id));
  if (previous?.indexPath && previous.indexPath !== indexPath)
    await deleteJson(previous.indexPath).catch(() => undefined);
  await storeJson(indexPath, index, true);
  await storeJson(pointerPath(index.entity, index.id), { indexPath } satisfies RetentionPointer, true);
}

export async function removeRetentionIndex(entity: RetentionIndex["entity"], id: string): Promise<void> {
  const pointer = await readJson<RetentionPointer>(pointerPath(entity, id));
  if (pointer?.indexPath) await deleteJson(pointer.indexPath).catch(() => undefined);
  await deleteJson(pointerPath(entity, id)).catch(() => undefined);
}

export async function deleteSupportCase(caseId: string, objectPath: string): Promise<{ deleted: boolean; statusEventsDeleted: number }> {
  const deleted = await jsonExists(objectPath);
  if (deleted) await deleteJson(objectPath);
  const date = caseId.slice(4, 12);
  const statusEventsDeleted = await deleteJsonPrefix(`support-status/${date.slice(0, 4)}/${date.slice(4, 6)}/${caseId}/`);
  await removeRetentionIndex("support", caseId);
  await deleteJson(holdPath("support", caseId)).catch(() => undefined);
  return { deleted, statusEventsDeleted };
}

export async function deleteFeedbackEvent(id: string, objectPath: string): Promise<void> {
  await deleteJson(objectPath);
  await removeRetentionIndex("feedback", id);
  await deleteJson(holdPath("feedback", id)).catch(() => undefined);
}
