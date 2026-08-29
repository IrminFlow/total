import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const artifactRoot = resolve(process.env.RELEASE_DIR ?? `${root}/dist`);
const evidenceName = process.env.RELEASE_EVIDENCE_NAME ?? "build-evidence.json";
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const filesBelow = (dir) => !existsSync(dir) ? [] : readdirSync(dir).flatMap((name) => {
  const file = join(dir, name);
  return statSync(file).isDirectory() ? filesBelow(file) : [file];
});
const revision = process.env.RELEASE_REVISION ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const actualRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (revision !== actualRevision) throw new Error(`Evidence revision ${revision} does not match checked-out commit ${actualRevision}`);
if (process.env.GITHUB_ACTIONS === "true" && sourceStatus)
  throw new Error("Release evidence cannot be recorded from a dirty hosted-runner source tree");
const trackedTree = execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" });
const evidence = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  revision,
  sourceDirty: sourceStatus.length > 0,
  trackedTreeSha256: createHash("sha256").update(trackedTree).digest("hex"),
  sourceCommitTime: execFileSync("git", ["show", "-s", "--format=%cI", revision], { cwd: root, encoding: "utf8" }).trim(),
  workflow: process.env.GITHUB_ACTIONS === "true" ? {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
    runnerOS: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
  } : null,
  packageVersion: JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version,
  lockSha256: sha256(`${root}/package-lock.json`),
  toolchain: { node: process.version, platform: process.platform, arch: process.arch, electron: JSON.parse(readFileSync(`${root}/node_modules/electron/package.json`, "utf8")).version },
  signing: { macIdentityConfigured: process.env.RELEASE_MAC_SIGNING_VERIFIED === "1" || !!process.env.MAC_CSC_LINK || !!process.env.CSC_LINK, appleNotarizationConfigured: process.env.RELEASE_MAC_NOTARIZATION_VERIFIED === "1" || !!process.env.APPLE_API_KEY, windowsIdentityConfigured: process.env.RELEASE_WINDOWS_SIGNING_VERIFIED === "1" || !!process.env.WIN_CSC_LINK },
  artifacts: filesBelow(artifactRoot).filter((file) => !file.endsWith(evidenceName)).map((file) => ({ name: basename(file), bytes: statSync(file).size, sha256: sha256(file) })).sort((a, b) => a.name.localeCompare(b.name)),
};
mkdirSync(artifactRoot, { recursive: true });
writeFileSync(join(artifactRoot, evidenceName), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, path: join(artifactRoot, evidenceName), artifacts: evidence.artifacts.length, revision }));
