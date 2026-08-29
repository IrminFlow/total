const FULL_SHA = /^[0-9a-f]{40}$/;

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

export function validateStagingIdentity(input) {
  const expectedBranch = input.expectedBranch ?? "v5-cloud-agent-sync";
  const productionHosts = new Set(
    (input.productionHosts ?? ["devjindal.tech", "www.devjindal.tech"])
      .map((host) => host.toLowerCase()),
  );
  let stagingUrl = null;
  try {
    stagingUrl = new URL(input.stagingOrigin);
  } catch {
    // The URL check below reports a bounded failure without reflecting the value.
  }

  const checks = [
    check("branch", input.branch === expectedBranch, input.branch ?? null),
    check("head-format", FULL_SHA.test(input.head ?? ""), input.head ?? null),
    check(
      "remote-head",
      input.head === input.remoteHead,
      input.remoteHead ?? null,
    ),
    check("pr-head", input.head === input.prHead, input.prHead ?? null),
    check("pr-branch", input.prBranch === expectedBranch, input.prBranch ?? null),
    check("pr-state", input.prState === "OPEN", input.prState ?? null),
    check("pr-draft", input.prDraft === true, input.prDraft ?? null),
    check(
      "pr-mergeable",
      input.prMergeable === "MERGEABLE",
      input.prMergeable ?? null,
    ),
    check("clean-worktree", input.worktreeClean === true, input.worktreeClean),
    check("diff-check", input.diffCheckOk === true, input.diffCheckOk),
    check(
      "version",
      input.rootVersion === "5.0.0" && input.siteVersion === input.rootVersion,
      { root: input.rootVersion ?? null, site: input.siteVersion ?? null },
    ),
    check(
      "staging-https",
      stagingUrl?.protocol === "https:",
      stagingUrl?.protocol ?? null,
    ),
    check(
      "staging-isolated-host",
      Boolean(stagingUrl?.hostname) &&
        !productionHosts.has(stagingUrl.hostname.toLowerCase()),
      stagingUrl?.hostname ?? null,
    ),
    check(
      "deployment-head",
      input.deploymentRevision === input.head,
      input.deploymentRevision ?? null,
    ),
    check(
      "deployment-version",
      input.deploymentVersion === input.rootVersion,
      input.deploymentVersion ?? null,
    ),
    check(
      "deployment-id",
      typeof input.deploymentId === "string" && input.deploymentId.length >= 8,
      typeof input.deploymentId === "string" ? input.deploymentId : null,
    ),
    check("live-probe", input.liveProbeOk === true, input.liveProbeOk),
  ];

  return { ok: checks.every((row) => row.ok), checks };
}

export function summarizeGateResults(results) {
  const checks = results.map((result) => ({
    id: result.id,
    ok: result.exitCode === 0,
    durationMs: result.durationMs,
  }));
  return { ok: checks.every((row) => row.ok), checks };
}
