import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/v5-cloud-agent-sync.yml", import.meta.url),
  "utf8",
);

test("branch package workflow prunes superseded public installers before packaging", () => {
  assert.match(workflow, /^  prune-test-downloads:$/m);
  assert.match(workflow, /list\(\{ prefix: 'v5\/', limit: 1000, cursor \}\)/);
  assert.match(workflow, /await del\(urls\.slice\(index, index \+ 100\)\)/);
  assert.match(workflow, /^    needs: \[quality, prune-test-downloads\]$/m);
});

test("branch package workflow retains exact revision and checksum evidence", () => {
  assert.match(workflow, /pathname="v5\/\$\{\{ github\.sha \}\}\//);
  assert.match(workflow, /sourceRevision: process\.env\.GITHUB_SHA/);
  assert.match(workflow, /sha256: digest\.digest\('hex'\)/);
  assert.match(workflow, /retention-days: 14/);
});
