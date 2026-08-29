import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, "utf8"));
const failures = [];
const direct = { ...pkg.dependencies, ...pkg.devDependencies };
for (const [name, range] of Object.entries(direct)) {
  if (typeof range !== "string" || /^(?:\*|latest|https?:|git\+|github:|file:)/.test(range))
    failures.push(`${name}: unpinned or non-registry range ${String(range)}`);
}
const forbidden = /(?:^|\s|\()(?:(?:A|SS|LG)?GPL)(?:-|\s|$)/i;
const allowedCopyleft = new Set();
const licenses = new Map();
for (const name of Object.keys(direct)) {
  const file = `${root}/node_modules/${name}/package.json`;
  if (!existsSync(file)) {
    failures.push(`${name}: installed package metadata missing`);
    continue;
  }
  const metadata = JSON.parse(readFileSync(file, "utf8"));
  const license = String(metadata.license ?? "UNKNOWN");
  licenses.set(name, license);
  if (forbidden.test(license) && !allowedCopyleft.has(name))
    failures.push(`${name}: forbidden direct dependency license ${license}`);
}
const deprecated = Object.entries(lock.packages ?? {})
  .filter(([, value]) => value && typeof value === "object" && "deprecated" in value)
  .map(([name, value]) => `${name || "root"}: ${value.deprecated}`);
const reviewedTransitiveDeprecations = new Map([
  ["node_modules/boolean", "electron-builder -> @electron/get -> global-agent"],
  ["node_modules/fstream", "exceljs -> unzipper"],
  ["node_modules/glob", "exceljs/electron-builder legacy archive helpers"],
  ["node_modules/inflight", "glob 7"],
  ["node_modules/lodash.isequal", "electron-updater and exceljs -> fast-csv"],
  ["node_modules/rimraf", "exceljs -> unzipper -> fstream and Windows packaging"],
]);
const unexpectedDeprecated = deprecated.filter((warning) => !reviewedTransitiveDeprecations.has(warning.slice(0, warning.indexOf(":"))));
if (unexpectedDeprecated.length) failures.push(...unexpectedDeprecated.map((warning) => `unreviewed transitive deprecation ${warning}`));
const directPackagePaths = new Set(Object.keys(direct).map((name) => `node_modules/${name}`));
const deprecatedDirect = Object.entries(lock.packages ?? {})
  .filter(([name, value]) => directPackagePaths.has(name) && value && typeof value === "object" && "deprecated" in value)
  .map(([name, value]) => `${name}: ${value.deprecated}`);
if (deprecatedDirect.length) failures.push(...deprecatedDirect);
const nativeDirect = Object.keys(pkg.dependencies ?? {}).filter((name) => {
  const file = `${root}/node_modules/${name}/package.json`;
  if (!existsSync(file)) return false;
  const metadata = JSON.parse(readFileSync(file, "utf8"));
  return existsSync(`${root}/node_modules/${name}/binding.gyp`) || metadata.gypfile === true || !!metadata.binary || /node-gyp|prebuild-install/.test(String(metadata.scripts?.install ?? ""));
});
for (const name of nativeDirect)
  if (name !== "better-sqlite3") failures.push(`${name}: native runtime dependency is not on the reviewed allow-list`);
const transitiveDeprecationExceptions = deprecated.map((warning) => {
  const path = warning.slice(0, warning.indexOf(":"));
  return { path, owner: reviewedTransitiveDeprecations.get(path) ?? null, warning: warning.slice(warning.indexOf(":") + 2) };
});
console.log(JSON.stringify({ ok: failures.length === 0, directDependencies: Object.keys(direct).length, nativeDirect, licenses: Object.fromEntries(licenses), transitiveDeprecationExceptions, failures }, null, 2));
if (failures.length) process.exit(1);
