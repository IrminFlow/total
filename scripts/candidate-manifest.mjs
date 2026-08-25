import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createCandidateManifest,
  validateCandidateManifest,
  validatePublishedCandidate,
} from "./lib/candidate-promotion.mjs";

const [command, directory = "release"] = process.argv.slice(2);
const root = resolve(directory);
const manifestPath = resolve(root, "candidate-manifest.json");

if (command === "create") {
  const manifest = createCandidateManifest({
    root,
    sourceRevision: process.env.RELEASE_REVISION ?? "",
    version: process.env.RELEASE_VERSION ?? "",
    repository: process.env.RELEASE_REPOSITORY ?? "",
    workflowRunId: Number(process.env.RELEASE_WORKFLOW_RUN_ID),
    workflowRunAttempt: Number(process.env.RELEASE_WORKFLOW_RUN_ATTEMPT),
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  const manifestSha256 = createHash("sha256")
    .update(readFileSync(manifestPath))
    .digest("hex");
  console.log(
    JSON.stringify(
      {
        ok: true,
        manifestPath,
        manifestSha256,
        publicAssetNames: manifest.publicAssetNames,
      },
      null,
      2,
    ),
  );
} else if (command === "validate") {
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  if (manifestSha256 !== process.env.RELEASE_CANDIDATE_MANIFEST_SHA256)
    throw new Error("Candidate manifest digest does not match promotion input");
  const manifest = JSON.parse(manifestBytes);
  const result = validateCandidateManifest(manifest, {
    root,
    sourceRevision: process.env.RELEASE_REVISION ?? "",
    version: process.env.RELEASE_VERSION ?? "",
    repository: process.env.RELEASE_REPOSITORY ?? "",
    workflowRunId: Number(process.env.RELEASE_WORKFLOW_RUN_ID),
    workflowRunAttempt: Number(process.env.RELEASE_WORKFLOW_RUN_ATTEMPT),
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        manifestSha256,
        publicAssetNames: result.manifest.publicAssetNames,
      },
      null,
      2,
    ),
  );
} else if (command === "public") {
  const publicDirectory = process.argv[4];
  if (!publicDirectory)
    throw new Error("public requires a downloaded-assets directory");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validatePublishedCandidate(manifest, resolve(publicDirectory));
  console.log(
    JSON.stringify(
      { ok: true, publicAssetNames: manifest.publicAssetNames },
      null,
      2,
    ),
  );
} else {
  throw new Error(
    "Usage: node scripts/candidate-manifest.mjs <create|validate|public> [candidate-directory] [downloaded-assets-directory]",
  );
}
