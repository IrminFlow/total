import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackageContract } from "./lib/package-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(process.env.RELEASE_DIR ?? "dist");
const platform = process.argv[2] === "win32" ? "win" : process.argv[2] === "darwin" ? "mac" : process.argv[2] ?? (process.platform === "darwin" ? "mac" : "win");
const pkg = JSON.parse((await import("node:fs")).readFileSync(resolve(root, "package.json"), "utf8"));
const result = validatePackageContract({ root, dist, platform, version: pkg.version });
const output = resolve(process.env.PACKAGE_CONTRACT_EVIDENCE ?? `dist/package-contract-${platform}.json`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ ...result, generatedAt: new Date().toISOString(), sourceRevision: process.env.RELEASE_REVISION ?? process.env.GITHUB_SHA ?? null }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, output, platform, artifacts: result.artifacts.length }));
