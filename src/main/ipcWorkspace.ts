// IPC channels for WP 6.4: bulk edit (preview / apply / undo), attachments on vouchers, ledgers,
// stock items and trade documents, and party notes / tasks. Registered from ipc.ts with its
// `handle` (role gate + { ok, data | error } envelope); every payload is Zod-parsed here.
//
// Attachments never take a path from the renderer: adding opens the native picker in this
// process, opening goes by id (services/attachments.ts checks the row, the location and the hash,
// then hands a private copy to shell.openPath).
import { dialog, shell } from 'electron'
import { z } from 'zod'
import type { DB } from './db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { Role } from './services/roles'
import { isoDate } from '@shared/schemas'
import { ATTACHMENT_ENTITIES, attachmentTargetSchema, cleanFileName, type Attachment } from '@shared/attachments'
import { partyNoteInputSchema, partyNoteUpdateSchema, partyNotesQuerySchema } from '@shared/partyNotes'
import { bulkRequestSchema } from '@shared/bulkEdit'
import { attachmentConfigSchema } from '@shared/attachments'
import * as bulk from './services/bulkEdit'
import * as att from './services/attachments'
import * as notes from './services/partyNotes'
import { companyAttachmentsDir } from './paths'
import { log } from './log'
import { rememberSalePrices } from './services/pricing'
import { getAgentBridgeEnabled } from './services/config'
import { scheduleMirrorRefresh } from './services/agentBridge'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void
interface Company { db: DB; info: CompanyInfo; slug: string }

const idSchema = z.object({ id: z.number().int().positive() })

export function registerWorkspaceIpc(handle: Handle, company: () => Company): void {
  const db = (): DB => company().db
  const dir = (): string => companyAttachmentsDir(company().slug)

  // ---------- bulk edit ----------
  // The preview runs every save inside a transaction it rolls back — it changes nothing.
  handle('bulk:preview', (p) => bulk.previewBulk(db(), bulkRequestSchema.parse(p)))
  // After an apply / undo, the same follow-ups the editor's voucher:save runs: "remember last
  // price" on sales and the agent mirror refresh. Neither ever fails the batch.
  const afterSaves = (voucherIds: number[]): void => {
    const c = company()
    for (const id of voucherIds) {
      try {
        rememberSalePrices(c.db, id)
      } catch (err) {
        log('warn', 'pricing.rememberSalePrices.failed', { error: (err as Error).message })
      }
    }
    if (voucherIds.length > 0 && getAgentBridgeEnabled(c.db)) scheduleMirrorRefresh(c.db, c.slug)
  }
  handle('bulk:apply', (p) => {
    const r = bulk.applyBulk(db(), bulkRequestSchema.parse(p))
    afterSaves(r.records.filter((x) => x.entity === 'voucher' && x.status === 'applied').map((x) => x.id))
    return r
  })
  handle('bulk:undo', (p) => {
    const r = bulk.undoBulk(db(), idSchema.parse(p).id)
    afterSaves(r.records.filter((x) => x.entity === 'voucher' && x.status === 'undone').map((x) => x.id))
    return r
  })
  handle('bulk:list', (p) => {
    const { target } = z.object({ target: z.enum(['voucher', 'ledger', 'stockItem']).optional() }).default({}).parse(p)
    return bulk.listBulkBatches(db(), target)
  }, 'viewer')
  handle('bulk:get', (p) => bulk.getBulkBatch(db(), idSchema.parse(p).id), 'viewer')

  // ---------- attachments ----------
  handle('attachments:list', (p) => att.listAttachments(db(), attachmentTargetSchema.parse(p)), 'viewer')
  handle('attachments:counts', (p) => {
    const { entity } = z.object({ entity: z.enum(ATTACHMENT_ENTITIES) }).parse(p)
    return att.attachmentCounts(db(), entity)
  }, 'viewer')
  handle('attachments:add', async (p) => {
    const target = attachmentTargetSchema.parse(p)
    const c = company()
    const cfg = att.getAttachmentConfig(c.db)
    const picked = await dialog.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Allowed files', extensions: cfg.allowedExtensions }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return { added: [] as Attachment[], refused: [] as { fileName: string; reason: string }[] }
    const added: Attachment[] = []
    const refused: { fileName: string; reason: string }[] = []
    for (const path of picked.filePaths) {
      try {
        added.push(att.addAttachment(c.db, companyAttachmentsDir(c.slug), target, path))
      } catch (err) {
        refused.push({ fileName: cleanFileName(path), reason: err instanceof Error ? err.message : String(err) })
      }
    }
    return { added, refused }
  })
  handle('attachments:open', async (p) => {
    const { id } = idSchema.parse(p)
    const path = att.prepareOpen(db(), dir(), id)
    const err = await shell.openPath(path)
    if (err) {
      log('warn', 'attachment-open-failed', { error: err })
      throw new Error(`Couldn't open the file: ${err}`)
    }
    return null
  }, 'viewer')
  handle('attachments:remove', (p) => {
    att.removeAttachment(db(), dir(), idSchema.parse(p).id)
    return null
  })
  handle('attachments:config', () => att.getAttachmentConfig(db()), 'viewer')
  handle('attachments:setConfig', (p) => att.setAttachmentConfig(db(), attachmentConfigSchema.parse(p)), 'owner')

  // ---------- party notes / tasks ----------
  handle('partyNotes:list', (p) => notes.listPartyNotes(db(), partyNotesQuerySchema.parse(p ?? {})), 'viewer')
  handle('partyNotes:add', (p) => notes.addPartyNote(db(), partyNoteInputSchema.parse(p)))
  handle('partyNotes:update', (p) => notes.updatePartyNote(db(), partyNoteUpdateSchema.parse(p)))
  handle('partyNotes:delete', (p) => {
    notes.deletePartyNote(db(), idSchema.parse(p).id)
    return null
  })
  handle('dashboard:tasksDue', (p) => {
    const { today } = z.object({ today: isoDate }).parse(p)
    return notes.tasksDue(db(), today)
  }, 'viewer')
}
