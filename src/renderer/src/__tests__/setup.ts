// Renderer test setup (vitest.renderer.config.ts setupFiles). WP 7.4: Testing Library's findBy* /
// waitFor give up after 1 s by default; a loaded machine (a full e2e run or other gates alongside)
// renders past that and four screen tests failed to find elements that render fine alone. The
// tests wait on conditions, so a longer ceiling costs nothing when they pass.
import { configure } from '@testing-library/react'

configure({ asyncUtilTimeout: 10_000 })

// hi / hinglish are loaded on demand in the app (lib/i18n.ts); tests see all three catalogues
// registered up front, as before (lazyCatalogues.test.tsx unregisters them where it needs to).
import '@shared/i18n/all'
