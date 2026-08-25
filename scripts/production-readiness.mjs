import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { validateReleaseCandidateEvidence } from "./lib/release-candidate-evidence.mjs";
import { validateProductionServiceEvidence } from "./lib/production-service-evidence.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const strict = process.argv.includes("--strict");
const preArtifact = process.argv.includes("--pre-artifact");
const env = process.env;
const file = (path) => existsSync(resolve(root, path));
const text = (path) => readFileSync(resolve(root, path), "utf8");
const productVersion = JSON.parse(text("package.json")).version;
const commercialEvidence = file("docs/evidence/commercial-policy-approved.json")
  ? JSON.parse(text("docs/evidence/commercial-policy-approved.json"))
  : null;
const freePublicBeta = commercialEvidence?.status === "approved"
  && commercialEvidence?.productVersion === productVersion
  && commercialEvidence?.betaPricePaise === 0
  && commercialEvidence?.automaticBetaConversion === false
  && text("docs/COMMERCIAL_POLICY.md").includes("Paid sales are not open yet.");
const sourceRevision = env.RELEASE_REVISION?.trim() || env.GITHUB_SHA?.trim() || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const siteRevision = env.SITE_REVISION?.trim() || sourceRevision;
const hasAll = (...names) => names.every((name) => Boolean(env[name]?.trim()));
const serviceEvidencePath = env.PRODUCTION_SERVICE_EVIDENCE?.trim();
let serviceEvidence = null;
let serviceEvidenceError = null;
if (serviceEvidencePath) {
  try {
    const raw = JSON.parse(readFileSync(resolve(root, serviceEvidencePath), "utf8"));
    serviceEvidence = validateProductionServiceEvidence(raw, { revision: siteRevision, version: productVersion });
  } catch (error) {
    serviceEvidenceError = error instanceof Error ? error.message : String(error);
  }
}
const approvedEvidence = (envName, fallback, kind) => {
  const value = env[envName]?.trim() || fallback;
  if (!value || !existsSync(resolve(root, value))) return false;
  try {
    const evidence = JSON.parse(readFileSync(resolve(root, value), "utf8"));
    if (!(evidence?.schema === 1 && evidence?.kind === kind && evidence?.status === "approved" && evidence?.productVersion === productVersion && Boolean(evidence?.approvedAt))) return false;
    const args = [resolve(root, "scripts/acceptance-gate.mjs"), resolve(root, value), "--quiet", "--revision", sourceRevision];
    if (candidateEvidenceDir && ["migration", "clean-machine", "human"].includes(kind)) args.push("--candidate-evidence-dir", resolve(root, candidateEvidenceDir));
    execFileSync(process.execPath, args, { stdio: "ignore" });
    return true;
  } catch { return false; }
};
let candidateEvidence = null;
let candidateEvidenceError = null;
const candidateEvidenceDir = env.RELEASE_CANDIDATE_EVIDENCE_DIR?.trim();
if (candidateEvidenceDir) {
  try {
    candidateEvidence = validateReleaseCandidateEvidence({ root: resolve(root, candidateEvidenceDir), revision: sourceRevision, version: productVersion });
  } catch (error) {
    candidateEvidenceError = error instanceof Error ? error.message : String(error);
  }
}
const checks = [];
const add = (id, status, detail, owner = "engineering") => checks.push({ id, status, detail, owner });

add("legal-pages", ["site/app/privacy/page.tsx", "site/app/terms/page.tsx", "site/app/security/page.tsx"].every(file) ? "ready" : "blocked", "Privacy, terms and security disclosures are versioned with the site.");
add("support-code", file("site/app/api/support/route.ts") && file("site/app/support/page.tsx") ? "ready" : "blocked", "Validated support intake and the user-facing fallback are present.");
add("feedback-code", file("site/app/api/feedback/route.ts") && file("site/app/feedback/page.tsx") ? "ready" : "blocked", "Feedback board and provider adapter are present.");
const serviceStatus = serviceEvidence ? "ready" : serviceEvidencePath ? "blocked" : "external";
const serviceDetail = serviceEvidence
  ? `Executed production checks passed at ${serviceEvidence.checkedAt} on deployment ${serviceEvidence.deploymentId} for ${serviceEvidence.sourceRevision}.`
  : serviceEvidenceError
    ? `Production service evidence failed validation: ${serviceEvidenceError}`
    : "Run the production support and feedback exercise against the current deployment and set PRODUCTION_SERVICE_EVIDENCE to its fresh evidence file.";
