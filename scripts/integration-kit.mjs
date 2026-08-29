#!/usr/bin/env node
// Partner compatibility gate for Total's declarative integration contract v1.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run integration:validate -- <plugin.manifest.json>");
  process.exit(2);
}

const absolute = resolve(path);
const errors = [];
let manifest;
try {
  if (statSync(absolute).size > 256 * 1024) errors.push("manifest exceeds 256 KB");
  manifest = JSON.parse(readFileSync(absolute, "utf8"));
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

const allowedKeys = new Set([
  "schemaVersion",
  "id",
  "name",
  "version",
  "publisher",
  "runtime",
  "compatibility",
  "permissions",
  "networkHosts",
  "screens",
  "importers",
  "reports",
  "exports",
]);
const allowedPermissions = new Set([
  "imports:preview",
  "reports:read",
  "exports:write",
  "webhooks:enqueue",
  "filesystem:plugin_storage",
  "network:declared_hosts",
]);
const reportPrimitives = new Set([
  "trial_balance",
  "day_book",
  "sales_register",
  "purchase_register",
  "receivables",
  "payables",
]);

if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
  for (const key of Object.keys(manifest))
    if (!allowedKeys.has(key)) errors.push(`unknown or executable key: ${key}`);
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (manifest.runtime !== "declarative-v1") errors.push("runtime must be declarative-v1");
  if (!/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(manifest.id ?? ""))
    errors.push("id must be a reverse-domain identifier");
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(manifest.version ?? ""))
    errors.push("version must be semantic");
  if (manifest.compatibility?.contractVersion !== 1)
    errors.push("compatibility.contractVersion must be 1");
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const permission of permissions)
    if (!allowedPermissions.has(permission)) errors.push(`unknown permission: ${permission}`);
  const importers = Array.isArray(manifest.importers) ? manifest.importers : [];
  const reports = Array.isArray(manifest.reports) ? manifest.reports : [];
  const exportsList = Array.isArray(manifest.exports) ? manifest.exports : [];
  const networkHosts = Array.isArray(manifest.networkHosts) ? manifest.networkHosts : [];
  if (importers.length && !permissions.includes("imports:preview"))
    errors.push("importers require imports:preview");
  if ((reports.length || exportsList.length) && !permissions.includes("reports:read"))
    errors.push("reports and exports require reports:read");
  if (networkHosts.length && !permissions.includes("network:declared_hosts"))
    errors.push("networkHosts require network:declared_hosts");
  for (const report of [...reports, ...exportsList])
    if (!reportPrimitives.has(report?.primitive))
      errors.push(`unsupported report primitive: ${report?.primitive ?? "missing"}`);
  for (const [section, values] of Object.entries({
    screens: manifest.screens,
    importers,
    reports,
    exports: exportsList,
  })) {
    const ids = (Array.isArray(values) ? values : []).map((value) => value?.id);
    if (new Set(ids).size !== ids.length) errors.push(`${section} contains duplicate ids`);
  }
} else if (errors.length === 0) {
  errors.push("manifest must be a JSON object");
}

const result = {
  ok: errors.length === 0,
  contractVersion: 1,
  manifest: absolute,
  pluginId: manifest?.id ?? null,
  errors,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
