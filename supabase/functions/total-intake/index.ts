import { createClient } from "npm:@supabase/supabase-js@2";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

Deno.serve(async (request) => {
  if (!["POST", "PATCH", "DELETE"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
  const expected = Deno.env.get("TOTAL_INTAKE_SECRET") ?? "";
  const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!expected || !safeEqual(supplied, expected)) return json({ error: "Unauthorized" }, 401);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 2 * 1024 * 1024) return json({ error: "Payload too large" }, 413);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const route = new URL(request.url).pathname;
  if (route.endsWith("/support")) {
    if (request.method === "PATCH") {
      const caseId = String(body.caseId ?? "").slice(0, 100);
      const requestedStatus = String(body.status ?? "");
      const statuses: Record<string, string> = {
        submitted: "submitted",
        in_review: "open",
        waiting_for_customer: "waiting",
        resolved: "resolved",
      };
      const status = statuses[requestedStatus];
      if (!caseId || !status) return json({ error: "Invalid support update" }, 400);
      const updatedAt = new Date().toISOString();
      const { data, error } = await supabase.from("total_support_tickets").update({
        status,
        updated_at: updatedAt,
        resolved_at: status === "resolved" ? updatedAt : null,
      }).eq("external_case_id", caseId).select("id").maybeSingle();
      if (error) return json({ error: "Ticket could not be updated" }, 500);
      if (!data) return json({ error: "Ticket not found" }, 404);
      await supabase.from("total_support_events").insert({
        ticket_id: data.id,
        kind: "status_changed",
        detail: { status: requestedStatus },
      });
      return json({ ok: true, caseId, status: requestedStatus });
    }
    if (request.method === "DELETE") {
      const caseId = String(body.caseId ?? "").slice(0, 100);
      if (!caseId) return json({ error: "Missing case ID" }, 400);
      const { data, error } = await supabase.from("total_support_tickets")
        .delete().eq("external_case_id", caseId).select("id");
      if (error) return json({ error: "Ticket could not be deleted" }, 500);
      return json({ ok: true, caseId, deleted: data?.length ?? 0 });
    }
    const caseId = String(body.caseId ?? "").slice(0, 100);
    const message = String(body.message ?? "").slice(0, 10_000);
    const category = String(body.category ?? "general").slice(0, 80);
    if (!caseId || !message) return json({ error: "Missing support fields" }, 400);
    const safeMetadata = {
      diagnostics: body.diagnostics ?? null,
      source: body.source === "app" ? "app" : "website",
      hasLogs: Array.isArray(body.logs) && body.logs.length > 0,
      hasScreenshot: typeof body.screenshotDataUrl === "string",
    };
    const { data, error } = await supabase.from("total_support_tickets").upsert({
      external_case_id: caseId,
      category,
      reply_email: typeof body.email === "string" ? body.email.slice(0, 320) : null,
      source: safeMetadata.source,
      message,
      safe_metadata: safeMetadata,
      updated_at: new Date().toISOString(),
    }, { onConflict: "external_case_id" }).select("id").single();
    if (error || !data) return json({ error: "Ticket could not be stored" }, 500);
    await supabase.from("total_support_events").insert({ ticket_id: data.id, kind: "received" });
    let notification = "not_configured";
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const supportEmail = Deno.env.get("TOTAL_SUPPORT_EMAIL");
    if (resendKey && supportEmail) {
      try {
        const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${resendKey}`, "content-type": "application/json" }, body: JSON.stringify({
          from: Deno.env.get("TOTAL_SUPPORT_FROM") ?? "Total Support <support@notifications.devjindal.tech>",
          to: [supportEmail],
          subject: `[Total] ${category} · ${caseId}`,
          text: `${message}\n\nCase: ${caseId}\nSource: ${safeMetadata.source}`,
        }) });
        notification = response.ok ? "delivered" : "failed";
      } catch { notification = "failed"; }
      await supabase.from("total_support_events").insert({ ticket_id: data.id, kind: notification === "delivered" ? "notification_sent" : "notification_failed" });
    }
    return json({ ok: true, caseId, status: "submitted", notification });
  }
  if (route.endsWith("/feedback")) {
    if (request.method === "DELETE") {
      const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
      const ids = events.flatMap((event) => {
        const id = typeof event?.id === "string" ? event.id : "";
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? [id] : [];
      });
      if (!ids.length || ids.length !== events.length) return json({ error: "Invalid feedback references" }, 400);
      const { data, error } = await supabase.from("total_feedback_events")
        .delete().in("external_event_id", ids).select("external_event_id");
      if (error) return json({ error: "Feedback could not be deleted" }, 500);
      return json({ ok: true, deleted: data?.length ?? 0 });
    }
    const rawKey = request.headers.get("idempotency-key") ?? crypto.randomUUID();
    const kind = ["idea", "vote", "follow", "unfollow"].includes(String(body.action)) ? String(body.action) : "idea";
    const externalEventId = typeof body.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id) ? body.id : null;
    const { error } = await supabase.from("total_feedback_events").upsert({ event_key: rawKey.slice(0, 200), external_event_id: externalEventId, kind, idea_id: typeof body.ideaId === "string" ? body.ideaId.slice(0, 200) : null, payload: body }, { onConflict: "event_key", ignoreDuplicates: true });
    if (error) return json({ error: "Feedback could not be stored" }, 500);
    return json({ ok: true, id: externalEventId, receivedAt: body.receivedAt ?? null });
  }
  return json({ error: "Route not found" }, 404);
});
