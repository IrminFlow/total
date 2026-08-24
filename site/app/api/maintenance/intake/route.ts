import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { deleteJson, intakeStoreConfigured, listJsonEntriesPage, readJson, storeJson } from "@/lib/intakeStore";
import {
  deleteSupportCase,
  holdPath,
  indexForRetention,
  retentionHoldFor,
  retentionIndexFor,
  type RetentionHold,
  type RetentionIndex,
} from "@/lib/intakeRetention";
import { deleteFeedbackEvent } from "@/lib/feedbackSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(expected: string | undefined, supplied: string): boolean {
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function authorized(request: NextRequest): boolean {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return secretMatches(process.env.CRON_SECRET, supplied)
    || secretMatches(process.env.SUPPORT_WEBHOOK_SECRET, supplied);
}

function requestLimit(request: NextRequest): number {
  const parsed = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(500, parsed)) : 100;
}

async function cleanupEntity(entity: RetentionIndex["entity"], limit: number, now: Date): Promise<{ scanned: number; deleted: number; held: number; migrated: number; backlog: boolean }> {
  let deleted = 0;
  let held = 0;
  let migrated = 0;
  let scanned = 0;
  let backlog = false;
  const scanBudget = Math.min(1_000, Math.max(200, limit * 5));
  const sources = [
    { prefix: `retention-index-v2/${entity}/`, legacy: false },
    { prefix: `retention-index/${entity}/`, legacy: true },
  ];
  for (const source of sources) {
    let cursor: string | undefined;
    let stopSource = false;
    do {
      const page = await listJsonEntriesPage<RetentionIndex>(source.prefix, Math.min(200, scanBudget - scanned), cursor);
      for (const entry of page.entries) {
        scanned += 1;
        if (entry.value.entity !== entity) continue;
        const deleteAt = Date.parse(entry.value.deleteAfter);
        if (!Number.isFinite(deleteAt)) continue;
        if (deleteAt > now.getTime()) {
          if (source.legacy) {
            await indexForRetention(entry.value);
            await deleteJson(entry.pathname).catch(() => undefined);
            migrated += 1;
          } else {
            // V2 keys contain the full UTC deadline, so no later entry can be due.
            stopSource = true;
            break;
          }
          continue;
        }
        if (deleted >= limit) {
          backlog = true;
          continue;
        }
        const hold = await readJson<RetentionHold>(holdPath(entity, entry.value.id));
        if (hold && Date.parse(hold.holdUntil) > now.getTime()) {
          held += 1;
          continue;
        }
        if (hold) await deleteJson(holdPath(entity, entry.value.id)).catch(() => undefined);
        if (entity === "support") await deleteSupportCase(entry.value.id, entry.value.objectPath);
        else await deleteFeedbackEvent(entry.value.id, entry.value.objectPath);
        deleted += 1;
      }
      if (stopSource) break;
      if (!page.hasMore || !page.cursor || scanned >= scanBudget || deleted >= limit) {
        backlog ||= Boolean(page.hasMore && page.cursor) || deleted >= limit;
        break;
      }
      cursor = page.cursor;
    } while (cursor);
    if (scanned >= scanBudget || deleted >= limit) {
      backlog = true;
      break;
    }
  }
  return { scanned, deleted, held, migrated, backlog };
}

async function cleanupSecurity(limit: number, now: Date): Promise<{ scanned: number; deleted: number; backlog: boolean }> {
  const prefixes = ["intake-security/rate/", "intake-security/dedup/"];
  let scanned = 0;
  let deleted = 0;
  let backlog = false;
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    let prefixDeleted = 0;
    let prefixScanned = 0;
    const scanBudget = Math.min(5_000, Math.max(1_000, limit * 5));
    do {
      const page = await listJsonEntriesPage<{ expiresAt?: string }>(
        prefix,
        Math.min(200, limit - prefixDeleted, scanBudget - prefixScanned),
        cursor,
      );
      scanned += page.entries.length;
      prefixScanned += page.entries.length;
      for (const entry of page.entries) {
        if (typeof entry.value.expiresAt === "string" && Date.parse(entry.value.expiresAt) <= now.getTime()) {
          await deleteJson(entry.pathname);
          deleted += 1;
          prefixDeleted += 1;
        }
      }
      if (!page.hasMore || !page.cursor || prefixDeleted >= limit || prefixScanned >= scanBudget) {
        backlog ||= Boolean(page.hasMore && page.cursor);
        break;
      }
      cursor = page.cursor;
    } while (cursor);
  }
  return { scanned, deleted, backlog };
}

async function cleanup(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!intakeStoreConfigured()) return NextResponse.json({ error: "Private intake storage is unavailable" }, { status: 503 });
  const limit = requestLimit(request);
  const now = new Date();
  const [support, feedback, security] = await Promise.all([
    cleanupEntity("support", limit, now),
    cleanupEntity("feedback", limit, now),
    cleanupSecurity(limit, now),
  ]);
  return NextResponse.json({ ok: true, ranAt: now.toISOString(), limit, support, feedback, security });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return cleanup(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return cleanup(request);
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!intakeStoreConfigured()) return NextResponse.json({ error: "Private intake storage is unavailable" }, { status: 503 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const entity = body?.entity === "support" || body?.entity === "feedback" ? body.entity : null;
  const id = typeof body?.id === "string" ? body.id : "";
  const validId = entity === "support"
    ? /^TOT-\d{8}-(?:[A-F0-9]{6}|[A-F0-9]{12})$/.test(id)
    : /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  const holdUntil = typeof body?.holdUntil === "string" ? new Date(body.holdUntil) : new Date(Number.NaN);
  const reasonCode = body?.reasonCode === "legal" || body?.reasonCode === "security" ? body.reasonCode : null;
  const now = new Date();
  const maxHold = new Date(now.getTime() + 2 * 366 * 24 * 60 * 60_000);
  if (!entity || !validId || !reasonCode || !Number.isFinite(holdUntil.getTime()) || holdUntil <= now || holdUntil > maxHold)
    return NextResponse.json({ error: "Provide a valid retained object and a future hold of no more than two years" }, { status: 400 });
  const index = await retentionIndexFor(entity, id);
  if (!index) return NextResponse.json({ error: "Retained object not found" }, { status: 404 });
  const currentHold = await retentionHoldFor(entity, id, now);
  const hold: RetentionHold = {
    entity,
    id,
    holdUntil: holdUntil.toISOString(),
    reasonCode,
    createdAt: now.toISOString(),
    originalDeleteAfter: currentHold?.originalDeleteAfter ?? index.deleteAfter,
  };
  await storeJson(holdPath(entity, id), hold, true);
  if (Date.parse(index.deleteAfter) < holdUntil.getTime())
    await indexForRetention({ ...index, deleteAfter: holdUntil.toISOString() });
  return NextResponse.json({ ok: true, entity, id, holdUntil: hold.holdUntil });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entity = request.nextUrl.searchParams.get("entity");
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if ((entity !== "support" && entity !== "feedback") || !id)
    return NextResponse.json({ error: "Entity and ID are required" }, { status: 400 });
  const hold = await readJson<RetentionHold>(holdPath(entity, id));
  const index = await retentionIndexFor(entity, id);
  await deleteJson(holdPath(entity, id)).catch(() => undefined);
  if (hold && index) await indexForRetention({ ...index, deleteAfter: hold.originalDeleteAfter });
  return NextResponse.json({ ok: true, entity, id, released: true });
}
