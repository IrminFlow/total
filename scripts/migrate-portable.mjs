#!/usr/bin/env node
// Upgrade Total portable JSON packages without opening the desktop app.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg) {
  console.error(
    "Usage: node scripts/migrate-portable.mjs <input.json> [output.json]",
  );
  process.exit(2);
}
const input = resolve(inputArg);
const output = resolve(outputArg ?? input.replace(/\.json$/i, "") + "-v1.json");
const pkg = JSON.parse(readFileSync(input, "utf8"));
const transformations = [];
if (pkg.schema === "total.portable" && pkg.schemaVersion === 1) {
  transformations.push(
    "Package already uses schema v1; content copied unchanged",
  );
} else {
  if (!pkg.schema) {
    pkg.schema = "total.portable";
    transformations.push("Added schema identity total.portable");
  }
  if (!pkg.exportedAt && pkg.exported_on) {
    pkg.exportedAt = pkg.exported_on;
    delete pkg.exported_on;
    transformations.push("Renamed exported_on to exportedAt");
  }
  if (!pkg.entities && pkg.tables) {
    pkg.entities = pkg.tables;
    delete pkg.tables;
    transformations.push("Renamed tables collection to entities");
  }
  pkg.schemaVersion = 1;
  transformations.push("Set schemaVersion to 1");
}
if (
  pkg.schema !== "total.portable" ||
  pkg.schemaVersion !== 1 ||
  !pkg.company ||
  typeof pkg.company !== "object" ||
  !pkg.exportedAt ||
  !pkg.entities ||
  typeof pkg.entities !== "object" ||
  Array.isArray(pkg.entities)
)
  throw new Error("Unsupported portable package: company, exportedAt, and entities are required");
for (const [name, rows] of Object.entries(pkg.entities)) {
  if (!Array.isArray(rows)) throw new Error(`Portable table "${name}" must be an array`);
}
const appDataNotice = pkg.appDataNotice ??
  "Amounts are integer paise; quantities are integer thousandths. Derived balances are not stored.";
const counts = Object.fromEntries(
  Object.entries(pkg.entities).map(([name, rows]) => [
    name,
    Array.isArray(rows) ? rows.length : 0,
  ]),
);
const base = {
  schema: "total.portable",
  schemaVersion: 1,
  exportedAt: pkg.exportedAt,
  appDataNotice,
  company: pkg.company,
  entities: pkg.entities,
};
const sha256 = createHash("sha256").update(JSON.stringify(base)).digest("hex");
const upgraded = {
  ...base,
  manifest: {
  ...(pkg.manifest ?? {}),
  counts,
  sha256,
  omittedSecrets: pkg.manifest?.omittedSecrets ?? [
    "user PIN hashes",
    "encrypted provider credentials",
    "live session tokens",
  ],
  migratedBy: "scripts/migrate-portable.mjs",
  transformations,
  },
};
writeFileSync(output, JSON.stringify(upgraded, null, 2), "utf8");
console.log(
  JSON.stringify(
    { input, output, schemaVersion: 1, transformations, counts },
    null,
    2,
  ),
);
