import { NextRequest, NextResponse } from "next/server";

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

export async function GET(): Promise<NextResponse> {
  const target = endpoint();
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
  if (!target)
    return NextResponse.json({ error: "Feedback voting is not configured" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const action = String(body.action);
  const ideaId = typeof body.ideaId === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(body.ideaId) ? body.ideaId : null;
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 2000) : "";
  const email = typeof body.email === "string" ? body.email.trim().slice(0, 200) : "";
  if (!(["vote", "follow"].includes(action) && ideaId) && !(action === "submit" && title.length >= 5 && detail.length >= 10))
    return NextResponse.json({ error: "Check the feedback fields" }, { status: 400 });
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.SUPPORT_WEBHOOK_SECRET ? { authorization: `Bearer ${process.env.SUPPORT_WEBHOOK_SECRET}` } : {}),
    },
    body: JSON.stringify({ action, ideaId, title, detail, email, source: body.source === "app" ? "app" : "website", receivedAt: new Date().toISOString() }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return NextResponse.json({ error: "Feedback service unavailable" }, { status: 502 });
  return NextResponse.json(await response.json());
}
