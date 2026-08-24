import Link from 'next/link'

/**
 * Slim top bar shared by every page except the homepage, which keeps its own hero-adjacent bar.
 *
 * Five links and a button is the ceiling: it has to stay on one line at a laptop width. Privacy,
 * the changelog and the partner pages live in the footer, where a page nobody visits twice
 * belongs.
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
          <Link href="/roadmap">Roadmap</Link>
          <Link href="/contact">Contact</Link>
        </span>
        <Link className="btn small" href="/download">
          Download
        </Link>
      </div>
    </nav>
  )
}
