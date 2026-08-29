import { describe, expect, it } from 'vitest'
import { isAllowedWindowOpenUrl, isUrlAtOrBelow } from './externalUrl'

describe('renderer window-open allowlist', () => {
  it('allows the two draft schemes the renderer generates', () => {
    expect(isAllowedWindowOpenUrl('mailto:accounts@example.test?subject=Invoice&body=Hello')).toBe(true)
    expect(isAllowedWindowOpenUrl('mailto:?subject=Invoice')).toBe(true)
    expect(isAllowedWindowOpenUrl('https://wa.me/919876543210?text=Hello')).toBe(true)
  })

  it.each([
    'not a URL',
    'file:///Applications/Calculator.app',
    'javascript:alert(1)',
    'https://example.test/',
    'http://wa.me/919876543210',
    'https://wa.me.example.test/919876543210',
    'https://user:password@wa.me/919876543210',
    'https://wa.me/not-a-number'
  ])('rejects an operating-system handoff to %s', (url) => {
    expect(isAllowedWindowOpenUrl(url)).toBe(false)
  })
})

describe('product external-link allowlist', () => {
  it('allows HTTPS links on the site and inside the repository', () => {
    expect(isUrlAtOrBelow('https://devjindal.tech/changelog', 'https://devjindal.tech')).toBe(true)
    expect(isUrlAtOrBelow('https://github.com/IrminFlow/total/releases/tag/v0.4.0', 'https://github.com/IrminFlow/total')).toBe(true)
  })

  it.each([
    'https://devjindal.tech.example.test/changelog',
    'http://devjindal.tech/changelog',
    'https://github.com/IrminFlow/total-malicious/releases',
    'https://github.com/another-owner/total/releases'
  ])('rejects the lookalike or out-of-scope URL %s', (url) => {
    const base = url.includes('github.com') ? 'https://github.com/IrminFlow/total' : 'https://devjindal.tech'
    expect(isUrlAtOrBelow(url, base)).toBe(false)
  })
})
