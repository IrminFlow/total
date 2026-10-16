/**
 * Moving the data root (Settings → "Where Total keeps your books"). Pure Node (fs / path / crypto),
 * every path injected, so the whole move is unit- and db-tested without Electron:
 *
 *   1. `inspectTarget` — the chosen folder must be EMPTY (or not exist yet, or hold only OS litter
 *      like .DS_Store / desktop.ini) or ALREADY be a Total data root (then Total just switches to
 *      the books there — nothing is copied over them). It may not be the current folder, inside
 *      it, or around it.
 *   2. `copyDataRoot` — every file under the current root (companies, backups, attachments,
 *      secrets.json, app-settings.json, logs …) is copied and fsynced, folders fsynced after;
 *      then the copy is VERIFIED against the source: the same files with the same sizes, and the
 *      same SHA-256 for every database / JSON file. Any failure removes what the copy made (the
 *      target is put back as it was) and nothing else changes.
 *   3. only then the pointer (`<userData>/data-root.json`) is written — tmp + fsync + rename; a
 *      move back to the default folder removes it instead. A pointer that cannot be written
 *      rolls the copy back too.
 *   4. the old folder is NEVER deleted: it gets a `MOVED-TO.txt` note saying where the books went.
 *
 * The caller (ipcDataRoot.ts) closes the open company first and relaunches after.
 */
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join, relative, resolve, sep } from 'path'
import { AppError } from '@shared/errors'
import { pointerText } from '../dataRootResolve'

export const MOVED_NOTE = 'MOVED-TO.txt'
/** Written into the target first and removed once the copy checks out: a copy cut short (Total
 *  killed while the window was busy, a power cut) is never taken for a Total folder later. */
export const COPY_MARKER = '.total-copy-unfinished'
/** Never copied: a hermetic run's Electron profile, the old note, OS litter. */
const SKIP = new Set(['.electron-userdata', MOVED_NOTE, COPY_MARKER, '.DS_Store', 'Thumbs.db', 'desktop.ini'])
const LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized'])
const HASHED = /\.(db|json|jsonl)$/i

export type TargetKind = 'empty' | 'new' | 'total'
export type TargetProblem = 'same' | 'inside_current' | 'contains_current' | 'not_empty' | 'not_a_folder' | 'not_writable' | 'no_space' | 'old_copy'

