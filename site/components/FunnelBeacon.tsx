"use client";

import { useEffect } from "react";
import {
  ATTRIBUTION_CAMPAIGNS,
  ATTRIBUTION_MEDIA,
  ATTRIBUTION_SOURCES,
  type AttributionEvent,
} from "@/lib/attributionContract";

const allowed = (values: readonly string[], value: string | null): string | null =>
  value && values.includes(value) ? value : null;

export default function FunnelBeacon({ event }: { event: Exclude<AttributionEvent, "download"> }): null {
  useEffect(() => {
    const current = new URL(window.location.href);
    const source = allowed(ATTRIBUTION_SOURCES, current.searchParams.get("utm_source")) ?? "direct";
    const medium = allowed(ATTRIBUTION_MEDIA, current.searchParams.get("utm_medium"));
    const campaign = allowed(ATTRIBUTION_CAMPAIGNS, current.searchParams.get("utm_campaign"));
    const dimensions = { source, ...(medium ? { medium } : {}), ...(campaign ? { campaign } : {}) };

    document.querySelectorAll<HTMLAnchorElement>('a[href^="/api/download"]').forEach((anchor) => {
      const target = new URL(anchor.href, window.location.origin);
      target.searchParams.set("source", source);
      if (medium) target.searchParams.set("medium", medium);
      if (campaign) target.searchParams.set("campaign", campaign);
      anchor.href = `${target.pathname}${target.search}`;
    });

    const key = `total:funnel:${event}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // A blocked session store may create duplicate anonymous counts, but it must not affect navigation.
    }
    void fetch("/api/attribution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...dimensions }),
      keepalive: true,
    }).catch(() => undefined);
  }, [event]);
  return null;
}
