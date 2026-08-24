import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const strict = process.argv.includes("--strict");
const env = process.env;
const file = (path) => existsSync(resolve(root, path));
const text = (path) => readFileSync(resolve(root, path), "utf8");
const hasAll = (...names) => names.every((name) => Boolean(env[name]?.trim()));
const checks = [];
const add = (id, status, detail, owner = "engineering") => checks.push({ id, status, detail, owner });

add("legal-pages", ["site/app/privacy/page.tsx", "site/app/terms/page.tsx", "site/app/security/page.tsx"].every(file) ? "ready" : "blocked", "Privacy, terms and security disclosures are versioned with the site.");
add("support-code", file("site/app/api/support/route.ts") && file("site/app/support/page.tsx") ? "ready" : "blocked", "Validated support intake and the user-facing fallback are present.");
add("feedback-code", file("site/app/api/feedback/route.ts") && file("site/app/feedback/page.tsx") ? "ready" : "blocked", "Feedback board and provider adapter are present.");
add("support-production", hasAll("CONVEX_SUPPORT_URL") || hasAll("SUPPORT_WEBHOOK_URL") ? "ready" : "external", "Set CONVEX_SUPPORT_URL or SUPPORT_WEBHOOK_URL in Vercel and exercise one synthetic case.", "operations");
add("feedback-production", hasAll("CONVEX_FEEDBACK_URL") ? "ready" : "external", "Set CONVEX_FEEDBACK_URL in Vercel and exercise submit, vote and follow.", "operations");
add("private-release-download", hasAll("GITHUB_TOKEN") ? "ready" : "external", "Set a read-only repository GITHUB_TOKEN in Vercel while releases are private.", "operations");
add("mac-signing", hasAll("MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") || hasAll("CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") ? "ready" : "external", "Configure Developer ID signing and App Store Connect notarization secrets in GitHub Actions.", "release-owner");
add("windows-signing", hasAll("WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD") ? "ready" : "external", "Configure an Authenticode certificate and password in GitHub Actions.", "release-owner");
add("release-workflow", text(".github/workflows/release.yml").includes("Create one complete public release") ? "ready" : "blocked", "Cross-platform signed artifacts converge into one non-draft release.");
add("quality-gates", text("package.json").includes('"release:scorecard"') ? "ready" : "blocked", "Correctness, type, renderer, DB, accessibility, restore, performance, security, dependency and chaos gates are scripted.");
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
