// Typed client for WP 6.4 — bulk edit, attachments, party notes / tasks (src/main/ipcWorkspace.ts).
import { call } from './client'
import type { BulkBatchDetail, BulkBatchRow, BulkRequest, BulkResult, BulkTarget, BulkUndoResult } from '@shared/bulkEdit'
import type { Attachment, AttachmentConfig, AttachmentEntity, AttachmentTarget } from '@shared/attachments'
import type { PartyNote, PartyNoteInput, PartyNoteUpdate, PartyNotesQuery, TasksDueSummary } from '@shared/partyNotes'

export type { BulkBatchDetail, BulkBatchRow, BulkRequest, BulkResult, BulkTarget, BulkUndoResult } from '@shared/bulkEdit'
export type { Attachment, AttachmentConfig, AttachmentEntity, AttachmentTarget } from '@shared/attachments'
export type { PartyNote, PartyNoteInput, PartyNoteUpdate, TasksDueSummary } from '@shared/partyNotes'

export const bulkApi = {
  preview: (req: BulkRequest) => call<BulkResult>('bulk:preview', req),
  apply: (req: BulkRequest) => call<BulkResult>('bulk:apply', req),
  undo: (id: number) => call<BulkUndoResult>('bulk:undo', { id }),
  list: (target?: BulkTarget) => call<BulkBatchRow[]>('bulk:list', target ? { target } : {}),
  get: (id: number) => call<BulkBatchDetail>('bulk:get', { id })
}

export const attachmentsApi = {
  list: (t: AttachmentTarget) => call<Attachment[]>('attachments:list', t),
  counts: (entity: AttachmentEntity) => call<Record<number, number>>('attachments:counts', { entity }),
  /** Opens the native picker in the main process — the renderer never handles a path. */
  add: (t: AttachmentTarget) => call<{ added: Attachment[]; refused: { fileName: string; reason: string }[] }>('attachments:add', t),
  open: (id: number) => call<null>('attachments:open', { id }),
  remove: (id: number) => call<null>('attachments:remove', { id }),
  config: () => call<AttachmentConfig>('attachments:config'),
  setConfig: (cfg: AttachmentConfig) => call<AttachmentConfig>('attachments:setConfig', cfg)
}

export const partyNotesApi = {
  list: (q: PartyNotesQuery = {}) => call<PartyNote[]>('partyNotes:list', q),
  add: (n: PartyNoteInput) => call<PartyNote>('partyNotes:add', n),
  update: (u: PartyNoteUpdate) => call<PartyNote>('partyNotes:update', u),
  remove: (id: number) => call<null>('partyNotes:delete', { id }),
  tasksDue: (today: string) => call<TasksDueSummary & { total: number }>('dashboard:tasksDue', { today })
}
