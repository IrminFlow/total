// IPC channels for document capture (WP 5.4). Registered from src/main/ipc.ts with its `handle`
// (role gate + { ok, data | error } envelope); every payload Zod-parsed here (schemas in
// @shared/capture/types). Roles: viewers see the queue and the estimate; capturing, sending,
// answering, removing and categorising need an accountant. Every write channel is mapped in
// auditCoverage.ts. The renderer never sends a path: picked files are read here (native dialog),
// dropped files arrive as bytes.
import { dialog, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { basename } from 'path'
import type { DB } from '../../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { AiSettings } from '@shared/ai'
import {
  CAPTURE_MAX_BYTES, CAPTURE_TYPES, captureAddFilesSchema, captureIdSchema, captureIdsSchema, captureProcessSchema, captureResolveSchema, categoriseAcceptSchema, categoriseSchema,
  type CaptureEstimate, type CaptureOrigin, type CaptureQueueView
} from '@shared/capture/types'
import { todayISO } from '@shared/dates'
import type { Role } from '../../services/roles'
import type { SecretStore } from '../../services/secrets'
import { writeAudit } from '../../services/audit'
import { companyDir } from '../../paths'
import { getAiSettings, readApiKey } from '../settings'
import { defaultProviderFactory, settingsView } from '../ipc'
import type { AiProvider } from '../types'
import { captureFilesDir, captureInboxDir, deleteCaptureFile } from './files'
import { addCaptureFile, fileStillUsed, getItem, listItems, patchItem, recoverQueue, removeItem, toCaptureDto, type CaptureItemRow } from './store'
import { captureRunner, redraft, type CaptureEnv } from './runner'
import { estimateCapture } from './estimate'
import { acceptCategories, categoriseStatement } from './bankCategorise'
import { syncCaptureWatcher } from './watcher'
import type { ImageConverter } from './prepare'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company {
  db: DB
  info: CompanyInfo
  slug: string
  usersExist: boolean
}

export interface CaptureIpcDeps {
  company: () => Company
  session: () => { name: string | null; role: Role }
  secrets: () => SecretStore
  mock: () => boolean
  providerFactory?: (opts: { apiKey: string | null; mock: boolean }) => AiProvider
  /** Injected by tests; the app converts with Electron's nativeImage. */
  images?: ImageConverter
}

/** Electron's own decoders: HEIC (macOS) → JPEG, photos wider than 2,000 px scaled down. */
export const electronImages: ImageConverter = (bytes, mime) => {
  const img = nativeImage.createFromBuffer(bytes)
  // nativeImage may not decode WEBP — the provider takes it as it is.
  if (img.isEmpty()) return mime === 'image/webp' ? { mime, bytes } : null
  const { width } = img.getSize()
  if (width <= 2000 && (mime === 'image/png' || mime === 'image/jpeg')) return { mime, bytes }
  const out = width > 2000 ? img.resize({ width: 2000, quality: 'best' }) : img
  return { mime: 'image/jpeg', bytes: out.toJPEG(85) }
}

/** Starts the runner for the open company (set by registerCaptureIpc). */
let kickCurrent: (() => void) | null = null

export function registerCaptureIpc(handle: Handle, deps: CaptureIpcDeps): void {
  const factory = deps.providerFactory ?? defaultProviderFactory
  const db = (): DB => deps.company().db
  const dir = (): string => companyDir(deps.company().slug)
  const env = (): CaptureEnv => {
    const c = deps.company()
    const e: CaptureEnv = {
      db: c.db, company: c.info, slug: c.slug, filesDir: captureFilesDir(companyDir(c.slug)),
      provider: () => factory({ apiKey: readApiKey(deps.secrets()), mock: deps.mock() }),
      settings: (): AiSettings => getAiSettings(c.db),
      blocker: () => settingsView(getAiSettings(c.db), deps.secrets(), deps.mock()).blocker,
      images: deps.images ?? electronImages,
      today: () => todayISO()
    }
    return e
  }
  kickCurrent = () => {
    try {
      captureRunner.kick(env())
    } catch {
      /* no company open */
    }
  }
  const view = (): CaptureQueueView => {
    const e = env()
    // Approved work resumes whenever the queue is looked at (after a restart, a sign-in).
    captureRunner.kick(e)
    return { items: listItems(db()).map(toCaptureDto), running: captureRunner.isRunning(e.slug), blocker: e.blocker(), inboxPath: captureInboxDir(dir()) }
  }
  const add = async (files: { name: string; bytes: Buffer }[], origin: CaptureOrigin): Promise<{ added: number[]; refused: string[] }> => {
    const out = { added: [] as number[], refused: [] as string[] }
    for (const f of files) {
      const r = await addCaptureFile(db(), captureFilesDir(dir()), { name: f.name, bytes: f.bytes, origin, addedBy: deps.session().name })
      if (r.item) out.added.push(r.item.id)
      else out.refused.push(r.refusal ?? `${f.name}: not captured`)
    }
    return out
  }
  const item = (id: number): CaptureItemRow => {
    const it = getItem(db(), id)
    if (!it) throw new Error('Capture item not found')
    return it
  }

  handle('capture:list', () => view(), 'viewer')
  handle('capture:get', (p) => toCaptureDto(item(captureIdSchema.parse(p).id)), 'viewer')
  handle('capture:pick', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose bills to capture',
      filters: [{ name: 'Bills (PDF, images)', extensions: Object.keys(CAPTURE_TYPES) }],
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) return { added: [], refused: [] }
    const files: { name: string; bytes: Buffer }[] = []
    const refused: string[] = []
    for (const path of picked.filePaths.slice(0, 50)) {
      if (statSync(path).size > CAPTURE_MAX_BYTES) refused.push(`${basename(path)} is larger than ${CAPTURE_MAX_BYTES / 1048576} MB`)
      else files.push({ name: basename(path), bytes: readFileSync(path) })
    }
    const r = await add(files, 'picker')
    return { added: r.added, refused: [...refused, ...r.refused] }
  })
  handle('capture:addFiles', (p) => {
    const { files } = captureAddFilesSchema.parse(p)
    return add(files.map((f) => ({ name: f.name, bytes: Buffer.from(f.base64, 'base64') })), 'drop')
  })
  // The estimate names the exact queued files it priced, and the privacy settings in force; the
  // approval sends only those files (one dropped while the dialog was open waits for its own).
  handle('capture:estimate', (p): CaptureEstimate => {
    const { ids } = captureIdsSchema.parse(p ?? {})
    const s = getAiSettings(db())
    const items = listItems(db()).filter((i) => i.status === 'queued' && (!ids?.length || ids.includes(i.id)))
    const e = estimateCapture(items, s.prices[s.defaultModel])
    return { items: items.length, ids: items.map((i) => i.id), ...e, model: s.defaultModel, blocker: env().blocker(), maskIds: s.privacy.maskIds, pseudonymise: s.privacy.pseudonymiseParties }
  }, 'viewer')
  handle('capture:process', (p) => {
    const { ids } = captureProcessSchema.parse(p)
    const e = env()
    const blocker = e.blocker()
    if (blocker) throw new Error(`${blocker} — the files stay in the queue until then`)
    const items = listItems(db()).filter((i) => i.status === 'queued' && ids.includes(i.id))
    const user = deps.session().name
    const s = e.settings()
    db().transaction(() => {
      for (const it of items) patchItem(db(), it.id, { status: 'pending', approvedBy: user, error: null }, true)
      // What the user agreed to send under: the items and the masking in force at approval.
      writeAudit(db(), 'capture_item', 0, 'update', null, { approved: items.map((i) => i.id), model: s.defaultModel, maskIds: s.privacy.maskIds, pseudonymise: s.privacy.pseudonymiseParties })
    })()
    captureRunner.kick(e)
    return { approved: items.length }
  })
  handle('capture:stop', () => {
    const c = deps.company()
    const n = listItems(c.db).filter((i) => i.status === 'pending' || i.status === 'processing').length
    captureRunner.stop(c.slug, c.db)
    writeAudit(c.db, 'capture_item', 0, 'update', { queued: n }, { stopped: true, backToQueued: n })
    return { stopped: n }
  })
  handle('capture:cancel', (p) => {
    const it = item(captureIdSchema.parse(p).id)
    if (it.status === 'saved' || it.status === 'drafted') throw new Error(`This file is already ${it.status} — discard the draft instead`)
    const c = deps.company()
    const after = patchItem(c.db, it.id, { status: 'cancelled' }, true)
    if (it.status === 'processing') captureRunner.cancelCurrent(c.slug, it.id)
    return toCaptureDto(after)
  })
  // "Send again" only puts the file back in the queue; it is sent after the user confirms its
  // estimate (and the unmaskable-image notice) like any other file.
  handle('capture:retry', (p) => {
    const it = item(captureIdSchema.parse(p).id)
    if (!['failed', 'cancelled', 'duplicate', 'needs_review'].includes(it.status)) throw new Error(`A ${it.status} file cannot be sent again`)
    const after = patchItem(db(), it.id, { status: 'queued', approvedBy: null, error: null, draftId: null, duplicateKind: null, duplicateVoucherId: null }, true)
    return toCaptureDto(after)
  })
  handle('capture:resolve', (p) => {
    const { id, mapping } = captureResolveSchema.parse(p)
    const it = item(id)
    if (it.status !== 'needs_review' && it.status !== 'failed' && it.status !== 'duplicate') throw new Error(`A ${it.status} file has no open questions`)
    const merged = { ...(it.mapping ?? {}), ...mapping, lines: { ...(it.mapping?.lines ?? {}), ...(mapping.lines ?? {}) } }
    patchItem(db(), id, { mapping: merged }, true)
    return toCaptureDto(redraft(env(), id, null))
  })
  handle('capture:remove', (p) => {
    const c = deps.company()
    const it = item(captureIdSchema.parse(p).id)
    const before = removeItem(c.db, it.id)
    if (!fileStillUsed(c.db, before.sha256)) deleteCaptureFile(captureFilesDir(companyDir(c.slug)), before.storedPath)
    return null
  })
  // Viewers may look at the folder; creating and watching it (which queues files) is capture work.
  handle('capture:revealInbox', async () => {
    const inbox = captureInboxDir(dir())
    if (existsSync(inbox)) await shell.openPath(inbox)
    return { path: inbox, exists: existsSync(inbox) }
  }, 'viewer')
  handle('capture:watchInbox', async () => {
    const inbox = captureInboxDir(dir())
    mkdirSync(inbox, { recursive: true })
    const c = deps.company()
    syncCaptureWatcher({ slug: c.slug, db: c.db, dir: companyDir(c.slug) })
    await shell.openPath(inbox)
    return { path: inbox, exists: true }
  })

  // ---------- bank statement categorisation ----------
  handle('bankImport:categorise', async (p) => {
    const { bankLedgerId, lineIds, useAi } = categoriseSchema.parse(p)
    const e = env()
    const ready = e.blocker() === null
    return categoriseStatement(
      { db: e.db, provider: ready ? e.provider : null, settings: ready ? e.settings() : null, today: e.today() },
      bankLedgerId,
      { lineIds, useAi }
    )
  })
  handle('bankImport:categoriseAccept', (p) => {
    const { bankLedgerId, items } = categoriseAcceptSchema.parse(p)
    const c = deps.company()
    return acceptCategories(c.db, c.info, todayISO(), bankLedgerId, items)
  })
}

/** Company open: interrupted work goes back to the approved queue, the drop folder is watched
 *  (when AI is on or the folder exists), and approved work resumes when nobody needs to sign in. */
export function captureOnCompanyOpen(c: { slug: string; db: DB; usersExist: boolean }): void {
  recoverQueue(c.db)
  const d = companyDir(c.slug)
  if (getAiSettings(c.db).enabled || existsSync(captureInboxDir(d))) syncCaptureWatcher({ slug: c.slug, db: c.db, dir: d })
  // Deferred past the open reply; a company with users waits for the sign-in (resumeCapture).
  if (!c.usersExist) setImmediate(() => kickCurrent?.())
}

export function captureOnCompanyClose(): void {
  syncCaptureWatcher(null)
  captureRunner.stopAll()
}

/** For the sign-in path: resume approved work once the company is unlocked. */
export function resumeCapture(): void {
  kickCurrent?.()
}
