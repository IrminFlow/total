import { describe, expect, it } from 'vitest'
import { isAllowedHelpUrl } from './helpLinks'

describe('isAllowedHelpUrl (WP 10.3)', () => {
  it('allows the GST portal and CBIC over https', () => {
    for (const u of ['https://www.gst.gov.in', 'https://gst.gov.in/help', 'https://cbic-gst.gov.in', 'https://taxinformation.cbic.gov.in/x']) {
      expect(isAllowedHelpUrl(u), u).toBe(true)
    }
  })
  it('refuses everything else', () => {
    for (const u of [
      'http://www.gst.gov.in', 'https://gst.gov.in.evil.com', 'https://evilgst.gov.in', 'https://example.com', 'javascript:alert(1)',
      'file:///etc/passwd', 'https://user:pw@gst.gov.in', 'https://gst.gov.in:8443', 'total://screen/simple-sell', 'not a url'
    ]) {
      expect(isAllowedHelpUrl(u), u).toBe(false)
    }
  })
})
