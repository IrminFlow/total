import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import {
  boundedWaitMs,
  canonicalRedirectProbeOk,
  privacySafeProbeError,
  releaseAssetProbeOk,
  releaseAssetSize,
  tlsProbeOk,
} from "./lib/production-live-probes.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const origin = process.env.TOTAL_PRODUCTION_URL ?? "https://devjindal.tech";
const adminSecret = process.env.INTAKE_ADMIN_SECRET ?? "";
const cronSecret = process.env.CRON_SECRET ?? "";
const syntheticEmail = process.env.TOTAL_SYNTHETIC_EMAIL ?? "";
const intakeEvidence = process.argv.includes("--intake-evidence");
const expectedSiteRevision =
  process.env.TOTAL_EXPECTED_SITE_REVISION?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  "";
const requireSynthetic =
  intakeEvidence || process.env.TOTAL_REQUIRE_SYNTHETIC === "1";
const requireCanonicalRedirect =
  process.env.TOTAL_REQUIRE_CANONICAL_REDIRECT === "1";
const deploymentWaitMs = boundedWaitMs(
  process.env.TOTAL_DEPLOYMENT_WAIT_MS,
  "TOTAL_DEPLOYMENT_WAIT_MS",
);
const releaseWaitMs = boundedWaitMs(
  process.env.TOTAL_RELEASE_WAIT_MS,
  "TOTAL_RELEASE_WAIT_MS",
);
const routes = [
  "/",
  "/support",
  "/feedback",
  "/pricing",
  "/privacy",
  "/terms",
  "/security",
  "/capture",
];
const requiredHeaders = [
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "x-frame-options",
  "content-security-policy",
];

async function requestJson(path, init = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function inspectTransport() {
  const canonical = new URL(origin);
  let tls = { ok: canonical.protocol !== "https:", hostname: canonical.hostname };
  if (canonical.protocol === "https:") {
    tls = await new Promise((resolveTls) => {
      const socket = tlsConnect({
        host: canonical.hostname,
        port: Number(canonical.port || 443),
        servername: canonical.hostname,
        rejectUnauthorized: true,
        timeout: 15_000,
      });
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerCertificate();
        const result = {
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ?? null,
          hostname: canonical.hostname,
          protocol: socket.getProtocol(),
          issuer: certificate.issuer?.O ?? certificate.issuer?.CN ?? null,
          validFrom: certificate.valid_from ?? null,
          validTo: certificate.valid_to ?? null,
          fingerprint256: certificate.fingerprint256 ?? null,
        };
        resolveTls({ ...result, ok: tlsProbeOk(result) });
        socket.end();
      });
      socket.once("timeout", () => socket.destroy(new Error("TLS connection timed out")));
      socket.once("error", (error) =>
        resolveTls({ ok: false, hostname: canonical.hostname, error: privacySafeProbeError(error) }),
      );
    });
  }
  let canonicalRedirect = { ok: false, status: null, location: null };
  if (canonical.protocol === "https:") {
    try {
      const response = await fetch(
        `http://${canonical.hostname}${canonical.port ? `:${canonical.port}` : ""}/`,
        { redirect: "manual", signal: AbortSignal.timeout(15_000) },
      );
      const location = response.headers.get("location");
      canonicalRedirect = {
        ok: canonicalRedirectProbeOk({
          status: response.status,
          location,
          canonicalOrigin: canonical.origin,
        }),
        status: response.status,
        location,
      };
    } catch (error) {
      canonicalRedirect = {
        ok: false,
        status: null,
        location: null,
        error: privacySafeProbeError(error),
      };
    }
  }
  return { tls, canonicalRedirect };
}

if (intakeEvidence && !/^[0-9a-f]{40}$/i.test(expectedSiteRevision))
  throw new Error(
    "Intake evidence requires TOTAL_EXPECTED_SITE_REVISION or GITHUB_SHA as a full commit SHA",
  );

