// WP 7.2 hardening: the only things the renderer may ask the OS to open outside the app (a
// `window.open` / target=_blank reaches main's setWindowOpenHandler, which opens nothing else):
//   - the help articles' pages (the GST portal / CBIC — helpLinks.ts, exact hosts);
//   - an e-mail draft (`mailto:` — statements and reminders, the support link);
//   - a WhatsApp chat (`https://wa.me/<number>?text=…` — People → Remind, shared/simple/people.ts).
// Everything else is refused (and logged by main). Pure; tested in externalLinks.test.ts.
import { allowedHelpUrl } from './helpLinks'

/** The normalised URL to open, or null when it is not one of the above. */
export function allowedExternalUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length > 8192) return null
  const help = allowedHelpUrl(url)
  if (help) return help
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol === 'mailto:') return u.href
  // wa.me: a chat with a number (digits only) or the bare share page — never another path on it.
  if (u.protocol === 'https:' && u.hostname === 'wa.me' && !u.username && !u.password && (!u.port || u.port === '443') && /^\/(\d{1,15})?$/.test(u.pathname) && !u.hash) return u.href
  return null
}
