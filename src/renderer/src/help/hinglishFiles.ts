/// <reference types="vite/client" />
// The Hinglish help articles (WP 10.4) — their own lazy chunk, like hiFiles.ts.
export const HINGLISH_FILES = import.meta.glob('./hinglish/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
