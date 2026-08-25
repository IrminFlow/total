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
    const installName = `install-evidence-${platform}.json`;
    const buildName = `build-evidence-${platform}.json`;
    const packageName = `package-contract-${platform}.json`;
    const scorecardName = `release-scorecard-${platform}.json`;
    const upgradePath = files.get(upgradeName);
    const installPath = files.get(installName);
    const buildPath = files.get(buildName);
    const packagePath = files.get(packageName);
    const scorecardPath = files.get(scorecardName);
    const upgrade = json(upgradePath ?? join(root, upgradeName), `${platform} upgrade evidence`);
    const install = json(installPath ?? join(root, installName), `${platform} hosted-runner install evidence`);
    const build = json(buildPath ?? join(root, buildName), `${platform} build evidence`);
    const packageContract = json(packagePath ?? join(root, packageName), `${platform} package contract`);
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
    assert(/^[0-9a-f]{64}$/.test(build.trackedTreeSha256 ?? ""), `${platform} build evidence has no tracked source-tree identity`);
    assert(packageContract.schema === 1 && packageContract.platform === platform && packageContract.version === version, `${platform} package contract is not tied to this release`);
    assert(packageContract.sourceRevision === revision, `${platform} package contract revision does not match the release commit`);
    for (const check of ["requiredResources", "updaterMetadata", "installerPresence"])
      assert(packageContract.checks?.[check] === "passed", `${platform} package contract check ${check} did not pass`);
    assert(Array.isArray(packageContract.packagedResources) && packageContract.packagedResources.some((row) => row.path.endsWith("app.asar")) && packageContract.packagedResources.some((row) => row.path.endsWith("total-mcp.mjs")) && packageContract.packagedResources.some((row) => row.path.endsWith("voucher.schema.json")), `${platform} package contract does not prove the required packaged resources`);
    if (platform === "mac") assert(packageContract.checks?.permissions === "passed" && packageContract.checks?.bundleMetadata === "passed", "mac package contract did not validate permissions and bundle metadata");
    else assert(packageContract.checks?.peHeader === "passed", "win package contract did not validate the executable header");
    if (platform === "mac") {
      assert(build.signing?.macIdentityConfigured === true, "mac build evidence does not confirm the signing identity");
      assert(build.signing?.appleNotarizationConfigured === true, "mac build evidence does not confirm notarization credentials");
    } else {
      assert(build.signing?.windowsIdentityConfigured === true, "win build evidence does not confirm the signing identity");
    }
    assert(scorecard.schema === 1 && scorecard.ok === true, `${platform} release scorecard did not pass`);
    const recorded = new Map((build.artifacts ?? []).map((artifact) => [artifact.name, artifact]));
    for (const name of [upgradeName, scorecardName, packageName]) {
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
    assert(install.schema === 1 && install.ok === true && install.executed === true, `${platform} hosted-runner install evidence was not executed successfully`);
    assert(install.platform === platform, `${platform} hosted-runner install evidence has the wrong platform`);
    assert(install.sourceRevision === revision && install.productVersion === version, `${platform} hosted-runner install evidence is not tied to this release`);
    assert(install.runner?.provider === "github-actions" && install.runner?.environment === "github-hosted", `${platform} install evidence did not run on a GitHub-hosted runner`);
    for (const field of ["os", "arch", "imageOS", "imageVersion", "runId", "runAttempt", "job"])
      assert(typeof install.runner?.[field] === "string" && install.runner[field].trim().length > 0, `${platform} hosted-runner ${field} is missing`);
    const expectedInstallMethod = platform === "mac" ? "mounted-readonly-dmg-and-copied-app" : "silent-nsis-install";
    assert(install.installationMethod === expectedInstallMethod, `${platform} installer was not exercised with the required method`);
    const expectedInstallSuffix = platform === "mac" ? ".dmg" : ".exe";
    assert(install.candidateArtifact?.name?.endsWith(expectedInstallSuffix), `${platform} install evidence references the wrong artifact type`);
    validateArtifact(files.get(install.candidateArtifact.name), install.candidateArtifact, `${platform} installed candidate artifact`);
    const requiredInstallChecks = ["freshIsolatedHomeAndProfile", "packagedLaunch", "postVoucher", "backupPreview", "backupRestore", "uninstallRemovesApplication", "uninstallPreservesCompanyData"];
    for (const check of requiredInstallChecks)
      assert(install.checks?.[check] === "passed", `${platform} hosted-runner install check ${check} did not pass`);
    const recordedInstall = recorded.get(installName);
    assert(recordedInstall, `${platform} build evidence does not include ${installName}`);
    validateArtifact(installPath, recordedInstall, `${platform} hosted-runner install evidence`);
    summaries.push({ platform, fixtureDigest: upgrade.publicRelease.fixtureDigest, artifacts: upgrade.candidateArtifacts.map((artifact) => artifact.name), hostedRunnerInstallVerified: true });
  }
  return { ok: true, revision, version, signingVerified: true, hostedRunnerInstallVerified: true, platforms: summaries };
}
