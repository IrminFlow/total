import { describe, expect, it } from 'vitest'
import { allowedHelpUrl, isAllowedHelpUrl } from './helpLinks'

describe('isAllowedHelpUrl (WP 10.3)', () => {
  it('allows the GST portal and CBIC over https', () => {
    for (const u of ['https://www.gst.gov.in', 'https://gst.gov.in/help', 'https://cbic-gst.gov.in', 'https://taxinformation.cbic.gov.in/x', 'https://WWW.GST.GOV.IN/']) {
      expect(isAllowedHelpUrl(u), u).toBe(true)
    }
  })
  it('refuses everything else', () => {
    for (const u of [
      'http://www.gst.gov.in', 'https://gst.gov.in.evil.com', 'https://evilgst.gov.in', 'https://example.com', 'javascript:alert(1)',
      'file:///etc/passwd', 'https://user:pw@gst.gov.in', 'https://gst.gov.in:8443', 'total://screen/simple-sell', 'not a url',
      // Review: exact hosts only — an unknown (or taken-over) subdomain is not an allowed page.
      'https://evil.gst.gov.in', 'https://a.b.cbic.gov.in/x', 'https://gst.gov.in.', 'https://evil.com\\@gst.gov.in', 'https://gst.gov.in@evil.com',
      'data:text/html,hi', 'https://www.gst.gov.in%2eevil.com'
    ]) {
      expect(isAllowedHelpUrl(u), u).toBe(false)
    }
  })
  it('returns the normalised URL that main opens', () => {
    expect(allowedHelpUrl('https://WWW.gst.gov.in')).toBe('https://www.gst.gov.in/')
    expect(allowedHelpUrl('https://www.gst.gov.in\\x y')).toBe('https://www.gst.gov.in/x%20y')
  })
})
