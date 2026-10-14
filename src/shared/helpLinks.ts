// WP 10.3: the only web pages the offline help articles may link to — the GST portal and the
// CBIC (Central Board of Indirect Taxes and Customs) sites, where a user files and reads the rules.
// Checked in the renderer before a link is shown as one, and again in main (`help:openLink`)
// before the system browser opens it. Everything else in an article is in-app (`total://…`).

const HOSTS = ['gst.gov.in', 'cbic.gov.in', 'cbic-gst.gov.in'] as const

/** https only, on one of HOSTS or a subdomain of one; no credentials, no odd ports. */
export function isAllowedHelpUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const host = u.hostname.toLowerCase()
  return HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}
