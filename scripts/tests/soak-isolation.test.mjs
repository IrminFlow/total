import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const soak = readFileSync(new URL("../soak-ci.mjs", import.meta.url), "utf8");

test("soak runner isolates both company data and the Electron profile", () => {
  assert.match(soak, /TOTAL_DATA_DIR: dataDir/);
  assert.match(soak, /--user-data-dir=\$\{profileDir\}/);
  assert.match(soak, /profileDir = join\(dataDir, "\.electron-profile"\)/);
});

test("soak evidence defaults outside the source worktree", () => {
  assert.match(soak, /mkdtempSync\(join\(tmpdir\(\), "total-soak-evidence-"\)\)/);
  assert.doesNotMatch(soak, /join\(process\.cwd\(\), "soak-out"\)/);
});
