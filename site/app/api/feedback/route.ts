import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { intakeStoreConfigured } from "@/lib/intakeStore";
import {
  completeIntake,
  protectIntake,
  releaseIntake,
} from "@/lib/intakeProtection";
import { feedbackDeleteAfter, retentionHoldFor } from "@/lib/intakeRetention";
import {
  deleteFeedbackEvent,
  feedbackVoteSummary,
  recordFeedbackEvent,
  TRACKED_FEEDBACK_IDEA_IDS,
  type StoredFeedbackEvent,
} from "@/lib/feedbackSummary";
import { latestRelease } from "@/lib/release";
import {
  bearerFrom,
  privilegedSecretMatches,
  providerAuthorization,
} from "@/lib/serverSecrets";

export const runtime = "nodejs";

const WINDOW_MS = 10 * 60_000;
const MAX_REQUESTS = 20;
const trackedIdeas = new Set<string>(TRACKED_FEEDBACK_IDEA_IDS);

const SHIPPED_IDEAS = [
  {
    id: "mobile-companion",
    title: "Read-only mobile companion",
    detail:
      "View key balances, invoices and reminders without moving the writable books off the desktop.",
    status: "considering",
    votes: 0,
    releaseVersion: null,
  },
  {
    id: "more-bank-formats",
    title: "More bank statement formats",
    detail:
      "Add reviewed presets for more Indian banks while keeping the generic mapper.",
    status: "planned",
    votes: 0,
    releaseVersion: null,
  },
  {
    id: "quarter-registers",
    title: "Quarterly sales and purchase registers",
    detail:
      "Switch monthly evidence into financial quarters with the same voucher drill-down.",
    status: "planned",
    votes: 0,
    releaseVersion: null,
  },
] as const;

function versionAtLeast(version: string | undefined, target: string): boolean {
  const parse = (value: string) =>
    value
      .split(".")
      .slice(0, 3)
      .map((part) => Number(part));
  const current = version ? parse(version) : [];
  const required = parse(target);
  if (
    current.length !== 3 ||
    current.some((part) => !Number.isInteger(part) || part < 0)
  )
    return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! > required[index]!) return true;
    if (current[index]! < required[index]!) return false;
  }
  return true;
}

async function publicIdeas() {
  const published = await latestRelease();
  const quarterlyReleased = versionAtLeast(published?.version, "0.5.0");
  return SHIPPED_IDEAS.map((idea) =>
    idea.id === "quarter-registers" && quarterlyReleased
      ? { ...idea, status: "released" as const, releaseVersion: "0.5.0" }
      : idea,
  );
}

