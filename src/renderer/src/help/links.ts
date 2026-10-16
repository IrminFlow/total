// WP 10.3: where a help article's link goes. Three kinds only:
//   total://screen/<registry name>[?section=…&tab=…&filter=…&report=…&side=…]  → a screen in the app
//   total://help/<article id>                                                    → another article
//   https://… on the GST portal / CBIC (shared/helpLinks.ts)                    → the system browser
// Anything else is not a link (shown as plain text). A screen link's parameters are checked
// against the values that screen knows (lib/screens.ts SCREEN_LINK_PARAMS): unknown keys / values
// are dropped (listed in `dropped`) — the link still opens the screen. articles.test.ts proves
// every link in every article resolves and drops nothing.
import { isAllowedHelpUrl } from '@shared/helpLinks'
import { SIMPLE_SECTION_IDS, type SimpleSectionId } from '@shared/simple/uiMode'
import { LINK_PARAMS, screenDef, screenLinkParams } from '../lib/screens'
import type { Screen } from '../state/stores'
import { isHelpArticleId, type HelpArticleId } from './articles'

export type HelpLink =
  | { kind: 'screen'; screen: Screen; dropped?: string[] }
  | { kind: 'help'; id: HelpArticleId }
  | { kind: 'external'; url: string }
  | { kind: 'invalid' }

const PARAMS = new Set<string>(LINK_PARAMS)
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
  const given: Record<string, string> = {}
  const dropped: string[] = []
  for (const [k, v] of new URLSearchParams(query ?? '')) {
    if (!PARAMS.has(k) || !v) dropped.push(`${k}=${v}`)
    else given[k] = v
  }
  const { kept: params, dropped: unknown } = screenLinkParams(def.name, given)
  dropped.push(...unknown)
  const out = (screen: Screen): HelpLink => ({ kind: 'screen', screen, ...(dropped.length ? { dropped } : {}) })
  if (def.name === 'simple-section') {
    // The section is what this screen IS: a link without a known one goes nowhere.
    if (!(SIMPLE_SECTION_IDS as readonly string[]).includes(params.section ?? '')) return { kind: 'invalid' }
    if (params.section === 'home') return out({ name: 'gateway' })
    return out({ name: 'simple-section', section: params.section as Exclude<SimpleSectionId, 'home'> } as Screen)
  }
  // A screen with a default target (the full app's) or a simple screen that opens without params.
  const base = def.screen ?? (def.modes.includes('simple') ? ({ name: def.name } as Screen) : null)
  if (!base) return { kind: 'invalid' }
  return out({ ...base, ...params } as Screen)
}
