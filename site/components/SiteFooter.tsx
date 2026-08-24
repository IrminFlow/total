import Link from 'next/link'
import { SALES_EMAIL } from '@/lib/product'

const COLUMNS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: 'Product',
    links: [
      { href: '/download', label: 'Download' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/buy', label: 'Buy a licence' },
      { href: '/demo', label: 'Watch it work' },
      { href: '/changelog', label: 'Changelog' }
    ]
  },
  {
    heading: 'Deciding',
    links: [
      { href: '/compare', label: 'Against TallyPrime' },
      { href: '/roadmap', label: 'Public roadmap' },
      { href: '/docs/coming-from-tally', label: 'Coming from Tally' },
      { href: '/docs/faq', label: 'Questions' },
      { href: '/privacy', label: 'Privacy' }
    ]
  },
  {
    heading: 'Working with us',
    links: [
      { href: '/ca', label: 'For chartered accountants' },
      { href: '/partners', label: 'Partners and resellers' },
      { href: '/contact', label: 'Talk to a person' }
    ]
  }
]

export default function SiteFooter(): React.JSX.Element {
  return (
    <div className="wrap">
      <div className="footer-grid">
        {COLUMNS.map((column) => (
          <div key={column.heading}>
            <p className="footer-head">{column.heading}</p>
            <ul>
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{link.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <p className="footer-head">Total</p>
          <p className="footer-note">Offline accounting for Indian businesses.</p>
          <p className="footer-note">
            <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a>
          </p>
          <p className="footer-note">Made for the desk that used to hold the bahi khata.</p>
        </div>
      </div>
    </div>
  )
}
