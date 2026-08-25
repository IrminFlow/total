import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateReleaseCandidateEvidence } from "./lib/release-candidate-evidence.mjs";

const root = resolve(process.env.RELEASE_CANDIDATE_EVIDENCE_DIR ?? process.env.RELEASE_DIR ?? "release");
const revision = process.env.RELEASE_REVISION ?? process.env.GITHUB_SHA;
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (!revision) throw new Error("RELEASE_REVISION or GITHUB_SHA is required");
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const version = tag ? tag.replace(/^v/, "") : packageVersion;
if (version !== packageVersion) throw new Error(`Candidate evidence version ${version} does not match package version ${packageVersion}`);
const result = validateReleaseCandidateEvidence({ root, revision, version });
if (!process.argv.includes("--quiet")) console.log(JSON.stringify(result, null, 2));
