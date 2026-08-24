import { NextRequest, NextResponse } from "next/server";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { deleteJson, intakeStoreConfigured, listJson, storeJson } from "@/lib/intakeStore";

export const runtime = "nodejs";

const SHIPPED_IDEAS = [
  { id: "mobile-companion", title: "Read-only mobile companion", detail: "View key balances, invoices and reminders without moving the writable books off the desktop.", status: "considering", votes: 0, releaseVersion: null },
  { id: "more-bank-formats", title: "More bank statement formats", detail: "Add reviewed presets for more Indian banks while keeping the generic mapper.", status: "planned", votes: 0, releaseVersion: null },
  { id: "quarter-registers", title: "Quarterly sales and purchase registers", detail: "Switch monthly evidence into financial quarters with the same voucher drill-down.", status: "released", votes: 0, releaseVersion: "0.5.0" },
] as const;

function endpoint(): URL | null {
  try {
    const raw = process.env.CONVEX_FEEDBACK_URL;
    if (!raw) return null;
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.SUPPORT_WEBHOOK_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export async function GET(): Promise<NextResponse> {
  const target = endpoint();
  if (!target && intakeStoreConfigured()) {
    try {
      const events = await listJson<{ action: string; ideaId?: string }>("feedback/events/");
      const votes = new Map<string, number>();
      for (const event of events)
        if (event.action === "vote" && event.ideaId) votes.set(event.ideaId, (votes.get(event.ideaId) ?? 0) + 1);
      return NextResponse.json({ ideas: SHIPPED_IDEAS.map((idea) => ({ ...idea, votes: votes.get(idea.id) ?? 0 })) });
    } catch {
      return NextResponse.json({ ideas: SHIPPED_IDEAS });
    }
  }
  if (!target) return NextResponse.json({ ideas: SHIPPED_IDEAS });
  try {
    const response = await fetch(target, {
      headers: process.env.SUPPORT_WEBHOOK_SECRET
        ? { authorization: `Bearer ${process.env.SUPPORT_WEBHOOK_SECRET}` }
        : {},
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("upstream");
    return NextResponse.json(await response.json());
  } catch {
    return NextResponse.json({ ideas: SHIPPED_IDEAS });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const target = endpoint();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const action = String(body.action);
  const ideaId = typeof body.ideaId === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(body.ideaId) ? body.ideaId : null;
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 2000) : "";
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 200) : "";
  if (!(["vote", "follow"].includes(action) && ideaId) && !(action === "submit" && title.length >= 5 && detail.length >= 10))
    return NextResponse.json({ error: "Check the feedback fields" }, { status: 400 });
  if ((action === "follow" || (action === "submit" && email)) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: "A valid email is required for updates" }, { status: 400 });
  const event = { id: randomUUID(), action, ideaId, title, detail, email, source: body.source === "app" ? "app" : "website", receivedAt: new Date().toISOString() };
  if (!target && intakeStoreConfigured()) {
    await storeJson(`feedback/events/${event.receivedAt.slice(0, 7)}/${event.id}.json`, event);
    return NextResponse.json({ ok: true, id: event.id, receivedAt: event.receivedAt, status: action === "submit" ? "awaiting_review" : "recorded" });
  }
  if (!target)
    return NextResponse.json({ error: "Feedback voting is not configured" }, { status: 503 });
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.SUPPORT_WEBHOOK_SECRET ? { authorization: `Bearer ${process.env.SUPPORT_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return NextResponse.json({ error: "Feedback service unavailable" }, { status: 502 });
  return NextResponse.json(await response.json());
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (endpoint()) return NextResponse.json({ error: "Feedback deletion is managed by the configured provider" }, { status: 503 });
  if (!intakeStoreConfigured()) return NextResponse.json({ error: "Feedback storage is unavailable" }, { status: 503 });
  const body = await request.json().catch(() => null) as { events?: Array<{ id?: string; receivedAt?: string }> } | null;
  if (!Array.isArray(body?.events) || body.events.length < 1 || body.events.length > 20)
    return NextResponse.json({ error: "Provide 1 to 20 feedback events" }, { status: 400 });
  const events = body.events.flatMap((event) => {
    const id = typeof event.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.id) ? event.id : null;
    const receivedAt = typeof event.receivedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(event.receivedAt) ? event.receivedAt : null;
    return id && receivedAt ? [{ id, receivedAt }] : [];
  });
  if (events.length !== body.events.length)
    return NextResponse.json({ error: "Invalid feedback event reference" }, { status: 400 });
  await Promise.all(events.map((event) => deleteJson(`feedback/events/${event.receivedAt.slice(0, 7)}/${event.id}.json`)));
  return NextResponse.json({ ok: true, deleted: events.length });
}
