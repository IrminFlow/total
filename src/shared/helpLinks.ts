// WP 10.3: the only web pages the offline help articles may link to — the GST portal and the
// CBIC (Central Board of Indirect Taxes and Customs) sites, where a user files and reads the rules.
// Checked in the renderer before a link is shown as one, and again in main (`help:openLink`)
// before the system browser opens it. Everything else in an article is in-app (`total://…`).
//
// EXACT hosts, never "any subdomain of": a forgotten or taken-over subdomain must not become a
// page the app opens by itself. A new host is added here by name (with a test).

const HOSTS: ReadonlySet<string> = new Set([
  'gst.gov.in',
  'www.gst.gov.in',
  'services.gst.gov.in',
  'tutorial.gst.gov.in',
  'cbic.gov.in',
  'www.cbic.gov.in',
  'taxinformation.cbic.gov.in',
  'cbic-gst.gov.in',
  'www.cbic-gst.gov.in'
])

/** The URL to open (normalised by the WHATWG parser), or null when it is not an allowed page:
 *  https only, one of HOSTS exactly, no credentials, no port other than 443. */
export function allowedHelpUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null
  if (!HOSTS.has(u.hostname.toLowerCase())) return null
  return u.href
}

export function isAllowedHelpUrl(url: string): boolean {
  return allowedHelpUrl(url) != null
}
