import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const origin = process.env.TOTAL_PRODUCTION_URL ?? "https://devjindal.tech";
const routes = ["/", "/support", "/feedback", "/privacy", "/terms", "/security", "/capture"];
const results = [];
for (const path of routes) {
  try {
    const response = await fetch(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const headers = Object.fromEntries(["x-content-type-options", "referrer-policy", "permissions-policy", "x-frame-options", "content-security-policy"].map((name) => [name, response.headers.get(name)]));
    results.push({ path, ok: response.status === 200, status: response.status, headers });
  } catch (error) {
    results.push({ path, ok: false, status: null, error: error instanceof Error ? error.message : String(error) });
  }
}
let release = { ok: false, status: null, version: null };
try {
  const response = await fetch(`${origin}/api/latest`, { signal: AbortSignal.timeout(15_000) });
  const body = response.ok ? await response.json() : null;
  release = { ok: response.ok && body?.version === pkg.version, status: response.status, version: body?.version ?? null };
} catch {}
let download = { ok: false, status: null };
try {
  const response = await fetch(`${origin}/api/download?platform=mac`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  download = { ok: [302, 303, 307, 308].includes(response.status), status: response.status };
} catch {}
const requiredHeaders = ["x-content-type-options", "referrer-policy", "permissions-policy", "x-frame-options", "content-security-policy"];
const securityHeadersOk = results.every((row) => row.ok && requiredHeaders.every((name) => Boolean(row.headers?.[name])));
const output = { schema: 1, checkedAt: new Date().toISOString(), origin, expectedVersion: pkg.version, ok: results.every((row) => row.ok) && release.ok && download.ok && securityHeadersOk, routes: results, release, download, securityHeadersOk };
mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/production-live-readiness.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exit(1);
