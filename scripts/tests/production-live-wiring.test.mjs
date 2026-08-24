import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("production evidence keeps administration and cleanup credentials separate", () => {
  const script = readFileSync(
    resolve(root, "scripts/production-live-check.mjs"),
    "utf8",
  );
  assert.match(script, /const adminSecret = process\.env\.INTAKE_ADMIN_SECRET/);
  assert.match(script, /const cronSecret = process\.env\.CRON_SECRET/);
  assert.match(
    script,
    /maintenance\/intake\?limit=1[\s\S]{0,160}Bearer \$\{cronSecret\}/,
  );
  assert.match(
    script,
    /api\/support\?caseId=[\s\S]{0,260}Bearer \$\{adminSecret\}/,
  );
});

test("production evidence requires delivered notifications and proves exact retention indexes", () => {
  const script = readFileSync(
    resolve(root, "scripts/production-live-check.mjs"),
    "utf8",
  );
  assert.match(script, /created\.body\?\.notification === "delivered"/);
  assert.match(script, /syntheticRunId/);
  assert.match(script, /method: "PATCH"[\s\S]{0,180}reasonCode: "security"/);
  assert.match(script, /method: "DELETE", headers: authHeaders/);
  assert.match(script, /synthetic\.checks\.retentionIndexes = \{/);
  assert.match(script, /synthetic\.checks\.retentionIndexes\?\.ok/);
});

for (const workflow of [
  ".github/workflows/production-monitor.yml",
  ".github/workflows/release-candidate.yml",
  ".github/workflows/release.yml",
]) {
  test(`${workflow} supplies both production intake authorities`, () => {
    const source = readFileSync(resolve(root, workflow), "utf8");
    assert.match(
      source,
      /INTAKE_ADMIN_SECRET: \$\{\{ secrets\.INTAKE_ADMIN_SECRET \}\}/,
    );
    assert.match(source, /CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}/);
  });
}

test("release candidate treats the dispatched version as untrusted shell data", () => {
  const source = readFileSync(
    resolve(root, ".github/workflows/release-candidate.yml"),
    "utf8",
  );
  const shellBodies = [...source.matchAll(/run: \|\n((?: {10}.*\n?)*)/g)]
    .map((match) => match[1])
    .join("\n");

  assert.doesNotMatch(shellBodies, /\$\{\{ inputs\.version \}\}/);
  assert.match(source, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(
    shellBodies,
    /\[\[ "\$RELEASE_VERSION" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/,
  );
});
