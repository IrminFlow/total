import { readFileSync } from "node:fs";
import {
  recoverCleanupReleaseId,
  validateCandidateRun,
  validateCleanupIdentity,
  validateEvidenceOnlyPaths,
  validatePublicationState,
} from "./lib/candidate-promotion.mjs";

const [command, ...args] = process.argv.slice(2);
if (command === "run") {
  const [runPath, artifactPath] = args;
  validateCandidateRun(
    JSON.parse(readFileSync(runPath, "utf8")),
    JSON.parse(readFileSync(artifactPath, "utf8")),
    {
      workflowRunId: Number(process.env.RELEASE_WORKFLOW_RUN_ID),
      workflowRunAttempt: Number(process.env.RELEASE_WORKFLOW_RUN_ATTEMPT),
      artifactId: Number(process.env.RELEASE_CANDIDATE_ARTIFACT_ID),
      sourceRevision: process.env.RELEASE_REVISION,
      repository: process.env.RELEASE_REPOSITORY,
    },
  );
  console.log(JSON.stringify({ ok: true, check: "candidate-run" }));
} else if (command === "paths") {
  validateEvidenceOnlyPaths(
    readFileSync(args[0], "utf8").split(/\r?\n/).filter(Boolean),
  );
  console.log(JSON.stringify({ ok: true, check: "evidence-only-diff" }));
} else if (command === "cleanup") {
  validateCleanupIdentity(JSON.parse(readFileSync(args[0], "utf8")), {
    createdReleaseId: Number(process.env.CREATED_RELEASE_ID),
    tagName: process.env.RELEASE_TAG,
    sourceRevision: process.env.RELEASE_REVISION,
  });
  console.log(JSON.stringify({ ok: true, check: "cleanup-identity" }));
} else if (command === "publication") {
  validatePublicationState(JSON.parse(readFileSync(args[0], "utf8")), {
    tagName: process.env.RELEASE_TAG,
    sourceRevision: process.env.RELEASE_REVISION,
    prerelease: process.env.EXPECTED_PRERELEASE === "1",
  });
  console.log(JSON.stringify({ ok: true, check: "publication-state" }));
} else if (command === "recover-cleanup-id") {
  const release = args[0] ? JSON.parse(readFileSync(args[0], "utf8")) : null;
  const releaseId = recoverCleanupReleaseId(
    Number(process.env.CREATED_RELEASE_ID),
    release,
    {
      tagName: process.env.RELEASE_TAG,
      sourceRevision: process.env.RELEASE_REVISION,
    },
  );
  console.log(JSON.stringify({ ok: true, releaseId }));
} else {
  throw new Error(
    "Usage: node scripts/promotion-gate.mjs <run|paths|cleanup|publication|recover-cleanup-id> ...",
  );
}
