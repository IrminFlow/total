import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  summarizeGateResults,
  validateStagingIdentity,
} from "./lib/staging-readiness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const runGates = process.argv.includes("--with-gates");
const stagingOrigin = (
  process.env.TOTAL_STAGING_URL ?? "https://total-v5-staging.vercel.app"
).replace(/\/$/, "");
const evidenceOverride = process.env.STAGING_READINESS_EVIDENCE_OUT?.trim();

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function required(program, args, label) {
  const result = command(program, args);
  if (result.exitCode !== 0)
    throw new Error(`${label} failed with exit code ${result.exitCode}`);
  return result.stdout;
}

function packageVersion(directory) {
  return JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"))
    .version;
}

function safeError(error) {
  const name = error instanceof Error ? error.name : "Error";
  return name.slice(0, 80);
}

async function deploymentIdentity() {
  try {
    const response = await fetch(`${stagingOrigin}/api/deployment`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      revision: body?.sourceRevision ?? null,
      version: body?.productVersion ?? null,
      id: body?.deploymentId ?? null,
    };
  } catch (error) {
    return { ok: false, status: null, error: safeError(error) };
  }
}

function runQualityGates(dataDirectory) {
  const steps = [
    ["root-install", root, "npm", ["ci"]],
    ["typecheck", root, "npm", ["run", "typecheck"]],
    ["unit", root, "npm", ["test"]],
    ["database", root, "npm", ["run", "test:db"]],
    ["renderer", root, "npm", ["run", "test:renderer"]],
    ["build", root, "npm", ["run", "build"]],
    ["smoke", root, "npm", ["run", "smoke"]],
    ["e2e", root, "npm", ["run", "e2e"]],
    ["visual", root, "npm", ["run", "test:visual"]],
    ["release-contracts", root, "npm", ["run", "test:release"]],
    ["large-data", root, "npm", ["run", "test:large"]],
    ["chaos", root, "npm", ["run", "test:chaos"]],
    ["bundle-budget", root, "npm", ["run", "perf:bundle"]],
    ["dependency-policy", root, "npm", ["run", "security:dependencies"]],
    ["security-audit", root, "npm", ["run", "security:audit"]],
    ["threat-model", root, "npm", ["run", "security:threat-model"]],
    ["site-install", resolve(root, "site"), "npm", ["ci"]],
    ["site-test", resolve(root, "site"), "npm", ["test"]],
    ["site-build", resolve(root, "site"), "npm", ["run", "build"]],
  ];
  const results = [];
  for (const [id, cwd, program, args] of steps) {
    const started = Date.now();
    const result = command(program, args, {
      cwd,
      inherit: true,
      env: { ...process.env, TOTAL_DATA_DIR: dataDirectory },
    });
    results.push({ id, exitCode: result.exitCode, durationMs: Date.now() - started });
    if (result.exitCode !== 0) break;
  }
  return summarizeGateResults(results);
}

const startedAt = new Date().toISOString();
let temporaryRoot = null;
let outputPath = null;
try {
  required("git", ["fetch", "origin", "--prune"], "remote refresh");
  const branch = required("git", ["branch", "--show-current"], "branch lookup");
  const head = required("git", ["rev-parse", "HEAD"], "HEAD lookup");
  const remoteHead = required(
    "git",
    ["rev-parse", "origin/v5-cloud-agent-sync"],
    "remote branch lookup",
  );
  const worktreeClean = command("git", ["status", "--porcelain"]).stdout === "";
  const diffCheckOk = command("git", ["diff", "--check"]).exitCode === 0;
  const pr = JSON.parse(
    required(
      "gh",
      [
        "pr",
        "view",
        "4",
        "--json",
        "headRefName,headRefOid,isDraft,state,mergeable,url",
      ],
      "PR lookup",
    ),
  );
  const deployment = await deploymentIdentity();
  const liveEvidencePath = resolve(root, "dist/staging-live-readiness.json");
  const live = command(
    process.execPath,
    [resolve(root, "scripts/production-live-check.mjs")],
    {
      inherit: true,
      env: {
        ...process.env,
        TOTAL_PRODUCTION_URL: stagingOrigin,
        TOTAL_EXPECTED_SITE_REVISION: head,
        TOTAL_REQUIRE_CANONICAL_REDIRECT: "1",
        PRODUCTION_SERVICE_EVIDENCE_OUT: liveEvidencePath,
      },
    },
  );
  const identity = validateStagingIdentity({
    expectedBranch: "v5-cloud-agent-sync",
    branch,
    head,
    remoteHead,
    prHead: pr.headRefOid,
    prBranch: pr.headRefName,
    prState: pr.state,
    prDraft: pr.isDraft,
    prMergeable: pr.mergeable,
    worktreeClean,
    diffCheckOk,
    rootVersion: packageVersion(root),
    siteVersion: packageVersion(resolve(root, "site")),
    stagingOrigin,
    deploymentRevision: deployment.revision,
    deploymentVersion: deployment.version,
    deploymentId: deployment.id,
    liveProbeOk: live.exitCode === 0,
  });
  temporaryRoot = mkdtempSync(resolve(tmpdir(), "total-v5-staging-"));
  const gates = runGates
    ? runQualityGates(resolve(temporaryRoot, "data"))
    : { ok: null, checks: [], skipped: true };
  const finalHead = required("git", ["rev-parse", "HEAD"], "final HEAD lookup");
  const finalClean = command("git", ["status", "--porcelain"]).stdout === "";
  identity.checks.push(
    { id: "post-gate-head", ok: finalHead === head, detail: finalHead },
    { id: "post-gate-clean", ok: finalClean, detail: finalClean },
  );
  identity.ok = identity.checks.every((row) => row.ok);
  const timestamp = startedAt.replace(/[:.]/g, "-");
  outputPath = resolve(
    root,
    evidenceOverride || `dist/staging-readiness-${head}-${timestamp}.json`,
  );
  const evidence = {
    schema: 1,
    kind: "staging-readiness",
    startedAt,
    completedAt: new Date().toISOString(),
    sourceRevision: head,
    productVersion: packageVersion(root),
    staging: {
      origin: stagingOrigin,
      deploymentId: deployment.id ?? null,
    },
    identity,
    gates,
    ok: identity.ok && (gates.ok === true || gates.skipped === true),
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: evidence.ok, outputPath, sourceRevision: head }));
  if (!evidence.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: safeError(error), outputPath }));
  process.exitCode = 1;
} finally {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}