let deployment = {
  ok: false,
  status: null,
  id: null,
  sourceRevision: null,
  productVersion: null,
  origin,
};
const deploymentDeadline = Date.now() + deploymentWaitMs;
do {
  try {
    const { response, body } = await requestJson("/api/deployment");
    deployment = {
      ok:
        response.ok &&
        /^[0-9a-f]{40}$/i.test(body?.sourceRevision ?? "") &&
        typeof body?.deploymentId === "string" &&
        body.deploymentId.length >= 8 &&
        body?.productVersion === pkg.version &&
        (!expectedSiteRevision || body.sourceRevision === expectedSiteRevision),
      status: response.status,
      id: body?.deploymentId ?? null,
      sourceRevision: body?.sourceRevision ?? null,
      productVersion: body?.productVersion ?? null,
      origin,
    };
  } catch (error) {
    deployment = {
      ...deployment,
      error: privacySafeProbeError(error),
    };
  }
  if (deployment.ok || Date.now() >= deploymentDeadline) break;
  await delay(Math.min(10_000, deploymentDeadline - Date.now()));
} while (true);

const routeResults = await Promise.all(
  routes.map(async (path) => {
    try {
      const response = await fetch(`${origin}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const headers = Object.fromEntries(
        requiredHeaders.map((name) => [name, response.headers.get(name)]),
      );
      return {
        path,
        ok: response.status === 200,
        status: response.status,
        headers,
      };
    } catch (error) {
      return {
        path,
        ok: false,
        status: null,
        error: privacySafeProbeError(error),
      };
    }
  }),
);

async function inspectDownload(platform, version) {
  try {
    const response = await fetch(
      `${origin}/api/download?platform=${platform}`,
      { redirect: "manual", signal: AbortSignal.timeout(15_000) },
    );
    const location = response.headers.get("location");
    const locationUrl = location ? new URL(location, origin) : null;
    if (![302, 303, 307, 308].includes(response.status) || !locationUrl)
      return {
        ok: false,
        status: response.status,
        location: locationUrl?.origin ?? null,
      };
    const asset = await fetch(locationUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    let assetStatus = asset.status;
    let disposition = asset.headers.get("content-disposition") ?? "";
    let contentType = asset.headers.get("content-type") ?? "";
    let size = releaseAssetSize({
      contentLength: asset.headers.get("content-length"),
      contentRange: asset.headers.get("content-range"),
    });
    let finalUrl = asset.url;
    if (size < 1_000_000) {
      const ranged = await fetch(locationUrl, {
        headers: { range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      assetStatus = ranged.status;
      disposition = ranged.headers.get("content-disposition") ?? disposition;
      contentType = ranged.headers.get("content-type") ?? contentType;
      size = releaseAssetSize({
        contentLength: ranged.headers.get("content-length"),
        contentRange: ranged.headers.get("content-range"),
      });
      finalUrl = ranged.url;
      await ranged.body?.cancel().catch(() => undefined);
    }
    return {
      ok: releaseAssetProbeOk({
        assetStatus,
        contentType,
        disposition,
        location: locationUrl.toString(),
        platform,
        size,
        version,
      }),
      status: response.status,
      assetStatus,
      location: locationUrl.origin,
      finalOrigin: new URL(finalUrl).origin,
      contentType,
      size,
      disposition: disposition.slice(0, 200),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: privacySafeProbeError(error),
    };
  }
}

async function inspectPublishedRelease() {
  let release = { ok: false, status: null, version: null, downloadUrl: null };
  try {
    const { response, body } = await requestJson("/api/latest");
    const downloadUrl =
      typeof body?.downloadUrl === "string"
        ? new URL(body.downloadUrl, origin)
        : null;
    const deliveryReady =
      response.ok &&
      typeof body?.version === "string" &&
      /^\d+\.\d+\.\d+$/.test(body.version) &&
      downloadUrl?.origin === new URL(origin).origin &&
      downloadUrl.pathname === "/api/download";
    release = {
      ok: deliveryReady && body.version === pkg.version,
      deliveryReady,
      status: response.status,
      version: body?.version ?? null,
      downloadUrl: downloadUrl?.toString() ?? null,
    };
  } catch (error) {
    release = {
      ...release,
      error: privacySafeProbeError(error),
    };
  }
  const downloads = {};
  const deliveredVersion = release.version ?? pkg.version;
  for (const platform of ["mac", "win"])
    downloads[platform] = await inspectDownload(platform, deliveredVersion);
  return { release, downloads };
}

let { release, downloads } = await inspectPublishedRelease();
const transport = await inspectTransport();
const releaseDeadline = Date.now() + releaseWaitMs;
while (
  (!release.ok || !Object.values(downloads).every((download) => download.ok)) &&
  Date.now() < releaseDeadline
) {
  await delay(Math.min(10_000, releaseDeadline - Date.now()));
  ({ release, downloads } = await inspectPublishedRelease());
}

const synthetic = {
  enabled: Boolean(adminSecret && cronSecret && syntheticEmail),
  ok: null,
  checks: {},
  cleanup: {},
};
if (synthetic.enabled) {
  const authHeaders = {
    authorization: `Bearer ${adminSecret}`,
    "content-type": "application/json",
  };
  const feedbackEvents = [];
  const activeHolds = [];
  const syntheticRunId = `monitor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let caseId = null;
  let baselineVotes = null;
  try {
    const baseline = await requestJson("/api/feedback");
    if (baseline.body?.storage !== "blob")
      throw new Error(
        `Synthetic feedback requires deletable Blob storage; production reported ${baseline.body?.storage ?? "an unknown backend"}`,
      );
    baselineVotes =
      baseline.body?.ideas?.find((idea) => idea.id === "mobile-companion")
        ?.votes ?? null;
    if (!baseline.response.ok || !Number.isInteger(baselineVotes))
      throw new Error("Could not read feedback vote baseline");

    for (const payload of [
      { action: "vote", ideaId: "mobile-companion", source: "website" },
      {
        action: "follow",
        ideaId: "mobile-companion",
        email: syntheticEmail,
        source: "website",
      },
      {
        action: "submit",
        title: "Synthetic production monitor",
        detail:
          "Automated delivery and cleanup check. This event should be deleted immediately.",
        email: syntheticEmail,
        source: "website",
      },
    ]) {
      const result = await requestJson("/api/feedback", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ...payload, syntheticRunId }),
      });
      if (!result.response.ok || !result.body?.id || !result.body?.receivedAt)
        throw new Error(`Feedback ${payload.action} failed`);
      feedbackEvents.push({
        id: result.body.id,
        receivedAt: result.body.receivedAt,
      });
    }
    const voted = await requestJson("/api/feedback");
    const afterVotes = voted.body?.ideas?.find(
      (idea) => idea.id === "mobile-companion",
    )?.votes;
    synthetic.checks.feedback = {
      ok: voted.response.ok && afterVotes === baselineVotes + 1,
      baselineVotes,
      afterVotes,
      events: feedbackEvents.length,
    };
    if (!synthetic.checks.feedback.ok)
      throw new Error("Feedback vote was not reflected");

    const created = await requestJson("/api/support", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: "question",
        email: syntheticEmail,
        message: `Synthetic production delivery check ${new Date().toISOString()}. Delete after validation.`,
        source: "website",
      }),
    });
    caseId = created.body?.caseId ?? null;
    if (!created.response.ok || !caseId || created.body?.status !== "submitted")
      throw new Error("Support creation failed");
    const tracked = await requestJson(
      `/api/support?caseId=${encodeURIComponent(caseId)}&email=${encodeURIComponent(syntheticEmail)}`,
    );
    const resolved = await requestJson("/api/support", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ caseId, status: "resolved" }),
    });
    const trackedResolved = await requestJson(
      `/api/support?caseId=${encodeURIComponent(caseId)}&email=${encodeURIComponent(syntheticEmail)}`,
    );
    const deleteAfter = Date.parse(resolved.body?.deleteAfter ?? "");
    const expectedRetentionMs = 90 * 24 * 60 * 60_000;
    synthetic.checks.support = {
      ok:
        tracked.response.ok &&
        tracked.body?.status === "submitted" &&
        resolved.response.ok &&
        trackedResolved.response.ok &&
        trackedResolved.body?.status === "resolved" &&
        created.body?.notification === "delivered" &&
        Number.isFinite(deleteAfter) &&
        Math.abs(
          deleteAfter -
            Date.parse(resolved.body?.updatedAt ?? "") -
            expectedRetentionMs,
        ) < 1_000,
      created: created.body?.status ?? null,
      final: trackedResolved.body?.status ?? null,
      notification: created.body?.notification ?? "missing",
      retentionDeleteAfter: Number.isFinite(deleteAfter)
        ? resolved.body.deleteAfter
        : null,
    };
    if (created.body?.notification !== "delivered")
      throw new Error(
        `Support case was stored, but notification delivery was ${created.body?.notification ?? "not reported"}`,
      );
    if (!synthetic.checks.support.ok)
      throw new Error("Support tracking or status transition failed");

    const retainedObjects = [
      { entity: "support", id: caseId },
      { entity: "feedback", id: feedbackEvents[0]?.id },
    ];
    const holdUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    const holdChecks = [];
    for (const retained of retainedObjects) {
      if (!retained.id)
        throw new Error(
          `Synthetic ${retained.entity} retention identity is missing`,
        );
      const held = await requestJson("/api/maintenance/intake", {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({
          ...retained,
          reasonCode: "security",
          holdUntil,
        }),
      });
      if (
        !held.response.ok ||
        held.body?.ok !== true ||
        held.body?.id !== retained.id
      )
        throw new Error(
          `Synthetic ${retained.entity} retention index was not found`,
        );
      activeHolds.push(retained);
      const released = await requestJson(
        `/api/maintenance/intake?entity=${retained.entity}&id=${encodeURIComponent(retained.id)}`,
        { method: "DELETE", headers: authHeaders },
      );
      if (!released.response.ok || released.body?.released !== true)
        throw new Error(
          `Synthetic ${retained.entity} retention hold could not be released`,
        );
      activeHolds.pop();
      holdChecks.push({ entity: retained.entity, held: true, released: true });
    }
    synthetic.checks.retentionIndexes = {
      ok: holdChecks.length === retainedObjects.length,
      objects: holdChecks,
    };
    const retention = await requestJson("/api/maintenance/intake?limit=1", {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    synthetic.checks.retention = {
      ok:
        retention.response.ok &&
        retention.body?.ok === true &&
        Number.isInteger(retention.body?.support?.scanned) &&
        Number.isInteger(retention.body?.feedback?.scanned) &&
        Number.isInteger(retention.body?.security?.scanned),
      status: retention.response.status,
      supportScanned: retention.body?.support?.scanned ?? null,
      feedbackScanned: retention.body?.feedback?.scanned ?? null,
      securityScanned: retention.body?.security?.scanned ?? null,
    };
    if (!synthetic.checks.retention.ok)
      throw new Error(
        "Retention maintenance authentication or execution failed",
      );
  } catch (error) {
    synthetic.error = privacySafeProbeError(error);
  } finally {
    const cleanupErrors = [];
    const holdResults = await Promise.allSettled(
      activeHolds
        .splice(0)
        .map((retained) =>
          requestJson(
            `/api/maintenance/intake?entity=${retained.entity}&id=${encodeURIComponent(retained.id)}`,
            { method: "DELETE", headers: authHeaders },
          ),
        ),
    );
    for (const result of holdResults) {
      if (result.status === "rejected")
        cleanupErrors.push(
          `retention hold: ${privacySafeProbeError(result.reason)}`,
        );
      else if (!result.value.response.ok)
        cleanupErrors.push(
          `retention hold: HTTP ${result.value.response.status}`,
        );
    }
    if (caseId) {
      try {
        const removed = await requestJson(
          `/api/support?caseId=${encodeURIComponent(caseId)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${adminSecret}` },
          },
        );
        const missing = await requestJson(
          `/api/support?caseId=${encodeURIComponent(caseId)}&email=${encodeURIComponent(syntheticEmail)}`,
        );
        synthetic.cleanup.support = {
          ok: removed.response.ok && missing.response.status === 404,
          statusEventsDeleted: removed.body?.statusEventsDeleted ?? null,
        };
      } catch (error) {
        synthetic.cleanup.support = { ok: false };
        cleanupErrors.push(
          `support: ${privacySafeProbeError(error)}`,
        );
      }
    }
    if (feedbackEvents.length) {
      try {
        const removed = await requestJson("/api/feedback", {
          method: "DELETE",
          headers: authHeaders,
          body: JSON.stringify({ events: feedbackEvents }),
        });
        const restored = await requestJson("/api/feedback");
        const finalVotes =
          restored.body?.ideas?.find((idea) => idea.id === "mobile-companion")
            ?.votes ?? null;
        synthetic.cleanup.feedback = {
          ok:
            removed.response.ok &&
            removed.body?.deleted === feedbackEvents.length &&
            finalVotes === baselineVotes,
          deleted: removed.body?.deleted ?? null,
          finalVotes,
        };
      } catch (error) {
        synthetic.cleanup.feedback = { ok: false };
        cleanupErrors.push(
          `feedback: ${privacySafeProbeError(error)}`,
        );
      }
    }
    if (cleanupErrors.length) synthetic.cleanupError = cleanupErrors.join("; ");
  }
  synthetic.ok = Boolean(
    synthetic.checks.support?.ok &&
    synthetic.checks.feedback?.ok &&
    synthetic.checks.retentionIndexes?.ok &&
    synthetic.checks.retention?.ok &&
    synthetic.cleanup.support?.ok &&
    synthetic.cleanup.feedback?.ok &&
    !synthetic.error &&
    !synthetic.cleanupError,
  );
}

