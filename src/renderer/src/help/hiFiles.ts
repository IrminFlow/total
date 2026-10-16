/// <reference types="vite/client" />
// The Hindi help articles (WP 10.4) — their own lazy chunk since #146: articles.ts imports this
// module dynamically when the help panel opens in Hindi or a search runs, so the renderer entry
// carries English only.
export const HI_FILES = import.meta.glob('./hi/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
