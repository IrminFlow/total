/**
 * Choosing a new home for the data folder (roadmap #244).
 *
 * The app warns, once per launch, that `~/Documents/total` looks like it is inside Dropbox or
 * iCloud, and then offers nothing: the user is told their books are in danger and left to move a
 * folder full of live SQLite databases by hand, with the app still holding them open. Most people
 * dismiss the warning instead, which is the rational response to advice you cannot act on.
 *
 * The rules for a target folder are here, pure, because they are the part worth being sure of:
 * a move that lands the books inside their own old folder, or on the sync client they were being
 * moved off, is worse than not moving at all.
 */
import { syncFolderWarning } from './syncpath'

export type MoveVerdict =
  | { ok: true; warning: string | null }
  | { ok: false; error: string }

const trimSlashes = (path: string): string => path.replace(/[/\\]+$/, '')

/** True when `child` is `parent` or sits underneath it. Compared case-insensitively: macOS and
 *  Windows filesystems usually are, and a case-only difference is the same folder there. */
export function isInside(child: string, parent: string): boolean {
  const a = trimSlashes(child).toLowerCase()
  const b = trimSlashes(parent).toLowerCase()
  return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`)
}

/**
 * Whether `target` is somewhere the data folder may be moved to.
 *
 * `targetHasContents` is the caller's answer to "is there already something in there" — moving
 * into a folder with other files in it is allowed (people pick their Documents folder and expect
 * a `total` inside it, which is what the caller builds), moving ONTO an existing Total data
 * folder is not, because the merge that implies is not a thing this can do.
 */
export function moveVerdict(
  currentRoot: string,
  target: string,
  options: { targetIsExistingDataRoot: boolean; targetHasContents: boolean }
): MoveVerdict {
  const to = trimSlashes(target)
  if (!to) return { ok: false, error: 'Choose a folder' }
  if (isInside(to, currentRoot)) {
    return { ok: false, error: 'That folder is inside the current data folder — pick somewhere outside it.' }
  }
  if (isInside(currentRoot, to)) {
    return { ok: false, error: 'The current data folder is inside that one, so moving there would move it into itself.' }
  }
  if (options.targetIsExistingDataRoot) {
    return {
      ok: false,
      error: 'There is already a Total data folder there. Moving onto it would mean merging two sets of books, which is not something this can do safely.'
    }
  }

  const synced = syncFolderWarning(to)
  if (synced) {
    return {
      ok: false,
      error: `That folder is synced by ${synced}, which is the problem this move exists to solve — a live database edited on two machines at once can be corrupted. Pick a folder on this machine.`
    }
  }

  return {
    ok: true,
    warning: options.targetHasContents ? 'That folder already has other files in it; Total will add its own folder alongside them.' : null
  }
}
