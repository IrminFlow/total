import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const origin = process.env.TOTAL_PRODUCTION_URL ?? "https://devjindal.tech";
const secret = process.env.SUPPORT_WEBHOOK_SECRET ?? "";
const syntheticEmail = process.env.TOTAL_SYNTHETIC_EMAIL ?? "";
const intakeEvidence = process.argv.includes("--intake-evidence");
const expectedSiteRevision = process.env.TOTAL_EXPECTED_SITE_REVISION?.trim() || process.env.GITHUB_SHA?.trim() || "";
const requireSynthetic = intakeEvidence || process.env.TOTAL_REQUIRE_SYNTHETIC === "1";
const routes = ["/", "/support", "/feedback", "/pricing", "/privacy", "/terms", "/security", "/capture"];
const requiredHeaders = ["strict-transport-security", "x-content-type-options", "referrer-policy", "permissions-policy", "x-frame-options", "content-security-policy"];

async function requestJson(path, init = {}) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  return { response, body };
}

if (intakeEvidence && !/^[0-9a-f]{40}$/i.test(expectedSiteRevision)) throw new Error("Intake evidence requires TOTAL_EXPECTED_SITE_REVISION or GITHUB_SHA as a full commit SHA");

let deployment = { ok: false, status: null, id: null, sourceRevision: null, productVersion: null, origin };
try {
  const { response, body } = await requestJson("/api/deployment");
  deployment = {
    ok: response.ok
      && /^[0-9a-f]{40}$/i.test(body?.sourceRevision ?? "")
      && typeof body?.deploymentId === "string"
      && body.deploymentId.length >= 8
      && body?.productVersion === pkg.version
      && (!expectedSiteRevision || body.sourceRevision === expectedSiteRevision),
    status: response.status,
    id: body?.deploymentId ?? null,
    sourceRevision: body?.sourceRevision ?? null,
    productVersion: body?.productVersion ?? null,
    origin,
  };
} catch (error) {
  deployment = { ...deployment, error: error instanceof Error ? error.message : String(error) };
}

