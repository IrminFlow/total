import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

const WINDOW_MS = 10 * 60_000;
const MAX_REQUESTS = 8;
const attempts = new Map<string, { count: number; resetAt: number }>();

function allowed(ip: string): boolean {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  current.count += 1;
  if (attempts.size > 10_000) {
    for (const [key, value] of attempts)
      if (value.resetAt <= now) attempts.delete(key);
  }
  return current.count <= MAX_REQUESTS;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 850_000)
    return NextResponse.json(
      { error: "Request is too large" },
      { status: 413 },
    );
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!allowed(ip))
    return NextResponse.json(
      { error: "Please wait before sending more feedback" },
      { status: 429 },
    );
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (body.website) return NextResponse.json({ ok: true }); // honeypot
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const category = ["question", "bug", "idea", "accessibility"].includes(
    String(body.category),
  )
    ? String(body.category)
    : "question";
  const generatedCaseId = `TOT-${new Date()
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  const caseId = /^TOT-\d{8}-[A-F0-9]{6}$/.test(String(body.caseId))
    ? String(body.caseId)
    : generatedCaseId;
  const rawFocus =
    body.focusContext && typeof body.focusContext === "object"
      ? (body.focusContext as Record<string, unknown>)
      : null;
  const bounded = (value: unknown, max: number): string | null =>
    typeof value === "string" ? value.slice(0, max) : null;
  const focusContext = rawFocus
    ? {
        tag: bounded(rawFocus.tag, 40),
        role: bounded(rawFocus.role, 80),
        name: bounded(rawFocus.name, 160) ?? "",
        testId: bounded(rawFocus.testId, 120),
        screen: bounded(rawFocus.screen, 120),
      }
    : null;
  const screenshotDataUrl =
    typeof body.screenshotDataUrl === "string" &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(body.screenshotDataUrl) &&
    body.screenshotDataUrl.length <= 700_000
      ? body.screenshotDataUrl
      : null;
  const rawDiagnostics =
    body.diagnostics && typeof body.diagnostics === "object"
      ? (body.diagnostics as Record<string, unknown>)
      : null;
  const diagnostics = rawDiagnostics
    ? {
        version: bounded(rawDiagnostics.version, 30) ?? "",
        platform: bounded(rawDiagnostics.platform, 30) ?? "",
        arch: bounded(rawDiagnostics.arch, 30) ?? "",
      }
    : null;
  const logs = Array.isArray(body.logs)
    ? body.logs.slice(-50).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        return [
          {
            ts: bounded(item.ts, 30) ?? "",
            level: bounded(item.level, 12) ?? "",
            event: bounded(item.event, 80) ?? "",
            version: bounded(item.version, 30) ?? "",
          },
        ];
      })
    : null;
  const rawCompany =
    body.companyMetadata && typeof body.companyMetadata === "object"
      ? (body.companyMetadata as Record<string, unknown>)
      : null;
  const companyMetadata = rawCompany
    ? {
        name: bounded(rawCompany.name, 200) ?? "",
        stateCode: bounded(rawCompany.stateCode, 4) ?? "",
        gstRegistrationType:
          bounded(rawCompany.gstRegistrationType, 40) ?? "",
        schemaVersion: Number.isInteger(rawCompany.schemaVersion)
          ? Number(rawCompany.schemaVersion)
          : 0,
        voucherCount: Number.isInteger(rawCompany.voucherCount)
          ? Math.max(0, Number(rawCompany.voucherCount))
          : 0,
        enabledFeatures: Array.isArray(rawCompany.enabledFeatures)
          ? rawCompany.enabledFeatures
              .filter((value): value is string => typeof value === "string")
              .slice(0, 50)
              .map((value) => value.slice(0, 80))
          : [],
      }
    : null;
  const rawCrash =
    body.crashEnvelope && typeof body.crashEnvelope === "object"
      ? (body.crashEnvelope as Record<string, unknown>)
      : null;
  const crashEnvelope = rawCrash
    ? {
        id: /^CR-\d{8}-[A-F0-9]{6}$/.test(String(rawCrash.id))
          ? String(rawCrash.id)
          : "",
        timestamp: bounded(rawCrash.timestamp, 40) ?? "",
        kind: bounded(rawCrash.kind, 40) ?? "",
        appVersion: bounded(rawCrash.appVersion, 30) ?? "",
        platform: bounded(rawCrash.platform, 30) ?? "",
        arch: bounded(rawCrash.arch, 30) ?? "",
        screen: bounded(rawCrash.screen, 80),
        fingerprint: /^[a-f0-9]{16}$/.test(String(rawCrash.fingerprint))
          ? String(rawCrash.fingerprint)
          : "",
        message: bounded(rawCrash.message, 300) ?? "",
        stackFrames: Array.isArray(rawCrash.stackFrames)
          ? rawCrash.stackFrames
              .filter((value): value is string => typeof value === "string")
              .slice(0, 10)
              .map((value) => value.slice(0, 300))
          : [],
      }
    : null;
  if (
    message.length < 10 ||
    message.length > 5000 ||
    email.length > 200 ||
    (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  ) {
    return NextResponse.json(
      { error: "Check the feedback fields" },
      { status: 400 },
    );
  }
  const webhook =
    process.env.CONVEX_SUPPORT_URL || process.env.SUPPORT_WEBHOOK_URL;
  if (!webhook)
    return NextResponse.json(
      { error: "Support intake is not configured" },
      { status: 503 },
    );
  const target = new URL(webhook);
  if (target.protocol !== "https:")
    return NextResponse.json(
      { error: "Support intake is misconfigured" },
      { status: 503 },
    );
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.SUPPORT_WEBHOOK_SECRET
        ? { authorization: `Bearer ${process.env.SUPPORT_WEBHOOK_SECRET}` }
        : {}),
    },
    body: JSON.stringify({
      caseId,
      category,
      email,
      message,
      source: body.source === "app" ? "app" : "website",
      diagnostics,
      logs,
      companyMetadata,
      crashEnvelope,
      focusContext,
      screenshotDataUrl,
      receivedAt: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    return NextResponse.json(
      { error: "Support service unavailable" },
      { status: 502 },
    );
  return NextResponse.json({ ok: true, caseId, status: "submitted" });
}
