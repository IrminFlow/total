// Registers every catalogue synchronously (perf: the renderer instead loads hi / hinglish as
// their own chunks on demand — renderer lib/i18n.ts). Imported by main (index.ts, i18n.ts, the
// CLI) — prints, error messages and bank suggestions in the company's language need them at
// once — and by the vitest setup files, so tests see all three catalogues as before.
// Never import this from renderer code: it would put both catalogues back in the startup bundle
// (`lazyCatalogues.test.ts` checks).

import { registerCatalogue } from './index'
import { hi } from './catalogues/hi'
import { hinglish } from './catalogues/hinglish'

registerCatalogue('hi', hi)
registerCatalogue('hinglish', hinglish)
