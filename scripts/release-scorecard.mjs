import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const checks = [
  ["correctness", "npm", ["test"]],
  ["type-safety", "npm", ["run", "typecheck"]],
  ["renderer", "npm", ["run", "test:renderer"]],
  ["database", "npm", ["run", "test:db"]],
  ["accessibility", process.execPath, ["scripts/run-e2e.mjs", "17", "47"]],
  ["restore", "npm", ["run", "test:db", "--", "src/main/db/backup.dbtest.ts", "src/main/db/upgradeRecovery.dbtest.ts"]],
  ["bundle-performance", "npm", ["run", "perf:bundle"]],
  ["startup-performance", "npm", ["run", "perf:startup"]],
  ["memory-performance", "npm", ["run", "perf:memory"]],
  ["security", "npm", ["run", "security:threat-model"]],
  ["dependencies", "npm", ["run", "security:dependencies"]],
  ["chaos", "npm", ["run", "test:chaos"]],
];
if (process.platform === "darwin") checks.push(["visual", "npm", ["run", "test:visual"]]);
const packagingPlatform = process.env.RELEASE_SCORECARD_PLATFORM;
if (packagingPlatform) checks.push(["packaging", "npm", ["run", "release:artifact", "--", packagingPlatform]]);
const results = [];
for (const [category, command, args] of checks) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  results.push({ category, ok: result.status === 0, durationMs: Date.now() - started });
  if (result.status !== 0) break;
}
const required = ["correctness", "type-safety", "renderer", "database", "accessibility", "restore", "bundle-performance", "startup-performance", "memory-performance", "security", "dependencies", "chaos", ...(process.platform === "darwin" ? ["visual"] : []), ...(packagingPlatform ? ["packaging"] : [])];
const ok = required.every((category) => results.find((result) => result.category === category)?.ok);
const output = { schema: 1, generatedAt: new Date().toISOString(), ok, required, results };
const dist = resolve(root, "dist");
mkdirSync(dist, { recursive: true });
const outputName = process.env.RELEASE_SCORECARD_NAME ?? "release-scorecard.json";
writeFileSync(resolve(dist, outputName), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (!ok) process.exit(1);
