import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  // The desktop app and the independently deployed site each have a package-lock.json. Next's
  // automatic upward scan therefore warns and treats the worktree as the site root. Vercel's root
  // is `site/`; make the local Turbopack filesystem boundary the same explicit directory.
  turbopack: {
    root: path.resolve(__dirname)
  }
}

export default nextConfig
