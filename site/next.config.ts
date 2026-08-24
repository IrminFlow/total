import type { NextConfig } from 'next'

const developmentEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''

const nextConfig: NextConfig = {
  // This package intentionally has its own lockfile inside the desktop-app monorepo.
  turbopack: { root: process.cwd() },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'${developmentEval}; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` }
    ] }]
  }
}

export default nextConfig
