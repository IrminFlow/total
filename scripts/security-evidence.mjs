import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runSecurityAudit } from "./lib/security-audit.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const output = resolve(process.env.SECURITY_EVIDENCE_PATH ?? `${root}/dist/security-evidence.json`);
const threat = spawnSync(process.execPath, ["scripts/threat-model-gate.mjs"], { cwd: root, encoding: "utf8" });
const staticAudit = runSecurityAudit(root);
const digest = (path) => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
const evidence = {
  schema: 1,
  kind: "security-verification",
  generatedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0,
  checks: {
    threatModel: { ok: threat.status === 0, output: threat.stdout.trim() },
    staticAndSecretScan: staticAudit,
  },
  documents: {
    threatModelSha256: digest("docs/THREAT_MODEL.md"),
    secretInventorySha256: digest("docs/SECURITY_SECRET_INVENTORY.md"),
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: threat.status === 0 && staticAudit.ok, path: output, revision: evidence.revision }));
if (threat.status !== 0 || !staticAudit.ok) process.exit(1);
