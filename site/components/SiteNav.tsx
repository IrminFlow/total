"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PRIMARY_LINKS = [
  { href: "/compare", label: "Compare" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/support", label: "Support" },
] as const;

const RESOURCE_LINKS = [
  { href: "/docs/coming-from-tally", label: "Coming from Tally" },
  { href: "/changelog", label: "Changelog" },
  { href: "/feedback", label: "Ideas" },
  { href: "/capture", label: "Capture" },
] as const;

/**
 * Shared top bar for marketing, support and documentation pages.
 */
export default function SiteNav(): React.JSX.Element {
  const pathname = usePathname();
  const current = (href: string): boolean => pathname === href;

  return (
    <>
      <nav className="sitenav" aria-label="Primary navigation">
        <div className="wrap sitenav-row">
          <Link
            href="/"
            className="wordmark serif"
            aria-current={current("/") ? "page" : undefined}
          >
            Total
          </Link>
          <span className="sitenav-links">
            {PRIMARY_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={current(link.href) ? "active" : undefined}
                aria-current={current(link.href) ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
          </span>
          <details className="sitenav-menu">
            <summary>Menu</summary>
            <div className="sitenav-mobile-links">
              {[...PRIMARY_LINKS, ...RESOURCE_LINKS].map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={current(link.href) ? "active" : undefined}
                  aria-current={current(link.href) ? "page" : undefined}
                >
                  {link.label}
                </Link>
              ))}
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
      <span id="main-content" className="skip-target" tabIndex={-1} />
    </>
  );
}