const routeResults = await Promise.all(routes.map(async (path) => {
  try {
    const response = await fetch(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const headers = Object.fromEntries(requiredHeaders.map((name) => [name, response.headers.get(name)]));
    return { path, ok: response.status === 200, status: response.status, headers };
  } catch (error) {
    return { path, ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}));

let release = { ok: false, status: null, version: null };
try {
  const { response, body } = await requestJson("/api/latest");
  release = { ok: response.ok && body?.version === pkg.version, status: response.status, version: body?.version ?? null };
} catch (error) {
  release = { ...release, error: error instanceof Error ? error.message : String(error) };
}

const downloads = {};
for (const platform of ["mac", "win"]) {
  try {
    const response = await fetch(`${origin}/api/download?platform=${platform}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const location = response.headers.get("location");
    downloads[platform] = { ok: [302, 303, 307, 308].includes(response.status) && Boolean(location), status: response.status, location: location ? new URL(location, origin).origin : null };
  } catch (error) {
    downloads[platform] = { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const synthetic = { enabled: Boolean(secret && syntheticEmail), ok: null, checks: {}, cleanup: {} };
if (synthetic.enabled) {
  const authHeaders = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const feedbackEvents = [];
  let caseId = null;
  let baselineVotes = null;
  try {
    const baseline = await requestJson("/api/feedback");
    baselineVotes = baseline.body?.ideas?.find((idea) => idea.id === "mobile-companion")?.votes ?? null;
    if (!baseline.response.ok || !Number.isInteger(baselineVotes)) throw new Error("Could not read feedback vote baseline");

    for (const payload of [
      { action: "vote", ideaId: "mobile-companion", source: "website" },
      { action: "follow", ideaId: "mobile-companion", email: syntheticEmail, source: "website" },
      { action: "submit", title: "Synthetic production monitor", detail: "Automated delivery and cleanup check. This event should be deleted immediately.", email: syntheticEmail, source: "website" },
    ]) {
      const result = await requestJson("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!result.response.ok || !result.body?.id || !result.body?.receivedAt) throw new Error(`Feedback ${payload.action} failed`);
      feedbackEvents.push({ id: result.body.id, receivedAt: result.body.receivedAt });
    }
    const voted = await requestJson("/api/feedback");
    const afterVotes = voted.body?.ideas?.find((idea) => idea.id === "mobile-companion")?.votes;
    synthetic.checks.feedback = { ok: voted.response.ok && afterVotes === baselineVotes + 1, baselineVotes, afterVotes, events: feedbackEvents.length };
    if (!synthetic.checks.feedback.ok) throw new Error("Feedback vote was not reflected");

    const created = await requestJson("/api/support", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "question", email: syntheticEmail, message: `Synthetic production delivery check ${new Date().toISOString()}. Delete after validation.`, source: "website" }),
    });
    caseId = created.body?.caseId ?? null;
    if (!created.response.ok || !caseId || created.body?.status !== "submitted") throw new Error("Support creation failed");
    const tracked = await requestJson(`/api/support?caseId=${encodeURIComponent(caseId)}&email=${encodeURIComponent(syntheticEmail)}`);
    const resolved = await requestJson("/api/support", { method: "PATCH", headers: authHeaders, body: JSON.stringify({ caseId, status: "resolved" }) });
    const trackedResolved = await requestJson(`/api/support?caseId=${encodeURIComponent(caseId)}&email=${encodeURIComponent(syntheticEmail)}`);
    synthetic.checks.support = {
      ok: tracked.response.ok && tracked.body?.status === "submitted" && resolved.response.ok && trackedResolved.response.ok && trackedResolved.body?.status === "resolved",
      caseId,
      created: created.body?.status ?? null,
      final: trackedResolved.body?.status ?? null,
    };
    if (!synthetic.checks.support.ok) throw new Error("Support tracking or status transition failed");
  } catch (error) {
    synthetic.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (caseId) {
        const removed = await requestJson(`/api/support?caseId=${encodeURIComponent(caseId)}`, { method: "DELETE", headers: { authorization: `Bearer ${secret}` } });
        const missing = await requestJson(`/api/support?caseId=${encodeURIComponent(caseId)}&email=${encodeURIComponent(syntheticEmail)}`);
        synthetic.cleanup.support = { ok: removed.response.ok && missing.response.status === 404, statusEventsDeleted: removed.body?.statusEventsDeleted ?? null };
      }
      if (feedbackEvents.length) {
        const removed = await requestJson("/api/feedback", { method: "DELETE", headers: authHeaders, body: JSON.stringify({ events: feedbackEvents }) });
        const restored = await requestJson("/api/feedback");
        const finalVotes = restored.body?.ideas?.find((idea) => idea.id === "mobile-companion")?.votes ?? null;
        synthetic.cleanup.feedback = { ok: removed.response.ok && removed.body?.deleted === feedbackEvents.length && finalVotes === baselineVotes, deleted: removed.body?.deleted ?? null, finalVotes };
      }
    } catch (error) {
      synthetic.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  synthetic.ok = Boolean(synthetic.checks.support?.ok && synthetic.checks.feedback?.ok && synthetic.cleanup.support?.ok && synthetic.cleanup.feedback?.ok && !synthetic.error && !synthetic.cleanupError);
}

const securityHeadersOk = routeResults.every((row) => row.ok && requiredHeaders.every((name) => Boolean(row.headers?.[name])));
const publicChecksOk = routeResults.every((row) => row.ok)
  && release.ok
  && Object.values(downloads).every((download) => download.ok)
  && securityHeadersOk;
const serviceChecksOk = deployment.ok && securityHeadersOk && synthetic.enabled && synthetic.ok;
const output = {
  schema: 3,
  kind: intakeEvidence ? "production-service-execution" : "production-live-execution",
  executed: true,
  checkedAt: new Date().toISOString(),
  origin,
  sourceRevision: deployment.sourceRevision,
  productVersion: deployment.productVersion,
  deployment: { id: deployment.id, origin, verified: deployment.ok },
  expectedVersion: pkg.version,
  ok: intakeEvidence ? serviceChecksOk : publicChecksOk && deployment.ok && (!requireSynthetic || serviceChecksOk),
  routes: routeResults,
  release,
  downloads,
  securityHeadersOk,
  synthetic,
};
const outputPath = resolve(root, process.env.PRODUCTION_SERVICE_EVIDENCE_OUT?.trim() || (intakeEvidence ? "dist/production-services.json" : "dist/production-live-readiness.json"));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exit(1);
