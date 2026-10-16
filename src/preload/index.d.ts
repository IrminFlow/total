export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** WP 8.5 structured error fields (see src/shared/errors): code, field path, params, issues. */
  code?: string
  field?: string
  params?: Record<string, string | number>
  issues?: { code: string; field?: string; line?: number; params?: Record<string, string | number>; message?: string }[]
}

declare global {
  interface Window {
    total: {
      platform: string
      invoke: (channel: string, payload?: unknown) => Promise<IpcResult>
      /** AI agent events (WP 5.1) — the payload is an AiEvent (src/shared/ai.ts). Returns an unsubscribe. */
      onAiEvent?: (listener: (event: unknown) => void) => () => void
      /** WP 7.2: main locked the session (⌘L / idle auto-lock). */
      onSessionLocked?: (listener: (event: { reason: 'manual' | 'idle'; kind?: 'pin' | 'passphrase' | 'privacy' }) => void) => () => void
      onUpdateEvent?: (listener: (notice: unknown) => void) => () => void
      /** to-do §4: masters changed by a write (main/masterEvents.ts); refetch those cached lists. */
      onMastersChanged?: (listener: (event: { entities: string[] }) => void) => () => void
    }
  }
}

export {}
