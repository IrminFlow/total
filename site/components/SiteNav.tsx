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
          <Link href="/pricing">Pricing</Link>
      <Link href="/compare">Compare</Link>
          <Link href="/changelog">Changelog</Link>
        </span>
        <a className="btn small" href="/api/download">
          Download
        </a>
      </div>
    </nav>
  )
}
