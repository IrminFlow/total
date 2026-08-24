import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { sha256, UPGRADE_DOMAINS, validateReleaseCandidateEvidence } from "../lib/release-candidate-evidence.mjs";

const revision = "a".repeat(40);
const version = "0.5.0";

function write(path, value) {
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  return { name: basename(path), bytes: Buffer.byteLength(typeof value === "string" ? value : `${JSON.stringify(value)}\n`), sha256: sha256(path) };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "total-candidate-evidence-"));
  mkdirSync(root, { recursive: true });
  for (const platform of ["mac", "win"]) {
    const candidates = platform === "mac"
      ? [write(join(root, "Total-0.5.0.dmg"), "signed dmg"), write(join(root, "Total-0.5.0-mac.zip"), "signed zip")]
      : [write(join(root, "Total.Setup.0.5.0.exe"), "signed exe")];
    const digest = "f".repeat(64);
    const upgradeName = `upgrade-evidence-${platform}.json`;
    const scorecardName = `release-scorecard-${platform}.json`;
    const upgrade = {
      schema: 3, ok: true, executed: true, platform, sourceRevision: revision,
      transition: `0.4.0 -> ${version}`,
      publicArtifact: { name: "public-v04", version: "0.4.0", bytes: 12, sha256: "b".repeat(64) },
      publicRelease: { fixtureDigest: digest },
      candidateFirstOpen: { fixtureDigest: digest, identity: { packaged: true } },
      candidateSecondOpen: { fixtureDigest: digest, identity: { packaged: true } },
      domains: UPGRADE_DOMAINS.map((id) => ({ id, status: "passed", ...(id === "attachments" ? { publicReleaseSupported: false, reason: "not available in v0.4" } : {}) })),
      candidateArtifacts: candidates,
      candidateExecution: {
        method: platform === "mac" ? "extracted-from-zip" : "installed-from-nsis",
        artifact: candidates.find((artifact) => artifact.name.endsWith(platform === "mac" ? "-mac.zip" : ".exe")),
        executable: { name: platform === "mac" ? "Total" : "Total.exe", bytes: 123, sha256: "e".repeat(64) },
        relativeExecutable: platform === "mac" ? "Total.app/Contents/MacOS/Total" : "Total.exe",
      },
    };
    const upgradeArtifact = write(join(root, upgradeName), upgrade);
    const scorecardArtifact = write(join(root, scorecardName), { schema: 1, ok: true });
    write(join(root, `build-evidence-${platform}.json`), {
      schema: 1, revision, packageVersion: version, sourceDirty: false,
      signing: { macIdentityConfigured: platform === "mac", appleNotarizationConfigured: platform === "mac", windowsIdentityConfigured: platform === "win" },
      artifacts: [...candidates, upgradeArtifact, scorecardArtifact],
    });
  }
  return root;
}

test("accepts two platform evidence sets linked to the exact artifacts and revision", () => {
  const root = fixture();
  assert.equal(validateReleaseCandidateEvidence({ root, revision, version }).ok, true);
});

test("fails when an installer changes after the upgrade was executed", () => {
  const root = fixture();
  writeFileSync(join(root, "Total.Setup.0.5.0.exe"), "replaced exe");
  assert.throws(() => validateReleaseCandidateEvidence({ root, revision, version }), /digest|size/);
});

test("fails when execution is not derived from a published distribution artifact", () => {
  const root = fixture();
  const path = join(root, "upgrade-evidence-mac.json");
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  evidence.candidateExecution.artifact = evidence.candidateArtifacts.find((artifact) => artifact.name.endsWith(".dmg"));
  writeFileSync(path, JSON.stringify(evidence));
  assert.throws(() => validateReleaseCandidateEvidence({ root, revision, version }), /execution artifact|wrong type/);
});

test("fails closed on a missing domain result or wrong source revision", () => {
  const root = fixture();
  const path = join(root, "upgrade-evidence-mac.json");
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  evidence.domains = evidence.domains.filter((row) => row.id !== "payroll");
  writeFileSync(path, JSON.stringify(evidence));
  assert.throws(() => validateReleaseCandidateEvidence({ root, revision, version }), /payroll/);
  assert.throws(() => validateReleaseCandidateEvidence({ root: fixture(), revision: "c".repeat(40), version }), /revision/);
});

test("fails closed when signed candidate evidence does not confirm signing readiness", () => {
  const root = fixture();
  const path = join(root, "build-evidence-win.json");
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  evidence.signing.windowsIdentityConfigured = false;
  writeFileSync(path, JSON.stringify(evidence));
  assert.throws(() => validateReleaseCandidateEvidence({ root, revision, version }), /signing identity/);
});
