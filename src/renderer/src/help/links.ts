// WP 10.3: where a help article's link goes. Three kinds only:
//   total://screen/<registry name>[?section=…&tab=…&filter=…&report=…&side=…]  → a screen in the app
//   total://help/<article id>                                                    → another article
//   https://… on the GST portal / CBIC (shared/helpLinks.ts)                    → the system browser
// Anything else is not a link (shown as plain text). articles.test.ts proves every link in every
// article resolves.
import { isAllowedHelpUrl } from '@shared/helpLinks'
import { SIMPLE_SECTION_IDS, type SimpleSectionId } from '@shared/simple/uiMode'
import { screenDef } from '../lib/screens'
import type { Screen } from '../state/stores'
import { isHelpArticleId, type HelpArticleId } from './articles'

export type HelpLink =
  | { kind: 'screen'; screen: Screen }
  | { kind: 'help'; id: HelpArticleId }
  | { kind: 'external'; url: string }
  | { kind: 'invalid' }

const PARAMS = new Set(['section', 'tab', 'filter', 'report', 'side'])
/** Screens that need an id no article can know (a person, a bill). */
const NEEDS_ID = new Set<string>(['simple-person'])
const TOTAL_LINK = /^total:\/\/(screen|help)\/([a-z0-9-]+)(?:\?([^#]*))?$/

export function resolveHelpLink(href: string): HelpLink {
  const m = TOTAL_LINK.exec(href.trim())
  if (!m) return isAllowedHelpUrl(href.trim()) ? { kind: 'external', url: href.trim() } : { kind: 'invalid' }
  const [, kind, id, query] = m
  if (kind === 'help') return isHelpArticleId(id!) && !query ? { kind: 'help', id: id! } : { kind: 'invalid' }
  const def = screenDef(id as Screen['name'])
  if (!def || NEEDS_ID.has(def.name)) return { kind: 'invalid' }
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(query ?? '')) {
    if (!PARAMS.has(k) || !v) return { kind: 'invalid' }
    params[k] = v
  }
  if (def.name === 'simple-section') {
    if (!(SIMPLE_SECTION_IDS as readonly string[]).includes(params.section ?? '')) return { kind: 'invalid' }
    if (params.section === 'home') return { kind: 'screen', screen: { name: 'gateway' } }
    return { kind: 'screen', screen: { name: 'simple-section', section: params.section as Exclude<SimpleSectionId, 'home'> } as Screen }
  }
  // A screen with a default target (the full app's) or a simple screen that opens without params.
  const base = def.screen ?? (def.modes.includes('simple') ? ({ name: def.name } as Screen) : null)
  if (!base) return { kind: 'invalid' }
  return { kind: 'screen', screen: { ...base, ...params } as Screen }
}
