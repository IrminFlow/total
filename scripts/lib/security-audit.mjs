import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const SECRET_PATTERNS = [
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{80,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/],
  ["GitHub access token", /\b(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,})\b/],
  ["AWS access key", /\bAKIA[A-Z0-9]{16}\b/],
  ["Slack access token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

const TEXT_EXTENSIONS = new Set([
  "", ".cjs", ".css", ".env", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
  ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);

export function scanText(path, source) {
  const findings = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    const match = source.match(pattern);
    const documentedLocalTestIdentity = kind === "private key material" && path.endsWith(".test.ts") &&
      source.includes("Test-only localhost identity; production always uses the operating system trust store.");
    if (match && !documentedLocalTestIdentity)
      findings.push({ path, kind, line: source.slice(0, match.index).split("\n").length });
  }
  if (/^(?:\.env|.+\.env)$/i.test(path) && !/(?:example|sample|template)/i.test(path)) {
    for (const [index, line] of source.split("\n").entries()) {
      if (/^[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD)\s*=\s*[^\s#][^#]{7,}$/.test(line))
        findings.push({ path, kind: "literal secret in tracked environment file", line: index + 1 });
    }
  }
  return findings;
}

export function runSecurityAudit(root = process.cwd()) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean);
  const findings = [];
  let filesScanned = 0;
  for (const relative of tracked) {
    const full = resolve(root, relative);
    if (!TEXT_EXTENSIONS.has(extname(relative).toLowerCase()) || statSync(full).size > 5 * 1024 * 1024) continue;
    filesScanned += 1;
    findings.push(...scanText(relative, readFileSync(full, "utf8")));
  }

  const index = readFileSync(resolve(root, "src/main/index.ts"), "utf8");
  const preload = readFileSync(resolve(root, "src/preload/index.ts"), "utf8");
  const unsafeSwitches = [
    ["nodeIntegration enabled", /nodeIntegration\s*:\s*true/],
    ["sandbox disabled", /sandbox\s*:\s*false/],
    ["webSecurity disabled", /webSecurity\s*:\s*false/],
    ["insecure mixed content enabled", /allowRunningInsecureContent\s*:\s*true/],
  ];
  for (const [kind, pattern] of unsafeSwitches) {
    if (pattern.test(index)) findings.push({ path: "src/main/index.ts", kind, line: 1 });
  }
  if (/contextBridge\.exposeInMainWorld\([^]*\bipcRenderer\b\s*[},]/.test(preload))
    findings.push({ path: "src/preload/index.ts", kind: "raw ipcRenderer exposed", line: 1 });

  return { schema: 1, ok: findings.length === 0, filesScanned, findings };
}
