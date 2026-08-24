import type { MetadataRoute } from 'next'
import { SEO_PAGES } from '@/lib/seo-pages'

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://devjindal.tech'

const STATIC_PATHS = [
  '/',
  '/download',
  '/pricing',
  '/buy',
  '/compare',
  '/roadmap',
  '/demo',
  '/ca',
  '/partners',
  '/contact',
  '/changelog',
  '/privacy',
  '/docs',
  '/docs/coming-from-tally',
  '/docs/gst-returns',
  '/docs/backups',
  '/docs/faq'
]

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()
  return [
    ...STATIC_PATHS.map((path) => ({
      url: `${BASE}${path}`,
      lastModified: now,
      priority: path === '/' ? 1 : 0.7
    })),
    ...SEO_PAGES.map((page) => ({
      url: `${BASE}/${page.slug}`,
      lastModified: now,
      priority: 0.6
    }))
  ]
}
