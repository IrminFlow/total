import { NextResponse } from "next/server";
import { parseAttribution, recordAttribution } from "@/lib/attribution";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return NextResponse.json({ error: "JSON required" }, { status: 415 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 512)
    return NextResponse.json({ error: "Request is too large" }, { status: 413 });
  const requestOrigin = new URL(request.url).origin;
  if (request.headers.get("origin") !== requestOrigin)
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const raw = await request.text().catch(() => "");
  if (raw.length > 512)
    return NextResponse.json({ error: "Request is too large" }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Parsed below as an invalid event.
  }
  const input = parseAttribution(body);
  if (!input || input.event === "download")
    return NextResponse.json({ error: "Invalid attribution event" }, { status: 400 });
  await recordAttribution(input);
  return new NextResponse(null, { status: 204, headers: { "cache-control": "private, no-store" } });
}
