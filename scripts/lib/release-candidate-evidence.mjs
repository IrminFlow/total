import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const UPGRADE_DOMAINS = [
  "inventory",
  "batches",
  "banking",
  "payroll",
  "gst",
  "tds",
  "usersLock",
  "attachments",
];

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(path, label) {
  assert(existsSync(path), `${label} is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function artifactMap(root) {
  const files = filesBelow(root);
  const duplicates = files.map((path) => basename(path)).filter((name, index, names) => names.indexOf(name) !== index);
  assert(duplicates.length === 0, `Candidate evidence directory has duplicate asset names: ${[...new Set(duplicates)].join(", ")}`);
  return new Map(files.map((path) => [basename(path), path]));
}

function validateArtifact(actual, expected, label) {
  assert(actual, `${label} ${expected.name} is missing`);
  assert(statSync(actual).size === expected.bytes, `${label} ${expected.name} size does not match executed evidence`);
  assert(sha256(actual) === expected.sha256, `${label} ${expected.name} digest does not match executed evidence`);
}

export function validateReleaseCandidateEvidence(options) {
  const root = resolve(options.root);
  const revision = options.revision;
  const version = options.version;
  assert(/^[0-9a-f]{40}$/i.test(revision), "A full 40-character release revision is required");
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), "A release version is required");
  assert(existsSync(root), `Candidate evidence directory is missing: ${root}`);
  const files = artifactMap(root);

  const platforms = ["mac", "win"];
  const summaries = [];
  for (const platform of platforms) {
    const upgradeName = `upgrade-evidence-${platform}.json`;
    const buildName = `build-evidence-${platform}.json`;
    const scorecardName = `release-scorecard-${platform}.json`;
    const upgradePath = files.get(upgradeName);
    const buildPath = files.get(buildName);
    const scorecardPath = files.get(scorecardName);
    const upgrade = json(upgradePath ?? join(root, upgradeName), `${platform} upgrade evidence`);
    const build = json(buildPath ?? join(root, buildName), `${platform} build evidence`);
    const scorecard = json(scorecardPath ?? join(root, scorecardName), `${platform} scorecard`);

    assert(upgrade.schema === 3 && upgrade.ok === true && upgrade.executed === true, `${platform} upgrade evidence was not executed successfully`);
    assert(upgrade.platform === platform, `${platform} upgrade evidence has the wrong platform`);
    assert(upgrade.sourceRevision === revision, `${platform} upgrade evidence revision does not match the release commit`);
    assert(upgrade.transition === `0.4.0 -> ${version}`, `${platform} upgrade transition is not 0.4.0 -> ${version}`);
    assert(upgrade.candidateFirstOpen?.fixtureDigest === upgrade.publicRelease?.fixtureDigest, `${platform} first-open fixture digest changed`);
    assert(upgrade.candidateSecondOpen?.fixtureDigest === upgrade.publicRelease?.fixtureDigest, `${platform} second-open fixture digest changed`);
    assert(upgrade.candidateFirstOpen?.identity?.packaged === true && upgrade.candidateSecondOpen?.identity?.packaged === true, `${platform} candidate verification did not use packaged applications`);
    assert(Array.isArray(upgrade.domains), `${platform} upgrade evidence has no domain results`);
    for (const domain of UPGRADE_DOMAINS) {
      const result = upgrade.domains.find((row) => row.id === domain);
      assert(result?.status === "passed", `${platform} upgrade domain ${domain} did not pass`);
    }
    const attachment = upgrade.domains.find((row) => row.id === "attachments");
    assert(attachment?.publicReleaseSupported === false && typeof attachment?.reason === "string", `${platform} evidence must record that public v0.4 has no managed voucher attachments`);

    assert(Array.isArray(upgrade.candidateArtifacts) && upgrade.candidateArtifacts.length >= (platform === "mac" ? 2 : 1), `${platform} candidate artifacts are not linked`);
    const extensions = platform === "mac" ? [".dmg", ".zip"] : [".exe"];
    for (const extension of extensions)
      assert(upgrade.candidateArtifacts.some((artifact) => artifact.name.endsWith(extension)), `${platform} evidence does not link a ${extension} candidate artifact`);
    for (const artifact of upgrade.candidateArtifacts)
      validateArtifact(files.get(artifact.name), artifact, `${platform} candidate artifact`);
    const execution = upgrade.candidateExecution;
    const expectedMethod = platform === "mac" ? "extracted-from-zip" : "installed-from-nsis";
    const expectedExecutionSuffix = platform === "mac" ? "-mac.zip" : ".exe";
    const expectedRelativeExecutable = platform === "mac" ? "Total.app/Contents/MacOS/Total" : "Total.exe";
    assert(execution?.method === expectedMethod, `${platform} candidate was not executed from its distribution artifact`);
    assert(execution?.artifact?.name?.endsWith(expectedExecutionSuffix), `${platform} execution artifact has the wrong type`);
    assert(execution?.relativeExecutable === expectedRelativeExecutable, `${platform} candidate executable path is not derived from the execution artifact`);
    assert(Number.isInteger(execution?.executable?.bytes) && execution.executable.bytes > 0 && /^[0-9a-f]{64}$/.test(execution?.executable?.sha256 ?? ""), `${platform} materialized executable provenance is missing`);
    const listedExecutionArtifact = upgrade.candidateArtifacts.find((artifact) => artifact.name === execution.artifact.name);
    assert(listedExecutionArtifact?.bytes === execution.artifact.bytes && listedExecutionArtifact?.sha256 === execution.artifact.sha256, `${platform} executed artifact is not one of the published candidate artifacts`);
    validateArtifact(files.get(execution.artifact.name), execution.artifact, `${platform} execution artifact`);

    assert(build.schema === 1 && build.revision === revision && build.packageVersion === version, `${platform} build evidence is not tied to this release commit`);
    assert(build.sourceDirty === false, `${platform} build evidence came from a dirty worktree`);
    if (platform === "mac") {
      assert(build.signing?.macIdentityConfigured === true, "mac build evidence does not confirm the signing identity");
      assert(build.signing?.appleNotarizationConfigured === true, "mac build evidence does not confirm notarization credentials");
    } else {
      assert(build.signing?.windowsIdentityConfigured === true, "win build evidence does not confirm the signing identity");
    }
    assert(scorecard.schema === 1 && scorecard.ok === true, `${platform} release scorecard did not pass`);
    const recorded = new Map((build.artifacts ?? []).map((artifact) => [artifact.name, artifact]));
    for (const name of [upgradeName, scorecardName]) {
      const actual = files.get(name);
      const expected = recorded.get(name);
      assert(expected, `${platform} build evidence does not include ${name}`);
      validateArtifact(actual, expected, `${platform} executed evidence`);
    }
    for (const artifact of upgrade.candidateArtifacts) {
      const expected = recorded.get(artifact.name);
      assert(expected?.sha256 === artifact.sha256 && expected?.bytes === artifact.bytes, `${platform} build evidence does not link ${artifact.name}`);
    }
    assert(upgrade.publicArtifact?.version === "0.4.0" && /^[0-9a-f]{64}$/.test(upgrade.publicArtifact?.sha256 ?? ""), `${platform} public v0.4 package provenance is missing`);
    summaries.push({ platform, fixtureDigest: upgrade.publicRelease.fixtureDigest, artifacts: upgrade.candidateArtifacts.map((artifact) => artifact.name) });
  }
  return { ok: true, revision, version, signingVerified: true, platforms: summaries };
}
