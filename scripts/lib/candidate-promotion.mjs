import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EVIDENCE_PATH = /^docs\/evidence\/[^/]+\.json$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

export function isPublicReleaseAsset(name) {
  return (
    name === "latest-mac.yml" ||
    name === "latest.yml" ||
    name === "SHA256SUMS" ||
    /^Total-[0-9][0-9A-Za-z.-]*\.dmg(?:\.blockmap)?$/.test(name) ||
    /^Total-[0-9][0-9A-Za-z.-]*-mac\.zip(?:\.blockmap)?$/.test(name) ||
    /^Total\.Setup\.[0-9][0-9A-Za-z.-]*\.exe(?:\.blockmap)?$/.test(name)
  );
}

export function createCandidateManifest(options) {
  const root = resolve(options.root);
  assert(existsSync(root), `Candidate directory is missing: ${root}`);
  assert(
    FULL_SHA.test(options.sourceRevision),
    "Candidate source revision must be a lowercase full SHA",
  );
  assert(VERSION.test(options.version), "Candidate version is invalid");
  assert(
    Number.isSafeInteger(options.workflowRunId) && options.workflowRunId > 0,
    "Candidate workflow run ID is invalid",
  );
  assert(
    Number.isSafeInteger(options.workflowRunAttempt) &&
      options.workflowRunAttempt > 0,
    "Candidate workflow attempt is invalid",
  );
  assert(
    typeof options.repository === "string" &&
      /^[^/]+\/[^/]+$/.test(options.repository),
    "Candidate repository is invalid",
  );

  const files = filesBelow(root).filter(
    (path) => basename(path) !== "candidate-manifest.json",
  );
  const duplicates = files
    .map((path) => basename(path))
    .filter((name, index, names) => names.indexOf(name) !== index);
  assert(
    duplicates.length === 0,
    `Candidate contains duplicate filenames: ${[...new Set(duplicates)].join(", ")}`,
  );
  const assets = files
    .map((path) => ({
      name: basename(path),
      bytes: statSync(path).size,
      sha256: sha256(path),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const publicAssetNames = assets
    .filter((asset) => isPublicReleaseAsset(asset.name))
    .map((asset) => asset.name);
  for (const extension of [".dmg", ".zip", ".exe"])
    assert(
      publicAssetNames.some((name) => name.endsWith(extension)),
      `Candidate is missing public ${extension} asset`,
    );
  for (const name of ["latest-mac.yml", "latest.yml"])
    assert(
      publicAssetNames.includes(name),
      `Candidate is missing public updater manifest ${name}`,
    );

  return {
    schema: 1,
    version: options.version,
    sourceRevision: options.sourceRevision,
    repository: options.repository,
    workflow: ".github/workflows/release-candidate.yml",
    workflowRunId: options.workflowRunId,
    workflowRunAttempt: options.workflowRunAttempt,
    createdAt: new Date().toISOString(),
    assets,
    publicAssetNames,
  };
}

export function validateCandidateManifest(manifest, options) {
  assert(manifest?.schema === 1, "Candidate manifest schema must be 1");
  assert(
    manifest.sourceRevision === options.sourceRevision,
    "Candidate manifest revision does not match promotion input",
  );
  assert(
    manifest.version === options.version,
    "Candidate manifest version does not match promotion input",
  );
  assert(
    manifest.repository === options.repository,
    "Candidate manifest repository does not match promotion repository",
  );
  assert(
    manifest.workflow === ".github/workflows/release-candidate.yml",
    "Candidate manifest workflow is not trusted",
  );
  assert(
    manifest.workflowRunId === options.workflowRunId,
    "Candidate manifest run ID does not match promotion input",
  );
  assert(
    manifest.workflowRunAttempt === options.workflowRunAttempt,
    "Candidate manifest run attempt does not match promotion input",
  );
  assert(
    Array.isArray(manifest.assets) && manifest.assets.length > 0,
    "Candidate manifest has no assets",
  );
  assert(
    Array.isArray(manifest.publicAssetNames) &&
      manifest.publicAssetNames.length > 0,
    "Candidate manifest has no public assets",
  );

  const root = resolve(options.root);
  const files = filesBelow(root).filter(
    (path) => basename(path) !== "candidate-manifest.json",
  );
  const byName = new Map(files.map((path) => [basename(path), path]));
  assert(
    byName.size === files.length,
    "Candidate directory contains duplicate filenames",
  );
  const recorded = new Map();
  for (const asset of manifest.assets) {
    assert(
      basename(asset?.name ?? "") === asset.name,
      "Candidate asset names must not contain paths",
    );
    assert(
      !recorded.has(asset.name),
      `Candidate manifest repeats ${asset.name}`,
    );
    assert(
      Number.isSafeInteger(asset.bytes) && asset.bytes > 0,
      `${asset.name} has an invalid size`,
    );
    assert(SHA256.test(asset.sha256), `${asset.name} has an invalid digest`);
    const path = byName.get(asset.name);
    assert(path, `Candidate asset ${asset.name} is missing`);
    assert(
      statSync(path).size === asset.bytes,
      `Candidate asset ${asset.name} size mismatch`,
    );
    assert(
      sha256(path) === asset.sha256,
      `Candidate asset ${asset.name} digest mismatch`,
    );
    recorded.set(asset.name, asset);
  }
  assert(
    recorded.size === byName.size,
    "Candidate directory contains unrecorded files",
  );
  const publicNames = new Set(manifest.publicAssetNames);
  assert(
    publicNames.size === manifest.publicAssetNames.length,
    "Public asset allowlist contains duplicates",
  );
  for (const name of publicNames) {
    assert(
      recorded.has(name),
      `Public asset ${name} is not recorded in the candidate manifest`,
    );
    assert(
      isPublicReleaseAsset(name),
      `Internal evidence cannot be published as ${name}`,
    );
  }
  const expectedPublic = manifest.assets
    .filter((asset) => isPublicReleaseAsset(asset.name))
    .map((asset) => asset.name)
    .sort();
  assert(
    JSON.stringify([...publicNames].sort()) === JSON.stringify(expectedPublic),
    "Public asset allowlist is incomplete or contains internal files",
  );
  return {
    manifest,
    publicAssetPaths: manifest.publicAssetNames.map((name) => byName.get(name)),
  };
}

export function validatePublishedCandidate(manifest, root) {
  const files = filesBelow(resolve(root));
  const byName = new Map(files.map((path) => [basename(path), path]));
  assert(byName.size === files.length, "Downloaded release assets contain duplicate filenames");
  const expectedNames = [...manifest.publicAssetNames].sort();
  assert(JSON.stringify([...byName.keys()].sort()) === JSON.stringify(expectedNames), "Staged release assets do not match the public allowlist");
  const recorded = new Map(manifest.assets.map((asset) => [asset.name, asset]));
  for (const name of expectedNames) {
    const expected = recorded.get(name);
    const path = byName.get(name);
    assert(expected && path, `Staged release asset ${name} is missing`);
    assert(statSync(path).size === expected.bytes, `Staged release asset ${name} size mismatch`);
    assert(sha256(path) === expected.sha256, `Staged release asset ${name} digest mismatch`);
  }
  return true;
}

export function validatePublicationState(release, expected) {
  assert(Number.isSafeInteger(release?.id) && release.id > 0, "Publication has no release ID");
  assert(release?.tag_name === expected.tagName, "Publication tag does not match");
  assert(release?.target_commitish === expected.sourceRevision, "Publication target revision does not match");
  assert(release?.draft === false, "Release publication must never be a draft");
  assert(release?.prerelease === expected.prerelease, `Release prerelease state must be ${expected.prerelease}`);
  return true;
}

export function recoverCleanupReleaseId(createdReleaseId, releaseByTag, expected) {
  if (Number.isSafeInteger(createdReleaseId) && createdReleaseId > 0) return createdReleaseId;
  if (!releaseByTag) return null;
  validatePublicationState(releaseByTag, { ...expected, prerelease: releaseByTag.prerelease });
  return releaseByTag.id;
}

export function validateCandidateRun(run, artifact, expected) {
  assert(
    run?.id === expected.workflowRunId,
    "Candidate workflow run ID does not match",
  );
  assert(
    run?.run_attempt === expected.workflowRunAttempt,
    "Candidate workflow run attempt does not match",
  );
  assert(
    run?.event === "workflow_dispatch",
    "Candidate was not built by workflow_dispatch",
  );
  assert(
    run?.conclusion === "success" && run?.status === "completed",
    "Candidate workflow did not complete successfully",
  );
  assert(
    run?.head_sha === expected.sourceRevision,
    "Candidate workflow revision does not match",
  );
  assert(
    run?.path === ".github/workflows/release-candidate.yml",
    "Candidate came from the wrong workflow",
  );
  assert(
    run?.head_repository?.full_name === expected.repository,
    "Candidate came from the wrong repository",
  );
  assert(
    artifact?.id === expected.artifactId,
    "Candidate artifact ID does not match",
  );
  assert(artifact?.expired === false, "Candidate artifact has expired");
  assert(
    artifact?.workflow_run?.id === expected.workflowRunId,
    "Candidate artifact belongs to another workflow run",
  );
  assert(
    artifact?.workflow_run?.head_sha === expected.sourceRevision,
    "Candidate artifact belongs to another revision",
  );
}

export function validateEvidenceOnlyPaths(paths) {
  const invalid = paths.filter((path) => !EVIDENCE_PATH.test(path));
  assert(
    invalid.length === 0,
    `Candidate is stale because non-evidence paths changed: ${invalid.join(", ")}`,
  );
  return true;
}

export function validateCleanupIdentity(actual, expected) {
  assert(
    Number.isSafeInteger(expected.createdReleaseId) &&
      expected.createdReleaseId > 0,
    "No release ID was created by this run",
  );
  assert(
    actual?.releaseId === expected.createdReleaseId,
    "Refusing to delete a release not created by this run",
  );
  assert(
    actual?.tagName === expected.tagName,
    "Refusing to delete a release with another tag",
  );
  assert(
    actual?.tagSha === expected.sourceRevision,
    "Refusing to delete a tag pointing to another revision",
  );
  assert(
    actual?.targetCommitish === expected.sourceRevision,
    "Refusing to delete a release targeting another revision",
  );
  return true;
}
