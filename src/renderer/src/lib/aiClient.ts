// Typed client for the AI agent (WP 5.1) — the channels in src/main/ai/ipc.ts plus the streamed
// `total:ai:event` push. The renderer never talks to the provider: everything goes through main.
import { call } from './client'
import type {
  AiConnectionResult, AiContext, AiDraftDto, AiEvent, AiMessageDto, AiOutboundRow, AiSendInput, AiSettingsPatch, AiSettingsView, AiThreadDto, AiToolInfo,
  AiUsageRow
} from '@shared/ai'

export type * from '@shared/ai'

export const aiApi = {
  settings: () => call<AiSettingsView>('ai:settings:get'),
  setSettings: (patch: AiSettingsPatch) => call<AiSettingsView>('ai:settings:set', patch),
  acceptNotice: () => call<AiSettingsView>('ai:notice:accept'),
  /** `confirmNoUsers`: no company on this computer has users — the user confirmed that anyone can change the shared key. */
  setKey: (key: string, confirmNoUsers = false) => call<AiSettingsView>('ai:key:set', { key, confirmNoUsers }),
  clearKey: (confirmNoUsers = false) => call<AiSettingsView>('ai:key:clear', { confirmNoUsers }),
  testConnection: () => call<AiConnectionResult>('ai:testConnection'),
  tools: () => call<AiToolInfo[]>('ai:tools'),
  threads: () => call<AiThreadDto[]>('ai:threads'),
  thread: (id: number) => call<{ thread: { id: number; title: string }; messages: AiMessageDto[]; running: boolean }>('ai:thread', { id }),
  deleteThread: (id: number) => call<null>('ai:thread:delete', { id }),
  send: (input: AiSendInput) => call<{ threadId: number; runId: string; userMessage: AiMessageDto }>('ai:send', input),
  /** WP 5.2: answer the thread's last question again (replaces its answer). */
  regenerate: (threadId: number, context?: AiContext) => call<{ threadId: number; runId: string; userMessage: AiMessageDto }>('ai:regenerate', { threadId, context }),
  renameThread: (id: number, title: string) => call<AiThreadDto | null>('ai:thread:rename', { id, title }),
  pinThread: (id: number, pinned: boolean) => call<AiThreadDto | null>('ai:thread:pin', { id, pinned }),
  cancel: (threadId: number) => call<{ cancelled: boolean }>('ai:cancel', { threadId }),
  draft: (id: number) => call<AiDraftDto>('ai:draft:get', { id }),
  drafts: (status?: 'open' | 'consumed' | 'discarded', threadId?: number) =>
    call<AiDraftDto[]>('ai:drafts', { ...(status ? { status } : {}), ...(threadId ? { threadId } : {}) }),
  discardDraft: (id: number) => call<AiDraftDto>('ai:draft:discard', { id }),
  usage: () => call<AiUsageRow[]>('ai:usage'),
  outbound: () => call<AiOutboundRow[]>('ai:outbound'),
  deleteAll: (includeLogs = false) => call<Record<string, number>>('ai:data:deleteAll', { includeLogs })
}

/** Subscribe to the agent's streamed events; returns the unsubscribe. A no-op where the preload
 *  bridge has no event channel (renderer unit tests stub `window.total` without it). */
export function onAiEvent(listener: (e: AiEvent) => void): () => void {
  const sub = window.total?.onAiEvent
  if (!sub) return () => {}
  return sub((e) => listener(e as AiEvent))
}
