import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeGateResults,
  validateStagingIdentity,
} from "../lib/staging-readiness.mjs";

const sha = "a".repeat(40);
const valid = {
  branch: "v5-cloud-agent-sync",
  head: sha,
  remoteHead: sha,
  prHead: sha,
  prBranch: "v5-cloud-agent-sync",
  prState: "OPEN",
  prDraft: true,
  prMergeable: "MERGEABLE",
  worktreeClean: true,
  diffCheckOk: true,
  rootVersion: "5.0.0",
  siteVersion: "5.0.0",
  stagingOrigin: "https://total-v5-staging.vercel.app",
  deploymentRevision: sha,
  deploymentVersion: "5.0.0",
  deploymentId: "dpl_staging_123",
  liveProbeOk: true,
};

test("accepts one exact isolated staging identity", () => {
  const result = validateStagingIdentity(valid);
  assert.equal(result.ok, true);
  assert.equal(result.checks.every((row) => row.ok), true);
});

test("rejects production hosts, dirty trees, non-draft PRs and revision drift", () => {
  const result = validateStagingIdentity({
    ...valid,
    stagingOrigin: "https://devjindal.tech",
    worktreeClean: false,
    prDraft: false,
    deploymentRevision: "b".repeat(40),
  });
  assert.equal(result.ok, false);
  for (const id of [
    "staging-isolated-host",
    "clean-worktree",
    "pr-draft",
    "deployment-head",
  ])
    assert.equal(result.checks.find((row) => row.id === id)?.ok, false);
});

test("rejects malformed staging URLs without reflecting their value", () => {
  const result = validateStagingIdentity({
    ...valid,
    stagingOrigin: "Bearer secret-value",
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((row) => row.id === "staging-https")?.detail, null);
});

test("summarizes fail-fast quality gate outcomes without command output", () => {
  const result = summarizeGateResults([
    { id: "typecheck", exitCode: 0, durationMs: 120 },
    { id: "unit", exitCode: 1, durationMs: 40 },
  ]);
  assert.deepEqual(result, {
    ok: false,
    checks: [
      { id: "typecheck", ok: true, durationMs: 120 },
      { id: "unit", ok: false, durationMs: 40 },
    ],
  });
});
