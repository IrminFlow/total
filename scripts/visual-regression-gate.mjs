import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const out = resolve(process.env.SMOKE_OUT ?? `${root}/smoke-out/e2e`);
const scenarios = process.argv.includes("--inspect-only") ? [] : ["12", "47", "49", "50"];
if (scenarios.length) {
  const run = spawnSync(process.execPath, ["scripts/run-e2e.mjs", ...scenarios], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SMOKE_OUT: out },
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

const contracts = [
  ["12-theme-a11y/01-light-gateway.png", 1440, 900, 45_000],
  ["12-theme-a11y/01-dark-gateway.png", 1440, 900, 45_000],
  ["47-accessibility-language/01-large-hindi-spaced.png", 1440, 900, 45_000],
  ["47-accessibility-language/02-hindi-invoice-labels.png", 1440, 900, 45_000],
  ["49-help-education/01-offline-help-search.png", 1440, 900, 45_000],
  ["49-help-education/02-guided-troubleshooting.png", 1440, 900, 45_000],
  ["50-community-learning/01-plan-and-community.png", 1440, 900, 45_000],
  ["50-community-learning/02-partner-training-pathway.png", 1440, 900, 45_000],
];
const failures = [];
const evidence = [];
for (const [relative, expectedWidth, expectedHeight, minimumBytes] of contracts) {
  const file = resolve(out, relative);
  if (!existsSync(file)) {
    failures.push(`${relative}: missing`);
    continue;
  }
  const header = readFileSync(file).subarray(0, 24);
  const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = png ? header.readUInt32BE(16) : 0;
  const height = png ? header.readUInt32BE(20) : 0;
  const bytes = statSync(file).size;
  if (!png || width !== expectedWidth || height !== expectedHeight || bytes < minimumBytes)
    failures.push(`${relative}: png=${png} dimensions=${width}x${height} bytes=${bytes}`);
  evidence.push({ file: relative, width, height, bytes });
}
console.log(JSON.stringify({ ok: failures.length === 0, contracts: evidence, failures }, null, 2));
if (failures.length) process.exit(1);
