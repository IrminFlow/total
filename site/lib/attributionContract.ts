export const ATTRIBUTION_EVENTS = [
  "landing_view",
  "pricing_view",
  "compare_view",
  "ai_data_view",
  "download",
] as const;
export const ATTRIBUTION_SOURCES = [
  "direct",
  "google",
  "github",
  "linkedin",
  "youtube",
  "newsletter",
  "partner",
  "product",
] as const;
export const ATTRIBUTION_MEDIA = ["organic", "referral", "email", "social", "product"] as const;
export const ATTRIBUTION_CAMPAIGNS = ["v5-beta", "launch", "migration", "accountant"] as const;

export type AttributionEvent = (typeof ATTRIBUTION_EVENTS)[number];
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];
export type AttributionMedium = (typeof ATTRIBUTION_MEDIA)[number];
export type AttributionCampaign = (typeof ATTRIBUTION_CAMPAIGNS)[number];

export interface AttributionInput {
  event: AttributionEvent;
  source?: AttributionSource;
  medium?: AttributionMedium;
  campaign?: AttributionCampaign;
  platform?: "mac" | "win";
}

const allowedKeys = new Set(["event", "source", "medium", "campaign", "platform"]);
const member = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  typeof value === "string" && values.includes(value);

/** Accepts only fixed dimensions. Free text, URLs, referrers and accounting fields have no schema path. */
export function parseAttribution(value: unknown): AttributionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !allowedKeys.has(key))) return null;
  if (!member(ATTRIBUTION_EVENTS, row.event)) return null;
  if (row.source !== undefined && !member(ATTRIBUTION_SOURCES, row.source)) return null;
  if (row.medium !== undefined && !member(ATTRIBUTION_MEDIA, row.medium)) return null;
  if (row.campaign !== undefined && !member(ATTRIBUTION_CAMPAIGNS, row.campaign)) return null;
  if (row.platform !== undefined && row.platform !== "mac" && row.platform !== "win") return null;
  return {
    event: row.event,
    ...(row.source === undefined ? {} : { source: row.source }),
    ...(row.medium === undefined ? {} : { medium: row.medium }),
    ...(row.campaign === undefined ? {} : { campaign: row.campaign }),
    ...(row.platform === undefined ? {} : { platform: row.platform }),
  };
}
