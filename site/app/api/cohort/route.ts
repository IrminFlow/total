import { NextRequest, NextResponse } from "next/server";
import { providerAuthorization } from "@/lib/serverSecrets";

export const runtime = "nodejs";

const EVENTS = new Set(["company_created", "first_voucher_posted", "first_backup_verified", "first_register_opened", "week_1_return", "month_1_return"]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const targetRaw = process.env.CONVEX_COHORT_URL;
  if (!targetRaw) return NextResponse.json({ error: "Product insights are not configured" }, { status: 503 });
  const target = new URL(targetRaw);
  if (target.protocol !== "https:") return NextResponse.json({ error: "Product insights are misconfigured" }, { status: 503 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const events = Array.isArray(body?.events) ? body.events : [];
  if (body?.schema !== 1 || !/^[a-z0-9]{8,40}$/.test(String(body?.installationId)) || !/^\d{4}-\d{2}$/.test(String(body?.activatedMonth)) || events.length > 6 || events.some((event) => !event || typeof event !== "object" || !EVENTS.has(String((event as Record<string, unknown>).name))))
    return NextResponse.json({ error: "Invalid aggregate payload" }, { status: 400 });
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", ...providerAuthorization(process.env.COHORT_PROVIDER_SECRET) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  return response.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Product insights service unavailable" }, { status: 502 });
}
