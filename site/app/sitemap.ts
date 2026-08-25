import type { MetadataRoute } from "next";

const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://devjindal.tech"
).replace(/\/$/, "");

const ROUTES = [
  ["", "weekly", 1],
  ["/pricing", "monthly", 0.9],
  ["/compare", "monthly", 0.9],
  ["/docs", "monthly", 0.8],
  ["/docs/coming-from-tally", "monthly", 0.8],
  ["/docs/gst-returns", "monthly", 0.8],
  ["/docs/backups", "monthly", 0.7],
  ["/docs/ai-data", "monthly", 0.7],
  ["/docs/faq", "monthly", 0.7],
  ["/support", "monthly", 0.7],
  ["/feedback", "weekly", 0.6],
  ["/changelog", "weekly", 0.6],
  ["/capture", "monthly", 0.5],
  ["/security", "yearly", 0.5],
  ["/privacy", "yearly", 0.4],
  ["/terms", "yearly", 0.4],
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(([path, changeFrequency, priority]) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  }));
}
