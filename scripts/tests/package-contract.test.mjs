import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePackageContract } from "../lib/package-contract.mjs";

test("package-contract entrypoint resolves file URLs portably on Windows", () => {
  const source = readFileSync(new URL("../package-contract.mjs", import.meta.url), "utf8");
  assert.match(source, /fileURLToPath\(import\.meta\.url\)/);
  assert.doesNotMatch(source, /import\.meta\.url\)\.pathname/);
});

test("Windows installer uses one updater-safe artifact name", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.build.win.artifactName, "${productName}-Setup-${version}.${ext}");
  assert.doesNotMatch(pkg.build.win.artifactName, /\s/);
});

function fixture(platform) {
  const root = mkdtempSync(join(tmpdir(), "total-package-contract-"));
  const dist = join(root, "dist");
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "build", "icon.png"), "icon");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.5.0", build: { icon: "build/icon.png" } }));
  const resources = platform === "mac"
    ? join(dist, "mac", "Total.app", "Contents", "Resources")
    : join(dist, "win-unpacked", "resources");
  mkdirSync(resources, { recursive: true });
  for (const name of ["app.asar", "total-mcp.mjs", "voucher.schema.json"]) writeFileSync(join(resources, name), name);
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
  test(`validates the ${platform} package layout, icon and updater bytes`, () => {
    const value = fixture(platform);
    try {
      const result = validatePackageContract({ ...value, platform, version: "0.5.0" });
      assert.equal(result.checks.updaterMetadata, "passed");
      assert.equal(result.packagedResources.length, 3);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
}

test("rejects updater metadata that does not match the installer bytes", () => {
  const value = fixture("win");
  try {
    writeFileSync(join(value.dist, "Total.Setup.0.5.0.exe"), "changed");
    assert.throws(() => validatePackageContract({ ...value, platform: "win", version: "0.5.0" }), /integrity|SHA-512/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
