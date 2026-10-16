// Ask Total IPC (WP 10.1). Registered from ipc.ts with its `handle` (role gate + { ok, data | error }
// envelope); payloads are Zod-parsed here.
//   assist:ask    viewer — answers from the read services; an entry request is rehearsed
//                 (always rolled back) and comes back as an offer: nothing is written.
//   assist:draft  accountant+ — stores the entry request as an ai_drafts row (source 'assistant',
//                 origin 'ask-total', audited) that the simple flow opens; simple:post with
//                 `aiDraftId` consumes it when the flow saves. The person's older open Ask Total
//                 drafts are discarded (one open at a time).
//   assist:draft:discard  accountant+ — the flow was left without saving: its draft is discarded
//                 (audited like Settings → AI drafts' Discard).
// No network, no model, no key: src/main/assist/ never reaches the AI provider (assistBoundary.test.ts).
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from '../services/roles'
import { assistAskSchema, assistDiscardSchema } from '@shared/assist'
import { todayISO } from '@shared/dates'
import { translator } from '@shared/i18n'
import { homeAsOn } from '../services/simpleHome'
import { companyLanguage } from '../i18n'
import { askTotal } from './answer'
import { classify } from './classify'
import { createAskDraft } from './entry'
import { discardAskDraft } from './settle'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void

export interface AskTotalDeps {
  company: () => { db: DB; info: CompanyInfo }
  /** The signed-in role; null = a company with users and nobody signed in. */
  roleNow: () => Role | null
  /** The signed-in user's name; null = nobody signed in (a company without users). */
  userNow?: () => string | null
}

export const canDraftAs = (role: Role | null): boolean => role === 'accountant' || role === 'owner'

export function registerAskTotalIpc(handle: Handle, deps: AskTotalDeps): void {
  handle('assist:ask', (payload) => {
    const p = assistAskSchema.parse(payload)
    const c = deps.company()
    return askTotal(
      c.db,
      c.info,
      { text: p.text, today: homeAsOn(p.today, todayISO()), ...(p.picks ? { picks: p.picks } : {}), ...(p.lang ? { lang: p.lang } : {}) },
      { canDraft: canDraftAs(deps.roleNow()) }
    )
  }, 'viewer')

  handle('assist:draft', (payload) => {
    const p = assistAskSchema.parse(payload)
    const c = deps.company()
    const t = translator(p.lang ?? companyLanguage(c.db))
    return createAskDraft(c.db, c.info, { text: p.text, today: homeAsOn(p.today, todayISO()), ...(p.picks ? { picks: p.picks } : {}) }, { canDraft: true }, t, classify, deps.userNow?.() ?? null)
  })

  // The flow an Ask Total draft opened was left without saving (renderer: useSimplePost's unmount).
  handle('assist:draft:discard', (payload) => {
    const p = assistDiscardSchema.parse(payload)
    return discardAskDraft(deps.company().db, p.draftId, deps.userNow?.() ?? null)
  })
}