function endpoint(): URL | null {
  try {
    const raw =
      process.env.SUPABASE_FEEDBACK_URL || process.env.CONVEX_FEEDBACK_URL;
    if (!raw) return null;
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function providerSecret(): string | undefined {
  return process.env.SUPABASE_FEEDBACK_URL
    ? process.env.SUPABASE_INTAKE_SECRET
    : process.env.FEEDBACK_PROVIDER_SECRET;
}

function authorized(request: NextRequest): boolean {
  return privilegedSecretMatches("INTAKE_ADMIN_SECRET", bearerFrom(request));
}

export async function GET(): Promise<NextResponse> {
  const target = endpoint();
  const ideas = await publicIdeas();
  if (!target && intakeStoreConfigured()) {
    try {
      const votes = await feedbackVoteSummary();
      return NextResponse.json({
        storage: "blob",
        ideas: ideas.map((idea) => ({ ...idea, votes: votes[idea.id] ?? 0 })),
      });
    } catch {
      return NextResponse.json({ storage: "blob", ideas });
    }
  }
  if (!target) return NextResponse.json({ storage: "static", ideas });
  try {
    const response = await fetch(target, {
      headers: providerAuthorization(providerSecret()),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("upstream");
    const body = (await response.json()) as unknown;
    return NextResponse.json({
      ...(body && typeof body === "object" ? body : { ideas }),
      storage: "provider",
    });
  } catch {
    return NextResponse.json({ storage: "provider_unavailable", ideas });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const target = endpoint();
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body)
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const action = String(body.action);
  const ideaId =
    typeof body.ideaId === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(body.ideaId)
      ? body.ideaId
      : null;
  const title =
    typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  const detail =
    typeof body.detail === "string" ? body.detail.trim().slice(0, 2000) : "";
  const email =
    typeof body.email === "string" ? body.email.trim().slice(0, 200) : "";
  const syntheticRunId =
    authorized(request) &&
    typeof body.syntheticRunId === "string" &&
    /^[A-Za-z0-9_-]{8,80}$/.test(body.syntheticRunId)
      ? body.syntheticRunId
      : null;
  if (
    !(
      ["vote", "follow"].includes(action) &&
      ideaId &&
      trackedIdeas.has(ideaId)
    ) &&
    !(action === "submit" && title.length >= 5 && detail.length >= 10)
  )
    return NextResponse.json(
      { error: "Check the feedback fields" },
      { status: 400 },
    );
  if (
    (action === "follow" || (action === "submit" && email)) &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  )
    return NextResponse.json(
      { error: "A valid email is required for updates" },
      { status: 400 },
    );
  const event: StoredFeedbackEvent = {
    id: randomUUID(),
    action,
    ideaId,
    title,
    detail,
    email,
    source: body.source === "app" ? "app" : "website",
    receivedAt: new Date().toISOString(),
  };
  const protection = await protectIntake({
    request,
    scope: "feedback",
    dedupeMaterial: JSON.stringify({
      action,
      ideaId,
      title,
      detail,
      email: email.toLowerCase(),
      ...(syntheticRunId ? { syntheticRunId } : {}),
    }),
    receipt: { id: event.id, receivedAt: event.receivedAt },
    maxRequests: MAX_REQUESTS,
    windowMs: WINDOW_MS,
  });
  if (!protection.allowed)
    return protection.pending
      ? NextResponse.json(
          { error: "This feedback is still being submitted" },
          { status: 409 },
        )
      : protection.unavailable
        ? NextResponse.json(
            { error: "Feedback storage is unavailable" },
            { status: 503 },
          )
        : NextResponse.json(
            { error: "Please wait before sending more feedback" },
            { status: 429 },
          );
  if (protection.duplicate)
    return NextResponse.json({
      ok: true,
      id: protection.receipt?.id ?? event.id,
      receivedAt: protection.receipt?.receivedAt ?? event.receivedAt,
      status: action === "submit" ? "awaiting_review" : "recorded",
      duplicate: true,
    });
  const acceptedEvent: StoredFeedbackEvent = {
    ...event,
    id: protection.receipt?.id ?? event.id,
    receivedAt: protection.receipt?.receivedAt ?? event.receivedAt,
  };
  if (!target && intakeStoreConfigured()) {
    const objectPath = `feedback/events/${acceptedEvent.receivedAt.slice(0, 7)}/${acceptedEvent.id}.json`;
    try {
      await recordFeedbackEvent(
        acceptedEvent,
        objectPath,
        feedbackDeleteAfter(acceptedEvent.receivedAt),
      );
    } catch {
      await releaseIntake(protection);
      return NextResponse.json(
        { error: "Feedback storage is unavailable" },
        { status: 503 },
      );
    }
    await completeIntake(protection).catch(() => undefined);
    return NextResponse.json({
      ok: true,
      id: acceptedEvent.id,
      receivedAt: acceptedEvent.receivedAt,
      status: action === "submit" ? "awaiting_review" : "recorded",
    });
  }
  if (!target) {
    await releaseIntake(protection);
    return NextResponse.json(
      { error: "Feedback voting is not configured" },
      { status: 503 },
    );
  }
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(protection.idempotencyKey
          ? { "idempotency-key": protection.idempotencyKey }
          : {}),
        ...providerAuthorization(providerSecret()),
      },
      body: JSON.stringify(acceptedEvent),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await releaseIntake(protection);
      return NextResponse.json(
        { error: "Feedback service unavailable" },
        { status: 502 },
      );
    }
    const result = await response.json();
    await completeIntake(protection).catch(() => undefined);
    return NextResponse.json(result);
  } catch {
    await releaseIntake(protection);
    return NextResponse.json(
      { error: "Feedback service unavailable" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (endpoint())
    return NextResponse.json(
      { error: "Feedback deletion is managed by the configured provider" },
      { status: 503 },
    );
  if (!intakeStoreConfigured())
    return NextResponse.json(
      { error: "Feedback storage is unavailable" },
      { status: 503 },
    );
  const body = (await request.json().catch(() => null)) as {
    events?: Array<{ id?: string; receivedAt?: string }>;
  } | null;
  if (
    !Array.isArray(body?.events) ||
    body.events.length < 1 ||
    body.events.length > 20
  )
    return NextResponse.json(
      { error: "Provide 1 to 20 feedback events" },
      { status: 400 },
    );
  const events = body.events.flatMap((event) => {
    const id =
      typeof event.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        event.id,
      )
        ? event.id
        : null;
    const receivedAt =
      typeof event.receivedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        event.receivedAt,
      )
        ? event.receivedAt
        : null;
    return id && receivedAt ? [{ id, receivedAt }] : [];
  });
  if (events.length !== body.events.length)
    return NextResponse.json(
      { error: "Invalid feedback event reference" },
      { status: 400 },
    );
  const held = (
    await Promise.all(
      events.map(async (event) =>
        (await retentionHoldFor("feedback", event.id)) ? event.id : null,
      ),
    )
  ).filter(Boolean);
  if (held.length)
    return NextResponse.json(
      {
        error:
          "One or more feedback events are subject to a temporary legal or security hold",
        held,
      },
      { status: 423 },
    );
  for (const event of events)
    await deleteFeedbackEvent(
      event.id,
      `feedback/events/${event.receivedAt.slice(0, 7)}/${event.id}.json`,
    );
  return NextResponse.json({ ok: true, deleted: events.length });
}
