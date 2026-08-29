import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import { validatePackageContract } from "../lib/package-contract.mjs";

test("package-contract entrypoint resolves file URLs portably on Windows", () => {
  const source = readFileSync(new URL("../package-contract.mjs", import.meta.url), "utf8");
  assert.match(source, /fileURLToPath\(import\.meta\.url\)/);
  assert.doesNotMatch(source, /import\.meta\.url\)\.pathname/);
});

test("package-contract resolves ASAR entries with host-native separators", () => {
  const source = readFileSync(new URL("../lib/package-contract.mjs", import.meta.url), "utf8");
  assert.match(source, /extractFile\(archive, join\("out", "desktop-build-profile\.json"\)\)/);
  assert.match(source, /extractFile\(archive, join\("out", "main", "index\.js"\)\)/);
  assert.doesNotMatch(source, /extractFile\(archive, "out\//);
});

test("Windows installer uses one updater-safe artifact name", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.build.win.artifactName, "${productName}-Setup-${version}.${ext}");
  assert.doesNotMatch(pkg.build.win.artifactName, /\s/);
});

test("packaged install smoke tolerates transient NSIS directory locks", () => {
  const source = readFileSync(new URL("../install-smoke.mjs", import.meta.url), "utf8");
  assert.match(source, /maxRetries:\s*20/);
  assert.match(source, /\['EBUSY', 'EPERM'\]/);
  assert.match(source, /waitForAbsent\(executable\)/);
  assert.match(source, /timeoutMs = 15_000/);
});

const PROFILES = {
  production: { schema: 1, name: "production", siteOrigin: "https://devjindal.tech", servicesOrigin: "https://devjindal.tech", updatesEnabled: true },
  staging: { schema: 1, name: "staging", siteOrigin: "https://total-v5-staging.vercel.app", servicesOrigin: "https://total-v5-staging.vercel.app", updatesEnabled: false },
};

async function fixture(platform, profileName = "production", extraBundleText = "") {
  const root = mkdtempSync(join(tmpdir(), "total-package-contract-"));
  const dist = join(root, "dist");
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "build", "icon.png"), "icon");
  writeFileSync(join(root, "build", "desktop-build-profiles.json"), JSON.stringify({ schema: 1, profiles: PROFILES }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.5.0", build: { icon: "build/icon.png" } }));
  const resources = platform === "mac"
    ? join(dist, "mac", "Total.app", "Contents", "Resources")
    : join(dist, "win-unpacked", "resources");
  mkdirSync(resources, { recursive: true });
  for (const name of ["total-mcp.mjs", "voucher.schema.json"]) writeFileSync(join(resources, name), name);
  const asarSource = join(root, "asar-source");
  mkdirSync(join(asarSource, "out", "main"), { recursive: true });
  writeFileSync(join(asarSource, "out", "desktop-build-profile.json"), JSON.stringify(PROFILES[profileName]));
  writeFileSync(
    join(asarSource, "out", "main", "index.js"),
    `${PROFILES[profileName].siteOrigin} ${PROFILES[profileName].servicesOrigin} /api/support /api/feedback /api/cohort ${extraBundleText}`,
  );
  await createPackage(asarSource, join(resources, "app.asar"));
  let artifact;
  if (platform === "mac") {
    const contents = join(dist, "mac", "Total.app", "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    writeFileSync(join(contents, "MacOS", "Total"), "bin", { mode: 0o755 });
    writeFileSync(join(contents, "Info.plist"), "<key>CFBundleIconFile</key><key>CFBundleIdentifier</key>");
    writeFileSync(join(resources, "icon.icns"), "icon");
    artifact = join(dist, "Total-0.5.0-mac.zip");
  } else {
    artifact = join(dist, "Total.Setup.0.5.0.exe");
    writeFileSync(join(dist, "win-unpacked", "Total.exe"), Buffer.from("MZbinary"));
  }
  writeFileSync(artifact, "installer");
  const digest = createHash("sha512").update("installer").digest("base64");
  const manifest = platform === "mac" ? "latest-mac.yml" : "latest.yml";
  writeFileSync(join(dist, manifest), `version: 0.5.0\nfiles:\n  - url: ${artifact.split("/").at(-1)}\n    sha512: ${digest}\n    size: 9\n`);
  return { root, dist };
}

for (const platform of ["mac", "win"]) {
  test(`validates the ${platform} package layout, icon and updater bytes`, async () => {
    const value = await fixture(platform);
    try {
      const result = validatePackageContract({ ...value, platform, version: "0.5.0" });
      assert.equal(result.checks.updaterMetadata, "passed");
      assert.equal(result.checks.buildProfile, "passed");
      assert.equal(result.buildProfile.name, "production");
      assert.equal(result.packagedResources.length, 3);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
}

test("rejects updater metadata that does not match the installer bytes", async () => {
  const value = await fixture("win");
  try {
    writeFileSync(join(value.dist, "Total.Setup.0.5.0.exe"), "changed");
    assert.throws(() => validatePackageContract({ ...value, platform: "win", version: "0.5.0" }), /integrity|SHA-512/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("accepts an isolated staging package with updater checks disabled", async () => {
  const value = await fixture("win", "staging");
  try {
    const result = validatePackageContract({ ...value, platform: "win", version: "0.5.0", expectedProfile: "staging" });
    assert.equal(result.buildProfile.servicesOrigin, "https://total-v5-staging.vercel.app");
    assert.equal(result.buildProfile.updatesEnabled, false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects a staging package whose main bundle contains a production origin", async () => {
  const value = await fixture("win", "staging", "https://devjindal.tech");
  try {
    assert.throws(
      () => validatePackageContract({ ...value, platform: "win", version: "0.5.0", expectedProfile: "staging" }),
      /production origin/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("rejects a staging catalog redirected to another HTTPS origin", async () => {
  const value = await fixture("win", "staging");
  try {
    const catalogPath = join(value.root, "build", "desktop-build-profiles.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    catalog.profiles.staging.siteOrigin = "https://example.com";
    catalog.profiles.staging.servicesOrigin = "https://example.com";
    writeFileSync(catalogPath, JSON.stringify(catalog));
    assert.throws(
      () => validatePackageContract({ ...value, platform: "win", version: "0.5.0", expectedProfile: "staging" }),
      /does not match staging|isolated staging origin/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
