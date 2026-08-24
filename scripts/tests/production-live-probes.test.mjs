import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedWaitMs,
  releaseAssetProbeOk,
} from "../lib/production-live-probes.mjs";

test("accepts only bounded deployment and release waits", () => {
  assert.equal(boundedWaitMs("600000", "WAIT"), 600000);
  assert.throws(() => boundedWaitMs("900001", "WAIT"), /between 0 and 900000/);
  assert.throws(
    () => boundedWaitMs("not-a-number", "WAIT"),
    /between 0 and 900000/,
  );
});

test("accepts a real versioned installer response", () => {
  assert.equal(
    releaseAssetProbeOk({
      assetStatus: 200,
      contentType: "application/octet-stream",
      disposition: "attachment; filename=Total.Setup.0.5.0.exe",
      location:
        "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset?response-content-disposition=filename%3DTotal.Setup.0.5.0.exe",
      platform: "win",
      size: 102_144_350,
      version: "0.5.0",
    }),
    true,
  );
});

test("rejects a release page, wrong version, tiny body, or HTML response", () => {
  const base = {
    assetStatus: 200,
    contentType: "application/octet-stream",
    disposition: "attachment; filename=Total-0.5.0-arm64.dmg",
    location: "https://github.com/IrminFlow/total/releases/tag/v0.5.0",
    platform: "mac",
    size: 119_784_996,
    version: "0.5.0",
  };
  assert.equal(releaseAssetProbeOk(base), false);
  assert.equal(
    releaseAssetProbeOk({
      ...base,
      location:
        "https://github.com/IrminFlow/total/releases/download/v0.5.0/Total-0.5.0-arm64.dmg",
    }),
    true,
  );
  assert.equal(
    releaseAssetProbeOk({
      ...base,
      disposition: "",
      location: "https://github.com/IrminFlow/total/releases/tag/v0.5.0",
    }),
    false,
  );
  assert.equal(releaseAssetProbeOk({ ...base, version: "0.6.0" }), false);
  assert.equal(
    releaseAssetProbeOk({
      ...base,
      disposition: "attachment; filename=Total-10.5.0-arm64.dmg",
    }),
    false,
  );
  assert.equal(
    releaseAssetProbeOk({
      ...base,
      disposition: "attachment; filename=Total-0.5.0.1-arm64.dmg",
    }),
    false,
  );
  assert.equal(releaseAssetProbeOk({ ...base, size: 42 }), false);
  assert.equal(
    releaseAssetProbeOk({ ...base, contentType: "text/html" }),
    false,
  );
});
