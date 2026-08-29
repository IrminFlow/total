import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { extractFile } from "@electron/asar";

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

function packagedBuildProfile(root, archive, expectedProfile) {
  let metadataBytes;
  let mainBundleBytes;
  try {
    // @electron/asar resolves entry names with the host platform's separator.
    // Literal POSIX paths work on macOS/Linux but miss the same entries on Windows.
    metadataBytes = extractFile(archive, join("out", "desktop-build-profile.json"));
    mainBundleBytes = extractFile(archive, join("out", "main", "index.js"));
  } catch (error) {
    throw new Error(`Packaged desktop build profile or main bundle is missing: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadataBytes.length > 16 * 1024) throw new Error("Packaged desktop build profile is oversized");
  let profile;
  try {
    profile = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    throw new Error("Packaged desktop build profile is invalid JSON");
  }
  const catalog = JSON.parse(readFileSync(join(root, "build", "desktop-build-profiles.json"), "utf8"));
  const expected = catalog?.schema === 1 ? catalog.profiles?.[expectedProfile] : null;
  if (!expected) throw new Error(`Unknown expected desktop build profile: ${expectedProfile}`);
  if (JSON.stringify(profile) !== JSON.stringify(expected))
    throw new Error(`Packaged desktop build profile does not match ${expectedProfile}`);

  const mainBundle = mainBundleBytes.toString("utf8");
  if (!mainBundle.includes(expected.siteOrigin) || !mainBundle.includes(expected.servicesOrigin))
    throw new Error(`Packaged main bundle does not contain the ${expectedProfile} service origin`);
  for (const route of ["/api/support", "/api/feedback", "/api/cohort"])
    if (!mainBundle.includes(route)) throw new Error(`Packaged main bundle is missing ${route}`);

  const production = catalog.profiles.production;
  if (expectedProfile === "staging") {
    if (profile.siteOrigin !== "https://total-v5-staging.vercel.app" || profile.servicesOrigin !== "https://total-v5-staging.vercel.app")
      throw new Error("Staging desktop package must use only the isolated staging origin");
    if (profile.updatesEnabled !== false) throw new Error("Staging desktop package must disable updater checks");
    if (mainBundle.includes(production.siteOrigin) || mainBundle.includes(production.servicesOrigin))
      throw new Error("Staging desktop package contains a production origin");
  }
  return {
    ...profile,
    metadataSha256: createHash("sha256").update(metadataBytes).digest("hex"),
    mainBundleSha256: createHash("sha256").update(mainBundleBytes).digest("hex"),
  };
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

export function validatePackageContract({ root, dist, platform, version, expectedProfile = "production" }) {
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
  const appArchive = requiredFile(join(resources, "app.asar"), "Packaged application archive");
  const packagedFiles = [
    appArchive,
    requiredFile(join(resources, "total-mcp.mjs"), "Packaged MCP server"),
    requiredFile(join(resources, "voucher.schema.json"), "Packaged voucher schema"),
  ];
  const buildProfile = packagedBuildProfile(root, appArchive, expectedProfile);
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
    buildProfile,
    updater,
    artifacts,
    checks: { ...checks, requiredResources: "passed", buildProfile: "passed", updaterMetadata: "passed", installerPresence: "passed" },
  };
}
