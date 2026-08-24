import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * The Content-Security-Policy is one line in one file, and every regression in it looks like a
 * harmless edit. This is the audit (roadmap #269) written down as a test: the three directives
 * that do NOT fall back to default-src are the ones a reviewer forgets, and the day script-src
 * gains 'unsafe-inline' should be the day a test fails rather than the day nobody notices.
 */
const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
const policy = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html)?.[1] ?? ''

const directives = new Map(
  policy
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/)
      return [name!, values] as const
    })
)

describe('the renderer content-security policy', () => {
  it('exists at all', () => {
    expect(policy).not.toBe('')
  })

  it('locks down the directives that do not inherit from default-src', () => {
    expect(directives.get('base-uri')).toEqual(["'none'"])
    expect(directives.get('form-action')).toEqual(["'none'"])
    expect(directives.get('frame-ancestors')).toEqual(["'none'"])
  })

  it('never allows inline or remote script', () => {
    // An injected <style> can deface this UI; an injected <script> owns the process.
    expect(directives.get('script-src')).toEqual(["'self'"])
    expect(policy).not.toMatch(/script-src[^;]*unsafe-eval/)
  })

  it('permits no network destination but itself', () => {
    // Every network call in the product belongs to the main process; one originating here is a
    // bug or an attack.
    expect(directives.get('connect-src')).toEqual(["'self'"])
    expect(directives.get('default-src')).toEqual(["'self'"])
  })

  it('allows the one frame the app actually renders, and no plugins or workers', () => {
    // The invoice-print preview is a sandboxed srcdoc iframe.
    expect(directives.get('frame-src')).toEqual(["'self'"])
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('worker-src')).toEqual(["'none'"])
  })

  it('allows inline style, deliberately and only there', () => {
    expect(directives.get('style-src')).toContain("'unsafe-inline'")
    expect(html).toMatch(/Tailwind's runtime writes inline styles/)
  })
})