add("support-production", serviceStatus, serviceDetail, "operations");
add("feedback-production", serviceStatus, serviceDetail, "operations");
add(
  "private-release-download",
  serviceEvidence?.privateReleaseDeliveryVerified ? "ready" : "external",
  serviceEvidence?.privateReleaseDeliveryVerified
    ? "The exact production deployment resolved both private release installers during the executed service check."
    : "Verify both private release installers through the exact production deployment; configuration presence alone is not evidence.",
  "operations",
);
add("mac-signing", candidateEvidence?.signingVerified || hasAll("MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") || hasAll("CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") ? "ready" : "external", candidateEvidence?.signingVerified ? "The exact candidate evidence confirms the macOS signing and notarization gates ran." : "Configure Developer ID signing and App Store Connect notarization secrets in the protected signing workflow.", "release-owner");
add("windows-signing", candidateEvidence?.signingVerified || hasAll("WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD") ? "ready" : "external", candidateEvidence?.signingVerified ? "The exact candidate evidence confirms the Windows signing gate ran." : "Configure an Authenticode certificate in the protected signing workflow.", "release-owner");
add("release-workflow", file("scripts/ci-provenance-gate.mjs") && text(".github/workflows/release-candidate.yml").includes("Require successful CI for the exact candidate commit") && text(".github/workflows/release-candidate.yml").includes("ci-provenance-gate.mjs") && text(".github/workflows/release.yml").includes("Create non-draft prerelease") && text(".github/workflows/release.yml").includes("Promote verified prerelease to public latest") && text(".github/workflows/release.yml").includes("Upload only approved public assets") && text(".github/workflows/release.yml").includes("candidate_artifact_id") ? "ready" : "blocked", "The exact main commit must have successful push CI before signed candidates are built; accepted candidates are promoted without rebuilding and publication never uses a draft release.");
add("quality-gates", text("package.json").includes('"release:scorecard"') ? "ready" : "blocked", "Correctness, type, renderer, DB, accessibility, restore, performance, security, dependency and chaos gates are scripted.");
add(
  "public-v04-upgrade",
  candidateEvidence ? "ready" : candidateEvidenceDir ? "blocked" : preArtifact ? "pending" : "external",
  candidateEvidence
    ? `Executed macOS and Windows evidence for ${candidateEvidence.revision} matches the downloaded candidate artifacts.`
    : candidateEvidenceError
      ? `Candidate evidence failed validation: ${candidateEvidenceError}`
      : preArtifact
        ? "Candidate artifacts do not exist yet. Publication must validate both executed upgrade evidence sets against their installer digests."
        : "Run the public-v0.4 upgrade against both packaged candidates and set RELEASE_CANDIDATE_EVIDENCE_DIR to the downloaded evidence directory.",
  "release-owner",
);
add("real-migration-acceptance", approvedEvidence("MIGRATION_ACCEPTANCE_EVIDENCE", "docs/evidence/migration-acceptance-approved.json", "migration") ? "ready" : "external", "Reconcile representative consented Tally, Busy, Marg, Zoho and spreadsheet exports and approve the evidence.", "acceptance-owner");
add(
  "hosted-runner-install-acceptance",
  candidateEvidence?.hostedRunnerInstallVerified ? "ready" : candidateEvidenceDir ? "blocked" : preArtifact ? "pending" : "external",
  candidateEvidence?.hostedRunnerInstallVerified
    ? "Fresh GitHub-hosted macOS and Windows jobs installed the exact signed candidates, launched them, posted a voucher, backed up, restored, upgraded public v0.4 books, uninstalled, and preserved company data."
    : candidateEvidenceError
      ? `Hosted-runner install evidence failed validation: ${candidateEvidenceError}`
      : preArtifact
        ? "The candidate workflow must produce exact-artifact install, upgrade, backup, restore and uninstall evidence on fresh GitHub-hosted macOS and Windows runners."
        : "Run the signed release-candidate workflow and provide its immutable evidence bundle.",
  "release-owner",
);
add("physical-clean-device-acceptance", approvedEvidence("CLEAN_MACHINE_EVIDENCE", "docs/evidence/clean-machine-approved.json", "clean-machine") ? "ready" : "optional", "Physical Apple Silicon, Intel macOS and Windows testing is best-effort supplementary coverage; do not present it as completed without real evidence.", "acceptance-owner");
add("human-acceptance", approvedEvidence("HUMAN_ACCEPTANCE_EVIDENCE", "docs/evidence/human-acceptance-approved.json", "human") ? "ready" : "external", "Approve structured bookkeeper, owner, CA, payroll and inventory/manufacturing sessions.", "product-owner");
add("mobile-device-acceptance", approvedEvidence("MOBILE_ACCEPTANCE_EVIDENCE", "docs/evidence/mobile-acceptance-approved.json", "mobile") ? "ready" : "optional", "Phone capture is an optional companion web workflow and is not a release gate for the macOS and Windows desktop app.", "acceptance-owner");
add("commercial-approval", approvedEvidence("COMMERCIAL_APPROVAL_EVIDENCE", "docs/evidence/commercial-policy-approved.json", "commercial") ? "ready" : "external", "Approve pricing, licence model, refund terms, support targets and beta-to-paid transition before publication.", "product-owner");
const qualifiedLegalReview = approvedEvidence("LEGAL_REVIEW_EVIDENCE", "docs/evidence/legal-review-approved.json", "legal");
const ownerLegalRiskAcceptance = approvedEvidence("LEGAL_RISK_ACCEPTANCE_EVIDENCE", "docs/evidence/legal-risk-acceptance-approved.json", "legal-risk");
add(
  "legal-release-governance",
  qualifiedLegalReview || (freePublicBeta && ownerLegalRiskAcceptance) ? "ready" : "external",
  qualifiedLegalReview
    ? "A qualified reviewer approved the exact policy documents."
    : freePublicBeta
      ? "For this free public beta, record the product owner's explicit acceptance of unreviewed legal risk. This is not legal advice or legal approval."
      : "Qualified legal review is required because this release is not a free public beta.",
  qualifiedLegalReview ? "legal-owner" : "product-owner",
);
add(
  "qualified-legal-review",
  qualifiedLegalReview ? "ready" : freePublicBeta ? "recommended" : "external",
  qualifiedLegalReview
    ? "The exact privacy, terms, security and commercial-policy documents received qualified review."
    : freePublicBeta
      ? "Qualified review is recommended for the free beta and becomes mandatory before direct paid sales or significant paid marketing."
      : "Obtain qualified legal review before direct paid sales or significant paid marketing.",
  "legal-owner",
);
add("online-statutory", "excluded", "NIC and online GST portal connectivity are explicitly outside this production completion scope.", "product-owner");

let dirty = false;
try {
  const evidenceRelative = candidateEvidenceDir ? relative(root, resolve(root, candidateEvidenceDir)).replaceAll("\\", "/") : null;
  dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      const path = line.slice(3).replaceAll("\\", "/");
      return !evidenceRelative || (path !== evidenceRelative && !path.startsWith(`${evidenceRelative}/`));
    });
} catch { dirty = true; }
add("source-state", dirty ? "worktree" : "ready", dirty ? "Commit and review the current implementation before tagging a release." : "Release source is committed.", "release-owner");

const blockers = checks.filter((check) => check.status === "blocked");
const external = checks.filter((check) => check.status === "external");
const pending = checks.filter((check) => check.status === "pending");
const output = { schema: 1, generatedAt: new Date().toISOString(), sourceRevision, siteDeploymentRevision: siteRevision, scope: { excluded: ["NIC live filing", "online GST portal connectivity"] }, readyForInternalAcceptance: blockers.length === 0, readyForPublicRelease: blockers.length === 0 && external.length === 0 && pending.length === 0 && !dirty, checks };
mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/production-readiness.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (blockers.length || (strict && (external.length > 0 || dirty || (!preArtifact && pending.length > 0)))) process.exit(1);
