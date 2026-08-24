import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCandidateManifest,
  recoverCleanupReleaseId,
  validateCandidateManifest,
  validateCandidateRun,
  validateCleanupIdentity,
  validateEvidenceOnlyPaths,
  validatePublicationState,
  validatePublishedCandidate,
} from "../lib/candidate-promotion.mjs";

const revision = "a".repeat(40);
const repository = "IrminFlow/total";

function candidate() {
  const root = mkdtempSync(join(tmpdir(), "total-candidate-"));
  const files = {
    "Total-0.5.0.dmg": "signed mac disk image",
    "Total-0.5.0-mac.zip": "signed mac archive",
    "Total.Setup.0.5.0.exe": "signed windows installer",
    "latest-mac.yml": "version: 0.5.0",
    "latest.yml": "version: 0.5.0",
    "build-evidence-mac.json": "{}",
    "upgrade-evidence-win.json": "{}",
  };
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(root, name), body);
  const manifest = createCandidateManifest({
    root,
    sourceRevision: revision,
    version: "0.5.0",
    repository,
    workflowRunId: 42,
    workflowRunAttempt: 2,
  });
  return { root, manifest };
}

const expected = {
  sourceRevision: revision,
  version: "0.5.0",
  repository,
  workflowRunId: 42,
  workflowRunAttempt: 2,
};

test("candidate manifest publishes installers and updater files but not internal evidence", () => {
  const { root, manifest } = candidate();
  validateCandidateManifest(manifest, { root, ...expected });
  assert(manifest.publicAssetNames.includes("Total-0.5.0.dmg"));
  assert(manifest.publicAssetNames.includes("Total.Setup.0.5.0.exe"));
  assert(!manifest.publicAssetNames.includes("build-evidence-mac.json"));
  assert(!manifest.publicAssetNames.includes("upgrade-evidence-win.json"));
});

test("an internal file disguised with an executable extension is not public", () => {
  const { root, manifest } = candidate();
  writeFileSync(join(root, "migration-evidence.exe"), "private evidence");
  const regenerated = createCandidateManifest({ root, ...expected });
  assert(!regenerated.publicAssetNames.includes("migration-evidence.exe"));
  assert.doesNotThrow(() =>
    validateCandidateManifest(regenerated, { root, ...expected }),
  );
  assert(!manifest.publicAssetNames.includes("migration-evidence.exe"));
});

test("candidate validation detects exact artifact substitution", () => {
  const { root, manifest } = candidate();
  writeFileSync(join(root, "Total-0.5.0.dmg"), "substituted mac disk image");
  assert.throws(
    () => validateCandidateManifest(manifest, { root, ...expected }),
    /size mismatch|digest mismatch/,
  );
});

test("staged prerelease download must reproduce the complete public allowlist", () => {
  const { root, manifest } = candidate();
  const staged = mkdtempSync(join(tmpdir(), "total-staged-release-"));
  for (const name of manifest.publicAssetNames)
    writeFileSync(join(staged, name), readFileSync(join(root, name)));
  assert.equal(validatePublishedCandidate(manifest, staged), true);
  writeFileSync(join(staged, "Total-0.5.0.dmg"), "replacement");
  assert.throws(() => validatePublishedCandidate(manifest, staged), /size mismatch|digest mismatch/);
});

test("candidate run validation rejects wrong workflow, run, repository and artifact", async (t) => {
  const run = {
    id: 42,
    run_attempt: 2,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: revision,
    path: ".github/workflows/release-candidate.yml",
    head_repository: { full_name: repository },
  };
  const artifact = {
    id: 99,
    expired: false,
    workflow_run: { id: 42, head_sha: revision },
  };
  const runExpected = { ...expected, artifactId: 99 };
  validateCandidateRun(run, artifact, runExpected);
  for (const [label, mutate, pattern] of [
    [
      "workflow",
      (value) => (value.path = ".github/workflows/ci.yml"),
      /wrong workflow/,
    ],
    ["run", (value) => (value.id = 41), /run ID/],
    [
      "repository",
      (value) => (value.head_repository.full_name = "attacker/total"),
      /wrong repository/,
    ],
  ]) {
    await t.test(label, () => {
      const changed = structuredClone(run);
      mutate(changed);
      assert.throws(
        () => validateCandidateRun(changed, artifact, runExpected),
        pattern,
      );
    });
  }
  assert.throws(
    () => validateCandidateRun(run, { ...artifact, id: 100 }, runExpected),
    /artifact ID/,
  );
});

