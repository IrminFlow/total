import { randomUUID } from "node:crypto";
import { deleteJson, listJson, readJson, storeJson } from "./intakeStore";
import { holdPath, indexForRetention, removeRetentionIndex } from "./intakeRetention";

export const TRACKED_FEEDBACK_IDEA_IDS = ["mobile-companion", "more-bank-formats", "quarter-registers"] as const;
const trackedIdeas = new Set<string>(TRACKED_FEEDBACK_IDEA_IDS);
const SUMMARY_PATH = "feedback/materialized/public-summary.json";
const LOCK_PATH = "feedback/materialized/summary-lock.json";

export interface StoredFeedbackEvent {
  id: string;
  action: string;
  ideaId: string | null;
  receivedAt: string;
  [key: string]: unknown;
}

interface FeedbackSummary {
  schema: 1;
  updatedAt: string;
  votes: Record<string, number>;
}

interface SummaryLock {
  owner: string;
  expiresAt: string;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function emptySummary(): FeedbackSummary {
  return {
    schema: 1,
    updatedAt: new Date().toISOString(),
    votes: Object.fromEntries(TRACKED_FEEDBACK_IDEA_IDS.map((id) => [id, 0])),
  };
}

function validSummary(value: FeedbackSummary | null): value is FeedbackSummary {
  return value?.schema === 1
    && TRACKED_FEEDBACK_IDEA_IDS.every((id) => Number.isSafeInteger(value.votes?.[id]) && value.votes[id] >= 0);
}

async function acquireSummaryLock(): Promise<string> {
  const owner = randomUUID();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await storeJson(LOCK_PATH, { owner, expiresAt: new Date(Date.now() + 15_000).toISOString() } satisfies SummaryLock);
      return owner;
    } catch {
      const lock = await readJson<SummaryLock>(LOCK_PATH).catch(() => null);
      if (lock && Date.parse(lock.expiresAt) <= Date.now()) {
        const current = await readJson<SummaryLock>(LOCK_PATH).catch(() => null);
        if (current?.owner === lock.owner) await deleteJson(LOCK_PATH).catch(() => undefined);
      }
      await delay(50 + attempt * 10);
    }
  }
  throw new Error("Feedback summary is busy");
}

async function withSummaryLock<T>(operation: () => Promise<T>): Promise<T> {
  const owner = await acquireSummaryLock();
  try {
    return await operation();
  } finally {
    const lock = await readJson<SummaryLock>(LOCK_PATH).catch(() => null);
    if (lock?.owner === owner) await deleteJson(LOCK_PATH).catch(() => undefined);
  }
}

async function rebuildSummaryUnlocked(): Promise<FeedbackSummary> {
  const summary = emptySummary();
  const events = await listJson<StoredFeedbackEvent>("feedback/events/");
  for (const event of events) {
    if (event.action === "vote" && event.ideaId && trackedIdeas.has(event.ideaId))
      summary.votes[event.ideaId] += 1;
  }
  summary.updatedAt = new Date().toISOString();
  await storeJson(SUMMARY_PATH, summary, true);
  return summary;
}

async function summaryUnlocked(): Promise<FeedbackSummary> {
  const summary = await readJson<FeedbackSummary>(SUMMARY_PATH);
  return validSummary(summary) ? summary : rebuildSummaryUnlocked();
}

async function invalidateSummary(): Promise<void> {
  await deleteJson(SUMMARY_PATH).catch(() => undefined);
}

export async function feedbackVoteSummary(): Promise<Record<string, number>> {
  const existing = await readJson<FeedbackSummary>(SUMMARY_PATH);
  const summary = validSummary(existing)
    ? existing
    : await withSummaryLock(async () => summaryUnlocked());
  return { ...summary.votes };
}

export async function recordFeedbackEvent(
  event: StoredFeedbackEvent,
  objectPath: string,
  deleteAfter: string,
): Promise<void> {
  if (event.action !== "vote" || !event.ideaId || !trackedIdeas.has(event.ideaId)) {
    await storeJson(objectPath, event);
    try {
      await indexForRetention({ entity: "feedback", id: event.id, objectPath, deleteAfter });
    } catch (error) {
      await deleteJson(objectPath).catch(() => undefined);
      throw error;
    }
    return;
  }
  await withSummaryLock(async () => {
    const summary = await summaryUnlocked();
    await storeJson(objectPath, event);
    try {
      await indexForRetention({ entity: "feedback", id: event.id, objectPath, deleteAfter });
      summary.votes[event.ideaId!] += 1;
      summary.updatedAt = new Date().toISOString();
      await storeJson(SUMMARY_PATH, summary, true);
    } catch (error) {
      await deleteJson(objectPath).catch(() => undefined);
      await removeRetentionIndex("feedback", event.id);
      await invalidateSummary();
      throw error;
    }
  });
}

export async function deleteFeedbackEvent(id: string, objectPath: string): Promise<void> {
  const event = await readJson<StoredFeedbackEvent>(objectPath);
  const remove = async () => {
    await deleteJson(objectPath);
    await removeRetentionIndex("feedback", id);
    await deleteJson(holdPath("feedback", id)).catch(() => undefined);
  };
  if (event?.action !== "vote" || !event.ideaId || !trackedIdeas.has(event.ideaId)) {
    await remove();
    return;
  }
  await withSummaryLock(async () => {
    const summary = await summaryUnlocked();
    await remove();
    summary.votes[event.ideaId!] = Math.max(0, summary.votes[event.ideaId!] - 1);
    summary.updatedAt = new Date().toISOString();
    try {
      await storeJson(SUMMARY_PATH, summary, true);
    } catch {
      await invalidateSummary();
    }
  });
}
