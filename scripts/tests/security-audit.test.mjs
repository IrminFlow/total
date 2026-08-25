import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "../lib/security-audit.mjs";

test("secret scanner detects credential formats and private keys", () => {
  assert.deepEqual(scanText("safe.ts", "const value = 'ordinary fixture text'"), []);
  assert.equal(scanText("leak.txt", `-----BEGIN PRIVATE KEY-----\n${"A".repeat(100)}\n-----END PRIVATE KEY-----`)[0]?.kind, "private key material");
  assert.equal(scanText("leak.txt", `token=${"github_pat_"}${"A".repeat(45)}`)[0]?.kind, "GitHub access token");
  assert.equal(scanText("leak.txt", `key=${"sk-proj-"}${"A".repeat(32)}`)[0]?.kind, "OpenAI API key");
});

test("tracked environment files reject literal secrets but templates remain documentable", () => {
  const line = "SUPPORT_WEBHOOK_SECRET=not-a-real-but-literal-value";
  assert.equal(scanText(".env", line)[0]?.kind, "literal secret in tracked environment file");
  assert.deepEqual(scanText(".env.example", line), []);
});
