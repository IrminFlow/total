/**
 * Renderer-created windows are used only for customer email drafts and WhatsApp drafts. Keep the
 * operating-system handoff that narrow: `shell.openExternal` can dispatch arbitrary protocols,
 * so accepting whatever a compromised renderer supplies would turn an XSS into a host action.
 */
export function isAllowedWindowOpenUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (url.protocol === 'mailto:') return true

  return (
    url.protocol === 'https:' &&
    url.hostname === 'wa.me' &&
    url.username === '' &&
    url.password === '' &&
    /^\/\d+$/.test(url.pathname)
  )
}

/** Match an HTTPS origin and, when the base has a path, stay inside that exact path boundary. */
export function isUrlAtOrBelow(raw: string, base: string): boolean {
  let candidate: URL
  let allowed: URL
  try {
    candidate = new URL(raw)
    allowed = new URL(base)
  } catch {
    return false
  }

  if (candidate.protocol !== 'https:' || candidate.origin !== allowed.origin) return false

  const basePath = allowed.pathname.replace(/\/+$/, '')
  return basePath === '' || candidate.pathname === basePath || candidate.pathname.startsWith(`${basePath}/`)
}