export interface TargetCheck {
  path: string
  ok: boolean
  kind?: TargetKind
  problem?: TargetProblem
  /** Bytes the copy needs (kind empty / new). */
  bytes?: number
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

function canonical(p: string): string {
  let r = resolve(p)
  try {
    r = realpathSync.native(r)
  } catch {
    // a folder that does not exist yet: its parent's real path + the name
    try {
      r = join(realpathSync.native(dirname(r)), r.slice(dirname(r).length + 1))
    } catch {
      // keep the resolved path
    }
  }
  r = r.replace(/[\\/]+$/, '') || r
  return caseInsensitive ? r.toLowerCase() : r
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !/^[a-z]:/i.test(rel) && !rel.startsWith(sep)
}

/** A folder Total already keeps books in: its registry, or a business's database under
 *  companies/ (a bare `companies` folder is not enough — any folder may have one), and not a copy
 *  that was cut short. */
export function isTotalDataRoot(path: string): boolean {
  if (existsSync(join(path, COPY_MARKER))) return false
  if (existsSync(join(path, 'total.json'))) return true
  try {
    return readdirSync(join(path, 'companies')).some((slug) => existsSync(join(path, 'companies', slug, 'company.db')))
  } catch {
    return false
  }
}

/** The folder Total moved the books OUT of (it holds MOVED-TO.txt): its books are older than the
 *  moved ones, so Total never switches back to it (that would silently open stale books). */
export function isOldCopy(path: string): boolean {
  return existsSync(join(path, MOVED_NOTE))
}

interface Entry { rel: string; size: number; dir: boolean }

function walk(root: string): Entry[] {
  const out: Entry[] = []
  const visit = (dir: string, top: boolean): void => {
    for (const name of readdirSync(dir).sort()) {
      if (top && SKIP.has(name)) continue
      if (!top && LITTER.has(name)) continue
      const abs = join(dir, name)
      const st = lstatSync(abs)
      const rel = relative(root, abs)
      if (st.isSymbolicLink()) throw new AppError('data_folder_link', `"${rel}" is a shortcut (symbolic link) — Total does not move those; move it out of the folder first`)
      if (st.isDirectory()) {
        out.push({ rel, size: 0, dir: true })
        visit(abs, false)
      } else if (st.isFile()) out.push({ rel, size: st.size, dir: false })
    }
  }
  visit(root, true)
  return out
}

export interface InspectDeps {
  /** Free bytes on the volume holding `path` (null = unknown — the copy is tried anyway). */
  freeBytes?: (path: string) => number | null
}

function defaultFreeBytes(path: string): number | null {
  try {
    const s = statfsSync(path)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export function inspectTarget(target: string, current: string, deps: InspectDeps = {}): TargetCheck {
  const path = resolve(target)
  const t = canonical(path)
  const c = canonical(current)
  const fail = (problem: TargetProblem, extra: Partial<TargetCheck> = {}): TargetCheck => ({ path, ok: false, problem, ...extra })
  if (t === c) return fail('same')
  if (isWithin(t, c)) return fail('inside_current')
  if (isWithin(c, t)) return fail('contains_current')
  let kind: TargetKind
  if (!existsSync(path)) kind = 'new'
  else {
    if (!statSync(path).isDirectory()) return fail('not_a_folder')
    if (isOldCopy(path)) return fail('old_copy')
    if (isTotalDataRoot(path)) return { path, ok: true, kind: 'total' }
    const names = readdirSync(path).filter((n) => !LITTER.has(n))
    if (names.length > 0) return fail('not_empty')
    kind = 'empty'
  }
  const bytes = existsSync(current) ? walk(current).reduce((s, e) => s + e.size, 0) : 0
  // Where the copy will land: the folder itself, else its nearest existing parent.
  let probe = path
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try {
    const st = statSync(probe)
    if (!st.isDirectory()) return fail('not_a_folder')
  } catch {
    return fail('not_writable')
  }
  const free = (deps.freeBytes ?? defaultFreeBytes)(probe)
  if (free !== null && free < Math.ceil(bytes * 1.05) + 1024 * 1024) return fail('no_space', { kind, bytes })
  return { path, ok: true, kind, bytes }
}

function fsyncPath(path: string, dir: boolean): void {
  if (dir && process.platform === 'win32') return // Windows cannot open a folder; NTFS journals it
  let fd: number | null = null
  try {
    fd = openSync(path, dir ? 'r' : 'r+')
    fsyncSync(fd) // libuv: F_FULLFSYNC on macOS
  } catch (err) {
    if (!dir) throw err
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Streamed in 1 MB reads: a database or backup over 2 GiB cannot be read whole (readFileSync
 *  throws ERR_FS_FILE_TOO_LARGE), and a big one should not sit in memory twice. */
function sha256(path: string): string {
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      hash.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

export interface CopyDeps {
  /** Injected for the failure tests. */
  copyFile?: (from: string, to: string) => void
}

export interface CopyResult { files: number; folders: number; bytes: number }

/** Copy + fsync + verify; on ANY failure the target is put back as it was and the error thrown. */
export function copyDataRoot(from: string, to: string, deps: CopyDeps = {}): CopyResult {
  const existed = existsSync(to)
  const made: string[] = [] // top-level entries this copy created in `to`
  const copy = deps.copyFile ?? ((a: string, b: string) => copyFileSync(a, b))
  const rollback = (): void => {
    for (const rel of made.reverse()) rmSync(join(to, rel), { recursive: true, force: true })
    rmSync(join(to, COPY_MARKER), { force: true })
    if (!existed) rmSync(to, { recursive: true, force: true })
  }
  try {
    const entries = walk(from)
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, COPY_MARKER), 'Total was copying books into this folder and did not finish. Delete this folder and move again.\n')
    fsyncPath(join(to, COPY_MARKER), false)
    const dirs = [to]
    let bytes = 0
    for (const e of entries) {
      const dst = join(to, e.rel)
      if (!e.rel.includes(sep)) made.push(e.rel)
      if (e.dir) {
        mkdirSync(dst, { recursive: true })
        dirs.push(dst)
      } else {
        copy(join(from, e.rel), dst)
        fsyncPath(dst, false)
        bytes += e.size
      }
    }
    for (const d of dirs.reverse()) fsyncPath(d, true)
    // Verify: the same tree, the same sizes, the same bytes for every database / JSON file.
    const copied = walk(to)
    const want = new Map(walk(from).map((e) => [e.rel, e]))
    if (copied.length !== want.size) throw new Error(`the copy has ${copied.length} entries, the folder ${want.size}`)
    for (const e of copied) {
      const w = want.get(e.rel)
      if (!w || w.dir !== e.dir || w.size !== e.size) throw new Error(`"${e.rel}" differs after the copy`)
      if (!e.dir && HASHED.test(e.rel) && sha256(join(from, e.rel)) !== sha256(join(to, e.rel))) throw new Error(`"${e.rel}" differs after the copy`)
    }
    rmSync(join(to, COPY_MARKER))
    fsyncPath(to, true)
    return { files: entries.filter((e) => !e.dir).length, folders: entries.filter((e) => e.dir).length, bytes }
  } catch (err) {
    try {
      rollback()
    } catch {
      // the error below says nothing was switched; leftovers in a new folder are harmless
    }
    if (err instanceof AppError) throw err
    throw new AppError('data_folder_copy_failed', `The books could not be copied — nothing was changed (${err instanceof Error ? err.message : String(err)})`)
  }
}

/** Write (or, for the default folder, remove) the pointer — atomic, durable. */
export function writePointer(pointerFile: string, path: string, defaultRoot: string): void {
  if (canonical(path) === canonical(defaultRoot)) {
    rmSync(pointerFile, { force: true })
    fsyncPath(dirname(pointerFile), true)
    return
  }
  mkdirSync(dirname(pointerFile), { recursive: true })
  const tmp = `${pointerFile}.tmp`
  writeFileSync(tmp, pointerText(path), { mode: 0o600 })
  fsyncPath(tmp, false)
  renameSync(tmp, pointerFile)
  fsyncPath(dirname(pointerFile), true)
}

export interface MoveOptions {
  from: string
  to: string
  pointerFile: string
  defaultRoot: string
  who: string | null
  appVersion: string
  now?: Date
  deps?: CopyDeps & InspectDeps & { writePointer?: typeof writePointer }
}

export interface MoveResult { path: string; kind: TargetKind; copied: CopyResult | null }

export function moveDataRoot(o: MoveOptions): MoveResult {
  const check = inspectTarget(o.to, o.from, o.deps)
  if (!check.ok || !check.kind) throw new AppError(`data_folder_${check.problem ?? 'not_writable'}`, problemMessage(check.problem ?? 'not_writable'))
  const to = check.path
  const copied = check.kind === 'total' ? null : copyDataRoot(o.from, to, o.deps)
  try {
    ;(o.deps?.writePointer ?? writePointer)(o.pointerFile, to, o.defaultRoot)
  } catch (err) {
    if (copied) {
      for (const name of readdirSync(to)) rmSync(join(to, name), { recursive: true, force: true })
      if (check.kind === 'new') rmSync(to, { recursive: true, force: true })
    }
    throw new AppError('data_folder_pointer_failed', `Total could not remember the new folder — nothing was changed (${err instanceof Error ? err.message : String(err)})`)
  }
  const at = (o.now ?? new Date()).toISOString()
  const line = `${JSON.stringify({ at, user: o.who, setting: 'dataRoot', before: o.from, after: to, copied: !!copied, appVersion: o.appVersion })}\n`
  for (const root of [to, o.from]) {
    try {
      appendFileSync(join(root, 'app-settings-audit.jsonl'), line, { mode: 0o600 })
    } catch {
      // best effort: the move is done
    }
  }
  if (copied) {
    try {
      writeFileSync(
        join(o.from, MOVED_NOTE),
        `Total's books were copied from this folder on ${at.slice(0, 10)} and are now kept in:\n\n  ${to}\n\n` +
          `Total opens that folder from now on. This folder was left as it was, as a safety copy;\n` +
          `you can delete it once you have checked your books in the new place.\n`,
        { mode: 0o644 }
      )
    } catch {
      // best effort
    }
  }
  return { path: to, kind: check.kind, copied }
}

export function problemMessage(problem: TargetProblem): string {
  switch (problem) {
    case 'same': return 'That is the folder Total already uses'
    case 'inside_current': return 'Pick a folder outside the current one'
    case 'contains_current': return 'That folder holds the current one — pick another folder'
    case 'not_empty': return 'That folder already has other files in it — pick an empty folder (or one Total already uses)'
    case 'not_a_folder': return 'That is not a folder'
    case 'not_writable': return 'Total cannot write to that folder'
    case 'no_space': return 'There is not enough free space there for your books'
    case 'old_copy': return 'That folder is the old copy Total left behind when your books were moved out of it — its books are older than yours. Rename or delete it first, or pick another folder'
  }
}
