import { spawnSync } from "node:child_process";

const targets = [
  "src/main/db/crashRecovery.dbtest.ts",
  "src/main/db/upgradeRecovery.dbtest.ts",
  "src/main/db/backup.dbtest.ts",
  "src/main/db/migrations.dbtest.ts",
  "src/main/services/importers.dbtest.ts",
];
const dbResult = spawnSync(process.execPath, ["scripts/test-db.mjs", ...targets], {
  stdio: "inherit",
  env: { ...process.env, TOTAL_CHAOS_SUITE: "1" },
});
if (dbResult.status !== 0) process.exit(dbResult.status ?? 1);

const fileResult = spawnSync("npm", ["test", "--", "--run", "src/main/services/exportSigning.test.ts", "src/main/atomicFile.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, TOTAL_CHAOS_SUITE: "1" },
});
if (fileResult.status !== 0) process.exit(fileResult.status ?? 1);

const allTargets = [...targets, "src/main/services/exportSigning.test.ts", "src/main/atomicFile.test.ts"];
console.log(JSON.stringify({ ok: true, terminationBoundaries: ["voucher", "import", "approval", "migration"], recoveryBoundaries: ["backup", "restore", "export-signing", "atomic-write"], targets: allTargets }));
