import Link from 'next/link'

export default function SiteFooter(): React.JSX.Element {
  return (
    <footer className="site-footer wrap">
      <span>Total — private accounting for macOS and Windows.</span>
      <span className="site-footer-links">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/security">Security</Link>
        <Link href="/support">Support</Link>
      </span>
    </footer>
  )
}
