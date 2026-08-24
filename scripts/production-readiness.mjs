import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const strict = process.argv.includes("--strict");
const env = process.env;
const file = (path) => existsSync(resolve(root, path));
const text = (path) => readFileSync(resolve(root, path), "utf8");
const productVersion = JSON.parse(text("package.json")).version;
const hasAll = (...names) => names.every((name) => Boolean(env[name]?.trim()));
const serviceEvidencePath = "docs/evidence/production-services-2026-08-24.json";
let serviceEvidence = null;
try { serviceEvidence = JSON.parse(text(serviceEvidencePath)); } catch {}
const supportVerified = serviceEvidence?.schema === 1 && serviceEvidence?.support?.ok === true && serviceEvidence?.support?.trackingAfterDeletionStatus === 404;
const feedbackVerified = serviceEvidence?.schema === 1 && serviceEvidence?.feedback?.ok === true && serviceEvidence?.feedback?.syntheticEventsDeleted === 3;
const privateDownloadVerified = serviceEvidence?.schema === 1 && serviceEvidence?.privateReleaseDownload?.ok === true;
const approvedEvidence = (envName, fallback, kind) => {
  const value = env[envName]?.trim() || fallback;
  if (!value || !existsSync(resolve(root, value))) return false;
  try {
    const evidence = JSON.parse(readFileSync(resolve(root, value), "utf8"));
    if (!(evidence?.schema === 1 && evidence?.kind === kind && evidence?.status === "approved" && evidence?.productVersion === productVersion && Boolean(evidence?.approvedAt))) return false;
    execFileSync(process.execPath, [resolve(root, "scripts/acceptance-gate.mjs"), resolve(root, value), "--quiet"], { stdio: "ignore" });
    return true;
  } catch { return false; }
};
const checks = [];
const add = (id, status, detail, owner = "engineering") => checks.push({ id, status, detail, owner });

add("legal-pages", ["site/app/privacy/page.tsx", "site/app/terms/page.tsx", "site/app/security/page.tsx"].every(file) ? "ready" : "blocked", "Privacy, terms and security disclosures are versioned with the site.");
add("support-code", file("site/app/api/support/route.ts") && file("site/app/support/page.tsx") ? "ready" : "blocked", "Validated support intake and the user-facing fallback are present.");
add("feedback-code", file("site/app/api/feedback/route.ts") && file("site/app/feedback/page.tsx") ? "ready" : "blocked", "Feedback board and provider adapter are present.");
add("support-production", supportVerified || hasAll("BLOB_READ_WRITE_TOKEN") || hasAll("CONVEX_SUPPORT_URL") || hasAll("SUPPORT_WEBHOOK_URL") ? "ready" : "external", supportVerified ? `Production create, track, resolve and delete passed at ${serviceEvidence.checkedAt}.` : "Connect private intake storage or a support webhook and exercise one synthetic tracked case.", "operations");
add("feedback-production", feedbackVerified || hasAll("BLOB_READ_WRITE_TOKEN") || hasAll("CONVEX_FEEDBACK_URL") ? "ready" : "external", feedbackVerified ? `Production submit, vote, follow and exact cleanup passed at ${serviceEvidence.checkedAt}.` : "Connect private intake storage or a feedback provider and exercise submit, vote and follow.", "operations");
add("private-release-download", privateDownloadVerified || hasAll("GITHUB_TOKEN") ? "ready" : "external", privateDownloadVerified ? `The private release resolver returned public v${serviceEvidence.privateReleaseDownload.resolvedPublicVersion}.` : "Set a read-only repository GITHUB_TOKEN in Vercel while releases are private.", "operations");
add("mac-signing", hasAll("MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") || hasAll("CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") ? "ready" : "external", "Configure Developer ID signing and App Store Connect notarization secrets in GitHub Actions.", "release-owner");
add("windows-signing", hasAll("WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD") ? "ready" : "external", "Configure an Authenticode certificate and password in GitHub Actions.", "release-owner");
add("release-workflow", text(".github/workflows/release.yml").includes("Create one complete public release") ? "ready" : "blocked", "Cross-platform signed artifacts converge into one non-draft release.");
add("quality-gates", text("package.json").includes('"release:scorecard"') ? "ready" : "blocked", "Correctness, type, renderer, DB, accessibility, restore, performance, security, dependency and chaos gates are scripted.");
add("public-v04-upgrade", file("scripts/upgrade-smoke.mjs") && text(".github/workflows/release.yml").includes("Upgrade real public v0.4 books") ? "ready" : "blocked", "Release CI downloads the actual public v0.4 packages and verifies migration, repeated reopen, balances and backup integrity.");
add("real-migration-acceptance", approvedEvidence("MIGRATION_ACCEPTANCE_EVIDENCE", "docs/evidence/migration-acceptance-approved.json", "migration") ? "ready" : "external", "Reconcile representative consented Tally, Busy, Marg, Zoho and spreadsheet exports and approve the evidence.", "acceptance-owner");
add("clean-device-acceptance", approvedEvidence("CLEAN_MACHINE_EVIDENCE", "docs/evidence/clean-machine-approved.json", "clean-machine") ? "ready" : "external", "Approve clean Apple Silicon, supported Intel macOS and Windows 11 installation, upgrade, backup, restore and uninstall evidence.", "acceptance-owner");
add("human-acceptance", approvedEvidence("HUMAN_ACCEPTANCE_EVIDENCE", "docs/evidence/human-acceptance-approved.json", "human") ? "ready" : "external", "Approve structured bookkeeper, owner, CA, payroll and inventory/manufacturing sessions.", "product-owner");
add("mobile-device-acceptance", approvedEvidence("MOBILE_ACCEPTANCE_EVIDENCE", "docs/evidence/mobile-acceptance-approved.json", "mobile") ? "ready" : "external", "Exercise camera capture and native sharing on current physical iOS and Android devices.", "acceptance-owner");
add("commercial-approval", approvedEvidence("COMMERCIAL_APPROVAL_EVIDENCE", "docs/evidence/commercial-policy-approved.json", "commercial") ? "ready" : "external", "Approve pricing, licence model, refund terms, support targets and beta-to-paid transition before publication.", "product-owner");
add("qualified-legal-review", approvedEvidence("LEGAL_REVIEW_EVIDENCE", "docs/evidence/legal-review-approved.json", "legal") ? "ready" : "external", "Obtain qualified legal review of privacy, terms, licensing and intended selling jurisdictions.", "legal-owner");
add("online-statutory", "excluded", "NIC and online GST portal connectivity are explicitly outside this production completion scope.", "product-owner");

let dirty = false;
try { dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0; } catch { dirty = true; }
add("source-state", dirty ? "worktree" : "ready", dirty ? "Commit and review the current implementation before tagging a release." : "Release source is committed.", "release-owner");

const blockers = checks.filter((check) => check.status === "blocked");
const external = checks.filter((check) => check.status === "external");
const output = { schema: 1, generatedAt: new Date().toISOString(), scope: { excluded: ["NIC live filing", "online GST portal connectivity"] }, readyForInternalAcceptance: blockers.length === 0, readyForPublicRelease: blockers.length === 0 && external.length === 0 && !dirty, checks };
mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/production-readiness.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (blockers.length || (strict && (!output.readyForPublicRelease))) process.exit(1);
