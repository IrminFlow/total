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
  !pkg.entities ||
  typeof pkg.entities !== "object"
)
  throw new Error("Unsupported portable package: expected an entities object");
const counts = Object.fromEntries(
  Object.entries(pkg.entities).map(([name, rows]) => [
    name,
    Array.isArray(rows) ? rows.length : 0,
  ]),
);
const base = { ...pkg, manifest: undefined };
const sha256 = createHash("sha256").update(JSON.stringify(base)).digest("hex");
pkg.manifest = {
  ...(pkg.manifest ?? {}),
  counts,
  sha256,
  migratedBy: "scripts/migrate-portable.mjs",
  transformations,
};
writeFileSync(output, JSON.stringify(pkg, null, 2), "utf8");
console.log(
  JSON.stringify(
    { input, output, schemaVersion: 1, transformations, counts },
    null,
    2,
  ),
);