const securityHeadersOk = routeResults.every(
  (row) =>
    row.ok && requiredHeaders.every((name) => Boolean(row.headers?.[name])),
);
const publicChecksOk =
  routeResults.every((row) => row.ok) &&
  release.ok &&
  Object.values(downloads).every((download) => download.ok) &&
  securityHeadersOk &&
  transport.tls.ok &&
  (!requireCanonicalRedirect || transport.canonicalRedirect.ok);
const serviceChecksOk =
  deployment.ok &&
  securityHeadersOk &&
  transport.tls.ok &&
  (!requireCanonicalRedirect || transport.canonicalRedirect.ok) &&
  synthetic.enabled &&
  synthetic.ok;
const output = {
  schema: 3,
  kind: intakeEvidence
    ? "production-service-execution"
    : "production-live-execution",
  executed: true,
  checkedAt: new Date().toISOString(),
  origin,
  sourceRevision: deployment.sourceRevision,
  productVersion: deployment.productVersion,
  deployment: { id: deployment.id, origin, verified: deployment.ok },
  expectedVersion: pkg.version,
  ok: intakeEvidence
    ? serviceChecksOk
    : publicChecksOk && deployment.ok && (!requireSynthetic || serviceChecksOk),
  routes: routeResults,
  release,
  downloads,
  transport,
  securityHeadersOk,
  synthetic,
};
const outputPath = resolve(
  root,
  process.env.PRODUCTION_SERVICE_EVIDENCE_OUT?.trim() ||
    (intakeEvidence
      ? "dist/production-services.json"
      : "dist/production-live-readiness.json"),
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
  mode: 0o600,
});
console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exit(1);