test("promotion accepts evidence-only commits and rejects runtime or workflow changes", () => {
  assert.equal(
    validateEvidenceOnlyPaths([
      "docs/evidence/human-acceptance-approved.json",
      "docs/evidence/migration-acceptance-approved.json",
    ]),
    true,
  );
  assert.throws(
    () =>
      validateEvidenceOnlyPaths([
        "docs/evidence/human-acceptance-approved.json",
        "src/main/ipc.ts",
      ]),
    /non-evidence paths changed/,
  );
  assert.throws(
    () => validateEvidenceOnlyPaths([".github/workflows/release.yml"]),
    /non-evidence paths changed/,
  );
});

test("cleanup refuses another release ID, tag or target revision", () => {
  const cleanupExpected = {
    createdReleaseId: 123,
    tagName: "v0.5.0",
    sourceRevision: revision,
  };
  validateCleanupIdentity(
    { releaseId: 123, tagName: "v0.5.0", tagSha: revision, targetCommitish: revision },
    cleanupExpected,
  );
  assert.throws(
    () =>
      validateCleanupIdentity(
        { releaseId: 124, tagName: "v0.5.0", tagSha: revision, targetCommitish: revision },
        cleanupExpected,
      ),
    /not created by this run/,
  );
  assert.throws(
    () =>
      validateCleanupIdentity(
        { releaseId: 123, tagName: "v0.4.0", tagSha: revision, targetCommitish: revision },
        cleanupExpected,
      ),
    /another tag/,
  );
  assert.throws(
    () =>
      validateCleanupIdentity(
        { releaseId: 123, tagName: "v0.5.0", tagSha: "b".repeat(40), targetCommitish: revision },
        cleanupExpected,
      ),
    /another revision/,
  );
  assert.throws(
    () =>
      validateCleanupIdentity(
        { releaseId: 123, tagName: "v0.5.0", tagSha: revision, targetCommitish: "b".repeat(40) },
        cleanupExpected,
      ),
    /targeting another revision/,
  );
});

test("cleanup recovers only an exact release-by-tag identity when step output is absent", () => {
  const release = { id: 123, tag_name: "v0.5.0", target_commitish: revision, draft: false, prerelease: true };
  assert.equal(recoverCleanupReleaseId(0, release, { tagName: "v0.5.0", sourceRevision: revision }), 123);
  assert.equal(recoverCleanupReleaseId(0, null, { tagName: "v0.5.0", sourceRevision: revision }), null);
  assert.throws(() => recoverCleanupReleaseId(0, { ...release, target_commitish: "b".repeat(40) }, { tagName: "v0.5.0", sourceRevision: revision }), /target revision/);
});

test("publication transitions from non-draft prerelease to public latest without a draft state", () => {
  const staged = { id: 123, tag_name: "v0.5.0", target_commitish: revision, draft: false, prerelease: true };
  const published = { ...staged, prerelease: false };
  assert.equal(validatePublicationState(staged, { tagName: "v0.5.0", sourceRevision: revision, prerelease: true }), true);
  assert.equal(validatePublicationState(published, { tagName: "v0.5.0", sourceRevision: revision, prerelease: false }), true);
  assert.throws(() => validatePublicationState({ ...staged, draft: true }, { tagName: "v0.5.0", sourceRevision: revision, prerelease: true }), /never be a draft/);
});
