/**
 * Moving the books to a new folder (roadmap #244).
 *
 * The app warns, once per launch, that `~/Documents/total` looks like it is inside Dropbox or
 * iCloud, and then offers nothing: the user is told their books are in danger and left to move a
 * folder full of live SQLite databases by hand, with the app still holding them open. Most people
 * dismiss the warning instead, which is the rational response to advice you cannot act on.
 *
 * A move here is a copy, a verification, and only then a switch. Nothing is deleted: somebody
 * moving their accounts between disks should end the operation with two copies and a choice, not
 * with one copy and a hope.
 *
 * The pointer to the current location lives in `dataRootConfig.ts` — see there for why it is a
 * separate module.
 */
import { cpSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { moveVerdict, type MoveVerdict } from '@shared/dataMove'
import { setConfiguredDataRoot } from './dataRootConfig'
import { verifyBackup } from './db/backup'

/** A folder that already holds a Total data tree. */
function looksLikeDataRoot(dir: string): boolean {
  return existsSync(join(dir, 'total.json')) || existsSync(join(dir, 'companies'))
}

export function inspectMoveTarget(currentRoot: string, target: string): MoveVerdict {
  const contents = existsSync(target) ? readdirSync(target) : []
  return moveVerdict(currentRoot, target, {
    targetIsExistingDataRoot: looksLikeDataRoot(target),
    targetHasContents: contents.length > 0
  })
}

export interface MoveResult {
  from: string
  to: string
  /** Company databases copied and re-opened successfully. */
  companies: number
}

/**
 * Copy the whole data tree to `destination/total`, prove every company database survived, and
 * point the app at the new copy.
 *
 * The caller must have closed the open company first: copying a database another handle is
 * writing to is precisely how a sync client corrupts one, and doing it ourselves would be a poor
 * joke in a feature about not doing that.
 *
 * Every company database in the copy is opened and checked before the switch. If any of them
 * fails, the copy is abandoned where it is and the app keeps using the original — a move that
 * half worked must never become the live data folder.
 */
export function moveDataRoot(currentRoot: string, destination: string): MoveResult {
  const verdict = inspectMoveTarget(currentRoot, destination)
  if (!verdict.ok) throw new Error(verdict.error)

  const target = join(destination, 'total')
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`There is already something at ${target}. Choose an empty folder, or a different one.`)
  }

  // Recursive copy rather than rename: the destination is very often a different filesystem
  // (an external drive), where rename fails with EXDEV.
  cpSync(currentRoot, target, { recursive: true })

  const companiesDir = join(target, 'companies')
  const slugs = existsSync(companiesDir) ? readdirSync(companiesDir) : []
  let companies = 0
  for (const slug of slugs) {
    const dbPath = join(companiesDir, slug, 'company.db')
    if (!existsSync(dbPath)) continue
    const proof = verifyBackup(dbPath)
    if (!proof.opensAsCompany || !proof.integrityOk) {
      throw new Error(
        `The copy of "${slug}" did not open correctly (${proof.problem ?? 'unknown problem'}). Nothing has been changed — your books are still in ${currentRoot}.`
      )
    }
    companies++
  }

  setConfiguredDataRoot(target)
  return { from: currentRoot, to: target, companies }
}
