import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export const sha256File = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export function filesBelow(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

function requiredFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0)
    throw new Error(`${label} is missing or empty: ${path}`);
  return path;
}

function updaterManifest(dist, platform, version) {
  const name = platform === "mac" ? "latest-mac.yml" : "latest.yml";
  const path = requiredFile(join(dist, name), "Updater manifest");
  const yaml = readFileSync(path, "utf8");
  const actualVersion = yaml.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1];
  if (actualVersion !== version)
    throw new Error(`${name} version ${actualVersion ?? "<missing>"} does not match ${version}`);
  const urls = [...yaml.matchAll(/^\s*-\s*url:\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm)].map(
    (match) => decodeURIComponent(match[1].trim()),
  );
  if (!urls.length) throw new Error(`${name} has no artifact URL`);
  for (const url of urls) {
    const artifact = requiredFile(join(dist, basename(url)), `${name} artifact`);
    const escaped = basename(url).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entry = yaml.match(new RegExp(`-\\s*url:\\s*['\"]?${escaped}['\"]?[^]*?(?=\\n\\s*-\\s*url:|$)`))?.[0] ?? "";
    const size = Number(entry.match(/^\s+size:\s*(\d+)\s*$/m)?.[1] ?? NaN);
    const digest = entry.match(/^\s+sha512:\s*['"]?(\S+?)['"]?\s*$/m)?.[1];
    if (!Number.isSafeInteger(size) || size !== statSync(artifact).size || !digest)
      throw new Error(`${name} integrity metadata is invalid for ${basename(url)}`);
    const actualDigest = createHash("sha512").update(readFileSync(artifact)).digest("base64");
    if (digest !== actualDigest) throw new Error(`${name} SHA-512 mismatch for ${basename(url)}`);
  }
  return {
    name,
    sha256: sha256File(path),
    artifacts: urls.map((url) => basename(url)).sort(),
  };
}

export function validatePackageContract({ root, dist, platform, version }) {
  if (platform !== "mac" && platform !== "win")
    throw new Error("Package platform must be mac or win");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.version !== version) throw new Error(`package.json version ${pkg.version} does not match ${version}`);
  const configuredIcon = requiredFile(join(root, pkg.build?.icon ?? ""), "Configured app icon");
  const files = filesBelow(dist);
  let packageRoot;
  let executable;
  let resources;
  const checks = {};
  if (platform === "mac") {
    const info = files.find((file) => file.endsWith("Total.app/Contents/Info.plist"));
    if (!info) throw new Error("Unpacked Total.app/Contents/Info.plist was not found");
    packageRoot = info.slice(0, -"/Contents/Info.plist".length);
    executable = requiredFile(join(packageRoot, "Contents", "MacOS", "Total"), "macOS executable");
    resources = join(packageRoot, "Contents", "Resources");
    const plist = readFileSync(info, "utf8");
    if (!plist.includes("CFBundleIconFile") || !plist.includes("CFBundleIdentifier"))
      throw new Error("Info.plist is missing bundle identity or icon metadata");
    const executableMode = statSync(executable).mode & 0o777;
    if ((executableMode & 0o100) === 0) throw new Error("macOS executable is not owner-executable");
    const unsafe = filesBelow(packageRoot).filter((file) => (statSync(file).mode & 0o022) !== 0);
    if (unsafe.length) throw new Error(`Packaged files are group/world writable: ${unsafe.map(basename).join(", ")}`);
    requiredFile(join(resources, "icon.icns"), "Packaged macOS icon");
    checks.permissions = "passed";
    checks.bundleMetadata = "passed";
  } else {
    executable = files.find((file) => /win-unpacked[\\/]Total\.exe$/.test(file));
    if (!executable) throw new Error("Unpacked win-unpacked/Total.exe was not found");
    requiredFile(executable, "Windows executable");
    packageRoot = join(executable, "..");
    resources = join(packageRoot, "resources");
    if (readFileSync(executable).subarray(0, 2).toString("ascii") !== "MZ")
      throw new Error("Windows executable has no PE MZ header");
    checks.peHeader = "passed";
  }
  const packagedFiles = [
    requiredFile(join(resources, "app.asar"), "Packaged application archive"),
    requiredFile(join(resources, "total-mcp.mjs"), "Packaged MCP server"),
    requiredFile(join(resources, "voucher.schema.json"), "Packaged voucher schema"),
  ];
  const updater = updaterManifest(dist, platform, version);
  const artifacts = files
    .filter((file) =>
      platform === "mac" ? /\.(dmg|zip)$/.test(file) : /\.exe$/.test(file) && !file.includes("win-unpacked"),
    )
    .map((file) => ({ name: basename(file), bytes: statSync(file).size, sha256: sha256File(file) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!artifacts.length) throw new Error(`No ${platform} installer artifacts were found`);
  return {
    schema: 1,
    platform,
    version,
    packageRoot: relative(dist, packageRoot),
    executable: { path: relative(dist, executable), bytes: statSync(executable).size, sha256: sha256File(executable) },
    configuredIcon: { path: relative(root, configuredIcon), bytes: statSync(configuredIcon).size, sha256: sha256File(configuredIcon) },
    packagedResources: packagedFiles.map((file) => ({ path: relative(packageRoot, file), bytes: statSync(file).size, sha256: sha256File(file) })),
    updater,
    artifacts,
    checks: { ...checks, requiredResources: "passed", updaterMetadata: "passed", installerPresence: "passed" },
  };
}
