import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateProductionServiceEvidence } from "../lib/production-service-evidence.mjs";

const revision = "a".repeat(40);
const version = "0.5.0";
const now = new Date("2026-08-24T18:00:00.000Z");

function fixture() {
  return {
    schema: 3,
    kind: "production-service-execution",
    executed: true,
    ok: true,
    checkedAt: "2026-08-24T17:30:00.000Z",
    sourceRevision: revision,
    productVersion: version,
    deployment: { id: "dpl_current123", origin: "https://total.example", verified: true },
    synthetic: {
      enabled: true,
      ok: true,
      checks: { support: { ok: true }, feedback: { ok: true } },
      cleanup: { support: { ok: true }, feedback: { ok: true, deleted: 3 } },
    },
  };
}

test("accepts fresh executed evidence for the exact deployment revision and version", () => {
  assert.equal(validateProductionServiceEvidence(fixture(), { revision, version, now }).ok, true);
});

test("rejects stale and wrong-revision production evidence", () => {
  const stale = fixture();
  stale.checkedAt = "2026-08-24T11:59:59.000Z";
  assert.throws(() => validateProductionServiceEvidence(stale, { revision, version, now }), /older than six hours/);
  assert.throws(() => validateProductionServiceEvidence(fixture(), { revision: "b".repeat(40), version, now }), /revision/);
});

test("rejects configuration-shaped evidence without successful execution and cleanup", () => {
  const notExecuted = fixture();
  notExecuted.executed = false;
  assert.throws(() => validateProductionServiceEvidence(notExecuted, { revision, version, now }), /not executed/);
  const incomplete = fixture();
  incomplete.synthetic.cleanup.feedback.deleted = 2;
  assert.throws(() => validateProductionServiceEvidence(incomplete, { revision, version, now }), /three synthetic events/);
});

test("readiness never treats configured provider secrets as executed production evidence", () => {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const output = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/production-readiness.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PRODUCTION_SERVICE_EVIDENCE: "",
      BLOB_READ_WRITE_TOKEN: "configured-only",
      CONVEX_SUPPORT_URL: "https://support.example",
      CONVEX_FEEDBACK_URL: "https://feedback.example",
    },
  }));
  assert.equal(output.checks.find((check) => check.id === "support-production").status, "external");
  assert.equal(output.checks.find((check) => check.id === "feedback-production").status, "external");
});

test("readiness fails closed when supplied production evidence is stale", () => {
  const root = resolve(new URL("../..", import.meta.url).pathname);
  const evidenceRoot = mkdtempSync(join(tmpdir(), "total-production-evidence-"));
  const path = join(evidenceRoot, "production-services.json");
  const stale = fixture();
  stale.sourceRevision = revision;
  stale.checkedAt = "2020-01-01T00:00:00.000Z";
  writeFileSync(path, JSON.stringify(stale));
  const result = spawnSync(process.execPath, [join(root, "scripts/production-readiness.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, RELEASE_REVISION: revision, PRODUCTION_SERVICE_EVIDENCE: path },
  });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.checks.find((check) => check.id === "support-production").status, "blocked");
});
