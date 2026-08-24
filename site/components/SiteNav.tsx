import Link from 'next/link'

/**
 * Slim top bar shared by every page except the homepage (which keeps its own
 * hero-adjacent .top bar with the same links inlined).
 */
export default function SiteNav(): React.JSX.Element {
  return (
    <nav className="sitenav">
      <div className="wrap sitenav-row">
        <Link href="/" className="wordmark serif">
          Total
        </Link>
        <span className="sitenav-links">
          <Link href="/docs">Docs</Link>
          <Link href="/compare">Compare</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/changelog">Changelog</Link>
          <Link href="/feedback">Ideas</Link>
          <Link href="/capture">Capture</Link>
          <Link href="/support">Support</Link>
        </span>
        <details className="sitenav-menu">
          <summary>Menu</summary>
          <div className="sitenav-mobile-links">
            <Link href="/docs">Docs</Link>
            <Link href="/compare">Compare</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/changelog">Changelog</Link>
            <Link href="/feedback">Ideas</Link>
            <Link href="/capture">Capture</Link>
            <Link href="/support">Support</Link>
            <a href="/api/download">Download</a>
          </div>
        </details>
        <a className="nav-email" href="mailto:total@irminflow.com">
          total@irminflow.com
        </a>
        <a className="btn small sitenav-download" href="/api/download">
          Download
        </a>
      </div>
    </nav>
  )
}
