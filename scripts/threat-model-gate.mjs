import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const index = read("src/main/index.ts");
const ipc = read("src/main/ipc.ts");
const preload = read("src/preload/index.ts");
const mcp = read("scripts/total-mcp.mjs");
const ai = read("src/main/services/ai.ts");
const manifest = read("src/shared/integrations.ts");
const model = read("docs/THREAT_MODEL.md");
const secrets = read("docs/SECURITY_SECRET_INVENTORY.md");

const checks = [
  ["renderer sandbox", /sandbox:\s*true/.test(index)],
  ["context isolation", /contextIsolation:\s*true/.test(index)],
  ["node integration disabled", /nodeIntegration:\s*false/.test(index)],
  ["external navigation denied", /will-navigate/.test(index) && /preventDefault/.test(index)],
  ["permissions denied", /setPermissionRequestHandler/.test(index) && /callback\(false\)/.test(index)],
  ["narrow preload", /ipcRenderer\.invoke\(`total:\$\{channel\}`/.test(preload)],
  ["central IPC gate", /function handle\(/.test(ipc) && /permissionAllows/.test(ipc) && /ZodError/.test(ipc)],
  ["IPC payloads excluded from logs", /Never log payloads/.test(ipc)],
  ["MCP scopes", /SCOPE_DENIED/.test(mcp) && /TOTAL_MCP_TOKEN/.test(mcp)],
  ["MCP proposal-only", /mutatesBooks:\s*false/.test(mcp) && /requiresHumanApproval:\s*true/.test(mcp)],
  ["bounded provider response", /AI_MAX_RESPONSE_BYTES/.test(ai) && /AbortSignal|timeout/.test(ai)],
  ["declarative plugins", /runtime:\s*z\.literal\("declarative-v1"\)/.test(manifest) && /\.strict\(\)/.test(manifest)],
  ["threat model boundaries", /## Assets and trust boundaries/.test(model) && /## Release review procedure/.test(model)],
  ["secret inventory covers current surfaces", /Local MCP access token/.test(secrets) && /Integration webhook signing secret/.test(secrets)],
];

const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed }, null, 2));
if (failed.length) process.exit(1);
