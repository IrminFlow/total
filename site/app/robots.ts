import type { MetadataRoute } from 'next'

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://devjindal.tech'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // The referral links set a cookie and redirect; there is nothing at them to index, and a
        // crawler following one would burn a code into a search result.
        disallow: ['/api/', '/r/']
      }
    ],
    sitemap: `${BASE}/sitemap.xml`
  }
}
