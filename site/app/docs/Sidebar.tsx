'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS: { href: string; label: string }[] = [
  { href: '/docs', label: 'Getting started' },
  { href: '/docs/coming-from-tally', label: 'Coming from Tally' },
  { href: '/docs/gst-returns', label: 'GST returns' },
  { href: '/docs/backups', label: 'Backups & data' },
  { href: '/docs/ai-data', label: 'AI & data use' },
  { href: '/docs/faq', label: 'FAQ' }
]

export default function Sidebar(): React.JSX.Element {
  const pathname = usePathname()

  return (
    <nav className="docs-sidebar" aria-label="Documentation">
      {LINKS.map((link) => {
        const active = link.href === '/docs' ? pathname === '/docs' : pathname.startsWith(link.href)
        return (
          <Link key={link.href} href={link.href} className={active ? 'active' : undefined}>
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
