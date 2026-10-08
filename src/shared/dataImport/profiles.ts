/**
 * The import wizard's profile registry (WP 6.3): "what is this file?" — a target × source pair
 * with its own field list and transform. Generic profiles are Total's canonical targets (also
 * what a Total Books export carries); Busy and Zoho profiles map those products' exports.
 */
import { BUSY_PROFILES } from './busy'
import { normalizeHeader, scoreHeaders } from './detect'
import { parseTarget, TARGETS, TARGET_IDS, type FieldDef, type MappedRecord, type RowError, type TargetId, type TargetRows } from './targets'
import { ZOHO_PROFILES, type ProfileContext, type SourceProfile } from './zoho'

export type { ProfileContext } from './zoho'
export type SourceId = 'generic' | 'busy' | 'zoho'

export interface ImportProfile {
  id: string
  source: SourceId
  target: TargetId
  label: string
  fields: FieldDef[]
  signature: string[]
  citations: string[]
  unverified: string[]
  transform: (records: MappedRecord[], ctx: ProfileContext) => { result: TargetRows; errors: RowError[] }
}

const GENERIC: ImportProfile[] = TARGET_IDS.map((t) => ({
  id: `generic:${t}`,
  source: 'generic' as const,
  target: t,
  label: TARGETS[t].label,
  fields: TARGETS[t].fields,
  signature: [],
  citations: [],
  unverified: [],
  transform: (records: MappedRecord[], ctx: ProfileContext) => parseTarget(t, records, { dateOrder: ctx.dateOrder })
}))

const fromSource = (p: SourceProfile): ImportProfile => ({ ...p, source: p.source })

export const PROFILES: ImportProfile[] = [...GENERIC, ...BUSY_PROFILES.map(fromSource), ...ZOHO_PROFILES.map(fromSource)]

export function profileById(id: string): ImportProfile | undefined {
  return PROFILES.find((p) => p.id === id)
}

export interface ProfileGuess {
  profileId: string
  score: number
  requiredMissing: string[]
}

/** Rank profiles for a header row. A source profile's signature headers weigh 3 each, so a Zoho
 *  invoice export beats the generic Vouchers profile it also half-matches. */
export function rankProfiles(headers: string[]): ProfileGuess[] {
  const norm = new Set(headers.map(normalizeHeader))
  return PROFILES.map((p) => {
    const s = scoreHeaders(headers, p.fields)
    const sig = p.signature.filter((h) => norm.has(normalizeHeader(h))).length
    // A profile missing a required column can only win on strong signature evidence.
    // Generic profiles win close calls: a source profile needs its signature headers to beat them.
    const home = p.source === 'generic' ? 2 : 0
    return { profileId: p.id, score: s.score + sig * 3 + home - s.requiredMissing.length * 5, requiredMissing: s.requiredMissing }
  }).sort((a, b) => b.score - a.score)
}

export function detectProfile(headers: string[]): ProfileGuess | null {
  const best = rankProfiles(headers)[0]
  return best && best.score > 0 ? best : null
}
