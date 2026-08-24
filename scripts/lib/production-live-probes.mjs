export function boundedWaitMs(value, name) {
  const milliseconds = Number(value ?? 0);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 15 * 60_000
  )
    throw new Error(`${name} must be between 0 and 900000 milliseconds`);
  return Math.floor(milliseconds);
}

export function releaseAssetProbeOk({
  assetStatus,
  contentType,
  disposition,
  location,
  platform,
  size,
  version,
}) {
  const extension =
    platform === "mac" ? ".dmg" : platform === "win" ? ".exe" : "";
  if (
    !extension ||
    typeof location !== "string" ||
    typeof disposition !== "string"
  )
    return false;
  let identity;
  let trustedAssetLocation = false;
  try {
    const url = new URL(location);
    trustedAssetLocation =
      url.protocol === "https:" &&
      (url.hostname.endsWith(".githubusercontent.com") ||
        (url.hostname === "github.com" &&
          url.pathname.includes("/releases/download/")));
    identity = decodeURIComponent(disposition).toLowerCase();
  } catch {
    return false;
  }
  const escapedVersion = String(version)
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExtension = extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionedFilename = new RegExp(
    `(^|[^0-9])${escapedVersion}(?:-[a-z0-9_-]+)?${escapedExtension}([^a-z0-9.]|$)`,
  );
  return (
    trustedAssetLocation &&
    assetStatus >= 200 &&
    assetStatus < 300 &&
    versionedFilename.test(identity) &&
    Number.isSafeInteger(size) &&
    size >= 1_000_000 &&
    !String(contentType).toLowerCase().includes("text/html")
  );
}
