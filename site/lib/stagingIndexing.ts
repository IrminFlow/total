import type { Metadata } from "next";

export const STAGING_ROBOTS_HEADER = "noindex, nofollow, noarchive";

export function isStagingSite(): boolean {
  return process.env.TOTAL_STAGING_MODE === "1";
}

export function stagingRobotsMetadata(): Metadata["robots"] | undefined {
  return isStagingSite()
    ? {
        index: false,
        follow: false,
        nocache: true,
        googleBot: { index: false, follow: false, noimageindex: true },
      }
    : undefined;
}
