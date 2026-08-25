/**
 * The spend ledger: what the assistant has cost today, and this session.
 *
 * Enforced in MAIN, next to the code that makes the request, for the same reason the feature flag
 * is checked here rather than only in the renderer: a cap the renderer applies is a cap that
 * stops applying the moment anything else calls `ai:chat`.
 *
 * Machine-level, beside ai.json, never in a company database — spend belongs to the key, and the
 * key is per user per machine. It would also be wrong for a restored backup to carry someone
 * else's spending, or for a CA opening twelve clients' books to get twelve fresh daily caps.
 *
 * The daily figure is kept per date and pruned, so the file cannot grow without bound on a
 * machine that is never restarted, and yesterday's total is still there for a user asking why
 * they were cut off.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { machineFile } from './config'

interface SpendFile {
  version: 1
  /** Paise per ISO date. */
  days: Record<string, number>
}

/** Kept for a fortnight: long enough to answer "why did it stop yesterday", short enough to stay small. */
const KEEP_DAYS = 14

/** Session spend is deliberately in memory: quitting the app is what ends a session. */
let sessionPaise = 0
/** Runs whose cost could not be priced, so the UI can say the figure is a floor, not a total. */
let sessionUnpriced = 0

function path(): string {
  return machineFile('ai-spend.json')
}

function read(): SpendFile {
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf8')) as SpendFile
    if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') {
      return { version: 1, days: raw.days }
    }
  } catch {
    // A corrupt or absent ledger reads as zero spent. The alternative — refusing to run — would
    // turn a scratched file into a broken feature, and the cap's job is to bound a runaway loop,
    // not to be an accounting record.
  }
  return { version: 1, days: {} }
}

function write(file: SpendFile): void {
  const target = path()
  mkdirSync(join(target, '..'), { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(file), 'utf8')
  renameSync(tmp, target)
}

function prune(days: Record<string, number>, today: string): Record<string, number> {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)
  return Object.fromEntries(Object.entries(days).filter(([date]) => date >= cutoff))
}

export function recordSpend(today: string, paise: number, priced: boolean): void {
  sessionPaise += paise
  if (!priced) sessionUnpriced += 1
  if (paise <= 0) return
  const file = read()
  const days = prune({ ...file.days }, today)
  days[today] = (days[today] ?? 0) + paise
  write({ version: 1, days })
}

export interface SpendSnapshot {
  sessionPaise: number
  todayPaise: number
  /** Runs in this session whose model was not in the price table, so the total is an under-count. */
  unpricedRuns: number
  /** Every day still on file, newest first — the "why was I cut off" answer. */
  recent: { date: string; paise: number }[]
}

export function spendSnapshot(today: string): SpendSnapshot {
  const file = read()
  return {
    sessionPaise,
    todayPaise: file.days[today] ?? 0,
    unpricedRuns: sessionUnpriced,
    recent: Object.entries(file.days)
      .map(([date, paise]) => ({ date, paise }))
      .sort((a, b) => b.date.localeCompare(a.date))
  }
}

/** Clearing the conversation clears the session budget — the drawer's Clear button means this. */
export function resetSession(): void {
  sessionPaise = 0
  sessionUnpriced = 0
}

/** Test seam: the ledger file may not exist, and that must read as zero rather than throw. */
export function spendFileExists(): boolean {
  return existsSync(path())
}
